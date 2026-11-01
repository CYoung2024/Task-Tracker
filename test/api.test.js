import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
