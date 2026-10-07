import readline from 'node:readline';
import path from 'node:path';

// ANSI formatting helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

export function renderTuiDashboard(overview, config) {
  const { session, tasks, todos, notes, stats } = overview;
  const divider = '─'.repeat(72);

  console.log(`\n${c.cyan}${c.bold}┌${divider}┐${c.reset}`);
  console.log(
    `${c.cyan}${c.bold}│${c.reset}  🤖  ${c.bold}PI CODE AGENT TUI${c.reset}  ${c.gray}[Session: ${session.id}]${c.reset}`.padEnd(81) +
      `${c.cyan}${c.bold}│${c.reset}`
  );
  console.log(`${c.cyan}${c.bold}├${divider}┤${c.reset}`);

  // Workspace & Config
  console.log(`${c.cyan}${c.bold}│${c.reset}  📂 Workspace : ${c.yellow}${session.workspace}${c.reset}`);
  console.log(`${c.cyan}${c.bold}│${c.reset}  🧠 Model     : ${c.white}${config.model || 'chat'}${c.reset} ${c.gray}(Turn limit: ${config.maxTurnTokens || 4000}t | Total: ${config.maxTotalTokens || 32000}t)${c.reset}`);
  console.log(
    `${c.cyan}${c.bold}│${c.reset}  📊 Tasks     : ${c.green}${stats.successTasks} Succeeded${c.reset} | ${c.red}${stats.failedTasks} Failed${c.reset} | ${stats.totalTasks} Total`
  );
  console.log(
    `${c.cyan}${c.bold}│${c.reset}  📝 Checklist : ${c.green}${stats.completedTodos} Done${c.reset} | ${c.yellow}${stats.pendingTodos} Pending${c.reset}`
  );

  // Todos / Checklist Section
  if (todos.length > 0) {
    console.log(`${c.cyan}${c.bold}├${divider}┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.bold}Checklist & Goals:${c.reset}`);
    todos.slice(-6).forEach((todo, idx) => {
      const checkbox = todo.done ? `${c.green}[✔]${c.reset}` : `${c.yellow}[ ]${c.reset}`;
      console.log(`${c.cyan}${c.bold}│${c.reset}    ${checkbox} ${todo.text} ${c.gray}(#${idx + 1})${c.reset}`);
    });
  }

  // Recent Tasks History Section
  console.log(`${c.cyan}${c.bold}├${divider}┤${c.reset}`);
  console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.bold}Recent Task History:${c.reset}`);
  if (tasks.length === 0) {
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}(No tasks executed yet in this session)${c.reset}`);
  } else {
    tasks.slice(-5).forEach((task) => {
      const statusIcon =
        task.status === 'success'
          ? `${c.green}✔ PASS${c.reset}`
          : task.status === 'failed'
          ? `${c.red}❌ FAIL${c.reset}`
          : `${c.yellow}⏳ RUNNING${c.reset}`;
      const duration = task.duration_ms ? `${(task.duration_ms / 1000).toFixed(1)}s` : '...';
      const promptSnippet = task.prompt.length > 42 ? task.prompt.slice(0, 39) + '...' : task.prompt;
      console.log(
        `${c.cyan}${c.bold}│${c.reset}    ${statusIcon} ${c.bold}"${promptSnippet}"${c.reset} ${c.gray}(${duration})${c.reset}`
      );
      if (task.summary) {
        const sumSnippet = task.summary.length > 58 ? task.summary.slice(0, 55) + '...' : task.summary;
        console.log(`${c.cyan}${c.bold}│${c.reset}      ${c.dim}↳ ${sumSnippet}${c.reset}`);
      }
    });
  }

  // Notes Section
  if (notes.length > 0) {
    console.log(`${c.cyan}${c.bold}├${divider}┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.bold}Working Memory Notes:${c.reset}`);
    notes.slice(-3).forEach((n) => {
      console.log(`${c.cyan}${c.bold}│${c.reset}    📌 ${n.content}`);
    });
  }

  console.log(`${c.cyan}${c.bold}└${divider}┘${c.reset}\n`);
}

