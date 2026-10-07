import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectMemory, pruneMemoryLog } from '../src/memory.js';
import { estimateTokens } from '../src/tokenizer.js';

const TEST_DIR = path.resolve(process.cwd(), 'temp_test_memory');

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

test('ProjectMemory loads null when AGENTS.md does not exist', () => {
  const memory = new ProjectMemory(TEST_DIR);
  assert.strictEqual(memory.load(), null);
});

test('ProjectMemory loads existing AGENTS.md content from agent/ folder', () => {
  const memory = new ProjectMemory(TEST_DIR);
  const agentDir = path.join(TEST_DIR, 'agent');
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  const sampleContent = '# Project Overview\nTest project.\n\n## Change Log\n### [2026-01-01] Initial setup\n- Done';
  fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), sampleContent, 'utf-8');

  const loaded = memory.load();
  assert.strictEqual(loaded, sampleContent);
});

test('ProjectMemory migrates legacy root AGENTS.md to agent/AGENTS.md', () => {
  const memory = new ProjectMemory(TEST_DIR);
  const rootFile = path.join(TEST_DIR, 'AGENTS.md');
  const agentFile = path.join(TEST_DIR, 'agent', 'AGENTS.md');
  
  if (fs.existsSync(agentFile)) {
    fs.unlinkSync(agentFile);
  }

  const legacyContent = '# Legacy Overview\nTest legacy root file.';
  fs.writeFileSync(rootFile, legacyContent, 'utf-8');

  const loaded = memory.load();
  assert.strictEqual(loaded, legacyContent);
  assert.strictEqual(fs.existsSync(agentFile), true);
  assert.strictEqual(fs.existsSync(rootFile), false);
});

test('pruneMemoryLog preserves overview and prunes oldest entries when exceeding budget', () => {
  const overview = '# Project Overview\nTest project.\n\n## Working Patterns\n- Pattern A\n\n## Change Log\n';
  const entryNew = '### [2026-03-01] Newest Task\n- Request: New task\n- Solution: Done\n\n';
  // Create an old entry that is artificially large
  const largeOldEntry = '### [2026-01-01] Old Big Task\n' + 'x'.repeat(16000) + '\n\n';

  const fullDoc = overview + entryNew + largeOldEntry;
  assert.ok(estimateTokens(fullDoc) > 4000);

  const pruned = pruneMemoryLog(fullDoc, 4000);
  assert.ok(estimateTokens(pruned) <= 4000);
  assert.ok(pruned.includes('# Project Overview'));
  assert.ok(pruned.includes('Newest Task'));
  assert.ok(!pruned.includes('Old Big Task'));
});
