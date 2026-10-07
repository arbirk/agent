import test from 'node:test';
import assert from 'node:assert';
import { MockChatApiServer } from '../src/mock-chat-api.js';
import { RestChatApiAdapter, enforceSeparate4kMessages, LlmClient } from '../src/llm.js';

test('enforceSeparate4kMessages keeps harness, AGENTS.md, and loop messages separate and capped at 4000 tokens', () => {
  const giantHarness = 'Harness instructions '.repeat(2000); // ~11,000 tokens
  const giantAgentsMd = 'AGENTS memory '.repeat(2000); // ~7,700 tokens
  const giantUserTurn = 'User turn '.repeat(2000); // ~5,500 tokens

  const inputMessages = [
    { role: 'system', content: giantHarness },
    { role: 'system', content: giantAgentsMd },
    { role: 'user', content: giantUserTurn },
  ];

  const separated = enforceSeparate4kMessages(inputMessages, 4000);

  // Must not collapse consecutive system messages into 1
  assert.strictEqual(separated.length, 3);
  assert.strictEqual(separated[0].role, 'system');
  assert.strictEqual(separated[1].role, 'system');
  assert.strictEqual(separated[2].role, 'user');

  // Each individual message must be capped to <= 4000 tokens (~14000 chars)
  for (let i = 0; i < separated.length; i++) {
    assert.ok(separated[i].content.length <= 4000 * 3.6);
  }
});

test('MockChatApiServer handles /chat/message, /chat/messages, and /chat/generate', async () => {
  const server = new MockChatApiServer(0, (messages, temp) => {
    return 'Mock response from generator';
  });

  const port = await server.start();
  const baseUrl = `http://localhost:${port}`;
  const adapter = new RestChatApiAdapter(baseUrl);

  try {
    // 1. Post initial messages (Harness, AGENTS.md, Loop message)
    const messages = [
      { role: 'system', content: 'Base harness instructions' },
      { role: 'system', content: 'Project memory from AGENTS.md' },
      { role: 'user', content: 'Task: build index.html' },
    ];

    await adapter.postMessages(messages);

    // 2. Verify messages with GET /chat/messages
    const retrieved = await adapter.getMessages();
    assert.strictEqual(retrieved.length, 3);
    assert.strictEqual(retrieved[0].content, 'Base harness instructions');
    assert.strictEqual(retrieved[1].content, 'Project memory from AGENTS.md');
    assert.strictEqual(retrieved[2].content, 'Task: build index.html');

    // 3. Trigger generation with POST /chat/generate
    const generated = await adapter.generate(0.2);
    assert.strictEqual(generated, 'Mock response from generator');

    // 4. Verify that generated response was appended as assistant message
    const afterGen = await adapter.getMessages();
    assert.strictEqual(afterGen.length, 4);
    assert.strictEqual(afterGen[3].role, 'assistant');
    assert.strictEqual(afterGen[3].content, 'Mock response from generator');
  } finally {
    await server.stop();
  }
});

test('LlmClient works seamlessly with RestChatApiAdapter', async () => {
  const server = new MockChatApiServer(0, (messages) => {
    return 'Action: ```bash\nGet-ChildItem\n```';
  });

  const port = await server.start();
  const baseUrl = `http://localhost:${port}`;
  const adapter = new RestChatApiAdapter(baseUrl);

  const dummyConfig = {
    baseUrl,
    apiKey: 'none',
    model: 'mock-model',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: process.cwd(),
    defaultShell: 'powershell',
    timeoutMs: 5000,
  };

  const client = new LlmClient(dummyConfig, adapter);

  try {
    const messages = [
      { role: 'system', content: 'Harness prompt' },
      { role: 'system', content: 'AGENTS.md notes' },
      { role: 'user', content: 'Execute task' },
    ];

    const result = await client.complete(messages);
    assert.ok(result.includes('Get-ChildItem'));

    const serverMsgs = server.getMessages();
    assert.strictEqual(serverMsgs.length, 4);
    assert.strictEqual(serverMsgs[0].content, 'Harness prompt');
    assert.strictEqual(serverMsgs[1].content, 'AGENTS.md notes');
    assert.strictEqual(serverMsgs[2].content, 'Execute task');
    assert.strictEqual(serverMsgs[3].role, 'assistant');
  } finally {
    await server.stop();
  }
});

test('authHeaders leaves out Authorization header when bearer token is empty or omitted', async () => {
  const { authHeaders } = await import('../src/llm.js');
  assert.deepStrictEqual(authHeaders({ apiKey: '' }), {});
  assert.deepStrictEqual(authHeaders({ apiKey: '   ' }), {});
  assert.deepStrictEqual(authHeaders({ apiKey: null }), {});
  assert.deepStrictEqual(authHeaders({ apiKey: undefined }), {});
  assert.deepStrictEqual(authHeaders({ apiKey: 'none' }), {});

  // When token is provided, formats as expected
  assert.deepStrictEqual(authHeaders({ apiKey: 'my-token' }), { Authorization: 'Bearer my-token' });
  assert.deepStrictEqual(authHeaders({ apiKey: 'Bearer existing' }), { Authorization: 'Bearer existing' });
  assert.deepStrictEqual(authHeaders({ apiKey: 'azure-key', authHeader: 'api-key' }), { 'api-key': 'azure-key' });
});

