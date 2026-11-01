import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { tick } from '../server/scheduler.js';
import { discordMessage, isValidWebhookUrl } from '../server/discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/token';
const realFetch = globalThis.fetch;
let calls;
let respond;

beforeEach(() => {
  calls = [];
  respond = () => new Response(null, { status: 204 });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return respond();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup() {
  const db = openDb(null);
  setSetting(db, 'timezone', 'America/Chicago');
  setSetting(db, 'discord_webhook_url', HOOK);
  db.prepare("INSERT INTO routines (title, days, remind_at) VALUES ('Read my Bible', '0123456', '06:00')").run();
  return db;
}

const SIX_AM_CHICAGO = new Date('2026-10-12T11:00:30Z');

test('a due routine posts one message to the webhook, never twice', async () => {
  const db = setup();
  await tick(db, SIX_AM_CHICAGO);
  await tick(db, new Date(SIX_AM_CHICAGO.getTime() + 60_000));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK);
  assert.equal(calls[0].body.embeds[0].title, 'Time for: Read my Bible');
});

test('a failed delivery is retried on the next tick', async () => {
  const db = setup();
  respond = () => new Response('nope', { status: 500 });
  await tick(db, SIX_AM_CHICAGO);
  respond = () => new Response(null, { status: 204 });
  await tick(db, new Date(SIX_AM_CHICAGO.getTime() + 30_000));
  await tick(db, new Date(SIX_AM_CHICAGO.getTime() + 60_000));
  assert.equal(calls.length, 2); // one failure, one success, then nothing
});

test('nothing is sent while no webhook is configured', async () => {
  const db = setup();
  setSetting(db, 'discord_webhook_url', '');
  await tick(db, SIX_AM_CHICAGO);
  assert.equal(calls.length, 0);
});

test('message format: mention and colors', () => {
  const msg = discordMessage({ title: 'Overdue: Trash', body: 'Due by 8:00 PM', kind: 'overdue', url: '/#today' }, { userId: '987654321098765432', appUrl: 'https://personal.example.com' });
  assert.equal(msg.content, '<@987654321098765432>');
  assert.deepEqual(msg.allowed_mentions, { users: ['987654321098765432'] });
  assert.equal(msg.embeds[0].color, 0xb5442f);
  assert.equal(msg.embeds[0].url, 'https://personal.example.com/#today');
  assert.equal(discordMessage({ title: 't' }).content, undefined);
});

test('only Discord webhook URLs are accepted', () => {
  assert.ok(isValidWebhookUrl(HOOK));
  assert.ok(isValidWebhookUrl('https://discordapp.com/api/webhooks/1/abc-DEF_1'));
  assert.ok(!isValidWebhookUrl('http://discord.com/api/webhooks/1/abc'));
  assert.ok(!isValidWebhookUrl('https://discord.com.evil.net/api/webhooks/1/abc'));
  assert.ok(!isValidWebhookUrl('https://discord.com/api/webhooks/1/abc/extra'));
});
