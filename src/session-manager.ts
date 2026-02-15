/**
 * Session management for context tracking and warnings
 */
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

export interface SessionMetrics {
  estimatedTokens: number;
  contextWindow: number;
  percentageUsed: number;
  shouldWarn: boolean;
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
  const shouldWarn = percentageUsed >= WARNING_THRESHOLD;

  logger.debug(
    {
      estimatedTokens,
      contextWindow,
      percentageUsed: (percentageUsed * 100).toFixed(1) + '%',
      shouldWarn,
    },
    'Session metrics calculated',
  );

  return {
    estimatedTokens,
    contextWindow,
    percentageUsed,
    shouldWarn,
  };
}

/**
 * Generate warning message for high context usage
 */
export function generateContextWarning(metrics: SessionMetrics): string {
  const percentage = (metrics.percentageUsed * 100).toFixed(0);
  return `⚠️ This chat session is getting long (${metrics.estimatedTokens.toLocaleString()} tokens, ${percentage}% of context window).
Consider starting a new chat session to keep responses fast and reduce costs.

To start fresh, say: "start a new chat session"`;
}
