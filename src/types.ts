export type ToolType = 'bash' | 'powershell' | 'read' | 'write' | 'edit' | 'grep' | 'note' | 'finish';

export interface BaseToolCall {
  type: ToolType;
  raw: string;
}

export interface BashToolCall extends BaseToolCall {
  type: 'bash' | 'powershell';
  command: string;
}

export interface ReadToolCall extends BaseToolCall {
  type: 'read';
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface WriteToolCall extends BaseToolCall {
  type: 'write';
  path: string;
  content: string;
}

export interface EditToolCall extends BaseToolCall {
  type: 'edit';
  path: string;
  find?: string;
  replace: string;
  startLine?: number;
  endLine?: number;
}

export interface GrepToolCall extends BaseToolCall {
  type: 'grep';
  path?: string;
  query: string;
}

export interface NoteToolCall extends BaseToolCall {
  type: 'note';
  content: string;
}

export interface FinishToolCall extends BaseToolCall {
  type: 'finish';
  summary: string;
}

export type ToolCall =
  | BashToolCall
  | ReadToolCall
  | WriteToolCall
  | EditToolCall
  | GrepToolCall
  | NoteToolCall
  | FinishToolCall;

export interface ToolResult {
  tool: ToolType;
  success: boolean;
  output: string;
  error?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTurnTokens: number;
  maxTotalTokens: number;
  workspaceDir: string;
  defaultShell: 'powershell' | 'bash';
  timeoutMs: number;
  debug?: boolean;
  debugLogPath?: string;
}

export interface LoopState {
  systemPrompt: string;
  taskPrompt: string;
  history: ChatMessage[];
  turnCount: number;
  compressedSummary?: string;
  isFinished: boolean;
  finalMessage?: string;
}
