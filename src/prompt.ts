import * as fs from 'fs';
import * as path from 'path';
import { ToolResult } from './types.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lists all files and folders in the workspace root directory with metadata.
 * Gives the agent immediate visibility into existing project files.
 */
export function listWorkspaceEntries(workspaceDir: string): string {
  try {
    if (!fs.existsSync(workspaceDir)) {
      return '*(Workspace directory does not exist)*';
    }

    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    if (entries.length === 0) {
      return '*(Workspace root is currently empty)*';
    }

    // Sort directories first, then files alphabetically
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const lines: string[] = [];
    for (const entry of sorted) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') {
        lines.push(`- 📁 ${entry.name}/ (system directory, ignored)`);
        continue;
      }

      if (entry.isDirectory()) {
        const subDirPath = path.join(workspaceDir, entry.name);
        try {
          const subChildren = fs.readdirSync(subDirPath, { withFileTypes: true });
          const subNames = subChildren
            .slice(0, 10)
            .map(c => c.name + (c.isDirectory() ? '/' : ''));
          const moreCount = subChildren.length > 10 ? ` (+${subChildren.length - 10} more)` : '';
          const childrenDesc = subNames.length > 0 ? ` [contains: ${subNames.join(', ')}${moreCount}]` : ' (empty folder)';
          lines.push(`- 📁 ${entry.name}/${childrenDesc}`);
        } catch {
          lines.push(`- 📁 ${entry.name}/`);
        }
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(path.join(workspaceDir, entry.name));
          lines.push(`- 📄 ${entry.name} (${formatBytes(stats.size)})`);
        } catch {
          lines.push(`- 📄 ${entry.name}`);
        }
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `*(Error reading workspace root: ${err.message})*`;
  }
}

