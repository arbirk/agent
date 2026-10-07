import test from 'node:test';
import assert from 'node:assert';
import { SessionStore } from '../src/session-store.js';
import { renderTuiDashboard, printTuiHelp } from '../src/tui.js';

test('renderTuiDashboard renders cleanly with session stats, checklist, and task history', () => {
  const store = new SessionStore(':memory:');
  const session = store.createSession('/workspace/app', 'App Session');

  store.addTodo(session.id, 'Scaffold project');
  const t2 = store.addTodo(session.id, 'Run build');
  store.toggleTodo(t2.id);

  store.addNote(session.id, 'Remember to check node version');

  const task = store.recordTaskStart(session.id, 'Setup package.json');
  store.recordTaskFinish(task.id, {
    success: true,
    exitCode: 0,
    durationMs: 950,
    summary: 'Created package.json with scripts',
  });

  const overview = store.getOverview(session.id);
  assert.ok(overview);

  const dummyConfig = {
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'test-key',
    model: 'mock-model',
    maxTurnTokens: 4000,
    maxTotalTokens: 32000,
    workspaceDir: '/workspace/app',
    defaultShell: 'powershell',
    timeoutMs: 60000,
  };

  let captured = '';
  const originalLog = console.log;
  console.log = (...args) => {
    captured += args.join(' ') + '\n';
  };

  try {
    renderTuiDashboard(overview, dummyConfig);
    assert.ok(captured.includes('PI CODE AGENT TUI'));
    assert.ok(captured.includes('App Session') || captured.includes(session.id));
    assert.ok(captured.includes('Setup package.json'));
    assert.ok(captured.includes('Remember to check node version'));
    assert.ok(captured.includes('Scaffold project'));

    // Test printTuiHelp
    captured = '';
    printTuiHelp();
    assert.ok(captured.includes('Code Agent TUI Commands:'));
    assert.ok(captured.includes('/overview'));
    assert.ok(captured.includes('/todo add'));
  } finally {
    console.log = originalLog;
    store.close();
  }
});
