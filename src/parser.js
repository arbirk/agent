const SHELL_TAGS = ['powershell', 'ps1', 'pwsh', 'shell', 'terminal', 'cmd', 'execute'];
const BASH_TAGS = ['bash', 'sh'];

const stripQuotes = (s) => (s || '').replace(/^["']|["']$/g, '').trim();
const unescape = (s) => s.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

// Parses `key="value"`, `key='value'`, `key=value` and YAML-style `key: value`.
function parseAttributes(text) {
  const attrs = {};
  if (!text) return attrs;
  const regex = /([a-zA-Z0-9_-]+)(?:=|\s*:\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    attrs[match[1].toLowerCase()] = unescape(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function unindent(raw) {
  const lines = raw.split(/\r?\n/);
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, (line.match(/^[ \t]*/) || [''])[0].length);
  }
  if (!min || min === Infinity) return raw;
  return lines.map((l) => (l.length >= min ? l.slice(min) : l.trimStart())).join('\n');
}

function parseEdit(path, headerAttrsStr, body, attrs, raw) {
  const full = (headerAttrsStr + '\n' + body).trim();
  if (!path) {
    const m = full.match(/path=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (m) path = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  }

  const startRaw = attrs.startline || attrs.start;
  const endRaw = attrs.endline || attrs.end;
  if (startRaw !== undefined && !full.includes('=======') && !full.includes('find=')) {
    return {
      type: 'edit', path, raw, replace: body,
      startLine: parseInt(startRaw, 10),
      endLine: endRaw !== undefined ? parseInt(endRaw, 10) : undefined,
    };
  }

  if (full.includes('=======') && (full.includes('>>>>>>> REPLACE') || full.includes('<<<<<<< FIND'))) {
    const [before, after = ''] = full.split('=======');
    let find = before;
    if (find.includes('<<<<<<< FIND')) {
      find = find.slice(find.indexOf('<<<<<<< FIND') + '<<<<<<< FIND'.length);
    } else {
      const lines = find.split(/\r?\n/);
      if (/^edit\b/i.test(lines[0])) find = lines.slice(1).join('\n');
    }
    let replace = after;
    if (replace.includes('>>>>>>> REPLACE')) replace = replace.slice(0, replace.indexOf('>>>>>>> REPLACE'));
    if (find.trim()) {
      return { type: 'edit', path, raw, find: find.replace(/^\r?\n/, ''), replace: replace.replace(/^\r?\n/, '') };
    }
  }

  let find = attrs.find || '';
  let replace = attrs.replace || '';
  if (!find || !replace) {
    const fm = full.match(/find=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/);
    const rm = full.match(/replace=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/);
    if (fm) find = unescape(fm[1] ?? fm[2] ?? '');
    if (rm) replace = unescape(rm[1] ?? rm[2] ?? '');
  }
  return { type: 'edit', path, raw, find, replace };
}

export function parseToolCalls(markdown) {
  const calls = [];
  if (!markdown) return calls;

  const blockRegex = /```([a-zA-Z0-9_-]+)(?:[ \t]+([^\r\n]*))?[\r\n]+([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(markdown)) !== null) {
    const tag = match[1].toLowerCase().trim();
    const headerAttrsStr = match[2] || '';
    const body = match[3];
    const raw = match[0];

    const headerAttrs = parseAttributes(headerAttrsStr);
    const bodyLines = body.split(/\r?\n/);
    const firstLineAttrs = parseAttributes(bodyLines[0] || '');
    const attrs = { ...firstLineAttrs, ...headerAttrs };
    const attrPath = stripQuotes(attrs.path || attrs.file || '');

    if (BASH_TAGS.includes(tag)) {
      calls.push({ type: 'bash', command: body.trim(), raw });
    } else if (SHELL_TAGS.includes(tag)) {
      calls.push({ type: 'powershell', command: body.trim(), raw });
    } else if (tag === 'read') {
      const start = attrs.startline || attrs.start;
      const end = attrs.endline || attrs.end;
      calls.push({
        type: 'read', raw,
        path: attrPath || stripQuotes(bodyLines[0]),
        startLine: start ? parseInt(start, 10) : undefined,
        endLine: end ? parseInt(end, 10) : undefined,
      });
    } else if (tag === 'write') {
      let path = attrPath;
      let content = body;
      const yamlPath = body.match(/^\s*(?:path|file)\s*[:=]\s*["']?([^\r\n"']+)["']?/i);
      if (yamlPath) {
        path = yamlPath[1].trim();
        const yamlContent = body.match(/^\s*(?:path|file)\s*[:=][^\r\n]*\r?\n\s*content\s*[:=]\s*\|?\s*\r?\n([\s\S]*)$/i);
        content = yamlContent ? unindent(yamlContent[1]) : bodyLines.slice(1).join('\n');
      } else if (!headerAttrs.path && !headerAttrs.file && firstLineAttrs.path) {
        content = bodyLines.slice(1).join('\n');
      }
      calls.push({ type: 'write', path: stripQuotes(path), content, raw });
    } else if (tag === 'edit') {
      calls.push(parseEdit(attrPath, headerAttrsStr, body, attrs, raw));
    } else if (tag === 'grep' || tag === 'search') {
      calls.push({ type: 'grep', path: attrPath || undefined, query: attrs.query || attrs.q || body.trim(), raw });
    } else if (tag === 'note' || tag === 'scratchpad') {
      calls.push({ type: 'note', content: body.trim(), raw });
    } else if (tag === 'finish') {
      calls.push({ type: 'finish', summary: body.trim(), raw });
    }
  }
  return calls;
}
