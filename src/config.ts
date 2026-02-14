import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Discord configuration
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

/** Parsed Discord channel entry from DISCORD_CHANNELS env var */
export interface DiscordChannelConfig {
  id: string;
  name: string;
  folder: string;
  requiresTrigger: boolean;
}

/**
 * Parse DISCORD_CHANNELS env var.
 * Format: id:name:folder[:noTrigger]  (comma-separated)
 * Falls back to legacy DISCORD_ADMIN_CHANNEL_ID if DISCORD_CHANNELS is not set.
 */
export function parseDiscordChannels(): DiscordChannelConfig[] {
  const raw = process.env.DISCORD_CHANNELS || '';
  if (raw.trim()) {
    return raw.split(',').map((entry) => {
      const parts = entry.trim().split(':');
      if (parts.length < 3) {
        throw new Error(
          `Invalid DISCORD_CHANNELS entry "${entry}". Expected id:name:folder[:noTrigger]`,
        );
      }
      return {
        id: parts[0],
        name: parts[1],
        folder: parts[2],
        requiresTrigger: parts[3] !== 'noTrigger',
      };
    });
  }

  // Legacy fallback: single admin channel
  const legacyId = process.env.DISCORD_ADMIN_CHANNEL_ID || '';
  if (legacyId) {
    return [
      {
        id: legacyId,
        name: 'Discord Admin',
        folder: MAIN_GROUP_FOLDER,
        requiresTrigger: false,
      },
    ];
  }

  return [];
}

export const DISCORD_CHANNELS = parseDiscordChannels();

// Agent configuration (Claude Agent SDK query options)
export const AGENT_MODEL = process.env.AGENT_MODEL || undefined;
export const AGENT_MAX_BUDGET_USD = process.env.AGENT_MAX_BUDGET_USD
  ? parseFloat(process.env.AGENT_MAX_BUDGET_USD)
  : undefined;
export const AGENT_MAX_TURNS = process.env.AGENT_MAX_TURNS
  ? parseInt(process.env.AGENT_MAX_TURNS, 10)
  : undefined;
export const AGENT_MAX_THINKING_TOKENS = process.env.AGENT_MAX_THINKING_TOKENS
  ? parseInt(process.env.AGENT_MAX_THINKING_TOKENS, 10)
  : undefined;

/**
 * Parse AGENT_CHANNEL_MODELS env var.
 * Format: folder:model,folder:model  (comma-separated)
 * Returns a map of folder name to model ID.
 */
export function parseChannelModelOverrides(): Record<string, string> {
  const raw = process.env.AGENT_CHANNEL_MODELS || '';
  const result: Record<string, string> = {};

  if (raw.trim()) {
    raw.split(',').forEach((entry) => {
      const [folder, model] = entry.trim().split(':');
      if (folder && model) {
        result[folder] = model;
      }
    });
  }

  return result;
}

export const AGENT_CHANNEL_MODELS = parseChannelModelOverrides();

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
