import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../server/db.js';
import { createApp } from '../server/app.js';
import { addDays, localParts } from '../server/time.js';

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

test('cycle routine validation', async () => {
  const post = async (extra) => (await call('POST', '/api/routines', { title: 'x', ...extra })).status;
  assert.equal(await post({ repeat_unit: 'fortnight', repeat_every: 1, start_date: '2027-01-01' }), 400);
  assert.equal(await post({ repeat_unit: 'month', repeat_every: 0, start_date: '2027-01-01' }), 400);
  assert.equal(await post({ repeat_unit: 'month', repeat_every: 1.5, start_date: '2027-01-01' }), 400);
  assert.equal(await post({ repeat_unit: 'month', repeat_every: 1, start_date: '2027-02-30' }), 400);
  assert.equal(await post({ days: [1], start_date: 'soon' }), 400);
  const cycle = { repeat_unit: 'month', repeat_every: 3, start_date: '2027-01-01' };
  assert.equal(await post({ ...cycle, remind_days_before: 3 }), 400); // no ping time to send it at
  assert.equal(await post({ ...cycle, remind_at: '09:00', remind_days_before: -1 }), 400);
  assert.equal(await post({ ...cycle, remind_at: '09:00', remind_days_before: 366 }), 400);
});

test('days-ahead pings save on cycle routines and are ignored on weekday ones', async () => {
  const cycle = await call('POST', '/api/routines', { title: 'Ahead', repeat_unit: 'month', repeat_every: 3, start_date: '2027-01-01', remind_at: '09:00', remind_days_before: 3 });
  assert.equal(cycle.body.remind_days_before, 3);
  const changed = await call('PUT', `/api/routines/${cycle.body.id}`, { title: 'Ahead', days: [1], remind_at: '09:00', remind_days_before: 3 });
  assert.equal(changed.body.remind_days_before, 0);
  await call('DELETE', `/api/routines/${cycle.body.id}`);
});

test('every routine has a start date, today by default, and stays off the list before it', async () => {
  const today = localParts(new Date(), 'UTC').date;
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const add = async (extra) => (await call('POST', '/api/routines', { days: everyDay, ...extra })).body;
  const titlesOn = async (date) => (await call('GET', `/api/today?date=${date}`)).body.routines.map((r) => r.title);

  const weekly = await add({ title: 'Starts today' });
  const monthly = await add({ title: 'Monthly from today', repeat_unit: 'month', repeat_every: 1 });
  assert.equal(weekly.start_date, today);
  assert.equal(monthly.start_date, today);

  const later = await add({ title: 'Starts next week', start_date: addDays(today, 7) });
  assert.ok(!(await titlesOn(today)).includes('Starts next week'));
  assert.ok((await titlesOn(addDays(today, 7))).includes('Starts next week'));
  assert.ok(!(await titlesOn(addDays(today, -1))).includes('Starts today'));

  for (const r of [weekly, monthly, later]) await call('DELETE', `/api/routines/${r.id}`);
});

test('a cycle routine shows on its date, waits until checked off, and only then leaves the list', async () => {
  const today = localParts(new Date(), 'UTC').date;
  const tomorrow = addDays(today, 1);
  const created = await call('POST', '/api/routines', { title: 'Quarterly review', repeat_unit: 'month', repeat_every: 3, start_date: today });
  assert.equal(created.status, 201);
  const { id } = created.body;
  const listed = async (date) => (await call('GET', `/api/today?date=${date}`)).body.routines.find((r) => r.id === id);

  assert.equal((await listed(addDays(today, -1))), undefined); // before it starts
  assert.equal((await listed(today)).occurrence, today);

  // Not done: still listed the next day, flagged as waiting since its date.
  const waiting = await listed(tomorrow);
  assert.equal(waiting.occurrence, today);
  assert.equal(waiting.status, 'overdue');

  // Checking it off from the later day completes the original occurrence.
  await call('PUT', `/api/today/${id}`, { date: tomorrow, done: true });
  assert.equal((await listed(today)).status, 'done');
  assert.equal(await listed(tomorrow), undefined); // it was finished today, so it isn't listed after

  await call('DELETE', `/api/routines/${id}`);
});

test('a cycle routine added after its latest date does not show up as already overdue', async () => {
  const today = localParts(new Date(), 'UTC').date;
  const { body } = await call('POST', '/api/routines', { title: 'Backdated', repeat_unit: 'day', repeat_every: 30, start_date: addDays(today, -5) });
  const titles = (await call('GET', '/api/today')).body.routines.map((r) => r.title);
  assert.ok(!titles.includes('Backdated'));
  await call('DELETE', `/api/routines/${body.id}`);
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

test('upgrading an older database keeps existing routines on their weekdays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
  const old = new DatabaseSync(path.join(dir, 'tasks.db'));
  old.exec(`
    CREATE TABLE routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      days TEXT NOT NULL DEFAULT '0123456', remind_at TEXT, due_by TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO routines (title, days) VALUES ('Clean the house', '6');
  `);
  old.close();

  const db = openDb(dir);
  const routine = db.prepare('SELECT * FROM routines').get();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(routine.days, '6');
  assert.equal(routine.repeat_unit, 'weekdays');
  assert.match(routine.start_date, /^2026-01-01$|^2025-12-31$/); // the day it was added, in the machine's time zone
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
