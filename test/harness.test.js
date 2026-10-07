import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, PiHarness } from '../src/harness.js';
import { extractAndSaveTemplate } from '../src/agent-loop.js';

const TEST_DIR = path.resolve(process.cwd(), 'temp_test_harness');

test.before(() => {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
});

test.after(async () => {
  if (fs.existsSync(TEST_DIR)) {
    // Small delay to allow any process handles to release
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

test('PiHarness write, read, and edit operations', async () => {
  const harness = new PiHarness(TEST_DIR);
  const testFile = 'sample.txt';

  // 1. Write file
  const writeRes = await harness.write(testFile, 'line 1\nline 2: target\nline 3');
  assert.strictEqual(writeRes.success, true);
  assert.strictEqual(fs.existsSync(path.join(TEST_DIR, testFile)), true);

  // 2. Read file
  const readRes = await harness.read(testFile, 1, 2);
  assert.strictEqual(readRes.success, true);
  assert.ok(readRes.output.includes('line 1'));
  assert.ok(readRes.output.includes('line 2: target'));
  assert.ok(!readRes.output.includes('line 3'));

  // 3. Edit file
  const editRes = await harness.edit(testFile, 'line 2: target', 'line 2: updated');
  assert.strictEqual(editRes.success, true);

  const updatedContent = fs.readFileSync(path.join(TEST_DIR, testFile), 'utf-8');
  assert.ok(updatedContent.includes('line 2: updated'));
});

test('PiHarness prevents path traversal outside workspace root', async () => {
  const harness = new PiHarness(TEST_DIR);
  const escapeRes = await harness.read('../outside.txt');
  assert.strictEqual(escapeRes.success, false);
  assert.ok(escapeRes.output.includes('Access denied'));
});

test('PiHarness executes shell commands', async () => {
  const harness = new PiHarness(TEST_DIR, 'powershell');
  const res = await harness.runShell('Write-Output "Harness is active"');
  assert.strictEqual(res.success, true);
  assert.ok(res.output.includes('Harness is active'));
});

test('PiHarness read detects oversized files and returns safe subset with loop instructions', async () => {
  const harness = new PiHarness(TEST_DIR);
  const largeFile = 'large_dataset.txt';
  
  // Generate 200 lines of data
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: Sample data record for entity #${i + 1}`);
  await harness.write(largeFile, lines.join('\n'));

  // Read entire file without line limits
  const res = await harness.read(largeFile);
  assert.strictEqual(res.success, true);
  assert.ok(res.output.includes('TOKEN LIMIT EXCEEDED - OUTPUT TRUNCATED TO SAFE SUBSET'));
  assert.ok(res.output.includes('LOOP INSTRUCTION FOR LARGE FILES / DATASETS'));
  assert.ok(res.output.includes('showing lines 1-50 of 200'));
  assert.ok(res.output.includes('Line 1:'));
  assert.ok(res.output.includes('Line 50:'));
  // Should not contain lines beyond subset
  assert.ok(!res.output.includes('Line 51:'));
  assert.ok(!res.output.includes('Line 199:'));
});

test('PiHarness read allows targeted small subsets without truncation warning', async () => {
  const harness = new PiHarness(TEST_DIR);
  const largeFile = 'large_dataset.txt';

  // Read small subset of 30 lines
  const res = await harness.read(largeFile, 10, 30);
  assert.strictEqual(res.success, true);
  assert.ok(!res.output.includes('TOKEN LIMIT EXCEEDED'));
  assert.ok(res.output.includes('lines 10-30 of 200'));
  assert.ok(res.output.includes('Line 10:'));
  assert.ok(res.output.includes('Line 30:'));
});

test('PiHarness shell truncates oversized output and adds loop instruction', async () => {
  const harness = new PiHarness(TEST_DIR, 'powershell');
  // Generate 150 lines of output via powershell
  const res = await harness.runShell('1..150 | ForEach-Object { "Long output line #$_ with detailed verbose data string" }');
  assert.strictEqual(res.success, true);
  assert.ok(res.output.includes('TOKEN LIMIT EXCEEDED - COMMAND OUTPUT TRUNCATED'));
  assert.ok(res.output.includes('LOOP INSTRUCTION'));
  assert.ok(res.output.includes('DO NOT dump large outputs or entire datasets to stdout'));
});

test('PiHarness supports line-number based edit', async () => {
  const harness = new PiHarness(TEST_DIR);
  const file = 'line_edit_test.txt';
  await harness.write(file, 'line 1\nline 2\nline 3\nline 4\nline 5');

  // Replace lines 2 to 4 with updated content
  const editRes = await harness.edit(file, {
    startLine: 2,
    endLine: 4,
    replace: 'line 2-4 replaced',
  });
  assert.strictEqual(editRes.success, true);

  const content = fs.readFileSync(path.join(TEST_DIR, file), 'utf-8');
  assert.strictEqual(content, 'line 1\nline 2-4 replaced\nline 5');
});

test('PiHarness grep finds matching lines with line numbers', async () => {
  const harness = new PiHarness(TEST_DIR);
  const file = 'grep_test.txt';
  await harness.write(file, 'alpha\nbeta target_symbol gamma\ndelta');

  const grepRes = await harness.grep('target_symbol', file);
  assert.strictEqual(grepRes.success, true);
  assert.ok(grepRes.output.includes('grep_test.txt:2: beta target_symbol gamma'));
});

test('PiHarness note records notes and maintains active session state', async () => {
  const harness = new PiHarness(TEST_DIR);
  const noteRes = harness.recordNote('Schema: id, name, type');
  assert.strictEqual(noteRes.success, true);

  const notes = harness.getNotes();
  assert.ok(notes.includes('Schema: id, name, type'));

  const state = harness.getSessionState();
  assert.ok(state.includes('Active Notes:'));
  assert.ok(state.includes('Schema: id, name, type'));
});

test('PiHarness validateAndFinish rejects finish when a modified file contains placeholder comments', async () => {
  const harness = new PiHarness(TEST_DIR);
  const stubFile = 'stub.js';
  await harness.write(stubFile, 'const items = [1, 2];\n// Additional data will be added here\n');

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'done' });
  assert.strictEqual(finishRes.success, false);
  assert.ok(finishRes.output.includes('contains an unpopulated placeholder comment'));
  assert.ok(finishRes.output.includes('Additional data will be added here'));
});

test('PiHarness validateAndFinish rejects finish when an HTML file contains invalid inline JS syntax', async () => {
  const harness = new PiHarness(TEST_DIR);
  const brokenHtml = 'broken.html';
  await harness.write(brokenHtml, '<!DOCTYPE html><html><body><script>const records = [ { id: 1, name: "sample" ];</script></body></html>');

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'done' });
  assert.strictEqual(finishRes.success, false);
  assert.ok(finishRes.output.includes('contains a JavaScript syntax error in an embedded <script> tag'));
});

