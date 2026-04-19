/**
 * Step: probe — Single upfront parallel scan for /new-setup's dynamic context
 * injection. Rendered into the SKILL.md prompt via `!`pnpm exec tsx ... probe``
 * so Claude sees the current system state before generating its first response.
 *
 * This is a routing aid, NOT a replacement for per-step idempotency checks.
 * Each existing step keeps its own checks; probe just tells the skill which
 * steps to bother calling.
 *
 * Keep this step fast (<2s total). All probes swallow their own errors and
 * report a neutral state rather than failing the whole scan.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { log } from '../src/log.js';
import { isValidTimezone } from '../src/timezone.js';
import { commandExists, getPlatform, isWSL } from './platform.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');
const PROBE_TIMEOUT_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;
const AGENT_IMAGE = 'nanoclaw-agent:latest';

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function readEnvVar(name: string): string | null {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return null;
  const content = fs.readFileSync(envFile, 'utf-8');
  const m = content.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function probeDocker(): {
  status: 'running' | 'installed_not_running' | 'not_found';
  imagePresent: boolean;
} {
  if (!commandExists('docker')) return { status: 'not_found', imagePresent: false };
  try {
    execSync('docker info', { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
  } catch {
    return { status: 'installed_not_running', imagePresent: false };
  }
  let imagePresent = false;
  try {
    execSync(`docker image inspect ${AGENT_IMAGE}`, {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    imagePresent = true;
  } catch {
    // image not built yet
  }
  return { status: 'running', imagePresent };
}

function probeOnecliUrl(): string | null {
  const fromEnv = readEnvVar('ONECLI_URL');
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    const parsed = JSON.parse(out) as { value?: unknown };
    if (typeof parsed.value === 'string' && parsed.value) return parsed.value;
  } catch {
    // onecli not installed or config not set
  }
  return null;
}

async function probeOnecliStatus(
  url: string | null,
): Promise<'healthy' | 'installed_not_healthy' | 'not_found'> {
  const installed =
    commandExists('onecli') || fs.existsSync(path.join(LOCAL_BIN, 'onecli'));
  if (!installed) return 'not_found';
  if (!url) return 'installed_not_healthy';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? 'healthy' : 'installed_not_healthy';
  } catch {
    return 'installed_not_healthy';
  }
}

function probeAnthropicSecret(): boolean {
  try {
    const out = execFileSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    });
    const parsed = JSON.parse(out) as { data?: Array<{ type: string }> };
    return !!parsed.data?.some((s) => s.type === 'anthropic');
  } catch {
    return false;
  }
}

function probeServiceStatus(): 'running' | 'stopped' | 'not_configured' {
  const platform = getPlatform();
  if (platform === 'macos') {
    try {
      const out = execSync('launchctl list', {
        encoding: 'utf-8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const line = out.split('\n').find((l) => l.includes('com.nanoclaw'));
      if (!line) return 'not_configured';
      // Format: "PID STATUS LABEL" — PID is "-" when loaded but not running
      const pid = line.trim().split(/\s+/)[0];
      return pid && pid !== '-' ? 'running' : 'stopped';
    } catch {
      return 'not_configured';
    }
  }
  if (platform === 'linux') {
    try {
      execSync('systemctl --user is-active nanoclaw', {
        stdio: 'ignore',
        timeout: PROBE_TIMEOUT_MS,
      });
      return 'running';
    } catch {
      // Either stopped, not-configured, or is-active returned non-zero.
      // Distinguish by checking if the unit file exists at all.
      try {
        execSync('systemctl --user cat nanoclaw', {
          stdio: 'ignore',
          timeout: PROBE_TIMEOUT_MS,
        });
        return 'stopped';
      } catch {
        return 'not_configured';
      }
    }
  }
  return 'not_configured';
}

function probeCliAgentWired(): boolean {
  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT 1 FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mg.channel_type = 'cli' LIMIT 1`,
      )
      .get();
    return !!row;
  } catch {
    // Tables may not exist yet
    return false;
  } finally {
    db?.close();
  }
}

function probeInferredDisplayName(): string {
  const reject = (s: string | null | undefined): boolean =>
    !s || !s.trim() || s.trim().toLowerCase() === 'root';

  // 1. git global user name
  try {
    const name = execFileSync('git', ['config', '--global', 'user.name'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!reject(name)) return name;
  } catch {
    // git missing or no config set
  }

  const user = process.env.USER || os.userInfo().username;
  const platform = getPlatform();

  // 2. Platform full-name from directory services
  if (platform === 'macos') {
    try {
      const fullName = execFileSync('id', ['-F', user], {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!reject(fullName)) return fullName;
    } catch {
      // id -F not supported
    }
  } else if (platform === 'linux') {
    try {
      const entry = execFileSync('getent', ['passwd', user], {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const gecos = entry.split(':')[4];
      if (gecos) {
        const fullName = gecos.split(',')[0].trim();
        if (!reject(fullName)) return fullName;
      }
    } catch {
      // getent missing
    }
  }

  // 3. $USER / whoami fallback
  if (!reject(user)) return user;
  return 'User';
}

function probeTimezone(): {
  status: 'configured' | 'autodetected' | 'utc_suspicious' | 'needs_input';
  envTz: string;
  systemTz: string;
} {
  const envTz = readEnvVar('TZ');
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

  let status: 'configured' | 'autodetected' | 'utc_suspicious' | 'needs_input';
  if (envTz && isValidTimezone(envTz)) {
    status = 'configured';
  } else if (systemTz === 'UTC' || systemTz === 'Etc/UTC') {
    status = 'utc_suspicious';
  } else if (systemTz && isValidTimezone(systemTz)) {
    status = 'autodetected';
  } else {
    status = 'needs_input';
  }

  return {
    status,
    envTz: envTz || 'none',
    systemTz: systemTz || 'unknown',
  };
}

export async function run(_args: string[]): Promise<void> {
  const started = Date.now();

  // Resolve OS (with WSL distinguished)
  const platform = getPlatform();
  const wsl = isWSL();
  const osLabel: 'macos' | 'linux' | 'wsl' | 'unknown' =
    wsl ? 'wsl' : platform === 'macos' ? 'macos' : platform === 'linux' ? 'linux' : 'unknown';
  const shell = process.env.SHELL || 'unknown';

  // Sync probes (child_process is blocking; parallelizing provides little gain
  // and complicates error handling).
  const docker = probeDocker();
  const oneCliUrl = probeOnecliUrl();
  const serviceStatus = probeServiceStatus();
  const cliAgentWired = probeCliAgentWired();
  const displayName = probeInferredDisplayName();
  const tz = probeTimezone();

  // Async: health check is the only non-blocking probe.
  const onecliStatus = await probeOnecliStatus(oneCliUrl);

  // Secret check uses the CLI client and works whenever onecli is installed,
  // even if our direct HTTP health probe failed (different network paths).
  const anthropicSecret = onecliStatus !== 'not_found' ? probeAnthropicSecret() : false;

  const elapsedMs = Date.now() - started;
  log.info('probe complete', { elapsedMs });

  emitStatus('PROBE', {
    OS: osLabel,
    SHELL: shell,
    DOCKER: docker.status,
    IMAGE_PRESENT: docker.imagePresent,
    ONECLI_STATUS: onecliStatus,
    ONECLI_URL: oneCliUrl || 'none',
    ANTHROPIC_SECRET: anthropicSecret,
    SERVICE_STATUS: serviceStatus,
    CLI_AGENT_WIRED: cliAgentWired,
    INFERRED_DISPLAY_NAME: displayName,
    TZ_STATUS: tz.status,
    TZ_ENV: tz.envTz,
    TZ_SYSTEM: tz.systemTz,
    ELAPSED_MS: elapsedMs,
    STATUS: 'success',
  });
}
