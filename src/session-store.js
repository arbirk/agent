import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ sessions: [], tasks: [], todos: [], notes: [] });
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Session, task, todo and note history persisted as a single JSON file (in memory when no path is given). */
export class SessionStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.data = EMPTY();
    if (filePath && filePath !== ':memory:' && fs.existsSync(filePath)) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
      } catch {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      }
    }
  }

  save() {
    if (!this.filePath || this.filePath === ':memory:') return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  touch(sessionId) {
    const session = this.getSession(sessionId);
    if (session) session.updated_at = now();
  }

  getOrCreateActiveSession(workspace, title) {
    const active = this.data.sessions
      .filter((s) => s.workspace === workspace && s.status === 'active')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return active || this.createSession(workspace, title || `Session @ ${path.basename(workspace)}`);
  }

  createSession(workspace, title) {
    const ts = now();
    for (const s of this.data.sessions) {
      if (s.workspace === workspace && s.status === 'active') Object.assign(s, { status: 'completed', updated_at: ts });
    }
    const session = { id: newId('sess'), title, workspace, status: 'active', created_at: ts, updated_at: ts };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  getSession(id) {
    return this.data.sessions.find((s) => s.id === id) || null;
  }

  recordTaskStart(sessionId, prompt) {
    const task = {
      id: newId('task'), session_id: sessionId, prompt, status: 'running',
      exit_code: null, duration_ms: null, summary: null, error: null, created_at: now(), finished_at: null,
    };
    this.data.tasks.push(task);
    this.touch(sessionId);
    this.save();
    return task;
  }

  recordTaskFinish(taskId, { success, exitCode, durationMs, summary, error }) {
    const task = this.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task with id ${taskId} not found`);
    Object.assign(task, {
      status: success ? 'success' : 'failed',
      exit_code: exitCode, duration_ms: durationMs,
      summary: summary || null, error: error || null, finished_at: now(),
    });
    this.touch(task.session_id);
    this.save();
    return task;
  }

  getTasks(sessionId) {
    return this.data.tasks.filter((t) => t.session_id === sessionId);
  }

  getLatestTask(sessionId) {
    return this.getTasks(sessionId).at(-1) || null;
  }

  addTodo(sessionId, text) {
    const todo = { id: newId('todo'), session_id: sessionId, text, done: false, created_at: now() };
    this.data.todos.push(todo);
    this.touch(sessionId);
    this.save();
    return todo;
  }

  toggleTodo(todoId) {
    const todo = this.data.todos.find((t) => t.id === todoId);
    if (!todo) return null;
    todo.done = !todo.done;
    this.touch(todo.session_id);
    this.save();
    return todo;
  }

  getTodos(sessionId) {
    return this.data.todos.filter((t) => t.session_id === sessionId);
  }

  addNote(sessionId, content) {
    const note = { id: newId('note'), session_id: sessionId, content, created_at: now() };
    this.data.notes.push(note);
    this.touch(sessionId);
    this.save();
    return note;
  }

  getNotes(sessionId) {
    return this.data.notes.filter((n) => n.session_id === sessionId);
  }

  getOverview(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const tasks = this.getTasks(sessionId);
    const todos = this.getTodos(sessionId);
    const notes = this.getNotes(sessionId);
    return {
      session, tasks, todos, notes,
      stats: {
        totalTasks: tasks.length,
        successTasks: tasks.filter((t) => t.status === 'success').length,
        failedTasks: tasks.filter((t) => t.status === 'failed').length,
        pendingTodos: todos.filter((t) => !t.done).length,
        completedTodos: todos.filter((t) => t.done).length,
      },
    };
  }

  close() {}
}
