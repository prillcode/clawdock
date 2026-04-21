/**
 * Non-interactive setup driver. Chains the deterministic setup steps so a
 * scripted install can go from a fresh checkout to a running service without
 * the `/setup` skill.
 *
 * Prerequisite: `bash setup.sh` has run (Node >= 20, pnpm install, native
 * module check). This driver picks up from there.
 *
 * Config via env:
 *   NANOCLAW_TZ    IANA zone override (skip autodetect)
 *   NANOCLAW_SKIP  comma-separated step names to skip
 *                  (environment|timezone|container|mounts|service|verify)
 *
 * Credential setup (OneCLI + channel auth + `/manage-channels`) is *not*
 * scripted — those require interactive platform flows and are handled by
 * `/setup`, `/add-<channel>`, and `/manage-channels` afterwards.
 */
import { spawn } from 'child_process';

type Fields = Record<string, string>;
type StepResult = { ok: boolean; fields: Fields; exitCode: number };

function parseStatus(stdout: string): Fields {
  const out: Fields = {};
  let inBlock = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('=== NANOCLAW SETUP:')) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('=== END ===')) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function runStep(name: string, extra: string[] = []): Promise<StepResult> {
  return new Promise((resolve) => {
    console.log(`\n── ${name} ────────────────────────────────────`);
    const args = ['exec', 'tsx', 'setup/index.ts', '--step', name];
    if (extra.length > 0) args.push('--', ...extra);

    const child = spawn('pnpm', args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      buf += s;
      process.stdout.write(s);
    });
    child.on('close', (code) => {
      const fields = parseStatus(buf);
      resolve({
        ok: code === 0 && fields.STATUS === 'success',
        fields,
        exitCode: code ?? 1,
      });
    });
  });
}

function fail(msg: string, hint?: string): never {
  console.error(`\n[setup:auto] ${msg}`);
  if (hint) console.error(`            ${hint}`);
  console.error('            Logs: logs/setup.log');
  process.exit(1);
}

async function main(): Promise<void> {
  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const tz = process.env.NANOCLAW_TZ;

  if (!skip.has('environment')) {
    const env = await runStep('environment');
    if (!env.ok) fail('environment check failed');
  }

  if (!skip.has('timezone')) {
    const res = await runStep('timezone', tz ? ['--tz', tz] : []);
    if (res.fields.NEEDS_USER_INPUT === 'true') {
      fail(
        'Timezone could not be autodetected.',
        'Set NANOCLAW_TZ to an IANA zone (e.g. NANOCLAW_TZ=America/New_York).',
      );
    }
    if (!res.ok) fail('timezone step failed');
  }

  if (!skip.has('container')) {
    const res = await runStep('container');
    if (!res.ok) {
      if (res.fields.ERROR === 'runtime_not_available') {
        fail(
          'Docker is not available and could not be started automatically.',
          'Install Docker Desktop or start it manually, then retry.',
        );
      }
      fail(
        'container build/test failed',
        'For stale build cache: `docker builder prune -f`, then retry `pnpm run setup:auto`.',
      );
    }
  }

  if (!skip.has('mounts')) {
    const res = await runStep('mounts', ['--empty']);
    if (!res.ok && res.fields.STATUS !== 'skipped') {
      fail('mount allowlist step failed');
    }
  }

  if (!skip.has('service')) {
    const res = await runStep('service');
    if (!res.ok) {
      fail(
        'service install failed',
        'Check logs/nanoclaw.error.log, or run `/setup` to iterate interactively.',
      );
    }
    if (res.fields.DOCKER_GROUP_STALE === 'true') {
      console.warn(
        '\n[setup:auto] Docker group stale in systemd session. Run:\n' +
          '             sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
          '             systemctl --user restart nanoclaw',
      );
    }
  }

  if (!skip.has('verify')) {
    const res = await runStep('verify');
    if (!res.ok) {
      console.log('\n[setup:auto] Scripted steps done. Remaining (interactive):');
      if (res.fields.CREDENTIALS !== 'configured') {
        console.log('  • OneCLI + Anthropic secret — see `/setup` §4 or https://onecli.sh');
      }
      if (!res.fields.CONFIGURED_CHANNELS) {
        console.log('  • Install a channel: `/add-discord`, `/add-slack`, `/add-telegram`, …');
      }
      if (res.fields.REGISTERED_GROUPS === '0') {
        console.log('  • Wire the channel to an agent group: `/manage-channels`');
      }
      return;
    }
  }

  console.log('\n[setup:auto] Complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
