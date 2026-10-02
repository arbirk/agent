import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, ToolResult, AgentConfig, ToolCall } from './types.js';
import { PiHarness } from './harness/pi-harness.js';
import { LlmClient } from './llm-client.js';
import { parseToolCalls } from './parser.js';
import { getSystemPrompt, formatToolResults, listWorkspaceEntries } from './prompt.js';
import { ProjectMemory } from './memory.js';
import {
  estimateTokens,
  estimateMessagesTokens,
  exceedsTurnBudget,
  shouldCompressAggressively,
  truncateToTokens,
  exceedsTotalBudget,
} from './tokenizer.js';

export interface TaskResult {
  success: boolean;
  finalMessage: string;
  turnCount: number;
  history: ChatMessage[];
}

/**
 * Detects reference templates or boilerplates embedded inside the task prompt,
 * offloads them cleanly to disk as a workspace reference asset, and provides a prompt notice.
 * Prevents massive LLM token waste, escaping collisions, and script bloat.
 * Fully language-agnostic (supports HTML, JSON, XML, SQL, YAML, Python, JS/TS, etc.) and content-neutral.
 */
export function extractAndSaveTemplate(
  taskPrompt: string,
  workspaceDir: string
): { templatePath?: string; promptNotice?: string } {
  // Matches any fenced code block with an optional language tag
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(taskPrompt)) !== null) {
    const rawTag = (match[1] || '').trim().toLowerCase();
    const blockContent = match[2].trim();

    // Only offload substantial templates/boilerplates (> 5 lines or > 120 chars)
    const lineCount = blockContent.split(/\r?\n/).length;
    if (lineCount < 5 && blockContent.length < 120) {
      continue;
    }

    // Determine extension agnostically
    let ext = 'template';
    if (['html', 'htm'].includes(rawTag)) ext = 'html';
    else if (['json', 'jsonc'].includes(rawTag)) ext = 'json';
    else if (['xml', 'svg'].includes(rawTag)) ext = 'xml';
    else if (['sql'].includes(rawTag)) ext = 'sql';
    else if (['yaml', 'yml'].includes(rawTag)) ext = 'yaml';
    else if (['csv', 'tsv'].includes(rawTag)) ext = 'csv';
    else if (['js', 'javascript', 'mjs'].includes(rawTag)) ext = 'js';
    else if (['ts', 'typescript'].includes(rawTag)) ext = 'ts';
    else if (['py', 'python'].includes(rawTag)) ext = 'py';
    else if (['css'].includes(rawTag)) ext = 'css';
    else if (rawTag) ext = rawTag;
    else {
      // Untagged: infer from content signature if possible
      if (blockContent.includes('<!DOCTYPE') || /<[a-z]+[^>]*>/i.test(blockContent)) {
        ext = 'html';
      } else if (/^[\{\[]/.test(blockContent)) {
        ext = 'json';
      }
    }

    const templateFileName = `template.${ext}`;
    const templateFilePath = path.join(workspaceDir, templateFileName);

    try {
      fs.writeFileSync(templateFilePath, blockContent, 'utf-8');
      return {
        templatePath: templateFileName,
        promptNotice: `\n\n💡 [Reference Template Offloaded]: The reference template provided in this prompt has been automatically saved to '${templateFileName}' in the workspace.
Recommended pattern: Read '${templateFileName}' directly from disk rather than embedding large multi-line template strings inside your helper scripts. Use a clean file pipeline to read the source data, read '${templateFileName}', inject the transformed data into the appropriate placeholders, and write the output file directly.`,
      };
    } catch {}
  }

  return {};
}

export class AgentLoop {
  private config: AgentConfig;
  private harness: PiHarness;
  private llm: LlmClient;
  private memory: ProjectMemory;
  private systemPrompt: string;

  constructor(config: AgentConfig) {
    this.config = config;
    this.harness = new PiHarness(
      config.workspaceDir,
      config.defaultShell,
      config.timeoutMs
    );
    this.llm = new LlmClient(config);
    this.memory = new ProjectMemory(config.workspaceDir);
    this.systemPrompt = getSystemPrompt(config.workspaceDir, config.defaultShell);
  }

  /**
   * Runs a single task as its own separate small loop.
   * Maintains the 4,000-token per-turn limit and respects the 32,000-token overall context limit.
   */
  public async runTask(
    taskPrompt: string,
    priorContextMessages: ChatMessage[] = [],
    maxTurns: number = 25
  ): Promise<TaskResult> {
    const templateInfo = extractAndSaveTemplate(taskPrompt, this.config.workspaceDir);
    if (templateInfo.templatePath) {
      console.log(`📄 [Template Ingested]: Reference template detected in task prompt and saved to ${templateInfo.templatePath}`);
    }

    console.log(`\n======================================================`);
    console.log(`🚀 Starting Task: ${taskPrompt}`);
    console.log(`📂 Workspace Root: ${this.config.workspaceDir}`);
    console.log(`📋 Workspace Root Inventory:\n${listWorkspaceEntries(this.config.workspaceDir)}`);
    console.log(`======================================================\n`);

    // Message 1: Base instructions & harness with fresh workspace inventory (dedicated up to 4000 tokens)
    this.systemPrompt = truncateToTokens(
      getSystemPrompt(this.config.workspaceDir, this.config.defaultShell),
      4000
    );
    const baseInstructionMessage: ChatMessage = {
      role: 'system',
      content: this.systemPrompt,
    };

    // Message 2: Project Memory from AGENTS.md (dedicated up to 4000 tokens)
    this.memory.ensureInitialized();
    const agentsMdContent = this.memory.load();
    const rawMemoryText = agentsMdContent
      ? `## Project Memory (from AGENTS.md):\n\n${agentsMdContent}`
      : `## Project Memory (from AGENTS.md):\n\n*(No AGENTS.md file found in workspace)*`;
    const memoryMessage: ChatMessage = {
      role: 'system',
      content: truncateToTokens(rawMemoryText, 4000),
    };

    const baseMessages = [baseInstructionMessage, memoryMessage];
    const baseTokens = estimateMessagesTokens(baseMessages);
    if (agentsMdContent) {
      console.log(`📖 [Project Memory] Loaded AGENTS.md (~${estimateTokens(agentsMdContent)} tokens in Message 2)`);
    }

    // Message 3 onwards: Current context / task history (dedicated 4,000 token limit)
    const taskHistory: ChatMessage[] = [
      {
        role: 'user',
        content: `Task: ${taskPrompt}${templateInfo.promptNotice || ''}\n\nEstablish your goals and tasklist, and execute your first action immediately with a tool block.`,
      },
    ];

    let turn = 0;
    let consecutiveNoTools = 0;
    let previousActionSignatures: string[] = [];
    let turnsSinceLastCompression = 99;

    while (turn < maxTurns) {
      turn++;
      turnsSinceLastCompression++;
      console.log(`\n--- [Turn ${turn}] ---`);

      // Check dedicated 4,000 token budget for current task context (Message 3 onwards)
      const currentTaskTokens = estimateMessagesTokens(taskHistory);
      console.log(
        `[Token Usage] Current task context: ~${currentTaskTokens} tokens (Limit: ${this.config.maxTurnTokens}) | Base prompt: ~${baseTokens} tokens`
      );

      const isOverBudget = exceedsTurnBudget(taskHistory, this.config.maxTurnTokens);
      const isLongLoop =
        turnsSinceLastCompression >= 2 &&
        shouldCompressAggressively(
          taskHistory,
          this.config.maxTurnTokens,
          turn,
          taskHistory.length
        );

      if (isOverBudget || isLongLoop) {
        turnsSinceLastCompression = 0;
        const reason = isOverBudget
          ? `Current task context (~${currentTaskTokens} tokens) reached ${this.config.maxTurnTokens} threshold!`
          : `Long loop detected on turn ${turn} (~${currentTaskTokens} tokens, ${taskHistory.length} history items)`;
        console.log(`\n⚠️  [Sliding Window Compression] ${reason}`);
        console.log(`⏳ Condensing older turns while preserving recent working memory...`);

        try {
          const taskPromptMsg = taskHistory[0];
          const RECENT_TO_KEEP = 3;
          const keepCount = Math.min(RECENT_TO_KEEP, Math.max(0, taskHistory.length - 1));
          const recentItems = taskHistory.slice(taskHistory.length - keepCount);
          const olderItems = taskHistory.slice(1, taskHistory.length - keepCount);

          if (olderItems.length > 0) {
            const sanitizedOlder = olderItems.map((m) => ({
              role: m.role,
              content: truncateToTokens(m.content, 450),
            }));

            const compressedSummary = await this.llm.compressHistory(sanitizedOlder);
            console.log(`✅ [History Compressed Successfully (Sliding Window)]`);
            console.log(`--- Summary Snapshot ---\n${compressedSummary}\n-------------------------`);

            taskHistory.length = 0;
            taskHistory.push(taskPromptMsg);
            taskHistory.push({
              role: 'user',
              content: `[Previous Context Summary (Sliding Window)]:\n${compressedSummary}\n\nContinue executing your task.`,
            });
            taskHistory.push(...recentItems);
          }
        } catch (compressionErr: any) {
          console.error(`❌ Compression failed: ${compressionErr.message}. Pruning earliest actions.`);
          if (taskHistory.length > 2) {
            taskHistory.splice(1, 2);
          }
        }
      }

      // Refresh Message 1 with latest workspace files & folders, plus active session state (capped at 4000 tokens)
      baseInstructionMessage.content = truncateToTokens(
        getSystemPrompt(this.config.workspaceDir, this.config.defaultShell) +
        this.harness.getSessionState(),
        4000
      );

      // Prepare request payload:
      // Message 1: Base instructions & harness
      // Message 2: Project Memory (AGENTS.md)
      // Message 3 onwards: Current context / task history
      const messagesToSend: ChatMessage[] = [
        baseInstructionMessage,
        memoryMessage,
        ...taskHistory,
      ];

      console.log(`📡 Querying LLM (${this.config.model})...`);
      let assistantResponse: string;
      try {
        assistantResponse = await this.llm.complete(messagesToSend);
      } catch (err: any) {
        console.error(`❌ LLM Request Error: ${err.message}`);
        return {
          success: false,
          finalMessage: `LLM call failed: ${err.message}`,
          turnCount: turn,
          history: taskHistory,
        };
      }

      console.log(`\n🤖 Assistant:\n${assistantResponse}\n`);
      taskHistory.push({ role: 'assistant', content: assistantResponse });

      // Parse markdown tool calls
      const toolCalls = parseToolCalls(assistantResponse);

      const actionCalls = toolCalls.filter((c) => c.type !== 'finish');
      const finishCall = toolCalls.find((c) => c.type === 'finish');

      // If action calls are present, execute all actions and feed results back for verification
      if (actionCalls.length > 0) {
        consecutiveNoTools = 0;
        const currentTurnSignatures: string[] = [];
        const results: ToolResult[] = [];

        for (const call of actionCalls) {
          const sig = `${call.type}:${(call as any).path || ''}:${(call as any).command || ''}`;
          currentTurnSignatures.push(sig);

          console.log(`⚙️  Executing [${call.type.toUpperCase()}]...`);
          const result = await this.harness.executeTool(call);

          // Detect loop repetition
          if (previousActionSignatures.includes(sig)) {
            result.output += `\n\n[Notice]: Identical action repeated from previous turn. Consider trying an alternative approach or script.`;
          }

          // If a shell command only contains comments, instruct the model to emit finish
          if (call.type === 'powershell' || call.type === 'bash') {
            const lines = (call.command || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const isOnlyComments = lines.length > 0 && lines.every((l) => l.startsWith('#') || l.startsWith('//'));
            if (isOnlyComments) {
              result.output += `\n\n💡 [Harness Notice]: Running a comment command does not finish the task. If your work is done and verified, please emit a \`\`\`finish\`\`\` block containing your final summary.`;
            }
          }

          results.push(result);

          const statusIcon = result.success ? '✅' : '❌';
          console.log(`${statusIcon} [${call.type.toUpperCase()}] ${result.success ? 'Success' : 'Failed'}`);
          if (result.output) {
            const preview = result.output.length > 300 ? result.output.slice(0, 300) + '...' : result.output;
            console.log(`   Output: ${preview.replace(/\n/g, ' ')}`);
          }
        }

        previousActionSignatures = currentTurnSignatures;

        const formattedResults = formatToolResults(results, this.config.defaultShell);
        taskHistory.push({
          role: 'user',
          content: formattedResults,
        });

        // If finishCall was also included in the same turn and all actions succeeded:
        if (finishCall && results.every((r) => r.success)) {
          const finishResult = await this.harness.executeTool(finishCall);
          if (!finishResult.success) {
            console.log(`❌ Finish rejected: ${finishResult.output}`);
            results.push(finishResult);
            const formattedResults = formatToolResults(results, this.config.defaultShell);
            taskHistory.push({
              role: 'user',
              content: formattedResults,
            });
            continue;
          }

          console.log(`\n🎉 Task Completed! (Actions completed with finish)`);
          console.log(`Summary:\n${finishCall.summary}\n`);

          // Update AGENTS.md memory
          await this.memory.recordTask(taskPrompt, finishCall.summary, this.llm);

          return {
            success: true,
            finalMessage: finishCall.summary,
            turnCount: turn,
            history: taskHistory,
          };
        }

        // Continue to let model observe results and verify or conclude
        continue;
      }

      // If ONLY finish block was emitted without pending actions
      if (finishCall && finishCall.type === 'finish') {
        const finishResult = await this.harness.executeTool(finishCall);
        if (!finishResult.success) {
          console.log(`❌ Finish rejected: ${finishResult.output}`);
          taskHistory.push({
            role: 'user',
            content: `### Tool Result [FINISH] - FAILED\n\`\`\`\n${finishResult.output}\n\`\`\``,
          });
          continue;
        }

        console.log(`\n🎉 Task Completed!`);
        console.log(`Summary:\n${finishCall.summary}\n`);

        // Update AGENTS.md memory
        await this.memory.recordTask(taskPrompt, finishCall.summary, this.llm);

        return {
          success: true,
          finalMessage: finishCall.summary,
          turnCount: turn,
          history: taskHistory,
        };
      }

      // Handle responses without tool calls
      const isGreeting = /^(hi|hello|hey|good\s*(morning|afternoon|evening))\b/i.test(taskPrompt.trim());
      if (turn === 1 && isGreeting) {
        console.log(`💬 Greeting answered.`);
        return {
          success: true,
          finalMessage: assistantResponse,
          turnCount: turn,
          history: taskHistory,
        };
      }

      consecutiveNoTools++;
      if (consecutiveNoTools < 4) {
        console.log(`⚠️  No tool calls detected (streak: ${consecutiveNoTools}). Prompting assistant to emit actions or finish.`);
        taskHistory.push({
          role: 'user',
          content: `Please execute your next step by emitting an actionable tool block (\`\`\`read\`\`\`, \`\`\`write\`\`\`, \`\`\`edit\`\`\`, \`\`\`${this.config.defaultShell}\`\`\`, or \`\`\`finish\`\`\`).`,
        });
        turn--; // Do not count conversational chatter against the max turns limit
        continue;
      }

      // If 4 consecutive turns with no tool blocks, abort the task as failed
      console.log(`❌ Task aborted: Model failed to provide tool actions after ${consecutiveNoTools} attempts.`);
      return {
        success: false,
        finalMessage: `Task stalled: Assistant provided conversational text without actionable tool blocks.`,
        turnCount: turn,
        history: taskHistory,
      };
    }

    console.log(`⚠️  Task stopped after reaching maximum turn limit (${maxTurns}).`);
    return {
      success: false,
      finalMessage: `Task reached maximum turn limit (${maxTurns}) without finishing.`,
      turnCount: turn,
      history: taskHistory,
    };
  }
}
