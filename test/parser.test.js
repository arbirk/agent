import test from 'node:test';
import assert from 'node:assert';
import { parseToolCalls } from '../src/parser.js';

test('parseToolCalls parses shell commands', () => {
  const markdown = `
Here is the command to list files:
\`\`\`powershell
Get-ChildItem -Name
\`\`\`
Let me know if you need more.
`;
  const calls = parseToolCalls(markdown);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'powershell');
  assert.strictEqual(calls[0].command, 'Get-ChildItem -Name');
});

test('parseToolCalls parses write and read blocks', () => {
  const markdown = `
\`\`\`write path="src/hello.ts"
export const greeting = "Hello World";
\`\`\`

Now reading the file:
\`\`\`read path="src/hello.ts" startLine=1 endLine=5
\`\`\`
`;
  const calls = parseToolCalls(markdown);
  assert.strictEqual(calls.length, 2);

  assert.strictEqual(calls[0].type, 'write');
  assert.strictEqual(calls[0].path, 'src/hello.ts');
  assert.strictEqual(calls[0].content.trim(), 'export const greeting = "Hello World";');

  assert.strictEqual(calls[1].type, 'read');
  assert.strictEqual(calls[1].path, 'src/hello.ts');
  assert.strictEqual(calls[1].startLine, 1);
  assert.strictEqual(calls[1].endLine, 5);
});

test('parseToolCalls parses edit blocks with attributes and diff markers', () => {
  const markdownAttr = `
\`\`\`edit path="config.json" find="\\"port\\": 3000" replace="\\"port\\": 8080"
\`\`\`
`;
  const callsAttr = parseToolCalls(markdownAttr);
  assert.strictEqual(callsAttr.length, 1);
  assert.strictEqual(callsAttr[0].type, 'edit');
  assert.strictEqual(callsAttr[0].path, 'config.json');
  assert.strictEqual(callsAttr[0].find, '"port": 3000');
  assert.strictEqual(callsAttr[0].replace, '"port": 8080');

  const markdownDiff = `
\`\`\`edit path="src/main.ts"
<<<<<<< FIND
const a = 1;
=======
const a = 42;
>>>>>>> REPLACE
\`\`\`
`;
  const callsDiff = parseToolCalls(markdownDiff);
  assert.strictEqual(callsDiff.length, 1);
  assert.strictEqual(callsDiff[0].type, 'edit');
  assert.strictEqual(callsDiff[0].path, 'src/main.ts');
  assert.strictEqual(callsDiff[0].find.trim(), 'const a = 1;');
  assert.strictEqual(callsDiff[0].replace.trim(), 'const a = 42;');
});

test('parseToolCalls parses multiline find and replace attributes', () => {
  const markdown = `
\`\`\`edit path="src/example.py" find="for line in lines:
    if line.startswith('#'):
        parts = line.split(' ')" replace="for line in lines:
    if not line.startswith('#'):
        continue
    parts = line.split('\\t')"
\`\`\`
`;
  const calls = parseToolCalls(markdown);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'edit');
  assert.strictEqual(calls[0].path, 'src/example.py');
  assert.strictEqual(
    calls[0].find,
    "for line in lines:\n    if line.startswith('#'):\n        parts = line.split(' ')"
  );
  assert.strictEqual(
    calls[0].replace,
    "for line in lines:\n    if not line.startswith('#'):\n        continue\n    parts = line.split('\\t')"
  );
});

test('parseToolCalls parses finish block', () => {
  const markdown = `
I have finished all tasks.
\`\`\`finish
Created the repository, configured the build, and all tests pass.
\`\`\`
`;
  const calls = parseToolCalls(markdown);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'finish');
  assert.strictEqual(calls[0].summary, 'Created the repository, configured the build, and all tests pass.');
});

test('parseToolCalls parses YAML style write blocks with path: and content: |', () => {
  const markdown = `
\`\`\`write
path: C:\\test\\rose.html
content: |
  <!DOCTYPE html>
  <html><body>Rose</body></html>
\`\`\`
`;
  const calls = parseToolCalls(markdown);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'write');
  assert.strictEqual(calls[0].path, 'C:\\test\\rose.html');
  assert.ok(calls[0].content.includes('<!DOCTYPE html>'));
  assert.ok(!calls[0].content.includes('path:'));
  assert.ok(!calls[0].content.includes('content: |'));
});