test('PiHarness validateAndFinish rejects finish when a JSON file contains invalid syntax', async () => {
  const harness = new PiHarness(TEST_DIR);
  const brokenJson = 'data.json';
  await harness.write(brokenJson, '{ "id": 1, "name": "sample", }');

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'done' });
  assert.strictEqual(finishRes.success, false);
  assert.ok(finishRes.output.includes('JSON file \'data.json\' contains a syntax error'));
});

test('PiHarness validateAndFinish rejects finish when a JS file contains invalid syntax', async () => {
  const harness = new PiHarness(TEST_DIR);
  const brokenJs = 'app.js';
  await harness.write(brokenJs, 'const x = { foo: ;');

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'done' });
  assert.strictEqual(finishRes.success, false);
  assert.ok(finishRes.output.includes('JavaScript file \'app.js\' contains a syntax error'));
});

test('PiHarness validateAndFinish rejects finish when a modified file is empty (0 bytes)', async () => {
  const harness = new PiHarness(TEST_DIR);
  const emptyFile = 'empty.js';
  fs.writeFileSync(path.join(TEST_DIR, emptyFile), '');
  harness.modifiedFiles.add(emptyFile);

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'done' });
  assert.strictEqual(finishRes.success, false);
  assert.ok(finishRes.output.includes('is completely empty (0 bytes)'));
});

