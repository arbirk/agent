export function estimateTokens(text) {
  return text ? Math.ceil(text.length / 3.6) : 0;
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((total, m) => total + 4 + estimateTokens(m.content), 0);
}

export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > maxChars * 0.8 ? truncated.slice(0, lastNewline) : truncated;
}

/**
 * Returns a reason string when the task history should be compressed, otherwise null.
 * Hard limit: within 500 tokens of the budget. Soft limits (only after a cooldown):
 * within 600 tokens of the budget, or a long loop (16+ messages over 2000 tokens).
 */
export function compressionReason(messages, maxTokens = 4000, cooledDown = true) {
  const tokens = estimateMessagesTokens(messages);
  if (tokens >= maxTokens - 500) return `task context (~${tokens} tokens) reached the ${maxTokens} limit`;
  if (!cooledDown) return null;
  if (tokens >= maxTokens - 600) return `task context (~${tokens} tokens) is near the ${maxTokens} limit`;
  if (messages.length >= 16 && tokens >= 2000) return `long loop (${messages.length} messages, ~${tokens} tokens)`;
  return null;
}

export function exceedsTurnBudget(messages, maxTokens = 4000) {
  return estimateMessagesTokens(messages) > maxTokens;
}

export function exceedsTotalBudget(systemPrompt, messages, maxTotalTokens = 32000) {
  const total = estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
  return total > maxTotalTokens;
}

export function shouldCompressAggressively(messages, maxTurnTokens = 4000, turn = 1, historyLength = 1) {
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens >= maxTurnTokens - 600) return true;
  if (historyLength >= 16 && currentTokens >= 2000) return true;
  return false;
}


