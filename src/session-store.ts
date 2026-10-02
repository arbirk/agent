import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

export interface AgentSession {
  id: string;
  title: string;
  workspace: string;
  status: 'active' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface TaskRecord {
  id: string;
  session_id: string;
  prompt: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TodoItem {
  id: string;
  session_id: string;
  text: string;
  done: boolean;
  created_at: string;
}

export interface NoteItem {
  id: string;
  session_id: string;
  content: string;
  created_at: string;
}

export interface TuiOverview {
  session: AgentSession;
  tasks: TaskRecord[];
  todos: TodoItem[];
  notes: NoteItem[];
  stats: {
    totalTasks: number;
    successTasks: number;
    failedTasks: number;
    pendingTodos: number;
    completedTodos: number;
  };
}

export class SessionStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER,
        duration_ms INTEGER,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
  }

  public getOrCreateActiveSession(workspace: string, title?: string): AgentSession {
    const existing = this.db
      .prepare(`SELECT * FROM sessions WHERE workspace = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
      .get(workspace) as any;

    if (existing) {
      return this.formatSession(existing);
    }

    return this.createSession(workspace, title || `Session @ ${path.basename(workspace)}`);
  }

  public createSession(workspace: string, title: string): AgentSession {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    // Mark previous active session for this workspace as completed
    this.db
      .prepare(`UPDATE sessions SET status = 'completed', updated_at = ? WHERE workspace = ? AND status = 'active'`)
      .run(now, workspace);

    this.db
      .prepare(`INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(id, title, workspace, now, now);

    return {
      id,
      title,
      workspace,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
  }

  public getSession(id: string): AgentSession | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    return row ? this.formatSession(row) : null;
  }

  public listSessions(workspace?: string): AgentSession[] {
    const query = workspace
      ? `SELECT * FROM sessions WHERE workspace = ? ORDER BY updated_at DESC`
      : `SELECT * FROM sessions ORDER BY updated_at DESC`;

    const rows = workspace
      ? (this.db.prepare(query).all(workspace) as any[])
      : (this.db.prepare(query).all() as any[]);

    return rows.map((r) => this.formatSession(r));
  }

  public recordTaskStart(sessionId: string, prompt: string): TaskRecord {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`INSERT INTO tasks (id, session_id, prompt, status, created_at) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, sessionId, prompt, now);

    this.touchSession(sessionId);

    return {
      id,
      session_id: sessionId,
      prompt,
      status: 'running',
      exit_code: null,
      duration_ms: null,
      summary: null,
      error: null,
      created_at: now,
      finished_at: null,
    };
  }

  public recordTaskFinish(
    taskId: string,
    result: {
      success: boolean;
      exitCode: number;
      durationMs: number;
      summary?: string;
      error?: string;
    }
  ): TaskRecord {
    const now = new Date().toISOString();
    const status = result.success ? 'success' : 'failed';

    this.db
      .prepare(`
        UPDATE tasks 
        SET status = ?, exit_code = ?, duration_ms = ?, summary = ?, error = ?, finished_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        result.exitCode,
        result.durationMs,
        result.summary || null,
        result.error || null,
        now,
        taskId
      );

    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (task) {
      this.touchSession(task.session_id);
      return this.formatTask(task);
    }

    throw new Error(`Task with id ${taskId} not found`);
  }

  public getTasks(sessionId: string): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as any[];

    return rows.map((r) => this.formatTask(r));
  }

  public getLatestTask(sessionId: string): TaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sessionId) as any;

    return row ? this.formatTask(row) : null;
  }

  public addTodo(sessionId: string, text: string): TodoItem {
    const id = `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`INSERT INTO todos (id, session_id, text, done, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run(id, sessionId, text, now);

    this.touchSession(sessionId);

    return {
      id,
      session_id: sessionId,
      text,
      done: false,
      created_at: now,
    };
  }

  public toggleTodo(todoId: string): TodoItem | null {
    const current = this.db.prepare(`SELECT * FROM todos WHERE id = ?`).get(todoId) as any;
    if (!current) return null;

    const newDone = current.done ? 0 : 1;
    this.db.prepare(`UPDATE todos SET done = ? WHERE id = ?`).run(newDone, todoId);
    this.touchSession(current.session_id);

    return {
      id: current.id,
      session_id: current.session_id,
      text: current.text,
      done: newDone === 1,
      created_at: current.created_at,
    };
  }

  public getTodos(sessionId: string): TodoItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as any[];

    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      text: r.text,
      done: Boolean(r.done),
      created_at: r.created_at,
    }));
  }

  public addNote(sessionId: string, content: string): NoteItem {
    const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`INSERT INTO notes (id, session_id, content, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, sessionId, content, now);

    this.touchSession(sessionId);

    return {
      id,
      session_id: sessionId,
      content,
      created_at: now,
    };
  }

  public getNotes(sessionId: string): NoteItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as any[];

    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      content: r.content,
      created_at: r.created_at,
    }));
  }

  public getOverview(sessionId: string): TuiOverview | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const tasks = this.getTasks(sessionId);
    const todos = this.getTodos(sessionId);
    const notes = this.getNotes(sessionId);

    const stats = {
      totalTasks: tasks.length,
      successTasks: tasks.filter((t) => t.status === 'success').length,
      failedTasks: tasks.filter((t) => t.status === 'failed').length,
      pendingTodos: todos.filter((t) => !t.done).length,
      completedTodos: todos.filter((t) => t.done).length,
    };

    return {
      session,
      tasks,
      todos,
      notes,
      stats,
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }

  private touchSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId);
  }

  private formatSession(row: any): AgentSession {
    return {
      id: row.id,
      title: row.title,
      workspace: row.workspace,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private formatTask(row: any): TaskRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      prompt: row.prompt,
      status: row.status,
      exit_code: row.exit_code,
      duration_ms: row.duration_ms,
      summary: row.summary,
      error: row.error,
      created_at: row.created_at,
      finished_at: row.finished_at,
    };
  }
}
