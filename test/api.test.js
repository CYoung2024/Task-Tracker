import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../server/db.js';
import { createApp } from '../server/app.js';
import { localParts } from '../server/time.js';

let server;
let base;

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

before(async () => {
  const db = openDb(null);
  setSetting(db, 'timezone', 'UTC');
  server = await listen(createApp(db));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('routines show up only on their days', async () => {
  const today = localParts(new Date(), 'UTC');
  const otherDay = (today.weekday + 1) % 7;
  const everyDay = await call('POST', '/api/routines', { title: 'Read my Bible', days: [0, 1, 2, 3, 4, 5, 6], remind_at: '06:00' });
  assert.equal(everyDay.status, 201);
  await call('POST', '/api/routines', { title: 'Not today', days: [otherDay] });

  const { body } = await call('GET', '/api/today');
  assert.equal(body.date, today.date);
  assert.deepEqual(body.routines.map((r) => r.title), ['Read my Bible']);

  // Check it off, then uncheck it.
  await call('PUT', `/api/today/${everyDay.body.id}`, { date: today.date, done: true });
  assert.equal((await call('GET', '/api/today')).body.routines[0].status, 'done');
  await call('PUT', `/api/today/${everyDay.body.id}`, { date: today.date, done: false });
  assert.notEqual((await call('GET', '/api/today')).body.routines[0].status, 'done');
});

test('routine validation', async () => {
  assert.equal((await call('POST', '/api/routines', { title: '', days: [1] })).status, 400);
  assert.equal((await call('POST', '/api/routines', { title: 'x', days: [] })).status, 400);
  assert.equal((await call('POST', '/api/routines', { title: 'x', days: [1], remind_at: '25:00' })).status, 400);
});

test('to-dos persist and can be completed and cleared', async () => {
  const created = await call('POST', '/api/todos', { title: 'Renew registration', due_at: '2030-01-01T17:00:00Z' });
  assert.equal(created.status, 201);
  assert.equal(created.body.due_at, '2030-01-01T17:00:00.000Z');

  await call('PATCH', `/api/todos/${created.body.id}`, { done: true });
  let list = (await call('GET', '/api/todos')).body;
  assert.equal(list.open.length, 0);
  assert.equal(list.done.length, 1);

  await call('DELETE', '/api/todos/completed');
  list = (await call('GET', '/api/todos')).body;
  assert.equal(list.done.length, 0);
});

test('dated to-dos sort first, new undated ones land just below them, and undated ones can be reordered', async () => {
  const add = async (title, extra) => (await call('POST', '/api/todos', { title, ...extra })).body.id;
  const titles = async () => (await call('GET', '/api/todos')).body.open.map((t) => t.title);

  const a = await add('A');
  const later = await add('Later', { due_at: '2030-06-01T17:00:00Z' });
  const b = await add('B');
  const sooner = await add('Sooner', { due_at: '2030-01-01T17:00:00Z' });
  assert.deepEqual(await titles(), ['Sooner', 'Later', 'B', 'A']);

  assert.equal((await call('PUT', '/api/todos/order', { ids: [sooner, later, a, b] })).status, 200);
  assert.deepEqual(await titles(), ['Sooner', 'Later', 'A', 'B']);

  // A new undated item goes between the dated ones and the rest, even after reordering.
  const c = await add('C');
  assert.deepEqual(await titles(), ['Sooner', 'Later', 'C', 'A', 'B']);

  // The due date always wins over a requested order.
  await call('PUT', '/api/todos/order', { ids: [b, later, sooner, c, a] });
  assert.deepEqual(await titles(), ['Sooner', 'Later', 'B', 'C', 'A']);

  assert.equal((await call('PUT', '/api/todos/order', { ids: 'nope' })).status, 400);

  // Stale list from another device: unknown ids ignored, undated items it didn't know about stay on top of the undated.
  const d = await add('D');
  await call('PUT', '/api/todos/order', { ids: [sooner, later, a, 99999, c, b] });
  assert.deepEqual(await titles(), ['Sooner', 'Later', 'D', 'A', 'C', 'B']);

  for (const id of [a, b, c, d, sooner, later]) await call('DELETE', `/api/todos/${id}`);
});

test('upgrading an older database keeps the existing to-do order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
  const old = new DatabaseSync(path.join(dir, 'tasks.db'));
  old.exec(`
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      due_at TEXT, remind_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO todos (title, due_at, created_at) VALUES
      ('no due, older', NULL, '2026-01-01T00:00:00.000Z'),
      ('due later', '2030-06-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      ('no due, newer', NULL, '2026-01-03T00:00:00.000Z'),
      ('due sooner', '2030-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
  `);
  old.close();

  const db = openDb(dir);
  const titles = db.prepare('SELECT title FROM todos ORDER BY sort_order').all().map((t) => t.title);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(titles, ['due sooner', 'due later', 'no due, newer', 'no due, older']);
});

test('Discord settings are validated and the token is never sent back', async () => {
  const hook = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_secret-token';
  assert.equal((await call('PUT', '/api/settings', { discord_webhook_url: 'https://example.com/hook' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { discord_user_id: 'me' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { discord_webhook_url: hook, discord_user_id: '987654321098765432' })).status, 200);

  const { body } = await call('GET', '/api/settings');
  assert.equal(body.discord.configured, true);
  assert.equal(body.discord.userId, '987654321098765432');
  assert.ok(!JSON.stringify(body).includes('secret-token'));

  await call('PUT', '/api/settings', { discord_webhook_url: '' });
  assert.equal((await call('GET', '/api/settings')).body.discord.configured, false);
  assert.equal((await call('POST', '/api/notify/test')).status, 400);
});
