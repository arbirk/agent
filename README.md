# Code Agent

A lean, autonomous coding agent harness designed for LLMs without native tool/function calling support. It reformulates user tasks into structured Markdown prompts, parses markdown code-block tool calls (`powershell`, `bash`, `read`, `write`, `edit`, `finish`), and executes them locally through a sandboxed execution harness.

## Features

- **Dual Modes**:
  - **Interactive TUI**: Run `.\agent.ps1` with no arguments to launch an interactive dashboard with checklists, history, notes, and task steering.
  - **1-Shot Task**: Run `.\agent.ps1 "<task prompt>"` to execute a single task and return exit code 0 or 1.
- **Markdown Tool Protocol**: Works with standard chat-completion models by executing code blocks (`powershell`, `bash`, `read`, `write`, `edit`, `grep`, `note`, `finish`).
- **Persistent Workspace Memory (`agent/AGENTS.md`)**: Automatically tracks project overview, tech stack, and change logs across sessions, auto-pruned to stay within token limits.
- **SQLite Session Tracking (`agent/session.sqlite`)**: Records task metrics, durations, summaries, and checklist todos using Node.js 22's built-in `node:sqlite`.
- **Context Sliding Window**: Per-turn token monitoring (default 4,000 tokens) with automated state condensation to prevent context overflow during multi-turn loops.

## Requirements

- **Node.js**: v22.0.0+ (required for native `node:sqlite`)
- **PowerShell**: Windows PowerShell 5.1+ or PowerShell Core (`pwsh`) on Windows/macOS/Linux

## Quick Start

### 1. Installation

```powershell
git clone <repo-url>
cd code-agent
npm install
npm test
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure your API key and endpoint:

```env
# OpenAI-compatible endpoint (OpenRouter, OpenAI, Gemini, Ollama, vLLM, etc.)
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=your_api_key_here
LLM_MODEL=openai/gpt-4o

# Token Limits
MAX_TURN_TOKENS=4000
MAX_TOTAL_CONTEXT_TOKENS=32000

# Shell & Timeout
PI_DEFAULT_SHELL=powershell
PI_TIMEOUT_MS=60000
```

### 3. Usage

#### Interactive TUI Mode

Launch the TUI from any project workspace:

```powershell
path\to\code-agent\agent.ps1
```

```text
┌────────────────────────────────────────────────────────────────────────┐
│  🤖  PI CODE AGENT TUI  [Session: sess_example_12345]                  │
├────────────────────────────────────────────────────────────────────────┤
│  📂 Workspace : C:\projects\my-app                                     │
│  🧠 Model     : openai/gpt-4o (Turn limit: 4000t | Total: 32000t)      │
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

#### 1-Shot Command Mode

Run a single autonomous task directly:

```powershell
path\to\code-agent\agent.ps1 "List files in the workspace and write a brief summary to summary.md"
```

#### CLI Flags

```powershell
# Show session overview dashboard and exit
.\agent.ps1 -Overview

# Show recent task execution history and exit
.\agent.ps1 -History

# Run with raw message debug stream logged to JSONL
.\agent.ps1 -d "Fix syntax error in server.ts"
```

## Repository Structure

- [`agent.ps1`](agent.ps1): PowerShell CLI entry point.
- [`src/cli.ts`](src/cli.ts): CLI argument parsing and mode dispatcher.
- [`src/tui.ts`](src/tui.ts): Terminal dashboard and interactive command palette.
- [`src/session-store.ts`](src/session-store.ts): SQLite session and task history persistence.
- [`src/memory.ts`](src/memory.ts): `agent/AGENTS.md` manager with token-capped history pruning.
- [`src/agent-loop.ts`](src/agent-loop.ts): Task execution loop with sliding window compression.
- [`src/parser.ts`](src/parser.ts): Markdown code-block tool call parser.
- [`src/prompt.ts`](src/prompt.ts): System instructions and workspace inventory generator.
- [`src/harness/pi-harness.ts`](src/harness/pi-harness.ts): Sandboxed file, grep, shell, and finish validator.
- [`src/llm-adapter.ts`](src/llm-adapter.ts): OpenAI-compatible and REST API completion adapters.
- [`test/`](test): Unit test suite.

## License

[MIT](LICENSE)
