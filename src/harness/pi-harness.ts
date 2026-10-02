import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { spawn } from 'child_process';
import { ToolCall, ToolResult } from '../types.js';
import { estimateTokens } from '../tokenizer.js';

export class PiHarness {
  private workspaceDir: string;
  private defaultShell: 'powershell' | 'bash';
  private timeoutMs: number;
  private lastReadPath?: string;
  private lastReadEndLine?: number;
  public modifiedFiles: Set<string> = new Set();
  public lastCommandStatus: { command: string; exitCode: number } | null = null;
  private notes: string[] = [];

  constructor(
    workspaceDir: string = process.cwd(),
    defaultShell: 'powershell' | 'bash' = 'powershell',
    timeoutMs: number = 60000
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.defaultShell = defaultShell;
    this.timeoutMs = timeoutMs;
  }

  public getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  public recordNote(content: string): ToolResult {
    this.notes.push(content);
    try {
      const notesPath = path.join(this.workspaceDir, 'agent', 'notes.txt');
      const dir = path.dirname(notesPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(notesPath, this.notes.join('\n---\n'), 'utf-8');
    } catch {}
    return {
      tool: 'note',
      success: true,
      output: `Note recorded. It will be preserved permanently across all turns and context compressions.`,
    };
  }

  public getNotes(): string {
    if (this.notes.length === 0) {
      try {
        const notesPath = path.join(this.workspaceDir, 'agent', 'notes.txt');
        if (fs.existsSync(notesPath)) {
          return fs.readFileSync(notesPath, 'utf-8');
        }
      } catch {}
      return '';
    }
    return this.notes.join('\n---\n');
  }

  public getSessionState(): string {
    const parts: string[] = [];
    if (this.modifiedFiles.size > 0) {
      parts.push(`Modified files: ${Array.from(this.modifiedFiles).join(', ')}`);
    }
    if (this.lastCommandStatus) {
      parts.push(`Last executed command: ${this.lastCommandStatus.command} (Exit code: ${this.lastCommandStatus.exitCode})`);
    }
    const notes = this.getNotes();
    if (notes) {
      parts.push(`Active Notes:\n${notes}`);
    }
    return parts.length > 0 ? `\n[Active Session State]\n${parts.join('\n')}\n` : '';
  }

  /**
   * Resolves a file path and strictly prevents escaping the workspace root.
   */
  private resolvePath(filePath: string): string {
    const cleanPath = (filePath || '').replace(/^["']|["']$/g, '').trim();
    if (!cleanPath) {
      throw new Error(`Missing target file path. Please specify a file path attribute, e.g. path="index.html".`);
    }
    const resolved = path.isAbsolute(cleanPath)
      ? path.resolve(cleanPath)
      : path.resolve(this.workspaceDir, cleanPath);

    const relative = path.relative(this.workspaceDir, resolved);
    // If relative path starts with '..' or is an absolute drive jump, it's outside workspace
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Access denied: '${filePath}' is outside the workspace root '${this.workspaceDir}'. You must strictly operate within the workspace root.`
      );
    }

    return resolved;
  }

  public async executeTool(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.type) {
        case 'read':
          return await this.read(call.path, call.startLine, call.endLine);
        case 'write':
          return await this.write(call.path, call.content);
        case 'edit':
          return await this.edit(call.path, {
            find: call.find,
            replace: call.replace,
            startLine: call.startLine,
            endLine: call.endLine,
          });
        case 'grep':
          return await this.grep(call.query, call.path);
        case 'note':
          return this.recordNote(call.content);
        case 'bash':
        case 'powershell':
          return await this.runShell(call.command, call.type);
        case 'finish':
          return await this.validateAndFinish(call.summary);
        default:
          return {
            tool: (call as any).type || 'unknown',
            success: false,
            output: `Unsupported tool type: ${(call as any).type}`,
          };
      }
    } catch (err: any) {
      return {
        tool: call.type,
        success: false,
        output: `Error executing ${call.type}: ${err.message}`,
        error: err.message,
      };
    }
  }

  public async read(filePath: string, startLine?: number, endLine?: number): Promise<ToolResult> {
    try {
      const fullPath = this.resolvePath(filePath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return {
          tool: 'read',
          success: false,
          output: `Error reading: '${filePath}' is a directory, not a file.`,
          error: 'EISDIR',
        };
      }
      if (!fs.existsSync(fullPath)) {
        return {
          tool: 'read',
          success: false,
          output: `File does not exist: ${filePath}`,
          error: 'ENOENT',
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      const start = Math.max(1, startLine || 1);
      const end = Math.min(totalLines, endLine || totalLines);

      const requestedLines = lines.slice(start - 1, end);
      const requestedText = requestedLines.join('\n');
      const requestedTokens = estimateTokens(requestedText);

      const MAX_SAFE_LINES = 70;
      const MAX_SAFE_TOKENS = 850;
      const SUBSET_LINES = 50;
      const MAX_LINE_CHARS = 180;

      const sanitizeLine = (line: string): string => {
        if (line.length > MAX_LINE_CHARS) {
          return `${line.slice(0, MAX_LINE_CHARS)}... [${line.length - MAX_LINE_CHARS} characters truncated]`;
        }
        return line;
      };

      let paginationWarning = '';
      if (
        this.lastReadPath === fullPath &&
        startLine &&
        this.lastReadEndLine &&
        startLine >= this.lastReadEndLine &&
        startLine <= this.lastReadEndLine + 5
      ) {
        paginationWarning = `\n\n⚠️ [PAGINATION DETECTED]: You are reading sequential chunks of ${filePath}. Do NOT read entire datasets into LLM context chunk-by-chunk. You already understand the schema/structure. Write and execute a script (Python, Node, or shell) to process and assemble files directly on disk.`;
      }

      this.lastReadPath = fullPath;
      this.lastReadEndLine = end;

      // Detect if requested read exceeds safe turn token limit
      if (requestedLines.length > MAX_SAFE_LINES || requestedTokens > MAX_SAFE_TOKENS) {
        const subsetEnd = Math.min(end, start + SUBSET_LINES - 1);
        const subsetLines = lines.slice(start - 1, subsetEnd);
        const formattedSubset = subsetLines
          .map((line, idx) => `${start + idx} | ${sanitizeLine(line)}`)
          .join('\n');

        const warningMsg = [
          `File: ${filePath} (showing lines ${start}-${subsetEnd} of ${totalLines}):`,
          formattedSubset,
          '',
          `---`,
          `⚠️ [TOKEN LIMIT EXCEEDED - OUTPUT TRUNCATED TO SAFE SUBSET]`,
          `Requested range (${start}-${end}) has ${requestedLines.length} lines (~${requestedTokens} tokens), which exceeds the safe turn token limit (4,000 tokens).`,
          `Showing lines ${start}-${subsetEnd} (${subsetEnd - start + 1} lines) above to keep the prompt within budget.`,
          '',
          `[LOOP INSTRUCTION FOR LARGE FILES / DATASETS]:`,
          `Do NOT attempt to paginate or read the rest of this file into context!`,
          `You now have the pattern and schema from the sample above. Write and run an executable script (Python, Node, or shell) to process, transform, or assemble the file directly on disk.`,
          paginationWarning,
        ].filter(Boolean).join('\n');

        return {
          tool: 'read',
          success: true,
          output: warningMsg,
        };
      }

      const formatted = requestedLines
        .map((line, idx) => `${start + idx} | ${sanitizeLine(line)}`)
        .join('\n');

      return {
        tool: 'read',
        success: true,
        output: `File: ${filePath} (lines ${start}-${end} of ${totalLines}):\n${formatted}${paginationWarning}`,
      };
    } catch (err: any) {
      return {
        tool: 'read',
        success: false,
        output: `Error reading ${filePath}: ${err.message}`,
        error: err.message,
      };
    }
  }

  public async write(filePath: string, content: string): Promise<ToolResult> {
    try {
      if (!filePath || !filePath.trim()) {
        return {
          tool: 'write',
          success: false,
          output: `Error writing: Missing file path. Specify a path, e.g. path="index.html" or path: index.html.`,
          error: 'MISSING_PATH',
        };
      }
      const fullPath = this.resolvePath(filePath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return {
          tool: 'write',
          success: false,
          output: `Error writing: '${filePath}' is a directory, not a file. Please specify a file name.`,
          error: 'EISDIR',
        };
      }
      const existed = fs.existsSync(fullPath);
      let prevSize = 0;
      if (existed) {
        try {
          prevSize = fs.statSync(fullPath).size;
        } catch {}
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content, 'utf-8');
      this.modifiedFiles.add(filePath);

      const overwriteNote = existed
        ? ` (Notice: Overwrote existing file of ${prevSize} bytes. Verify you preserved all necessary existing layout and styles!)`
        : '';

      const placeholderMatch = content.match(/(?:\/\/|\/\*|<!--)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining|todo:?\s*add|\.\.\.)/i);
      const placeholderWarn = placeholderMatch
        ? `\n⚠️ [WARNING: PLACEHOLDER DETECTED]: Written content contains placeholder "${placeholderMatch[0]}". Do not truncate code or data with placeholders; use a script to assemble complete datasets directly.`
        : '';

      return {
        tool: 'write',
        success: true,
        output: `Successfully wrote ${content.length} characters to ${filePath}${overwriteNote}${placeholderWarn}`,
      };
    } catch (err: any) {
      return {
        tool: 'write',
        success: false,
        output: `Error writing to ${filePath}: ${err.message}`,
        error: err.message,
      };
    }
  }

  public async edit(
    filePath: string,
    findOrOptions: string | { find?: string; replace: string; startLine?: number; endLine?: number },
    replaceArg?: string,
    startLineArg?: number,
    endLineArg?: number
  ): Promise<ToolResult> {
    try {
      const fullPath = this.resolvePath(filePath);
      if (!fs.existsSync(fullPath)) {
        return {
          tool: 'edit',
          success: false,
          output: `File does not exist: ${filePath}`,
          error: 'ENOENT',
        };
      }

      let find = '';
      let replace = '';
      let startLine: number | undefined;
      let endLine: number | undefined;

      if (typeof findOrOptions === 'object') {
        find = findOrOptions.find || '';
        replace = findOrOptions.replace || '';
        startLine = findOrOptions.startLine;
        endLine = findOrOptions.endLine;
      } else {
        find = findOrOptions || '';
        replace = replaceArg || '';
        startLine = startLineArg;
        endLine = endLineArg;
      }

      // Check for illegal placeholder ellipsis in replacement content
      const placeholderRegex = /(?:^|\n)\s*(?:\/\/|\/\*|<!--)?\s*\.{3,}\s*(?:\*\/|-->)?\s*(?:\n|$)|(?:\/\/|\/\*|<!--)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining|todo:?\s*add)/i;
      const placeholderMatch = replace.match(placeholderRegex);
      if (placeholderMatch) {
        return {
          tool: 'edit',
          success: false,
          output: `Edit rejected: replacement contains placeholder "${placeholderMatch[0].trim()}". Never use placeholders or '...' to represent omitted code or data. When embedding large datasets, write and run a script to assemble the file on disk.`,
          error: 'PLACEHOLDER_DETECTED',
        };
      }

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return {
          tool: 'edit',
          success: false,
          output: `Error editing: '${filePath}' is a directory, not a file.`,
          error: 'EISDIR',
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      // 1. Line-number based replacement (precise, fast, immune to indentation/whitespace mismatches)
      if (startLine !== undefined && !isNaN(startLine)) {
        const isCrlf = content.includes('\r\n');
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const s = Math.max(1, startLine);
        const e = endLine !== undefined && !isNaN(endLine) ? Math.min(lines.length, Math.max(s, endLine)) : s;

        const before = lines.slice(0, s - 1);
        const after = lines.slice(e);
        // Strip accidental line number prefixes like "35 | " or "35: " if LLM copied from read output
        const rawLines = replace.replace(/\r\n/g, '\n').split('\n');
        const hasLineNumberPrefixes = rawLines.length > 0 && rawLines.some(l => /^\s*\d+\s*[|:]\s*/.test(l));
        const newLines = hasLineNumberPrefixes
          ? rawLines.map(l => l.replace(/^\s*\d+\s*[|:]\s?/, ''))
          : rawLines;
        const finalLines = [...before, ...newLines, ...after];
        const finalContent = isCrlf ? finalLines.join('\r\n') : finalLines.join('\n');
        fs.writeFileSync(fullPath, finalContent, 'utf-8');
        this.modifiedFiles.add(filePath);

        return {
          tool: 'edit',
          success: true,
          output: `Successfully replaced lines ${s}-${e} in ${filePath}`,
        };
      }

      // 2. Exact match search & replace
      if (!find || find.trim() === '') {
        return {
          tool: 'edit',
          success: false,
          output: `Edit failed: 'find' pattern cannot be empty. Provide the exact text to find and replace, or specify startLine and endLine.`,
          error: 'EMPTY_FIND',
        };
      }

      const normalizedContent = content.replace(/\r\n/g, '\n');
      const normalizedFind = find.replace(/\r\n/g, '\n');
      const normalizedReplace = replace.replace(/\r\n/g, '\n');

      if (!normalizedContent.includes(normalizedFind)) {
        return {
          tool: 'edit',
          success: false,
          output: `Target text not found in ${filePath}. Verify exact match, whitespace, or read the file first.`,
          error: 'NOT_FOUND',
        };
      }

      const updated = normalizedContent.replace(normalizedFind, normalizedReplace);
      const finalContent = content.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
      fs.writeFileSync(fullPath, finalContent, 'utf-8');
      this.modifiedFiles.add(filePath);

      return {
        tool: 'edit',
        success: true,
        output: `Successfully replaced target content in ${filePath}`,
      };
    } catch (err: any) {
      return {
        tool: 'edit',
        success: false,
        output: `Error editing ${filePath}: ${err.message}`,
        error: err.message,
      };
    }
  }

  public async grep(query: string, filePath?: string): Promise<ToolResult> {
    try {
      if (!query || !query.trim()) {
        return { tool: 'grep', success: false, output: 'Missing search query', error: 'INVALID_QUERY' };
      }
      const MAX_MATCHES = 30;
      const MAX_LINE_CHARS = 180;
      const sanitizeLine = (line: string) =>
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}... [truncated]` : line;

      const matches: string[] = [];

      const searchInFile = (relPath: string) => {
        const full = this.resolvePath(relPath);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return;
        const content = fs.readFileSync(full, 'utf-8');
        const lines = content.split(/\r?\n/);
        const lowerQuery = query.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            matches.push(`${relPath}:${i + 1}: ${sanitizeLine(lines[i].trim())}`);
            if (matches.length >= MAX_MATCHES) break;
          }
        }
      };

      if (filePath) {
        searchInFile(filePath);
      } else {
        const walk = (dir: string, prefix = '') => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.endsWith('.jsonl')) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              walk(path.join(dir, entry.name), rel);
            } else {
              searchInFile(rel);
            }
            if (matches.length >= MAX_MATCHES) break;
          }
        };
        walk(this.workspaceDir);
      }

      if (matches.length === 0) {
        return {
          tool: 'grep',
          success: true,
          output: `No matches found for "${query}"${filePath ? ` in ${filePath}` : ''}.`,
        };
      }

      const note = matches.length >= MAX_MATCHES ? `\n(Matches capped at ${MAX_MATCHES})` : '';
      return {
        tool: 'grep',
        success: true,
        output: `Found ${matches.length} match(es) for "${query}":\n${matches.join('\n')}${note}`,
      };
    } catch (err: any) {
      return { tool: 'grep', success: false, output: `Grep error: ${err.message}`, error: err.message };
    }
  }

  public async runShell(command: string, shellType: 'powershell' | 'bash' = this.defaultShell): Promise<ToolResult> {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      let shellCmd: string;
      let shellArgs: string[];

      if (shellType === 'powershell') {
        shellCmd = isWindows ? 'powershell.exe' : 'pwsh';
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', command];
      } else {
        if (isWindows) {
          // If Git Bash exists, use it; otherwise fallback to powershell.exe so single quotes and multiline commands work
          const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
          if (fs.existsSync(gitBashPath)) {
            shellCmd = gitBashPath;
            shellArgs = ['-c', command];
          } else {
            shellCmd = 'powershell.exe';
            shellArgs = ['-NoProfile', '-NonInteractive', '-Command', command];
          }
        } else {
          shellCmd = 'bash';
          shellArgs = ['-c', command];
        }
      }

      const proc = spawn(shellCmd, shellArgs, {
        cwd: this.workspaceDir,
        env: { ...process.env },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill();
        resolve({
          tool: shellType,
          success: false,
          output: `Command timed out after ${this.timeoutMs}ms:\n${stdout}\n${stderr}`,
          error: 'TIMEOUT',
        });
      }, this.timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        let combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
        const tokenCount = estimateTokens(combined);
        const MAX_SHELL_TOKENS = 850;
        const MAX_SHELL_LINES = 50;

        if (tokenCount > MAX_SHELL_TOKENS) {
          const lines = combined.split(/\r?\n/);
          const truncatedLines = lines.slice(0, MAX_SHELL_LINES).join('\n');
          combined = [
            truncatedLines,
            '',
            '---',
            `⚠️ [TOKEN LIMIT EXCEEDED - COMMAND OUTPUT TRUNCATED]`,
            `Command output was ~${tokenCount} tokens (${lines.length} lines), exceeding the safe per-turn token limit (4,000 tokens).`,
            `Showing first ${Math.min(lines.length, MAX_SHELL_LINES)} lines above to keep prompt within budget.`,
            '',
            `[LOOP INSTRUCTION]:`,
            `DO NOT dump large outputs or entire datasets to stdout!`,
            `1. To probe smaller subsets: Use pagination or filtering tools (e.g. \`head -n 50\`, \`Get-Content -TotalCount 50\`, \`Select-String\`, or \`grep\`).`,
            `2. To process or transform datasets: Write a Python or Node.js script that reads and writes files directly without dumping data to the console.`,
          ].join('\n');
        }

        if (code !== 0 && (combined.includes('IndentationError') || combined.includes('SyntaxError'))) {
          combined += `\n\n💡 [Harness Tip: In Python, line edits easily break indentation. If this is a helper script, write the entire clean script directly with 'write' rather than editing line-by-line.]`;
        }

        if (/(?:^|[;&|\n])\s*(?:start|Start-Process)\b/i.test(command)) {
          combined += `\n\n⚠️ [Windows/PowerShell Notice]: 'start' opens a process in the background and returns exit code 0 without verifying file contents or execution correctness. To verify, test output integrity and syntax using automated commands (e.g. Get-Content, Select-String, node -c, or python).`;
        }

        this.lastCommandStatus = { command, exitCode: code ?? -1 };

        resolve({
          tool: shellType,
          success: code === 0,
          output: combined || `(Command exited with code ${code})`,
          error: code === 0 ? undefined : `Exited with code ${code}`,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          tool: shellType,
          success: false,
          output: `Failed to spawn shell: ${err.message}`,
          error: err.message,
        });
      });
    });
  }

  /**
   * Validates workspace state and modified files before allowing task completion.
   * Rejects finish if files contain unpopulated placeholder comments, empty files,
   * or syntax errors in modified code/data files.
   */
  public async validateAndFinish(summary: string): Promise<ToolResult> {
    for (const filePath of this.modifiedFiles) {
      let fullPath: string;
      try {
        fullPath = this.resolvePath(filePath);
      } catch {
        continue;
      }

      if (!fs.existsSync(fullPath)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) continue;

      // 1. Empty file check
      if (stat.size === 0) {
        return {
          tool: 'finish',
          success: false,
          output: `❌ Cannot finish: File '${filePath}' is completely empty (0 bytes). Please write valid content before completing the task.`,
          error: 'EMPTY_FILE',
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      // 2. Unpopulated placeholder comments check in code/data files
      const codeExtensions = ['.js', '.ts', '.py', '.html', '.htm', '.css', '.json', '.sh', '.ps1'];
      if (codeExtensions.includes(ext) || ext === '') {
        const lines = content.split(/\r?\n/);
        const PLACEHOLDER_PATTERNS = [
          /(?:\/\/|\/\*|<!--|#)\s*(?:additional|more|remaining|other|todo:?\s*add|\.\.\.)/i,
          /(?:\/\/|\/\*|<!--|#)\s*(?:add\s+(?:more|all|other|remaining)|rest\s+of|remaining\s+data|placeholder)/i,
          /^\s*(?:\/\/|\/\*|<!--|#)\s*\.\.\.\s*$/m,
          /\bTODO:?\s*implement\b/i,
        ];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pattern of PLACEHOLDER_PATTERNS) {
            if (pattern.test(line)) {
              return {
                tool: 'finish',
                success: false,
                output: `❌ Cannot finish: File '${filePath}' (line ${i + 1}) contains an unpopulated placeholder comment:\n"${line.trim()}"\nYou must process and inject the complete dataset or code directly. Do not leave placeholder comments, stubs, or truncated samples.`,
                error: 'UNPOPULATED_PLACEHOLDER',
              };
            }
          }
        }
      }

      // 3. Multi-format syntax validation (JSON, JS, HTML embedded scripts)
      if (ext === '.json') {
        try {
          JSON.parse(content);
        } catch (jsonErr: any) {
          return {
            tool: 'finish',
            success: false,
            output: `❌ Cannot finish: JSON file '${filePath}' contains a syntax error:\n${jsonErr.message}\nPlease resolve the syntax error before finishing.`,
            error: 'JSON_SYNTAX_ERROR',
          };
        }
      } else if (ext === '.js' || ext === '.mjs') {
        try {
          new vm.Script(content);
        } catch (syntaxErr: any) {
          return {
            tool: 'finish',
            success: false,
            output: `❌ Cannot finish: JavaScript file '${filePath}' contains a syntax error:\n${syntaxErr.message}\nPlease resolve the syntax error before finishing.`,
            error: 'JS_SYNTAX_ERROR',
          };
        }
      } else if (ext === '.html' || ext === '.htm') {
        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let scriptMatch: RegExpExecArray | null;
        while ((scriptMatch = scriptRegex.exec(content)) !== null) {
          const scriptTag = scriptMatch[0];
          // Skip external scripts with src="..."
          if (/src\s*=\s*["']/i.test(scriptTag)) continue;
          // Skip non-JS script types (e.g. type="application/json" or type="text/html")
          const typeMatch = scriptTag.match(/type\s*=\s*["']([^"']+)["']/i);
          if (typeMatch && !/^(?:text\/javascript|application\/javascript|module)$/i.test(typeMatch[1])) {
            continue;
          }

          const jsCode = scriptMatch[1].trim();
          if (!jsCode) continue;

          try {
            new vm.Script(jsCode);
          } catch (syntaxErr: any) {
            return {
              tool: 'finish',
              success: false,
              output: `❌ Cannot finish: HTML file '${filePath}' contains a JavaScript syntax error in an embedded <script> tag:\n${syntaxErr.message}\nPlease resolve the syntax error before finishing.`,
              error: 'JS_SYNTAX_ERROR',
            };
          }
        }
      }
    }

    return {
      tool: 'finish',
      success: true,
      output: `Task completed. Summary: ${summary}`,
    };
  }
}
