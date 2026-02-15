/**
 * Session management for context tracking and warnings
 */
import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';

// Approximate context window sizes for different models
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  opus: 200000,
  sonnet: 200000,
  haiku: 200000,
  'claude-opus-4-20250514': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-sonnet-3-7-20241029': 200000,
  'claude-haiku-3-5-20241022': 200000,
};

const DEFAULT_CONTEXT_WINDOW = 200000;
const WARNING_THRESHOLD = 0.8; // 80%
const AUTO_RESET_THRESHOLD = 1.0; // 100%

export interface SessionMetrics {
  estimatedTokens: number;
  contextWindow: number;
  percentageUsed: number;
  shouldWarn: boolean;
  shouldAutoReset: boolean;
}

/**
 * Estimate token count from message content
 * Rough approximation: 1 token ≈ 4 characters
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Get context window size for a model
 */
function getContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return MODEL_CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW;
}

/**
 * Calculate session metrics from conversation history
 */
export function calculateSessionMetrics(
  conversationHistory: string[],
  model?: string,
): SessionMetrics {
  const estimatedTokens = conversationHistory.reduce(
    (sum, msg) => sum + estimateTokens(msg),
    0,
  );
  const contextWindow = getContextWindow(model);
  const percentageUsed = estimatedTokens / contextWindow;
  const shouldWarn =
    percentageUsed >= WARNING_THRESHOLD &&
    percentageUsed < AUTO_RESET_THRESHOLD;
  const shouldAutoReset = percentageUsed >= AUTO_RESET_THRESHOLD;

  logger.debug(
    {
      estimatedTokens,
      contextWindow,
      percentageUsed: (percentageUsed * 100).toFixed(1) + '%',
      shouldWarn,
      shouldAutoReset,
    },
    'Session metrics calculated',
  );

  return {
    estimatedTokens,
    contextWindow,
    percentageUsed,
    shouldWarn,
    shouldAutoReset,
  };
}

/**
 * Generate warning message for high context usage
 */
export function generateContextWarning(metrics: SessionMetrics): string {
  const percentage = (metrics.percentageUsed * 100).toFixed(0);
  return `⚠️ This chat session is getting long (${metrics.estimatedTokens.toLocaleString()} tokens, ${percentage}% of context window).

Start a new session anytime by telling ${ASSISTANT_NAME}:
• "Start a new session with context summary of current session" (recommended - preserves continuity)
• "Start a new session completely fresh" (best for new work)`;
}

/**
 * Generate automatic reset notification
 */
export function generateAutoResetMessage(): string {
  return `🔄 **Automatic Session Reset**

This chat session reached 100% of the context window. I've automatically started a new session with a summary of our previous discussion saved to session-summary.md.

You can reference the full archive at: /workspace/group/conversations/archive/ if needed.`;
}
