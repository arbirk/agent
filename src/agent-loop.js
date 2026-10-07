import fs from 'node:fs';
import path from 'node:path';
import { Harness } from './harness.js';
import { LlmClient } from './llm.js';
import { parseToolCalls } from './parser.js';
import { getSystemPrompt, formatToolResults, listWorkspaceEntries } from './prompt.js';
import { ProjectMemory } from './memory.js';
import {
  estimateTokens,
  estimateMessagesTokens,
  compressionReason,
  truncateToTokens,
} from './tokenizer.js';

export function extractAndSaveTemplate(taskPrompt, workspaceDir) {
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(taskPrompt)) !== null) {
    const rawTag = (match[1] || '').trim().toLowerCase();
    const blockContent = match[2].trim();
    const lineCount = blockContent.split(/\r?\n/).length;

    if (lineCount < 5 && blockContent.length < 120) continue;

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
    else if (blockContent.includes('<!DOCTYPE') || /<[a-z]+[^>]*>/i.test(blockContent)) ext = 'html';
    else if (/^[\{\[]/.test(blockContent)) ext = 'json';

    const templateFileName = `template.${ext}`;
    const templateFilePath = path.join(workspaceDir, templateFileName);

    try {
      fs.writeFileSync(templateFilePath, blockContent, 'utf-8');
      return {
        templatePath: templateFileName,
        promptNotice: `\n\n💡 [Reference Template Offloaded]: The reference template provided in this prompt has been automatically saved to '${templateFileName}' in the workspace. Read '${templateFileName}' directly from disk rather than embedding large template strings inside helper scripts.`,
      };
    } catch {}
  }
  return {};
}

export class AgentLoop {
  constructor(config, harness = null, llm = null) {
    this.config = config;
    this.harness = harness || new Harness(config.workspaceDir, config.defaultShell, config.timeoutMs);
    this.llm = llm || new LlmClient(config);
    this.memory = new ProjectMemory(config.workspaceDir);
  }

  async runTask(taskPrompt, priorContextMessages = [], maxTurns = 25) {
    this.harness.reset();
    const templateInfo = extractAndSaveTemplate(taskPrompt, this.config.workspaceDir);
    if (templateInfo.templatePath) {
      console.log(`📄 [Template Ingested]: Saved to ${templateInfo.templatePath}`);
    }

    console.log(`\n======================================================`);
    console.log(`🚀 Starting Task: ${taskPrompt}`);
    console.log(`📂 Workspace Root: ${this.config.workspaceDir}`);
    console.log(`📋 Workspace Root Inventory:\n${listWorkspaceEntries(this.config.workspaceDir)}`);
    console.log(`======================================================\n`);

    const baseInstructionMessage = {
      role: 'system',
      content: truncateToTokens(getSystemPrompt(this.config.workspaceDir, this.config.defaultShell), 4000),
    };

    this.memory.ensureInitialized();
    const agentsMdContent = this.memory.load();
    const memoryMessage = {
      role: 'system',
      content: truncateToTokens(
        agentsMdContent
          ? `## Project Memory (from AGENTS.md):\n\n${agentsMdContent}`
          : `## Project Memory (from AGENTS.md):\n\n*(No AGENTS.md file found in workspace)*`,
        4000
      ),
    };

    if (agentsMdContent) {
      console.log(`📖 [Project Memory] Loaded AGENTS.md (~${estimateTokens(agentsMdContent)} tokens in Message 2)`);
    }

    const taskHistory = [
      {
        role: 'user',
        content: `Task: ${taskPrompt}${templateInfo.promptNotice || ''}\n\nEstablish your goals and tasklist, and execute your first action immediately with a tool block.`,
      },
    ];

    let turn = 0;
    let consecutiveNoTools = 0;
    let previousActionSignatures = [];
    let turnsSinceLastCompression = 99;

    while (turn < maxTurns) {
      turn++;
      turnsSinceLastCompression++;
      console.log(`\n--- [Turn ${turn}] ---`);

      const currentTaskTokens = estimateMessagesTokens(taskHistory);
      console.log(`[Token Usage] Current task context: ~${currentTaskTokens} tokens (Limit: ${this.config.maxTurnTokens})`);

      const compressionTrigger = compressionReason(
        taskHistory,
        this.config.maxTurnTokens,
        turnsSinceLastCompression >= 2
      );

      if (compressionTrigger) {
        turnsSinceLastCompression = 0;
        console.log(`\n⚠️  [Sliding Window Compression] ${compressionTrigger}`);
        console.log(`⏳ Condensing older turns while preserving recent working memory...`);

        try {
          const taskPromptMsg = taskHistory[0];
          const keepCount = Math.min(3, Math.max(0, taskHistory.length - 1));
          const recentItems = taskHistory.slice(taskHistory.length - keepCount);
          const olderItems = taskHistory.slice(1, taskHistory.length - keepCount);

          if (olderItems.length > 0) {
            const sanitizedOlder = olderItems.map((m) => ({
              role: m.role,
              content: truncateToTokens(m.content, 450),
            }));

            const compressedSummary = await this.llm.compressHistory(sanitizedOlder);
            console.log(`✅ [History Compressed Successfully]`);
            console.log(`--- Summary Snapshot ---\n${compressedSummary}\n-------------------------`);

            taskHistory.length = 0;
            taskHistory.push(taskPromptMsg);
            taskHistory.push({
              role: 'user',
              content: `[Previous Context Summary (Sliding Window)]:\n${compressedSummary}\n\nContinue executing your task.`,
            });
            taskHistory.push(...recentItems);
          }
        } catch (compressionErr) {
          console.error(`❌ Compression failed: ${compressionErr.message}. Pruning earliest actions.`);
          if (taskHistory.length > 2) taskHistory.splice(1, 2);
        }
      }

      // Refresh system prompt with fresh workspace entries and session state
      baseInstructionMessage.content = truncateToTokens(
        getSystemPrompt(this.config.workspaceDir, this.config.defaultShell) +
        this.harness.getSessionState(),
        4000
      );

      const messagesToSend = [baseInstructionMessage, memoryMessage, ...taskHistory];

      console.log(`📡 Querying LLM (${this.config.model || 'chat'})...`);
      let assistantResponse;
      try {
        assistantResponse = await this.llm.complete(messagesToSend);
      } catch (err) {
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

      const toolCalls = parseToolCalls(assistantResponse);
      const actionCalls = toolCalls.filter((c) => c.type !== 'finish');
      const finishCall = toolCalls.find((c) => c.type === 'finish');

      if (actionCalls.length > 0) {
        consecutiveNoTools = 0;
        const currentTurnSignatures = [];
        const results = [];

        for (const call of actionCalls) {
          const sig = `${call.type}:${call.path || ''}:${call.command || ''}`;
          currentTurnSignatures.push(sig);

          console.log(`⚙️  Executing [${call.type.toUpperCase()}]...`);
          const result = await this.harness.executeTool(call);

          if (previousActionSignatures.includes(sig)) {
            result.output += `\n\n[Notice]: Identical action repeated from previous turn. Try an alternative approach.`;
          }

          if (call.type === 'powershell' || call.type === 'bash') {
            const lines = (call.command || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            if (lines.length > 0 && lines.every((l) => l.startsWith('#') || l.startsWith('//'))) {
              result.output += `\n\n💡 [Harness Notice]: Running comments does not finish the task. If your work is done and verified, emit \`\`\`finish\`\`\` with your summary.`;
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
        taskHistory.push({
          role: 'user',
          content: formatToolResults(results, this.config.defaultShell),
        });

        if (finishCall && results.every((r) => r.success)) {
          const finishResult = await this.harness.executeTool(finishCall);
          if (!finishResult.success) {
            console.log(`❌ Finish rejected: ${finishResult.output}`);
            results.push(finishResult);
            taskHistory.push({
              role: 'user',
              content: formatToolResults(results, this.config.defaultShell),
            });
            continue;
          }

          console.log(`\n🎉 Task Completed!`);
          console.log(`Summary:\n${finishCall.summary}\n`);
          await this.memory.recordTask(taskPrompt, finishCall.summary, this.llm);
          return { success: true, finalMessage: finishCall.summary, turnCount: turn, history: taskHistory };
        }
        continue;
      }

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
        await this.memory.recordTask(taskPrompt, finishCall.summary, this.llm);
        return { success: true, finalMessage: finishCall.summary, turnCount: turn, history: taskHistory };
      }

      const isGreeting = /^(hi|hello|hey|good\s*(morning|afternoon|evening))\b/i.test(taskPrompt.trim());
      if (turn === 1 && isGreeting) {
        console.log(`💬 Greeting answered.`);
        return { success: true, finalMessage: assistantResponse, turnCount: turn, history: taskHistory };
      }

      consecutiveNoTools++;
      if (consecutiveNoTools < 4) {
        console.log(`⚠️  No tool calls detected (streak: ${consecutiveNoTools}). Prompting assistant to emit actions or finish.`);
        taskHistory.push({
          role: 'user',
          content: `Please execute your next step by emitting an actionable tool block (\`\`\`read\`\`\`, \`\`\`write\`\`\`, \`\`\`edit\`\`\`, \`\`\`${this.config.defaultShell}\`\`\`, or \`\`\`finish\`\`\`).`,
        });
        turn--;
        continue;
      }

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
