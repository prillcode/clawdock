import fs from 'fs';
import path from 'path';

import {
  AGENT_CHANNEL_MODELS,
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_MAX_THINKING_TOKENS,
  AGENT_MODEL,
  ASSISTANT_NAME,
  DATA_DIR,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNELS,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SESSION_MAX_RESUME_TOKENS,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { DiscordChannel } from './channels/discord.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSessionMetrics,
  getSessionSummary,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateSessionMetrics,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  routeOutbound,
} from './router.js';
import {
  checkSessionThresholds,
  estimateTokens,
  generateContextWarning,
} from './session-manager.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let totalResponseTokens = 0; // Phase 1: Track response tokens for incremental metrics

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

      // Phase 1: Accumulate response tokens
      totalResponseTokens += estimateTokens(raw);

      const text = formatOutbound(raw);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Phase 1: Incremental token tracking
  // Update session metrics after successful response
  if (outputSentToUser && channel) {
    try {
      // Estimate tokens for the prompt and response (incremental)
      const promptTokens = estimateTokens(prompt);
      updateSessionMetrics(group.folder, promptTokens + totalResponseTokens, 1);

      // Check thresholds based on stored metrics (no message re-fetch needed)
      const storedMetrics = getSessionMetrics(group.folder);
      const model = group.containerConfig?.model || AGENT_MODEL;
      const thresholds = checkSessionThresholds(storedMetrics, model);

      // Phase 2: Auto-reset at 90% with summary
      if (thresholds.shouldAutoReset) {
        logger.warn(
          {
            group: group.name,
            estimatedTokens: thresholds.estimatedTokens,
          },
          'Context reached 90% - triggering automatic reset with summary',
        );

        // Notify user
        await channel.sendMessage(
          chatJid,
          `⚠️ Session context at 90% — generating summary and starting fresh session...`,
        );

        // Send a message to trigger the agent to generate a summary and reset
        // The agent will use the new_chat_session_with_summary MCP tool
        const summaryRequest = `Please use the new_chat_session_with_summary tool to generate a concise summary of our conversation and start a new session. Include:
- Key accomplishments
- Current state/progress
- Next steps or open questions

Keep the summary brief (2-3 paragraphs max).`;

        await channel.sendMessage(chatJid, summaryRequest);

        logger.info(
          { group: group.name },
          'Automatic session reset requested at 90%',
        );
      } else if (thresholds.shouldWarn) {
        // Send warning at 80%
        const warning = generateContextWarning(thresholds);
        await channel.sendMessage(chatJid, warning);
        logger.info(
          {
            group: group.name,
            estimatedTokens: thresholds.estimatedTokens,
            percentageUsed: (thresholds.percentageUsed * 100).toFixed(1) + '%',
          },
          'Sent context warning to user',
        );
      }
    } catch (error) {
      // Don't fail the entire message processing if context check fails
      logger.warn(
        { error, group: group.name },
        'Failed to update session metrics',
      );
    }
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  let sessionId: string | undefined = sessions[group.folder];

  // Phase 3: Resume guard - skip resume if session is too large
  if (sessionId) {
    const metrics = getSessionMetrics(group.folder);
    if (metrics && metrics.estimated_tokens > SESSION_MAX_RESUME_TOKENS) {
      logger.info(
        {
          group: group.name,
          tokens: metrics.estimated_tokens,
          threshold: SESSION_MAX_RESUME_TOKENS,
        },
        'Session too large to resume efficiently, starting fresh',
      );
      deleteSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
      // Note: The agent will see the session summary (if available) but start
      // with a fresh SDK session to avoid slow resume.
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    // Phase 2: Retrieve session summary if available (will be injected in agent-runner)
    const sessionSummary = getSessionSummary(group.folder);

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        sessionSummary: sessionSummary || undefined,
        groupFolder: group.folder,
        chatJid,
        isMain,
        model: group.containerConfig?.model,
        maxBudgetUsd: group.containerConfig?.maxBudgetUsd,
        maxTurns: group.containerConfig?.maxTurns,
        maxThinkingTokens: group.containerConfig?.maxThinkingTokens,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start channels based on available credentials
  const whatsappAuthExists = fs.existsSync(
    path.join(STORE_DIR, 'auth', 'creds.json'),
  );

  if (whatsappAuthExists) {
    whatsapp = new WhatsAppChannel({
      onMessage: (_chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => registeredGroups,
    });
    channels.push(whatsapp);
    await whatsapp.connect();
    logger.info('WhatsApp channel active');
  }

  if (DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel({
      token: DISCORD_BOT_TOKEN,
      onMessage: (_chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(discord);
    await discord.connect();
    logger.info('Discord channel active');

    // Auto-register Discord channels from DISCORD_CHANNELS config
    for (const ch of DISCORD_CHANNELS) {
      // Resolve model: per-channel override > global default
      const model = AGENT_CHANNEL_MODELS[ch.folder] || AGENT_MODEL;

      const updatedConfig = {
        name: ch.name,
        folder: ch.folder,
        trigger: ch.requiresTrigger ? `@${ASSISTANT_NAME}` : '@mention',
        requiresTrigger: ch.requiresTrigger,
        containerConfig: {
          image: ch.image || 'base',
          model,
          maxBudgetUsd: AGENT_MAX_BUDGET_USD,
          maxTurns: AGENT_MAX_TURNS,
          maxThinkingTokens: AGENT_MAX_THINKING_TOKENS,
        },
      };

      if (!registeredGroups[ch.id]) {
        registerGroup(ch.id, {
          ...updatedConfig,
          added_at: new Date().toISOString(),
        });
      } else {
        // Update existing group configuration (e.g., trigger name change)
        // Merge containerConfig to preserve additionalMounts while updating model/budget/turns
        registeredGroups[ch.id] = {
          ...registeredGroups[ch.id],
          ...updatedConfig,
          containerConfig: {
            ...registeredGroups[ch.id].containerConfig,
            ...updatedConfig.containerConfig,
          },
          added_at: registeredGroups[ch.id].added_at, // Preserve original add date
        };
        setRegisteredGroup(ch.id, registeredGroups[ch.id]);
        logger.info(
          { jid: ch.id, name: ch.name, trigger: updatedConfig.trigger },
          'Discord group configuration updated',
        );
      }
    }
  }

  if (channels.length === 0) {
    logger.error(
      'No channels configured. Set DISCORD_BOT_TOKEN or configure WhatsApp auth.',
    );
    process.exit(1);
  }

  logger.info({ channels: channels.map((c) => c.name) }, 'Active channels');

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => routeOutbound(channels, jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