export function getSystemPrompt(workspaceDir: string, defaultShell: string = 'powershell'): string {
  const inventory = listWorkspaceEntries(workspaceDir);

  return `# Autonomous Coding Agent

You are an autonomous software engineer operating inside the workspace:
\`${workspaceDir}\`

You interact with the workspace exclusively through tool blocks executed by the harness.

## Workspace Overview:
${inventory}

## Harness Tools:
Emit tools as markdown code blocks:

1. **Execute Shell Command**:
\`\`\`${defaultShell}
<command>
\`\`\`
*(On Windows, all commands run via PowerShell. Avoid Unix-only syntax like \`cat << EOF\` or \`python3\` if not installed).*

2. **Grep / Search**:
\`\`\`grep query="searchTerm" path="optional/path.ext"
\`\`\`
Fast targeted search across files or a specific file. Returns line numbers and snippets using minimal tokens.

3. **Read File**:
\`\`\`read path="relative/path.ext" startLine=1 endLine=50
\`\`\`
Read a focused slice (10–50 lines).

4. **Edit File (Line-Number or Search & Replace)**:
Prefer line numbers for precise, clean edits:
\`\`\`edit path="relative/path.ext" startLine=10 endLine=15
<replacement lines for lines 10-15>
\`\`\`
Or use diff search & replace:
\`\`\`edit path="relative/path.ext"
<<<<<<< FIND
<exact lines to find>
=======
<new replacement lines>
>>>>>>> REPLACE
\`\`\`

5. **Write File**:
\`\`\`write path="relative/path.ext"
<entire file content>
\`\`\`
*(Specify the destination path directly on the opening tag: \`\`\`write path="filename.ext"\`\`\`. Place raw file content directly in the body without YAML wrappers).*

6. **Note / Scratchpad**:
\`\`\`note
<schemas, variables, key decisions, or plans to preserve permanently across all turns>
\`\`\`

7. **Finish Task**:
\`\`\`finish
<summary of what was accomplished>
\`\`\`

## Turn Protocol:
Every turn MUST end with an executable tool block (or \`\`\`finish\`\`\`) to perform your next action. Never stop after explaining your plan without the tool block to execute it.

## Core Operating Rules:

1. **Be Exploratory — Always Inspect First**:
Before modifying code or writing scripts to parse data, inspect existing code and sample input data first (read 10–20 lines). When parsing structured text or data files, key on record delimiters (e.g. lines starting with '#' or record markers) rather than assuming a fixed line stride, as datasets often contain section headers or blank lines. Use \`grep\` to find symbols or declarations quickly rather than dumping entire files.

2. **Manage Context Length (Precise Surgical Edits & Small Reads)**:
In most tasks, make small, precise edits using line numbers or exact matches. Do not rewrite whole files when changing a few lines. Never read entire large files—keep reads to 10–50 lines.
- **Helper Scripts in agent/**: For short helper scripts under ~80 lines, if you encounter indentation or syntax errors, REWRITE the entire clean script with \`write\` instead of doing piecemeal line edits. Piecemeal edits on scripts or nested structures frequently introduce formatting or indentation mismatches.
- **No Ellipsis ('...')**: Never use '...' to represent omitted code in edits or writes. Provide the complete code for the targeted lines. For multiple non-contiguous edits in a file, emit separate \`edit\` blocks for each location.

3. **Extract Patterns & Apply with Scripts (Template Pipelines & Clean Temp Files)**:
- Never stream or copy bulk data through LLM context. When dealing with large datasets or bulk transformations, write and run a script inside the \`agent/\` folder (e.g. \`agent/process_data.py\` or \`.js\`) to assemble complete files directly on disk.
- **Strict Template Decoupling**: DO NOT embed or hardcode reference templates as large multi-line strings inside helper scripts. If a reference template was provided in the task prompt or exists in the workspace (e.g. \`template.<ext>\`), have your script read the template directly from disk. Keep transformation scripts focused purely on data extraction, formatting, and placeholder substitution.
- **Format Data at the Source (Logicless Templates)**: Format, normalize, and clean data during the extraction phase rather than relying on downstream runtime workarounds. Keep presentation templates and consumers as simple and logicless as possible. Format padded IDs, numbers, and sanitized types directly in the structured data before injection.
- **Validate Fields & Filter Non-Data Artifacts**: When parsing unstructured, scraped, or tabulated data, validate that extracted fields strictly belong to the intended domain. Explicitly filter out navigation headers, alphabet jumps, pagination controls, or non-data category artifacts.
- Never use \`edit\` or \`write\` to manually type out data collections or leave placeholder comments like \`// Add remaining records here\`. Always use a script to inject the complete dataset directly on disk.
- All helper scripts must be created inside the \`agent/\` folder.
- **Temporary Files Must Be Deleted**: All temporary files, intermediate data dumps, and temporal scratch scripts must always be deleted before concluding the task, leaving only reusable code in \`agent/\`.

4. **Use Types & Linting to Ensure Quality (Automated Verification on Windows/PowerShell)**:
Always validate your changes using automated checks or execution commands:
- **Validate Data Scripts First**: Have your data processing script assert and print item counts or verification summaries directly (e.g. \`print(f"Successfully processed {len(records)} records")\`). This immediately confirms transformation accuracy.
- **Simple Output File Verification**: Avoid complex or fragile one-line parsers to inspect generated files. Instead, use reliable PowerShell commands to verify output integrity:
  - Check file existence & line count: \`(Get-Content <output_file> | Measure-Object -Line).Lines\`
  - Verify target placeholders were populated: \`Select-String -Path <output_file> -Pattern '<expected_marker>'\`
  - Check file size: \`(Get-Item <output_file>).Length\`
- Avoid \`start <file>\` (or \`Start-Process\`) as verification—\`start\` launches detached processes in the background and always returns exit code 0 without validating file contents or runtime correctness.
- **Harness Finish Guardrails**: The harness strictly validates all modified files on \`\`\`finish\`\`\`. It will REJECT \`\`\`finish\`\`\` if:
  1. Any modified file contains unpopulated placeholder comments (e.g. \`// Additional data...\`, \`TODO\`, \`...\`).
  2. Any modified code or template file contains syntax or parsing errors.
  3. Any modified file is completely empty (0 bytes).
Never finish a task without running an automated check that proves the output is intact and error-free.

5. **Establish Clear Goals, Tasklist & Confirm Results**:
Establish clear goals and a step-by-step tasklist upfront. Follow through systematically, confirm the actual result end-to-end with verification commands, clean up all temporary files, and conclude with \`\`\`finish\`\`\`.


`;
}

export function getCompressionPrompt(): string {
  return `You are an AI context condenser. The current task loop is approaching the per-iteration token limit.
Review the previous conversation history and summarize the state into a concise, high-density markdown status report strictly under 200 tokens.

Include ONLY:
1. **Initial Goal**: The user's primary objective.
2. **Completed Actions**: Concrete files created, edited, or commands run.
3. **Current State & Findings**: Key findings and current blockers.
4. **Next Step**: Exactly what concrete action to take next. If transforming large datasets, use a script rather than reading or writing lines manually.

Keep the summary strictly under 200 tokens. Do NOT include tool blocks in this summary.`;
}

export function formatToolResults(results: ToolResult[], defaultShell: string = 'powershell'): string {
  if (results.length === 0) {
    return `*(No tool calls detected. Please emit a tool block like \`\`\`read, \`\`\`write, \`\`\`edit, \`\`\`${defaultShell}, or \`\`\`finish.)*`;
  }

  const parts = results.map((res) => {
    const status = res.success ? 'SUCCESS' : 'FAILED';
    const output = res.output ? res.output : '(empty output)';
    return `### Tool Result [${res.tool.toUpperCase()}] - ${status}\n\`\`\`\n${output}\n\`\`\``;
  });

  return parts.join('\n\n');
}

