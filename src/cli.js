import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLlmConfig } from './llm.js';
import { AgentLoop } from './agent-loop.js';
import { SessionStore } from './session-store.js';
import { runInteractiveTui, renderTuiDashboard } from './tui.js';

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {}
}

export function loadConfig(workspaceDirOverride, debugOverride, debugLogPathOverride) {
  const resolvedWorkspace = path.resolve(
    workspaceDirOverride || process.env.AGENT_WORKSPACE_DIR || process.cwd()
  );

  // Load .env from workspace, then current directory, then agent repository root
  loadDotEnv(path.join(resolvedWorkspace, '.env'));
  loadDotEnv(path.resolve('.env'));
  try {
    const agentRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    loadDotEnv(path.join(agentRootDir, '.env'));
  } catch {}

  const isDebug = debugOverride ?? (process.env.DEBUG === '1' || process.env.DEBUG === 'true');

  return resolveLlmConfig({
    workspaceDir: resolvedWorkspace,
    defaultShell: process.env.AGENT_DEFAULT_SHELL || 'powershell',
    timeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || process.env.PI_TIMEOUT_MS || '60000', 10),
    debug: isDebug,
    debugLogPath: debugLogPathOverride || path.join(resolvedWorkspace, 'agent', 'llm-debug.jsonl'),
  });
}

export async function main() {
  const rawArgs = process.argv.slice(2);
  let workspaceDir;
  let debugMode;
  let debugLogPath;
  const taskWords = [];

  let showOverviewOnly = false;
  let showHistoryOnly = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--workspace' && i + 1 < rawArgs.length) {
      workspaceDir = rawArgs[++i];
    } else if (arg === '--debug' || arg === '-d') {
      debugMode = true;
    } else if (arg === '--debug-file' && i + 1 < rawArgs.length) {
      debugLogPath = rawArgs[++i];
      debugMode = true;
    } else if (arg === '--overview' || arg === '-o' || arg === '-Overview') {
      showOverviewOnly = true;
    } else if (arg === '--history' || arg === '-History') {
      showHistoryOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Code Agent - Autonomous CLI & Harness (CLM Safe)

Usage:
  node src/cli.js "<task prompt>"      Execute 1-shot task
  node src/cli.js                     Open interactive TUI dashboard

Options:
  -d, --debug            Log raw LLM request/response stream to disk in a JSONL file
  --debug-file <path>    Specify custom JSONL debug log file destination
  --workspace <path>     Workspace directory (defaults to current working directory)
  -o, --overview         Display the current session dashboard and exit
  --history              Display task history and exit
  -h, --help             Show this help message
`);
      process.exit(0);
    } else {
      taskWords.push(arg);
    }
  }

  const config = loadConfig(workspaceDir, debugMode, debugLogPath);

  if (config.debug) {
    console.log(`🐛 [Debug Mode] Logging LLM communications to: ${config.debugLogPath}`);
  }

  const loop = new AgentLoop(config);
  const sessionPath = path.join(config.workspaceDir, 'agent', 'session.json');
  const store = new SessionStore(sessionPath);

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
    } catch (err) {
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

// Only run automatically when executed directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
