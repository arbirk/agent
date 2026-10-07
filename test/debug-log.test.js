import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { LlmClient } from '../src/llm.js';

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
  const debugFile = path.join(TEST_DIR, 'llm-debug.jsonl');
  const client = new LlmClient({
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'test-key',
    model: 'mock-model',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 5000,
    debug: true,
    debugLogPath: debugFile,
  });

  // Log sample debug events
  client.logDebug({ event: 'request', model: 'mock-model', test: true });
  client.logDebug({ event: 'stream_chunk', chunk: { id: 'chunk-1', delta: 'hello' } });
  client.logDebug({ event: 'response_complete', content: 'hello' });

  assert.strictEqual(fs.existsSync(debugFile), true);
  const content = fs.readFileSync(debugFile, 'utf-8').trim();
  const lines = content.split('\n');

  assert.strictEqual(lines.length, 3);

  const parsed1 = JSON.parse(lines[0]);
  assert.strictEqual(parsed1.event, 'request');
  assert.strictEqual(parsed1.model, 'mock-model');
  assert.ok(parsed1.timestamp);

  const parsed2 = JSON.parse(lines[1]);
  assert.strictEqual(parsed2.event, 'stream_chunk');
  assert.strictEqual(parsed2.chunk.id, 'chunk-1');

  const parsed3 = JSON.parse(lines[2]);
  assert.strictEqual(parsed3.event, 'response_complete');
  assert.strictEqual(parsed3.content, 'hello');
});

test('LlmClient defaults debugLogPath to agent/llm-debug.jsonl when not specified', () => {
  const client = new LlmClient({
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'test-key',
    model: 'mock-model',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 5000,
    debug: true,
  });

  client.logDebug({ event: 'default_path_test', status: 'ok' });
  const defaultFile = path.join(TEST_DIR, 'agent', 'llm-debug.jsonl');
  assert.strictEqual(fs.existsSync(defaultFile), true);
  const content = fs.readFileSync(defaultFile, 'utf-8').trim();
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.event, 'default_path_test');
});

test('LlmClient records rich error details, network causes, and hints on failed request', async () => {
  const failureDebugFile = path.join(TEST_DIR, 'failure-debug.jsonl');
  const client = new LlmClient({
    baseUrl: 'http://127.0.0.1:59999/v1',
    apiKey: 'sk-test-secret-123456789',
    model: 'gpt-4o',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 1000,
    retryDelayMs: 50,
    debug: true,
    debugLogPath: failureDebugFile,
  });

  try {
    await client.complete([{ role: 'user', content: 'hello failing test' }]);
    assert.fail('Should have thrown network error');
  } catch (err) {
    assert.ok(err.message.includes('59999'));
    assert.ok(err.troubleshootingHint);
  }

  assert.strictEqual(fs.existsSync(failureDebugFile), true);
  const lines = fs.readFileSync(failureDebugFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

  // Request entry
  const req = lines.find((l) => l.event === 'request');
  assert.ok(req);
  assert.strictEqual(req.endpoint, 'http://127.0.0.1:59999/v1/chat/completions');
  assert.strictEqual(req.auth_status, 'provided');
  assert.ok(req.headers.Authorization.includes('...')); // Redacted/masked
  assert.ok(req.env_diagnostics.node_version);
  assert.ok(req.test_commands.curl);

  // Error entry
  const errEntry = lines.find((l) => l.event === 'error');
  assert.ok(errEntry);
  assert.strictEqual(errEntry.endpoint, 'http://127.0.0.1:59999/v1/chat/completions');
  assert.ok(errEntry.duration_ms >= 0);
  assert.strictEqual(errEntry.error_category, 'CONNECTION_REFUSED');
  assert.ok(errEntry.troubleshooting_hint.includes('refused') || errEntry.troubleshooting_hint.includes('59999'));
  assert.ok(errEntry.message.includes('59999'));
  assert.ok(Array.isArray(errEntry.troubleshooting_checklist));
  assert.ok(errEntry.troubleshooting_checklist.length > 0);
  assert.ok(errEntry.diagnostic_commands.powershell);
  assert.ok(errEntry.network_cause);
});

test('LlmClient diagnoses placeholder / unresolvable endpoint with ENOTFOUND and checklist', async () => {
  const dnsFailureDebugFile = path.join(TEST_DIR, 'dns-failure-debug.jsonl');
  const client = new LlmClient({
    baseUrl: 'https://your-llm-service.internal/v1',
    apiKey: '',
    model: 'gpt-4o',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: TEST_DIR,
    defaultShell: 'powershell',
    timeoutMs: 1000,
    retryDelayMs: 50,
    debug: true,
    debugLogPath: dnsFailureDebugFile,
  });

  try {
    await client.complete([{ role: 'user', content: 'test placeholder fail' }]);
    assert.fail('Should have failed DNS resolution');
  } catch (err) {
    assert.ok(err.troubleshootingHint.includes('your-llm-service.internal'));
    assert.ok(err.troubleshootingChecklist.length >= 2);
  }

  assert.strictEqual(fs.existsSync(dnsFailureDebugFile), true);
  const lines = fs.readFileSync(dnsFailureDebugFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

  const req = lines.find((l) => l.event === 'request');
  assert.ok(req);
  assert.strictEqual(req.auth_status, 'omitted');
  assert.strictEqual(req.url_details.isPlaceholder, true);
  assert.ok(req.warning.includes('your-llm-service.internal'));

  const errEntry = lines.find((l) => l.event === 'error');
  assert.ok(errEntry);
  assert.ok(errEntry.error_code === 'ENOTFOUND' || errEntry.error_category === 'DNS_RESOLUTION_FAILURE');
  assert.ok(errEntry.troubleshooting_hint.includes('your-llm-service.internal'));
  assert.ok(errEntry.diagnostic_commands.powershell);
});

