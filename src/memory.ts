import * as fs from 'fs';
import * as path from 'path';
import { LlmClient } from './llm-client.js';
import { estimateTokens } from './tokenizer.js';

const AGENT_DIR_NAME = 'agent';
const AGENTS_MD_FILENAME = 'AGENTS.md';
export const MAX_MEMORY_TOKENS = 4000;

/**
 * Prunes the oldest Change Log entries if the content exceeds maxTokens.
 * Preserves Project Overview and Working Patterns, removing entries from the bottom of Change Log.
 */
export function pruneMemoryLog(content: string, maxTokens: number = MAX_MEMORY_TOKENS): string {
  if (estimateTokens(content) <= maxTokens) {
    return content;
  }

  const changeLogHeader = '## Change Log';
  const changeLogIdx = content.indexOf(changeLogHeader);
  if (changeLogIdx === -1) {
    const ratio = maxTokens / Math.max(1, estimateTokens(content));
    return content.slice(0, Math.floor(content.length * ratio * 0.9));
  }

  const prefix = content.slice(0, changeLogIdx + changeLogHeader.length);
  const logSection = content.slice(changeLogIdx + changeLogHeader.length);

  // Split into entries by ### [
  const entries = logSection.split(/(?=###\s*\[)/);
  if (entries.length <= 1) {
    return content.slice(0, Math.floor(maxTokens * 3.5));
  }

  // Remove oldest entries from the end until under budget
  const keptEntries = [...entries];
  while (keptEntries.length > 1) {
    keptEntries.pop();
    const candidate = `${prefix}${keptEntries.join('')}\n\n*(Older change log entries pruned to stay under ${maxTokens} tokens)*`;
    if (estimateTokens(candidate) <= maxTokens) {
      return candidate;
    }
  }

  return `${prefix}${keptEntries.join('')}`;
}

export class ProjectMemory {
  private workspaceDir: string;
  private agentDir: string;
  private filePath: string;
  private legacyFilePath: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.agentDir = path.join(this.workspaceDir, AGENT_DIR_NAME);
    this.filePath = path.join(this.agentDir, AGENTS_MD_FILENAME);
    this.legacyFilePath = path.join(this.workspaceDir, AGENTS_MD_FILENAME);
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public getAgentDir(): string {
    return this.agentDir;
  }

  /**
   * Ensures the agent/ directory and an initial AGENTS.md file exist in the workspace.
   */
  public ensureInitialized(): string {
    if (!fs.existsSync(this.agentDir)) {
      try {
        fs.mkdirSync(this.agentDir, { recursive: true });
      } catch {}
    }
    const current = this.load();
    if (current) return current;

    const initial = `# Project Overview\nWorkspace: ${path.basename(this.workspaceDir)}\n\n## Working Patterns & Tech Stack\n- Shell: PowerShell\n\n## Change Log\n*(Ready for tasks)*\n`;
    try {
      fs.writeFileSync(this.filePath, initial, 'utf-8');
      console.log(`🧠 [Project Memory] Initialized agent/${AGENTS_MD_FILENAME}`);
      return initial;
    } catch {
      return '';
    }
  }

  /**
   * Reads AGENTS.md from agent/ (or migrates from workspace root if present), ensuring it stays under 4,000 tokens.
   */
  public load(): string | null {
    // 1. Auto-migrate legacy root AGENTS.md to agent/AGENTS.md if needed
    if (!fs.existsSync(this.filePath) && fs.existsSync(this.legacyFilePath)) {
      try {
        if (!fs.existsSync(this.agentDir)) {
          fs.mkdirSync(this.agentDir, { recursive: true });
        }
        const legacyContent = fs.readFileSync(this.legacyFilePath, 'utf-8');
        fs.writeFileSync(this.filePath, legacyContent, 'utf-8');
        fs.unlinkSync(this.legacyFilePath);
        console.log(`📦 [Project Memory] Migrated AGENTS.md to agent/AGENTS.md`);
      } catch (err: any) {
        console.error(`⚠️ Could not migrate legacy AGENTS.md: ${err.message}`);
      }
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const rawContent = fs.readFileSync(this.filePath, 'utf-8').trim();
        if (rawContent.length === 0) return null;

        // Ensure file stays within 4,000 token limit
        const pruned = pruneMemoryLog(rawContent, MAX_MEMORY_TOKENS);
        if (pruned !== rawContent) {
          fs.writeFileSync(this.filePath, pruned, 'utf-8');
          console.log(`🧹 [Project Memory] Pruned oldest entries in agent/${AGENTS_MD_FILENAME} to stay under ${MAX_MEMORY_TOKENS} tokens.`);
        }
        return pruned;
      } catch (err: any) {
        console.error(`⚠️ Could not read agent/${AGENTS_MD_FILENAME}: ${err.message}`);
      }
    }
    return null;
  }

  /**
   * Updates or initializes AGENTS.md with a new change log entry and refreshed project overview.
   */
  public async recordTask(
    userRequest: string,
    solutionSummary: string,
    llm: LlmClient
  ): Promise<void> {
    const existingContent = this.load();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const updatePrompt = `You are maintaining the AGENTS.md project memory file for the workspace.
Here is the current content of AGENTS.md (or empty if new):
---
${existingContent || '(None yet - new file)'}
---

The following task was just completed:
- **User Request**: "${userRequest}"
- **Solution / Result**: "${solutionSummary}"

Generate the updated content of AGENTS.md in clean Markdown format with the following exact structure:

# Project Overview
<2-3 concise sentences describing what this project/workspace is and its current state>

## Working Patterns & Tech Stack
<Bullet points of key technologies, working CDN URLs/packages, ports, or quirks discovered>

## Change Log
### [${timestamp}] ${userRequest.length > 60 ? userRequest.substring(0, 60) + '...' : userRequest}
- **Request**: ${userRequest}
- **Solution**: ${solutionSummary}

${existingContent ? '<Include previous Change Log entries below this new one>' : ''}

RULES:
1. Total output must be concise.
2. Put the NEWEST change log entry at the TOP of the Change Log.
3. Keep previous change log entries underneath.
4. Output ONLY raw Markdown content without extra conversational text.`;

    try {
      const updatedMarkdown = await llm.complete(
        [
          {
            role: 'system',
            content: 'You are an expert technical documenter who creates precise, factual AGENTS.md memory files.',
          },
          {
            role: 'user',
            content: updatePrompt,
          },
        ],
        0.1
      );

      // Clean any accidental wrapper fences
      let cleanContent = updatedMarkdown.trim();
      if (cleanContent.startsWith('```markdown')) {
        cleanContent = cleanContent.replace(/^```markdown\r?\n/, '').replace(/```$/, '').trim();
      } else if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```\r?\n/, '').replace(/```$/, '').trim();
      }

      // Enforce the 4,000 token limit by pruning oldest entries from the bottom if necessary
      const finalContent = pruneMemoryLog(cleanContent, MAX_MEMORY_TOKENS);

      // Ensure agent directory exists
      if (!fs.existsSync(this.agentDir)) {
        fs.mkdirSync(this.agentDir, { recursive: true });
      }

      fs.writeFileSync(this.filePath, finalContent, 'utf-8');
      console.log(`📝 [Project Memory] Updated agent/${AGENTS_MD_FILENAME} (${estimateTokens(finalContent)} tokens)`);
    } catch (err: any) {
      console.error(`❌ Failed to update agent/${AGENTS_MD_FILENAME}: ${err.message}`);
      // Fallback simple append if LLM call fails
      this.fallbackAppend(timestamp, userRequest, solutionSummary);
    }
  }

  private fallbackAppend(timestamp: string, request: string, solution: string): void {
    const entry = `\n\n### [${timestamp}] ${request}\n- **Request**: ${request}\n- **Solution**: ${solution}`;
    if (!fs.existsSync(this.agentDir)) {
      fs.mkdirSync(this.agentDir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      const initial = `# Project Overview\nLocal workspace project.\n\n## Change Log${entry}`;
      fs.writeFileSync(this.filePath, initial, 'utf-8');
    } else {
      const current = fs.readFileSync(this.filePath, 'utf-8');
      const updated = pruneMemoryLog(current + entry, MAX_MEMORY_TOKENS);
      fs.writeFileSync(this.filePath, updated, 'utf-8');
    }
  }
}
