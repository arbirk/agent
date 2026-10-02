import { ToolCall, ToolType } from './types.js';

/**
 * Extracts attributes from code fence header or first line
 * e.g., `path="foo/bar.ts" startLine=1 endLine=20`
 */
function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!text) return attrs;

  // Handles key="quoted" or key='quoted' or key=nonspace or key: "quoted" or key: nonspace
  const regex = /([a-zA-Z0-9_-]+)(?:=|\s*:\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    let val = match[2] ?? match[3] ?? match[4] ?? '';
    // Unescape common escapes like \" and \\
    val = val.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    attrs[key] = val;
  }
  return attrs;
}

function unindentYamlBlock(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^([ \t]+)/);
    const indent = match ? match[1].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent > 0 && minIndent !== Infinity) {
    return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line.trimStart())).join('\n');
  }
  return raw;
}

export function parseToolCalls(markdown: string): ToolCall[] {
  const calls: ToolCall[] = [];
  if (!markdown) return calls;

  // Regex to match code blocks ```tag [attrs]\n content \n```
  const codeBlockRegex = /```([a-zA-Z0-9_-]+)(?:[ \t]+([^\r\n]*))?[\r\n]+([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const rawTag = match[1].toLowerCase().trim();
    const headerAttrsStr = match[2] || '';
    const body = match[3];
    const fullBlock = match[0];

    const headerAttrs = parseAttributes(headerAttrsStr);
    const bodyLines = body.split(/\r?\n/);
    const firstLineAttrs = parseAttributes(bodyLines[0] || '');
    const mergedAttrs = { ...firstLineAttrs, ...headerAttrs };

    if (rawTag === 'bash' || rawTag === 'sh') {
      calls.push({
        type: 'bash',
        command: body.trim(),
        raw: fullBlock,
      });
    } else if (
      rawTag === 'powershell' ||
      rawTag === 'ps1' ||
      rawTag === 'pwsh' ||
      rawTag === 'shell' ||
      rawTag === 'terminal' ||
      rawTag === 'cmd' ||
      rawTag === 'execute'
    ) {
      calls.push({
        type: 'powershell',
        command: body.trim(),
        raw: fullBlock,
      });
    } else if (rawTag === 'read') {
      const path = mergedAttrs['path'] || mergedAttrs['file'] || (bodyLines[0]?.trim() ?? '');
      const startLine = mergedAttrs['startline'] || mergedAttrs['start'];
      const endLine = mergedAttrs['endline'] || mergedAttrs['end'];

      calls.push({
        type: 'read',
        path: path.replace(/^["']|["']$/g, '').trim(),
        startLine: startLine ? parseInt(startLine, 10) : undefined,
        endLine: endLine ? parseInt(endLine, 10) : undefined,
        raw: fullBlock,
      });
    } else if (rawTag === 'write') {
      let path = mergedAttrs['path'] || mergedAttrs['file'] || '';
      let content = body;

      // Also check if body has YAML-like header:
      // path: filename.html
      // content: |
      //   ...
      const yamlPathMatch = body.match(/^\s*(?:path|file)\s*[:=]\s*["']?([^\r\n"']+)["']?/i);
      if (yamlPathMatch) {
        path = yamlPathMatch[1].trim();
        const contentMarkerMatch = body.match(/^\s*(?:path|file)\s*[:=][^\r\n]*\r?\n\s*content\s*[:=]\s*\|?\s*\r?\n([\s\S]*)$/i);
        if (contentMarkerMatch) {
          content = unindentYamlBlock(contentMarkerMatch[1]);
        } else {
          content = bodyLines.slice(1).join('\n');
        }
      } else if (!headerAttrs['path'] && !headerAttrs['file'] && firstLineAttrs['path']) {
        content = bodyLines.slice(1).join('\n');
      }

      calls.push({
        type: 'write',
        path: path.replace(/^["']|["']$/g, '').trim(),
        content: content,
        raw: fullBlock,
      });
    } else if (rawTag === 'edit') {
      const fullContent = (headerAttrsStr + '\n' + body).trim();
      let path = (mergedAttrs['path'] || mergedAttrs['file'] || '').replace(/^["']|["']$/g, '').trim();
      if (!path) {
        const pathMatch = fullContent.match(/path=(?:"([^"]+)"|'([^']+)'|(\S+))/);
        if (pathMatch) {
          path = (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? '').trim();
        }
      }

      // Check for Line-Number based Edit: edit path="..." startLine=10 endLine=15
      const startLineRaw = mergedAttrs['startline'] || mergedAttrs['start'];
      const endLineRaw = mergedAttrs['endline'] || mergedAttrs['end'];
      if (startLineRaw !== undefined && !fullContent.includes('=======') && !fullContent.includes('find=')) {
        calls.push({
          type: 'edit',
          path,
          startLine: parseInt(startLineRaw, 10),
          endLine: endLineRaw !== undefined ? parseInt(endLineRaw, 10) : undefined,
          replace: body,
          raw: fullBlock,
        });
        continue;
      }

      // Check for Diff style: (with or without <<<<<<< FIND) ... ======= ... >>>>>>> REPLACE
      if (fullContent.includes('=======') && (fullContent.includes('>>>>>>> REPLACE') || fullContent.includes('<<<<<<< FIND'))) {
        const parts = fullContent.split('=======');
        let findPart = parts[0];
        if (findPart.includes('<<<<<<< FIND')) {
          findPart = findPart.slice(findPart.indexOf('<<<<<<< FIND') + '<<<<<<< FIND'.length);
        } else {
          const lines = findPart.split(/\r?\n/);
          if (lines[0].toLowerCase().startsWith('edit ') || lines[0].toLowerCase() === 'edit') {
            findPart = lines.slice(1).join('\n');
          }
        }

        let replacePart = parts[1] || '';
        if (replacePart.includes('>>>>>>> REPLACE')) {
          replacePart = replacePart.slice(0, replacePart.indexOf('>>>>>>> REPLACE'));
        }

        if (findPart.trim()) {
          calls.push({
            type: 'edit',
            path,
            find: findPart.replace(/^\r?\n/, ''),
            replace: replacePart.replace(/^\r?\n/, ''),
            raw: fullBlock,
          });
          continue;
        }
      }

      // Check for find="..." and replace="..." in attrs or body, including multiline
      let find = mergedAttrs['find'] || '';
      let replace = mergedAttrs['replace'] || '';

      if (!find || !replace) {
        const findMatch = fullContent.match(/find=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/);
        const replaceMatch = fullContent.match(/replace=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/);

        if (findMatch) {
          const rawVal = findMatch[1] ?? findMatch[2] ?? '';
          find = rawVal.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        }
        if (replaceMatch) {
          const rawVal = replaceMatch[1] ?? replaceMatch[2] ?? '';
          replace = rawVal.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        }
      }

      calls.push({
        type: 'edit',
        path,
        find,
        replace,
        raw: fullBlock,
      });
    } else if (rawTag === 'grep' || rawTag === 'search') {
      const path = (mergedAttrs['path'] || mergedAttrs['file'] || '').replace(/^["']|["']$/g, '').trim();
      const query = mergedAttrs['query'] || mergedAttrs['q'] || body.trim();
      calls.push({
        type: 'grep',
        path: path || undefined,
        query,
        raw: fullBlock,
      });
    } else if (rawTag === 'note' || rawTag === 'scratchpad') {
      calls.push({
        type: 'note',
        content: body.trim(),
        raw: fullBlock,
      });
    } else if (rawTag === 'finish') {
      calls.push({
        type: 'finish',
        summary: body.trim(),
        raw: fullBlock,
      });
    }
  }

  return calls;
}
