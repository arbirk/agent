import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './tokenizer.js';

export const MAX_MEMORY_TOKENS = 4000;

/** Drops the oldest Change Log entries (bottom of the log) until content fits maxTokens. */
export function pruneMemoryLog(content, maxTokens = MAX_MEMORY_TOKENS) {
  if (estimateTokens(content) <= maxTokens) return content;

  const header = '## Change Log';
  const idx = content.indexOf(header);
  if (idx === -1) return content.slice(0, Math.floor(maxTokens * 3.5 * 0.9));

  const prefix = content.slice(0, idx + header.length);
  const entries = content.slice(idx + header.length).split(/(?=###\s*\[)/);
  if (entries.length <= 1) return content.slice(0, Math.floor(maxTokens * 3.5));

  while (entries.length > 1) {
    entries.pop();
    const candidate = `${prefix}${entries.join('')}\n\n*(Older change log entries pruned to stay under ${maxTokens} tokens)*`;
    if (estimateTokens(candidate) <= maxTokens) return candidate;
  }
  return `${prefix}${entries.join('')}`;
}

function stripFences(text) {
  return text.trim().replace(/^```(?:markdown)?\r?\n/, '').replace(/```$/, '').trim();
}

/** Manages <workspace>/agent/AGENTS.md: project overview, working patterns and change log. */
export class ProjectMemory {
  constructor(workspaceDir) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.agentDir = path.join(this.workspaceDir, 'agent');
    this.filePath = path.join(this.agentDir, 'AGENTS.md');
    this.legacyFilePath = path.join(this.workspaceDir, 'AGENTS.md');
  }

  ensureInitialized() {
    const current = this.load();
    if (current) return current;
    const initial = `# Project Overview\nWorkspace: ${path.basename(this.workspaceDir)}\n\n## Working Patterns & Tech Stack\n- Shell: PowerShell\n\n## Change Log\n*(Ready for tasks)*\n`;
    try {
      fs.mkdirSync(this.agentDir, { recursive: true });
      fs.writeFileSync(this.filePath, initial, 'utf-8');
      console.log('🧠 [Project Memory] Initialized agent/AGENTS.md');
      return initial;
    } catch {
      return '';
    }
  }

  load() {
    if (!fs.existsSync(this.filePath) && fs.existsSync(this.legacyFilePath)) {
      try {
        fs.mkdirSync(this.agentDir, { recursive: true });
        const legacyContent = fs.readFileSync(this.legacyFilePath, 'utf-8');
        fs.writeFileSync(this.filePath, legacyContent, 'utf-8');
        fs.unlinkSync(this.legacyFilePath);
      } catch {}
    }
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (!raw) return null;
      const pruned = pruneMemoryLog(raw);
      if (pruned !== raw) {
        fs.writeFileSync(this.filePath, pruned, 'utf-8');
        console.log(`🧹 [Project Memory] Pruned oldest entries in agent/AGENTS.md to stay under ${MAX_MEMORY_TOKENS} tokens.`);
      }
      return pruned;
    } catch (err) {
      console.error(`⚠️ Could not read agent/AGENTS.md: ${err.message}`);
      return null;
    }
  }

  async recordTask(userRequest, solutionSummary, llm) {
    const existing = this.load();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const title = userRequest.length > 60 ? userRequest.substring(0, 60) + '...' : userRequest;

    const prompt = `You maintain the AGENTS.md project memory file for this workspace.
Current content (empty if new):
---
${existing || '(None yet - new file)'}
---

Task just completed:
- **User Request**: "${userRequest}"
- **Solution / Result**: "${solutionSummary}"

Produce the updated AGENTS.md in Markdown with exactly this structure:

# Project Overview
<2-3 concise sentences describing the workspace and its current state>

## Working Patterns & Tech Stack
<Bullet points of key technologies, packages, ports, or quirks discovered>

## Change Log
### [${timestamp}] ${title}
- **Request**: ${userRequest}
- **Solution**: ${solutionSummary}
${existing ? '\n<previous Change Log entries below this new one>' : ''}

RULES: Be concise. Newest entry at the TOP of the Change Log, previous entries underneath. Output ONLY the raw Markdown.`;

    try {
      const updated = await llm.complete(
        [
          { role: 'system', content: 'You are a precise technical documenter who maintains factual AGENTS.md memory files.' },
          { role: 'user', content: prompt },
        ],
        0.1
      );
      const finalContent = pruneMemoryLog(stripFences(updated));
      fs.mkdirSync(this.agentDir, { recursive: true });
      fs.writeFileSync(this.filePath, finalContent, 'utf-8');
      console.log(`📝 [Project Memory] Updated agent/AGENTS.md (${estimateTokens(finalContent)} tokens)`);
    } catch (err) {
      console.error(`❌ Failed to update agent/AGENTS.md: ${err.message}`);
      this.appendEntry(timestamp, userRequest, solutionSummary);
    }
  }

  appendEntry(timestamp, request, solution) {
    const entry = `\n\n### [${timestamp}] ${request}\n- **Request**: ${request}\n- **Solution**: ${solution}`;
    fs.mkdirSync(this.agentDir, { recursive: true });
    const current = fs.existsSync(this.filePath)
      ? fs.readFileSync(this.filePath, 'utf-8')
      : '# Project Overview\nLocal workspace project.\n\n## Change Log';
    fs.writeFileSync(this.filePath, pruneMemoryLog(current + entry), 'utf-8');
  }
}
