import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { LlmClient } from '../src/llm-client.js';

const TEST_DIR = path.resolve(process.cwd(), 'temp_test_debug');

test.before(() => {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
});

test.after(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

test('LlmClient logs debug events to JSONL file when debug is enabled', () => {
  const debugFile = path.join(TEST_DIR, 'openrouter-debug.jsonl');
  const client = new LlmClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    model: 'openai/gpt-4o',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 5000,
    debug: true,
    debugLogPath: debugFile,
  });

  // Log sample debug events
  client.logDebug({ event: 'request', model: 'openai/gpt-4o', test: true });
  client.logDebug({ event: 'stream_chunk', chunk: { id: 'chunk-1', delta: 'hello' } });
  client.logDebug({ event: 'response_complete', content: 'hello' });

  assert.strictEqual(fs.existsSync(debugFile), true);
  const content = fs.readFileSync(debugFile, 'utf-8').trim();
  const lines = content.split('\n');

  assert.strictEqual(lines.length, 3);

  const parsed1 = JSON.parse(lines[0]);
  assert.strictEqual(parsed1.event, 'request');
  assert.strictEqual(parsed1.model, 'openai/gpt-4o');
  assert.ok(parsed1.timestamp);

  const parsed2 = JSON.parse(lines[1]);
  assert.strictEqual(parsed2.event, 'stream_chunk');
  assert.strictEqual(parsed2.chunk.id, 'chunk-1');

  const parsed3 = JSON.parse(lines[2]);
  assert.strictEqual(parsed3.event, 'response_complete');
  assert.strictEqual(parsed3.content, 'hello');
});

test('LlmClient defaults debugLogPath to agent/openrouter-debug.jsonl when not specified', () => {
  const client = new LlmClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    model: 'openai/gpt-4o',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 5000,
    debug: true,
  });

  client.logDebug({ event: 'default_path_test', status: 'ok' });
  const defaultFile = path.join(TEST_DIR, 'agent', 'openrouter-debug.jsonl');
  assert.strictEqual(fs.existsSync(defaultFile), true);
  const content = fs.readFileSync(defaultFile, 'utf-8').trim();
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.event, 'default_path_test');
});