export function printTuiHelp() {
  console.log(`
${c.bold}Code Agent TUI Commands:${c.reset}
  ${c.cyan}<any prompt>${c.reset}        Execute an autonomous task and record results to session history
  ${c.cyan}/overview${c.reset}, ${c.cyan}/status${c.reset}  Redraw the dashboard & session stats
  ${c.cyan}/history${c.reset}, ${c.cyan}/h${c.reset}        List all task executions in this workspace
  ${c.cyan}/show <index>${c.reset}     View details & log output of task #
  ${c.cyan}/todo add <text>${c.reset}  Add a goal to the project checklist
  ${c.cyan}/todo done <#>${c.reset}   Toggle checklist item completion
  ${c.cyan}/note <text>${c.reset}      Save a note to working memory
  ${c.cyan}/retry${c.reset}            Re-run the previous task
  ${c.cyan}/steer <hint>${c.reset}     Re-run the previous task with follow-up steering instructions
  ${c.cyan}/new [title]${c.reset}      Start a new active session
  ${c.cyan}/clear${c.reset}            Clear screen and redraw dashboard
  ${c.cyan}/exit${c.reset}, ${c.cyan}/quit${c.reset}      Exit the agent TUI
`);
}

export async function runInteractiveTui(loop, config, store) {
  const session = store.getOrCreateActiveSession(config.workspaceDir);
  let overview = store.getOverview(session.id);
  if (overview) renderTuiDashboard(overview, config);

  console.log(`${c.dim}Type any task to execute, or /help for TUI commands.${c.reset}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = () => {
    rl.question(`\n${c.bold}${c.cyan}agent>${c.reset} `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }

      if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit' || trimmed === 'quit') {
        console.log(`\n👋 Exiting Code Agent TUI. Session state saved.`);
        store.close();
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/help') {
        printTuiHelp();
        promptUser();
        return;
      }

      if (trimmed === '/clear') {
        console.clear();
        overview = store.getOverview(session.id);
        if (overview) renderTuiDashboard(overview, config);
        promptUser();
        return;
      }

      if (trimmed === '/overview' || trimmed === '/status') {
        overview = store.getOverview(session.id);
        if (overview) renderTuiDashboard(overview, config);
        promptUser();
        return;
      }

      if (trimmed === '/history' || trimmed === '/h') {
        const tasks = store.getTasks(session.id);
        console.log(`\n${c.bold}📜 Task Execution History:${c.reset}`);
        if (tasks.length === 0) {
          console.log('No tasks executed yet in this session.');
        } else {
          tasks.forEach((t, idx) => {
            const badge = t.status === 'success' ? `${c.green}✔ PASS${c.reset}` : `${c.red}❌ FAIL${c.reset}`;
            const dur = t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}s` : '0s';
            console.log(`[#${idx + 1}] ${badge} (${dur}) ${t.prompt}`);
            if (t.summary) console.log(`      ↳ ${t.summary}`);
          });
        }
        promptUser();
        return;
      }

      if (trimmed.startsWith('/show ')) {
        const idx = parseInt(trimmed.replace('/show', '').trim(), 10);
        const tasks = store.getTasks(session.id);
        const target = tasks[idx - 1];
        if (!target) {
          console.log(`${c.red}Task #${idx} not found.${c.reset}`);
        } else {
          console.log(`\n${c.bold}=== Task #${idx} Details ===${c.reset}`);
          console.log(`Prompt    : ${target.prompt}`);
          console.log(`Status    : ${target.status}`);
          console.log(`Exit Code : ${target.exit_code}`);
          console.log(`Duration  : ${(target.duration_ms || 0) / 1000}s`);
          console.log(`Summary   : ${target.summary || 'None'}`);
          if (target.error) console.log(`Error     :\n${target.error}`);
        }
        promptUser();
        return;
      }

      if (trimmed.startsWith('/todo add ')) {
        const text = trimmed.replace('/todo add ', '').trim();
        store.addTodo(session.id, text);
        console.log(`${c.green}✔ Added goal to checklist:${c.reset} "${text}"`);
        promptUser();
        return;
      }

      if (trimmed.startsWith('/todo done ')) {
        const idxStr = trimmed.replace('/todo done ', '').trim();
        const idx = parseInt(idxStr, 10);
        const todos = store.getTodos(session.id);
        const target = todos[idx - 1];
        if (!target) {
          console.log(`${c.red}Checklist item #${idxStr} not found.${c.reset}`);
        } else {
          const updated = store.toggleTodo(target.id);
          console.log(`${c.green}✔ Updated checklist item:${c.reset} "${target.text}" -> ${updated?.done ? 'DONE' : 'PENDING'}`);
        }
        promptUser();
        return;
      }

      if (trimmed.startsWith('/note ')) {
        const content = trimmed.replace('/note ', '').trim();
        store.addNote(session.id, content);
        console.log(`${c.green}✔ Saved note to working memory:${c.reset} "${content}"`);
        promptUser();
        return;
      }

      if (trimmed.startsWith('/new')) {
        const title = trimmed.replace('/new', '').trim() || undefined;
        const newSess = store.createSession(config.workspaceDir, title || `Session @ ${path.basename(config.workspaceDir)}`);
        session.id = newSess.id;
        session.title = newSess.title;
        console.log(`${c.green}✔ Started new session: ${newSess.id}${c.reset}`);
        overview = store.getOverview(session.id);
        if (overview) renderTuiDashboard(overview, config);
        promptUser();
        return;
      }

      // Handle Task Execution (/retry, /steer, or raw prompt)
      let taskPrompt = trimmed;
      if (trimmed === '/retry') {
        const latest = store.getLatestTask(session.id);
        if (!latest) {
          console.log(`${c.yellow}No previous task found to retry.${c.reset}`);
          promptUser();
          return;
        }
        taskPrompt = latest.prompt;
        console.log(`🔄 Retrying previous task: "${taskPrompt}"`);
      } else if (trimmed.startsWith('/steer ')) {
        const steeringHint = trimmed.replace('/steer ', '').trim();
        const latest = store.getLatestTask(session.id);
        if (!latest) {
          taskPrompt = steeringHint;
        } else {
          taskPrompt = `${latest.prompt}\n\n[Follow-up steering]: ${steeringHint}`;
        }
        console.log(`🧭 Steering task with instructions: "${steeringHint}"`);
      }

      console.log(`\n${c.cyan}🚀 Running 1-shot task...${c.reset}\n`);
      const taskRecord = store.recordTaskStart(session.id, taskPrompt);
      const startTime = Date.now();

      try {
        const result = await loop.runTask(taskPrompt);
        const durationMs = Date.now() - startTime;

        store.recordTaskFinish(taskRecord.id, {
          success: result.success,
          exitCode: result.success ? 0 : 1,
          durationMs,
          summary: result.finalMessage,
        });

        const statusLabel = result.success ? `${c.green}✔ Task Succeeded${c.reset}` : `${c.red}❌ Task Failed${c.reset}`;
        console.log(`\n${statusLabel} in ${(durationMs / 1000).toFixed(1)}s.`);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        store.recordTaskFinish(taskRecord.id, {
          success: false,
          exitCode: 1,
          durationMs,
          error: err.message,
          summary: `Execution error: ${err.message}`,
        });
        console.error(`\n${c.red}❌ Error executing task: ${err.message}${c.reset}`);
      }

      // Refresh overview dashboard after task completes
      overview = store.getOverview(session.id);
      if (overview) renderTuiDashboard(overview, config);

      promptUser();
    });
  };

  promptUser();
}
