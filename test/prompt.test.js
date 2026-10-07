import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaceEntries, getSystemPrompt } from '../src/prompt.js';
import { PiHarness } from '../src/harness.js';

const TEST_DIR = path.resolve(process.cwd(), 'temp_test_prompt');

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

test('listWorkspaceEntries lists files and folders with sizes and child previews', () => {
  // Setup directory structure
  const subDir = path.join(TEST_DIR, 'agent');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'script.py'), 'print("hello")');
  fs.writeFileSync(path.join(subDir, 'AGENTS.md'), '# Memory');

  fs.writeFileSync(path.join(TEST_DIR, 'index.html'), '<html><body>Hello</body></html>');
  fs.writeFileSync(path.join(TEST_DIR, 'data.txt'), 'Sample data content');

  const listing = listWorkspaceEntries(TEST_DIR);

  // Check folders
  assert.ok(listing.includes('📁 agent/'));
  assert.ok(listing.includes('script.py'));
  assert.ok(listing.includes('AGENTS.md'));

  // Check files and sizes
  assert.ok(listing.includes('📄 index.html'));
  assert.ok(listing.includes('📄 data.txt'));
  assert.ok(listing.includes('B') || listing.includes('KB'));
});

test('listWorkspaceEntries handles empty directory', () => {
  const emptyDir = path.join(TEST_DIR, 'empty_sub');
  fs.mkdirSync(emptyDir, { recursive: true });

  const listing = listWorkspaceEntries(emptyDir);
  assert.ok(listing.includes('empty'));

  fs.rmdirSync(emptyDir);
});

test('getSystemPrompt embeds workspace inventory and core operating principles', () => {
  const prompt = getSystemPrompt(TEST_DIR, 'powershell');

  // Verify inventory is in the prompt
  assert.ok(prompt.includes('## Workspace Overview:'));
  assert.ok(prompt.includes('index.html'));
  assert.ok(prompt.includes('agent/'));

  // Verify core operating principles
  assert.ok(prompt.includes('Be Exploratory'));
  assert.ok(prompt.includes('Manage Context Length'));
  assert.ok(prompt.includes('Extract Patterns & Apply with Scripts'));
  assert.ok(prompt.includes('Use Types & Linting to Ensure Quality'));
  assert.ok(prompt.includes('Establish Clear Goals, Tasklist & Confirm Results'));
});

test('PiHarness write warns when overwriting an existing file', async () => {
  const harness = new PiHarness(TEST_DIR);
  const targetFile = 'overwrite_test.html';

  // 1. Initial write
  const res1 = await harness.write(targetFile, '<h1>Original Content</h1>');
  assert.strictEqual(res1.success, true);
  assert.ok(!res1.output.includes('Overwrote existing file'));

  // 2. Overwrite
  const res2 = await harness.write(targetFile, '<h1>New Content</h1>');
  assert.strictEqual(res2.success, true);
  assert.ok(res2.output.includes('Notice: Overwrote existing file'));
  assert.ok(res2.output.includes('Verify you preserved all necessary existing layout and styles'));
});
