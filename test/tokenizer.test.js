import test from 'node:test';
import assert from 'node:assert';
import {
  estimateTokens,
  estimateMessagesTokens,
  exceedsTurnBudget,
  shouldCompressAggressively,
  truncateToTokens,
  exceedsTotalBudget,
} from '../src/tokenizer.js';

test('estimateTokens calculates reasonable token approximations', () => {
  const shortText = 'Hello world, this is a test.';
  const tokens = estimateTokens(shortText);
  assert.ok(tokens > 5 && tokens < 15);

  const longText = 'a'.repeat(3600);
  assert.strictEqual(estimateTokens(longText), 1000);
});

test('exceedsTurnBudget detects 4000 token limit', () => {
  const smallMessages = [
    { role: 'user', content: 'Do something' },
    { role: 'assistant', content: 'Sure, here is the answer' },
  ];
  assert.strictEqual(exceedsTurnBudget(smallMessages, 4000), false);

  // Large message > 4000 tokens (e.g. 15,000 characters)
  const hugeMessages = [
    { role: 'user', content: 'x'.repeat(16000) },
  ];
  assert.strictEqual(exceedsTurnBudget(hugeMessages, 4000), true);
});

test('exceedsTotalBudget detects 32000 total context limit', () => {
  const systemPrompt = 'System prompt';
  const mediumMessages = [
    { role: 'user', content: 'x'.repeat(20000) },
  ];
  assert.strictEqual(exceedsTotalBudget(systemPrompt, mediumMessages, 32000), false);

  const hugeContext = [
    { role: 'user', content: 'x'.repeat(120000) },
  ];
  assert.strictEqual(exceedsTotalBudget(systemPrompt, hugeContext, 32000), true);
});

test('shouldCompressAggressively triggers on high token density or long loop turns', () => {
  const smallMessages = [
    { role: 'user', content: 'hello' },
  ];

  // Turn 1, small tokens -> false
  assert.strictEqual(shouldCompressAggressively(smallMessages, 4000, 1, 1), false);

  // Small history (< 16 messages) -> false
  assert.strictEqual(shouldCompressAggressively(smallMessages, 4000, 4, 4), false);

  // Long history but small tokens (< 2000 tokens) -> false (preserves context!)
  assert.strictEqual(shouldCompressAggressively(smallMessages, 4000, 8, 16), false);

  // Long history AND heavy tokens (>= 2000 tokens) -> true
  const mediumMessages = [
    { role: 'user', content: 'x'.repeat(8000) },
  ];
  assert.strictEqual(shouldCompressAggressively(mediumMessages, 4000, 8, 16), true);

  // Heavy tokens (>= 3400 tokens = ~12500+ chars) -> true regardless of message count
  const heavyMessages = [
    { role: 'user', content: 'x'.repeat(13000) },
  ];
  assert.strictEqual(shouldCompressAggressively(heavyMessages, 4000, 2, 2), true);
});

test('truncateToTokens cleanly cuts off text within budget', () => {
  const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
  const truncated = truncateToTokens(text, 5); // 5 tokens = ~17.5 chars
  assert.ok(truncated.length <= 25);
  assert.ok(truncated.includes('Line 1'));
});
