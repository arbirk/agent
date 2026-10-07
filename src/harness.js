import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { estimateTokens } from './tokenizer.js';

const MAX_LINE_CHARS = 180;
const MAX_OUTPUT_TOKENS = 850;
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const clipLine = (line) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}... [${line.length - MAX_LINE_CHARS} characters truncated]` : line;

const fail = (tool, output, error = output) => ({ tool, success: false, output, error });
const ok = (tool, output) => ({ tool, success: true, output });

const PLACEHOLDER_IN_EDIT =
  /(?:^|\n)\s*(?:\/\/|\/\*|<!--)?\s*\.{3,}\s*(?:\*\/|-->)?\s*(?:\n|$)|(?:\/\/|\/\*|<!--)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining|todo:?\s*add)/i;
const PLACEHOLDER_IN_WRITE = /(?:\/\/|\/\*|<!--)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining|todo:?\s*add|\.\.\.)/i;
const PLACEHOLDER_ON_FINISH = [
  /(?:\/\/|\/\*|<!--|#)\s*(?:additional|more|remaining|other|todo:?\s*add|\.\.\.)/i,
  /(?:\/\/|\/\*|<!--|#)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining\s+data|placeholder)/i,
  /^\s*(?:\/\/|\/\*|<!--|#)\s*\.\.\.\s*$/m,
  /\bTODO:?\s*implement\b/i,
];
const CODE_EXTENSIONS = ['.js', '.mjs', '.ts', '.py', '.html', '.htm', '.css', '.json', '.sh', '.ps1', ''];

export class Harness {
  constructor(workspaceDir = process.cwd(), defaultShell = 'powershell', timeoutMs = 60000) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.defaultShell = defaultShell;
    this.timeoutMs = timeoutMs;
    this.notesPath = path.join(this.workspaceDir, 'agent', 'notes.txt');
    this.notes = [];
    this.reset();
  }

  /** Clears per-task state so finish validation only covers the current task. */
  reset() {
    this.modifiedFiles = new Set();
    this.lastCommandStatus = null;
    this.lastReadPath = undefined;
    this.lastReadEndLine = undefined;
  }

  recordNote(content) {
    this.notes.push(content);
    try {
      fs.mkdirSync(path.dirname(this.notesPath), { recursive: true });
      fs.writeFileSync(this.notesPath, this.notes.join('\n---\n'), 'utf-8');
    } catch {}
    return ok('note', 'Note recorded. It will be preserved across all turns and context compressions.');
  }

  getNotes() {
    if (this.notes.length > 0) return this.notes.join('\n---\n');
    try {
      return fs.existsSync(this.notesPath) ? fs.readFileSync(this.notesPath, 'utf-8') : '';
    } catch {
      return '';
    }
  }

  getSessionState() {
    const parts = [];
    if (this.modifiedFiles.size > 0) parts.push(`Modified files: ${[...this.modifiedFiles].join(', ')}`);
    if (this.lastCommandStatus) {
      parts.push(`Last executed command: ${this.lastCommandStatus.command} (Exit code: ${this.lastCommandStatus.exitCode})`);
    }
    const notes = this.getNotes();
    if (notes) parts.push(`Active Notes:\n${notes}`);
    return parts.length > 0 ? `\n[Active Session State]\n${parts.join('\n')}\n` : '';
  }

  resolvePath(filePath) {
    const clean = (filePath || '').replace(/^["']|["']$/g, '').trim();
    if (!clean) throw new Error('Missing target file path. Specify a path attribute, e.g. path="index.html".');
    const resolved = path.resolve(this.workspaceDir, clean);
    const relative = path.relative(this.workspaceDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Access denied: '${filePath}' is outside the workspace root '${this.workspaceDir}'.`);
    }
    return resolved;
  }

  isDirectory(fullPath) {
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  }

  async executeTool(call) {
    try {
      switch (call.type) {
        case 'read': return this.read(call.path, call.startLine, call.endLine);
        case 'write': return this.write(call.path, call.content);
        case 'edit': return this.edit(call.path, call);
        case 'grep': return this.grep(call.query, call.path);
        case 'note': return this.recordNote(call.content);
        case 'bash':
        case 'powershell': return await this.runShell(call.command, call.type);
        case 'finish': return this.validateAndFinish(call.summary);
        default: return fail(call.type || 'unknown', `Unsupported tool type: ${call.type}`);
      }
    } catch (err) {
      return fail(call.type, `Error executing ${call.type}: ${err.message}`, err.message);
    }
  }

  read(filePath, startLine, endLine) {
    try {
      const fullPath = this.resolvePath(filePath);
      if (this.isDirectory(fullPath)) return fail('read', `Error reading: '${filePath}' is a directory, not a file.`, 'EISDIR');
      if (!fs.existsSync(fullPath)) return fail('read', `File does not exist: ${filePath}`, 'ENOENT');

      const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/);
      const total = lines.length;
      const start = Math.max(1, startLine || 1);
      const end = Math.min(total, endLine || total);
      const requested = lines.slice(start - 1, end);
      const requestedTokens = estimateTokens(requested.join('\n'));
      const numbered = (subset) => subset.map((line, i) => `${start + i} | ${clipLine(line)}`).join('\n');

      let paginationWarning = '';
      if (this.lastReadPath === fullPath && startLine && this.lastReadEndLine &&
          startLine >= this.lastReadEndLine && startLine <= this.lastReadEndLine + 5) {
        paginationWarning = `\n\n⚠️ [PAGINATION DETECTED]: You are reading sequential chunks of ${filePath}. Do NOT page whole datasets into context. You already know the structure — write and run a script to process the file on disk.`;
      }
      this.lastReadPath = fullPath;
      this.lastReadEndLine = end;

      if (requested.length > 70 || requestedTokens > MAX_OUTPUT_TOKENS) {
        const subsetEnd = Math.min(end, start + 49);
        return ok('read', [
          `File: ${filePath} (showing lines ${start}-${subsetEnd} of ${total}):`,
          numbered(lines.slice(start - 1, subsetEnd)),
          '',
          '---',
          '⚠️ [TOKEN LIMIT EXCEEDED - OUTPUT TRUNCATED TO SAFE SUBSET]',
          `Requested range (${start}-${end}) has ${requested.length} lines (~${requestedTokens} tokens), exceeding the safe per-turn budget.`,
          '',
          '[LOOP INSTRUCTION FOR LARGE FILES / DATASETS]:',
          'Do NOT paginate the rest of this file into context. Use the sample above to write and run a script that processes the file directly on disk.',
          paginationWarning,
        ].filter(Boolean).join('\n'));
      }

      return ok('read', `File: ${filePath} (lines ${start}-${end} of ${total}):\n${numbered(requested)}${paginationWarning}`);
    } catch (err) {
      return fail('read', `Error reading ${filePath}: ${err.message}`, err.message);
    }
  }

  write(filePath, content) {
    try {
      if (!filePath || !filePath.trim()) {
        return fail('write', 'Error writing: Missing file path. Specify a path, e.g. path="index.html".', 'MISSING_PATH');
      }
      const fullPath = this.resolvePath(filePath);
      if (this.isDirectory(fullPath)) {
        return fail('write', `Error writing: '${filePath}' is a directory, not a file. Specify a file name.`, 'EISDIR');
      }
      const prevSize = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : null;
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      this.modifiedFiles.add(filePath);

      const overwriteNote = prevSize !== null
        ? ` (Notice: Overwrote existing file of ${prevSize} bytes. Verify you preserved all necessary existing layout and styles!)`
        : '';
      const placeholder = content.match(PLACEHOLDER_IN_WRITE);
      const placeholderWarn = placeholder
        ? `\n⚠️ [WARNING: PLACEHOLDER DETECTED]: Content contains placeholder "${placeholder[0]}". Do not truncate code or data; use a script to assemble complete data.`
        : '';
      return ok('write', `Successfully wrote ${content.length} characters to ${filePath}${overwriteNote}${placeholderWarn}`);
    } catch (err) {
      return fail('write', `Error writing to ${filePath}: ${err.message}`, err.message);
    }
  }

  edit(filePath, findOrOptions = {}, maybeReplace = '') {
    try {
      const opts = typeof findOrOptions === 'string'
        ? { find: findOrOptions, replace: maybeReplace }
        : (findOrOptions || {});
      const { find = '', replace = '', startLine, endLine } = opts;
      const fullPath = this.resolvePath(filePath);
      if (!fs.existsSync(fullPath)) return fail('edit', `File does not exist: ${filePath}`, 'ENOENT');
      if (this.isDirectory(fullPath)) return fail('edit', `Error editing: '${filePath}' is a directory, not a file.`, 'EISDIR');

      const placeholder = replace.match(PLACEHOLDER_IN_EDIT);
      if (placeholder) {
        return fail('edit', `Edit rejected: replacement contains placeholder "${placeholder[0].trim()}". Never use placeholders or '...' for omitted code or data; use a script for large datasets.`, 'PLACEHOLDER_DETECTED');
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const isCrlf = content.includes('\r\n');
      const normalized = content.replace(/\r\n/g, '\n');
      const save = (text) => {
        fs.writeFileSync(fullPath, isCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf-8');
        this.modifiedFiles.add(filePath);
      };

      if (startLine !== undefined && !isNaN(startLine)) {
        const lines = normalized.split('\n');
        const s = Math.max(1, startLine);
        const e = endLine !== undefined && !isNaN(endLine) ? Math.min(lines.length, Math.max(s, endLine)) : s;
        let newLines = replace.replace(/\r\n/g, '\n').split('\n');
        // Strip "35 | " prefixes copied from read output.
        if (newLines.some((l) => /^\s*\d+\s*[|:]\s*/.test(l))) newLines = newLines.map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, ''));
        save([...lines.slice(0, s - 1), ...newLines, ...lines.slice(e)].join('\n'));
        return ok('edit', `Successfully replaced lines ${s}-${e} in ${filePath}`);
      }

      if (!find.trim()) {
        return fail('edit', "Edit failed: 'find' cannot be empty. Provide the exact text to replace, or startLine/endLine.", 'EMPTY_FIND');
      }
      const target = find.replace(/\r\n/g, '\n');
      if (!normalized.includes(target)) {
        return fail('edit', `Target text not found in ${filePath}. Verify the exact text and whitespace, or read the file first.`, 'NOT_FOUND');
      }
      save(normalized.replace(target, () => replace.replace(/\r\n/g, '\n')));
      return ok('edit', `Successfully replaced target content in ${filePath}`);
    } catch (err) {
      return fail('edit', `Error editing ${filePath}: ${err.message}`, err.message);
    }
  }

  grep(query, filePath) {
    try {
      if (!query || !query.trim()) return fail('grep', 'Missing search query', 'INVALID_QUERY');
      const MAX_MATCHES = 30;
      const lowerQuery = query.toLowerCase();
      const matches = [];

      const searchFile = (rel) => {
        const full = this.resolvePath(rel);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return;
        const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) matches.push(`${rel}:${i + 1}: ${clipLine(lines[i].trim())}`);
        }
      };
      const walk = (dir, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (matches.length >= MAX_MATCHES) return;
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.endsWith('.jsonl')) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else searchFile(rel);
        }
      };

      if (filePath) searchFile(filePath);
      else walk(this.workspaceDir);

      if (matches.length === 0) return ok('grep', `No matches found for "${query}"${filePath ? ` in ${filePath}` : ''}.`);
      const capped = matches.length >= MAX_MATCHES ? `\n(Matches capped at ${MAX_MATCHES})` : '';
      return ok('grep', `Found ${matches.length} match(es) for "${query}":\n${matches.join('\n')}${capped}`);
    } catch (err) {
      return fail('grep', `Grep error: ${err.message}`, err.message);
    }
  }

  shellInvocation(command, shellType) {
    const isWindows = process.platform === 'win32';
    const ps = [isWindows ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]];
    if (shellType !== 'bash') return ps;
    if (!isWindows) return ['bash', ['-c', command]];
    return fs.existsSync(GIT_BASH) ? [GIT_BASH, ['-c', command]] : ps;
  }

  runShell(command, shellType = this.defaultShell) {
    return new Promise((resolve) => {
      const [cmd, args] = this.shellInvocation(command, shellType);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const proc = spawn(cmd, args, { cwd: this.workspaceDir, env: process.env, windowsHide: true });
      const timer = setTimeout(() => {
        proc.kill();
        finish(fail(shellType, `Command timed out after ${this.timeoutMs}ms:\n${stdout}\n${stderr}`, 'TIMEOUT'));
      }, this.timeoutMs);

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (err) => finish(fail(shellType, `Failed to spawn shell: ${err.message}`, err.message)));
      proc.on('close', (code) => {
        let output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
        const tokens = estimateTokens(output);
        if (tokens > MAX_OUTPUT_TOKENS) {
          const lines = output.split(/\r?\n/);
          output = [
            lines.slice(0, 50).join('\n'),
            '',
            '---',
            '⚠️ [TOKEN LIMIT EXCEEDED - COMMAND OUTPUT TRUNCATED]',
            `Output was ~${tokens} tokens (${lines.length} lines). Showing the first ${Math.min(lines.length, 50)} lines.`,
            '',
            '[LOOP INSTRUCTION]:',
            'DO NOT dump large outputs or entire datasets to stdout!',
            '1. To probe subsets: filter with Select-Object -First 50, Get-Content -TotalCount 50, Select-String, or grep.',
            '2. To process datasets: write a Node.js script that reads and writes files directly.',
          ].join('\n');
        }
        if (code !== 0 && /IndentationError|SyntaxError/.test(output)) {
          output += "\n\n💡 [Harness Tip: If this is a helper script, rewrite the whole clean script with 'write' instead of editing line-by-line.]";
        }
        if (/Language\s*Mode|not supported in this language mode|Cannot invoke method|Cannot create type/i.test(output)) {
          output += '\n\n💡 [Harness Tip: PowerShell is in Constrained Language Mode. Avoid .NET calls, Add-Type and New-Object; use cmdlets, or write a Node.js script in agent/ and run it with node.]';
        }
        if (/(?:^|[;&|\n])\s*(?:start|Start-Process)\b/i.test(command)) {
          output += "\n\n⚠️ [Windows/PowerShell Notice]: 'start' launches a detached process and returns exit code 0 without verifying anything. Verify results with Get-Content, Select-String or node --check.";
        }
        this.lastCommandStatus = { command, exitCode: code ?? -1 };
        finish({
          tool: shellType,
          success: code === 0,
          output: output || `(Command exited with code ${code})`,
          error: code === 0 ? undefined : `Exited with code ${code}`,
        });
      });
    });
  }

  /** Rejects finish when modified files are empty, contain placeholders, or have syntax errors. */
  validateAndFinish(summary) {
    const reject = (output, error) => fail('finish', `❌ Cannot finish: ${output}`, error);

    for (const filePath of this.modifiedFiles) {
      let fullPath;
      try {
        fullPath = this.resolvePath(filePath);
      } catch {
        continue;
      }
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) continue;
      if (stat.size === 0) {
        return reject(`File '${filePath}' is completely empty (0 bytes). Write valid content before completing the task.`, 'EMPTY_FILE');
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      if (CODE_EXTENSIONS.includes(ext)) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (PLACEHOLDER_ON_FINISH.some((p) => p.test(lines[i]))) {
            return reject(
              `File '${filePath}' (line ${i + 1}) contains an unpopulated placeholder comment:\n"${lines[i].trim()}"\nInject the complete data or code. Do not leave placeholders, stubs, or truncated samples.`,
              'UNPOPULATED_PLACEHOLDER'
            );
          }
        }
      }

      if (ext === '.json') {
        try {
          JSON.parse(content);
        } catch (err) {
          return reject(`JSON file '${filePath}' contains a syntax error:\n${err.message}\nResolve it before finishing.`, 'JSON_SYNTAX_ERROR');
        }
      } else if (ext === '.js' || ext === '.mjs') {
        const syntaxError = checkJs(content, ext === '.mjs' || /^\s*(import|export)\s/m.test(content));
        if (syntaxError) {
          return reject(`JavaScript file '${filePath}' contains a syntax error:\n${syntaxError}\nResolve it before finishing.`, 'JS_SYNTAX_ERROR');
        }
      } else if (ext === '.html' || ext === '.htm') {
        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = scriptRegex.exec(content)) !== null) {
          const tag = m[0];
          if (/src\s*=\s*["']/i.test(tag)) continue;
          const type = tag.match(/type\s*=\s*["']([^"']+)["']/i);
          if (type && !/^(?:text\/javascript|application\/javascript|module)$/i.test(type[1])) continue;
          const code = m[1].trim();
          if (!code) continue;
          const syntaxError = checkJs(code, type && /^module$/i.test(type[1]));
          if (syntaxError) {
            return reject(`HTML file '${filePath}' contains a JavaScript syntax error in an embedded <script> tag:\n${syntaxError}\nResolve it before finishing.`, 'JS_SYNTAX_ERROR');
          }
        }
      }
    }
    return ok('finish', `Task completed. Summary: ${summary}`);
  }
}

function checkJs(code, isModule) {
  try {
    if (isModule && typeof vm.SourceTextModule === 'function') new vm.SourceTextModule(code);
    else if (isModule) return null; // Module syntax can't be checked without --experimental-vm-modules.
    else new vm.Script(code);
    return null;
  } catch (err) {
    return err.message;
  }
}

export const PiHarness = Harness;