test('PiHarness validateAndFinish approves finish when modified files are valid', async () => {
  const harness = new PiHarness(TEST_DIR);
  const validFile = 'valid.html';
  await harness.write(validFile, '<!DOCTYPE html><html><body><script>const data = [{ id: 1, name: "Record1" }];</script></body></html>');

  const finishRes = await harness.executeTool({ type: 'finish', raw: '```finish```', summary: 'all valid' });
  assert.strictEqual(finishRes.success, true);
  assert.ok(finishRes.output.includes('Task completed'));
});

test('PiHarness runShell includes Windows notice when start command is executed', async () => {
  const harness = new PiHarness(TEST_DIR, 'powershell');
  const res = await harness.runShell('Start-Process -FilePath "notepad.exe" -WhatIf');
  assert.ok(res.output.includes('Windows/PowerShell Notice'));
  assert.ok(res.output.includes('start'));
});

test('extractAndSaveTemplate detects and offloads HTML templates from task prompts', () => {
  const prompt = `I have data in data.txt. Fit it in this template:
\`\`\`html
<!DOCTYPE html>
<html>
<head><title>Test Viewer</title></head>
<body><script>const items = [];</script></body>
</html>
\`\`\``;

  const result = extractAndSaveTemplate(prompt, TEST_DIR);
  assert.strictEqual(result.templatePath, 'template.html');
  assert.ok(result.promptNotice?.includes('Reference Template Offloaded'));

  const savedContent = fs.readFileSync(path.join(TEST_DIR, 'template.html'), 'utf-8');
  assert.ok(savedContent.includes('<!DOCTYPE html>'));
  assert.ok(savedContent.includes('Test Viewer'));
});

test('extractAndSaveTemplate detects and offloads JSON templates agnostically', () => {
  const prompt = `Convert the incoming log entries into this JSON schema:
\`\`\`json
{
  "timestamp": "ISO-8601",
  "level": "INFO",
  "payload": {
    "userId": "string",
    "event": "string"
  }
}
\`\`\``;

  const result = extractAndSaveTemplate(prompt, TEST_DIR);
  assert.strictEqual(result.templatePath, 'template.json');
  assert.ok(result.promptNotice?.includes('Reference Template Offloaded'));

  const savedContent = fs.readFileSync(path.join(TEST_DIR, 'template.json'), 'utf-8');
  assert.ok(savedContent.includes('"timestamp": "ISO-8601"'));
});

test('PiHarness safely rejects empty paths and directory targets without unhandled errors', async () => {
  const harness = new PiHarness(TEST_DIR);
  const subDir = path.join(TEST_DIR, 'subfolder');
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

  // 1. Write to empty path
  const emptyWrite = await harness.write('', 'some content');
  assert.strictEqual(emptyWrite.success, false);
  assert.ok(emptyWrite.output.includes('Missing file path'));

  // 2. Write to a directory
  const dirWrite = await harness.write('subfolder', 'some content');
  assert.strictEqual(dirWrite.success, false);
  assert.ok(dirWrite.output.includes('directory, not a file'));

  // 3. Read from a directory
  const dirRead = await harness.read('subfolder');
  assert.strictEqual(dirRead.success, false);
  assert.ok(dirRead.output.includes('directory, not a file'));

  // 4. Edit a directory
  const dirEdit = await harness.edit('subfolder', { find: 'a', replace: 'b' });
  assert.strictEqual(dirEdit.success, false);
  assert.ok(dirEdit.output.includes('directory, not a file'));
});
