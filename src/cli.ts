import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { AgentConfig, ChatMessage } from './types.js';
import { AgentLoop } from './agent-loop.js';
import { SessionStore } from './session-store.js';
import { runInteractiveTui, renderTuiDashboard } from './tui.js';

dotenv.config();

function loadConfig(
  workspaceDirOverride?: string,
  debugOverride?: boolean,
  debugLogPathOverride?: string
): AgentConfig {
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  const defaultBaseUrl = process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY
    ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
    : 'https://openrouter.ai/api/v1';

  const defaultModel = process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY
    ? 'gemini-flash-lite-latest'
    : 'openai/gpt-4o';

  const resolvedWorkspace = path.resolve(
    workspaceDirOverride ||
    process.env.AGENT_WORKSPACE_DIR ||
    process.cwd()
  );

  const isDebug = debugOverride ?? (process.env.DEBUG === '1' || process.env.DEBUG === 'true');

  return {
    baseUrl: process.env.LLM_BASE_URL || defaultBaseUrl,
    apiKey,
    model: process.env.LLM_MODEL || defaultModel,
    maxTurnTokens: parseInt(process.env.MAX_TURN_TOKENS || '4000', 10),
    maxTotalTokens: parseInt(process.env.MAX_TOTAL_CONTEXT_TOKENS || '32000', 10),
    workspaceDir: resolvedWorkspace,
    defaultShell: (process.env.PI_DEFAULT_SHELL as any) || 'powershell',
    timeoutMs: parseInt(process.env.PI_TIMEOUT_MS || '60000', 10),
    debug: isDebug,
    debugLogPath: debugLogPathOverride || path.join(resolvedWorkspace, 'agent', 'openrouter-debug.jsonl'),
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  let workspaceDir: string | undefined;
  let debugMode: boolean | undefined;
  let debugLogPath: string | undefined;
  const taskWords: string[] = [];

  let showOverviewOnly = false;
  let showHistoryOnly = false;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--workspace' && i + 1 < rawArgs.length) {
      workspaceDir = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === '--debug' || rawArgs[i] === '-d') {
      debugMode = true;
    } else if (rawArgs[i] === '--debug-file' && i + 1 < rawArgs.length) {
      debugLogPath = rawArgs[i + 1];
      debugMode = true;
      i++;
    } else if (rawArgs[i] === '--overview' || rawArgs[i] === '-o' || rawArgs[i] === '-Overview') {
      showOverviewOnly = true;
    } else if (rawArgs[i] === '--history' || rawArgs[i] === '-History') {
      showHistoryOnly = true;
    } else if (rawArgs[i] === '--help' || rawArgs[i] === '-h') {
      console.log(`
Pi Code Agent - Autonomous Markdown CLI Harness

Usage:
  .\\agent.ps1 "<task prompt>"      Execute 1-shot task
  .\\agent.ps1                     Open interactive TUI dashboard

Options:
  -d, --debug            Stream raw OpenRouter message stream to disk in a JSONL file
  --debug-file <path>    Specify custom JSONL debug log file destination
  --workspace <path>     Workspace directory (defaults to current working directory)
  -o, --overview         Display the current session dashboard and exit
  --history              Display task history and exit
  -h, --help             Show this help message
`);
      process.exit(0);
    } else {
      taskWords.push(rawArgs[i]);
    }
  }

  const config = loadConfig(workspaceDir, debugMode, debugLogPath);

  if (!config.apiKey) {
    console.error('❌ Error: No API key provided.');
    console.error('Please set LLM_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in .env or environment.');
    process.exit(1);
  }

  if (config.debug) {
    console.log(`🐛 [Debug Mode] Streaming raw OpenRouter messages to: ${config.debugLogPath}`);
  }

  const loop = new AgentLoop(config);
  const dbPath = path.join(config.workspaceDir, 'agent', 'session.sqlite');
  const store = new SessionStore(dbPath);

  if (showOverviewOnly) {
    const session = store.getOrCreateActiveSession(config.workspaceDir);
    const overview = store.getOverview(session.id);
    if (overview) renderTuiDashboard(overview, config);
    store.close();
    process.exit(0);
  }

  if (showHistoryOnly) {
    const session = store.getOrCreateActiveSession(config.workspaceDir);
    const tasks = store.getTasks(session.id);
    console.log(`\n📜 Task History for ${config.workspaceDir}:`);
    if (tasks.length === 0) {
      console.log('No tasks executed yet in this session.');
    } else {
      tasks.forEach((t, idx) => {
        const badge = t.status === 'success' ? '✔ PASS' : '❌ FAIL';
        const dur = t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}s` : '0s';
        console.log(`[#${idx + 1}] ${badge} (${dur}) ${t.prompt}`);
        if (t.summary) console.log(`      ↳ ${t.summary}`);
      });
    }
    store.close();
    process.exit(0);
  }

  // One-shot command execution
  if (taskWords.length > 0) {
    const task = taskWords.length === 1 ? taskWords[0] : taskWords.join(' ');
    const session = store.getOrCreateActiveSession(config.workspaceDir);
    const taskRecord = store.recordTaskStart(session.id, task);
    const startTime = Date.now();

    try {
      const result = await loop.runTask(task);
      const durationMs = Date.now() - startTime;
      store.recordTaskFinish(taskRecord.id, {
        success: result.success,
        exitCode: result.success ? 0 : 1,
        durationMs,
        summary: result.finalMessage,
      });
      store.close();
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      store.recordTaskFinish(taskRecord.id, {
        success: false,
        exitCode: 1,
        durationMs,
        error: err.message,
        summary: `Error: ${err.message}`,
      });
      store.close();
      process.exit(1);
    }
  }

  // Interactive TUI session
  await runInteractiveTui(loop, config, store);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
