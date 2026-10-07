# Code Agent

A zero-dependency, autonomous coding agent harness designed for LLMs without native tool/function calling support. It translates user tasks into structured Markdown prompts, parses markdown code-block tool calls (`powershell`, `cmd`, `bash`, `read`, `write`, `edit`, `grep`, `note`, `finish`), and executes them locally through a sandboxed execution harness.

Built specifically to work in restricted enterprise environments:
- **Zero Dependencies**: Pure standard Node.js ES modules (`.js`). No npm packages, no TypeScript compilation, no external runtimes.
- **PowerShell Constrained Language Mode (CLM) Safe**: Designed to operate under strict PowerShell CLM (AppLocker / WDAC policies). Avoids prohibited .NET reflection, `Add-Type`, and COM objects.
- **Bare Chat Endpoints**: Works with standard OpenAI-compatible `/chat/completions` endpoints or enterprise REST chat endpoints (`POST /chat/message` + `POST /chat/generate`), with zero vendor lock-in.
- **Dual Launchers**: Includes `agent.ps1` for PowerShell and `agent.cmd` as a batch fallback when `.ps1` execution is blocked.

---

## Features

- **Dual Modes**:
  - **Interactive TUI**: Run `.\agent.ps1` or `agent.cmd` with no arguments to launch an interactive dashboard with checklists, task history, notes, and steering.
  - **1-Shot Task**: Run `.\agent.ps1 "<task prompt>"` to execute an autonomous task end-to-end and exit with code 0 (success) or 1 (failure).
- **Markdown Tool Protocol**: Prompts models to act via executable markdown blocks:
  - `powershell` / `cmd` / `bash`: Shell execution
  - `read`: Paginated file reader with token overflow protection
  - `write`: File creation with placeholder detection
  - `edit`: Precise line-range or diff-based edits
  - `grep`: Line-numbered search
  - `note`: Persistent working memory across turns
  - `finish`: Completion summary with automated quality & syntax checks
- **Persistent Workspace Memory (`agent/AGENTS.md`)**: Automatically tracks project overview, tech stack, and change logs across sessions, auto-pruned to stay within token limits.
- **Atomic Session Store (`agent/session.json`)**: Tracks tasks, durations, checklists, and notes with atomic write operations.
- **Context Sliding Window**: Per-turn token monitoring (default 4,000 tokens) with automated summary condensation to prevent context overflow.

---

## Requirements

- **Node.js**: Modern Node.js (v20+ / v22+ / v23+)
- **Shell**: PowerShell (5.1+ or pwsh, Full Language or Constrained Language Mode), or `cmd.exe`

---

## Quick Start

### 1. Zero-Install Setup

No `npm install` or compilation required:

```powershell
cd code-agent
node --test test/**/*.test.js
```

### 2. Configure Environment

Copy `.env.example` to `.env` in the agent folder or your workspace:

```env
# Bare Chat Endpoint Configuration
LLM_BASE_URL=https://your-llm-service.internal/v1
LLM_API_KEY=your-api-key-here
LLM_MODEL=gpt-4o

# Endpoint Type: 'chat' (OpenAI-compatible) or 'rest' (POST /chat/message + POST /chat/generate)
LLM_API_TYPE=chat

# Optional custom auth header (e.g. 'api-key' for Azure, defaults to 'Authorization')
# LLM_AUTH_HEADER=Authorization

# Token Limits
MAX_TURN_TOKENS=4000
MAX_TOTAL_CONTEXT_TOKENS=32000

# Shell & Timeout Settings
AGENT_DEFAULT_SHELL=powershell
AGENT_TIMEOUT_MS=60000
```

---

## Usage

### Interactive TUI Mode

Launch the TUI from any project workspace:

```powershell
path\to\code-agent\agent.ps1
```
*(or via Command Prompt: `path\to\code-agent\agent.cmd`)*

```text
┌────────────────────────────────────────────────────────────────────────┐
│  🤖  PI CODE AGENT TUI  [Session: sess_example_12345]                  │
├────────────────────────────────────────────────────────────────────────┤
│  📂 Workspace : C:\projects\my-app                                     │
│  🧠 Model     : gpt-4o (Turn limit: 4000t | Total: 32000t)             │
│  📊 Tasks     : 2 Succeeded | 0 Failed | 2 Total                       │
│  📝 Checklist : 1 Done | 1 Pending                                     │
├────────────────────────────────────────────────────────────────────────┤
│  Checklist & Goals:                                                    │
│    [✔] Initialize database schema (#1)                                 │
│    [ ] Add authentication endpoints (#2)                               │
├────────────────────────────────────────────────────────────────────────┤
│  Recent Task History:                                                  │
│    ✔ PASS "Initialize schema" (1.8s)                                   │
│      ↳ Created schema.sql and migrations table                         │
└────────────────────────────────────────────────────────────────────────┘

agent> Add authentication endpoints
agent> /todo add Write integration tests
agent> /todo done 2
agent> /note Using bcrypt for password hashing
agent> /retry
agent> /steer Ensure passwords are at least 8 characters
agent> /history
agent> /exit
```

### 1-Shot Command Mode

Run an autonomous task directly:

```powershell
path\to\code-agent\agent.ps1 "List files in the workspace and write a brief summary to summary.md"
```

Or with `agent.cmd`:

```cmd
path\to\code-agent\agent.cmd "Inspect project and create package.json"
```

### CLI Flags

```powershell
# Show session overview dashboard and exit
.\agent.ps1 -o

# Show task history and exit
.\agent.ps1 --history

# Run with raw LLM communication stream logged to JSONL
.\agent.ps1 -d "Fix syntax error in app.js"

# Show help
.\agent.ps1 -h
```

---

## PowerShell Constrained Language Mode (CLM) Notes

Under CLM:
- Basic PowerShell cmdlets (`Get-ChildItem`, `Get-Content`, `Set-Content`, `Select-String`, `ConvertFrom-Json`, pipelines) work normally.
- Direct .NET method calls (e.g. `[System.IO.File]::ReadAllText`), `Add-Type`, and `New-Object` on non-whitelisted types are blocked by the OS.
- The agent prompt instructs the model to use built-in cmdlets or write helper scripts to `agent/<script>.js` and execute them with `node agent/<script>.js`, cleanly bypassing PowerShell language restrictions.

---

## Repository Structure

- [`agent.ps1`](agent.ps1): CLM-compatible PowerShell launcher.
- [`agent.cmd`](agent.cmd): Batch wrapper fallback for restricted environments.
- [`src/cli.js`](src/cli.js): Zero-dependency CLI argument parser and mode dispatcher.
- [`src/tui.js`](src/tui.js): Interactive terminal dashboard and REPL.
- [`src/session-store.js`](src/session-store.js): Atomic JSON session and task history persistence.
- [`src/memory.js`](src/memory.js): `agent/AGENTS.md` project memory manager with log pruning.
- [`src/agent-loop.js`](src/agent-loop.js): Autonomous task execution loop with sliding-window compression.
- [`src/parser.js`](src/parser.js): Markdown tool block parser.
- [`src/prompt.js`](src/prompt.js): System instructions, CLM rules, and workspace inventory.
- [`src/harness.js`](src/harness.js): Sandboxed file operations, shell execution, and finish validator.
- [`src/llm.js`](src/llm.js): Zero-dependency HTTP client for bare OpenAI and REST chat endpoints.
- [`src/tokenizer.js`](src/tokenizer.js): Pure-JS token estimation and budget calculation.
- [`test/`](test): Test suite running on native `node --test`.

---

## License

[MIT](LICENSE)
