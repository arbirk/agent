import { test } from 'node:test';
import * as assert from 'node:assert';
import { SessionStore } from '../src/session-store.js';

test('SessionStore creates active session, records task lifecycle, and tracks metrics', () => {
  const store = new SessionStore(':memory:');

  const session = store.getOrCreateActiveSession('/fake/workspace', 'Test Session');
  assert.ok(session.id.startsWith('sess_'));
  assert.strictEqual(session.workspace, '/fake/workspace');
  assert.strictEqual(session.status, 'active');

  const task = store.recordTaskStart(session.id, 'Implement feature X');
  assert.ok(task.id.startsWith('task_'));
  assert.strictEqual(task.status, 'running');

  const finished = store.recordTaskFinish(task.id, {
    success: true,
    exitCode: 0,
    durationMs: 1200,
    summary: 'Feature X implemented successfully.',
  });

  assert.strictEqual(finished.status, 'success');
  assert.strictEqual(finished.exit_code, 0);
  assert.strictEqual(finished.duration_ms, 1200);
  assert.strictEqual(finished.summary, 'Feature X implemented successfully.');

  const tasks = store.getTasks(session.id);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].id, task.id);

  store.close();
});

test('SessionStore handles todos and notes', () => {
  const store = new SessionStore(':memory:');
  const session = store.createSession('/workspace', 'Todo Session');

  const t1 = store.addTodo(session.id, 'Goal 1: Design database');
  const t2 = store.addTodo(session.id, 'Goal 2: Add API');

  let todos = store.getTodos(session.id);
  assert.strictEqual(todos.length, 2);
  assert.strictEqual(todos[0].done, false);

  const toggled = store.toggleTodo(t1.id);
  assert.strictEqual(toggled?.done, true);

  store.addNote(session.id, 'Architecture note: Use node:sqlite');
  const notes = store.getNotes(session.id);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].content, 'Architecture note: Use node:sqlite');

  const overview = store.getOverview(session.id);
  assert.ok(overview);
  assert.strictEqual(overview.stats.completedTodos, 1);
  assert.strictEqual(overview.stats.pendingTodos, 1);

  store.close();
});
