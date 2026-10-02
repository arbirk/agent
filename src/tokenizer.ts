import { ChatMessage } from './types.js';

/**
 * Fast and accurate token estimation for code and chat prompts.
 * Averages ~3.6 - 3.8 characters per token for typical code + markdown.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Code and structured text tend to have higher token density (~3.5 chars per token)
  // than plain english prose (~4 chars per token).
  return Math.ceil(text.length / 3.6);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // 4 tokens overhead per message (role + framing tokens)
    total += 4 + estimateTokens(msg.content);
  }
  return total;
}

/**
 * Checks if the current task context messages exceed the allowed single-turn / task-loop token limit (default: 4000).
 * Isolates the active context so base instructions (Message 1) and AGENTS.md (Message 2) don't consume the task's budget.
 */
export function exceedsTurnBudget(
  taskMessages: ChatMessage[],
  maxTurnTokens: number = 4000,
  safetyMargin: number = 500
): boolean {
  const currentTokens = estimateMessagesTokens(taskMessages);
  return currentTokens >= maxTurnTokens - safetyMargin;
}

/**
 * Checks if aggressive compression should be triggered on long loops or high token usage in current task context.
 * Compresses when task context reaches ~3400 tokens of 4000, or after 16+ messages with >2000 tokens.
 */
export function shouldCompressAggressively(
  taskMessages: ChatMessage[],
  maxTurnTokens: number = 4000,
  turn: number = 1,
  historyLength: number = 1
): boolean {
  const currentTokens = estimateMessagesTokens(taskMessages);

  // 1. Task context token threshold: compress when task history reaches near the budget limit
  // (e.g. 3,400 of 4,000, leaving 600 tokens of generation headroom in the task context)
  if (currentTokens >= maxTurnTokens - 600) {
    return true;
  }

  // 2. Long loop threshold: compress only when history has accumulated 16 or more messages (8+ full turns)
  // AND has consumed substantial context (at least 2,000 tokens)
  if (historyLength >= 16 && currentTokens >= 2000) {
    return true;
  }

  return false;
}

/**
 * Cleanly truncates a string to fit within a specified token budget.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text) return '';
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline);
  }
  return truncated;
}

/**
 * Checks if overall cumulative context exceeds maximum total context (default: 32000).
 */
export function exceedsTotalBudget(
  systemPrompt: string,
  messages: ChatMessage[],
  maxTotalTokens: number = 32000
): boolean {
  const currentTokens = estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
  return currentTokens >= maxTotalTokens;
}

