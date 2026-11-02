import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, GRACE_MINUTES } from '../server/reminders.js';
import { localParts, addDays, isValidDate } from '../server/time.js';

const bible = { id: 1, title: 'Read my Bible', notes: '', days: '0123456', remind_at: '06:00', due_by: '08:00' };
const trash = { id: 2, title: 'Take out trash', notes: '', days: '1', remind_at: '19:00', due_by: null };

const at = (minutes, weekday = 1) => ({ date: addDays('2026-10-11', weekday), minutes, weekday }); // Oct 11 is a Sunday
const keys = (list) => list.map((n) => n.key);

test('routine pings at its time and is overdue at its due-by time', () => {
  const base = { now: new Date(), routines: [bible], doneToday: new Set(), todos: [] };
  assert.deepEqual(keys(dueReminders({ ...base, local: at(5 * 60 + 59) })), []);
  assert.deepEqual(keys(dueReminders({ ...base, local: at(6 * 60) })), ['routine:1:2026-10-12:remind']);
  assert.deepEqual(keys(dueReminders({ ...base, local: at(8 * 60 + 5) })), ['routine:1:2026-10-12:overdue']);
});

test('reminders older than the grace window are skipped', () => {
  const base = { now: new Date(), routines: [bible], doneToday: new Set(), todos: [] };
  assert.equal(dueReminders({ ...base, local: at(6 * 60 + GRACE_MINUTES) }).length, 1);
  assert.equal(dueReminders({ ...base, local: at(6 * 60 + GRACE_MINUTES + 1) }).length, 0);
});

test('completed routines and routines not scheduled today stay quiet', () => {
  const now = new Date();
  assert.equal(dueReminders({ now, local: at(6 * 60), routines: [bible], doneToday: new Set([1]), todos: [] }).length, 0);
  // Trash is Monday-only: fires Monday, not Tuesday.
  assert.equal(dueReminders({ now, local: at(19 * 60, 1), routines: [trash], doneToday: new Set(), todos: [] }).length, 1);
  assert.equal(dueReminders({ now, local: at(19 * 60, 2), routines: [trash], doneToday: new Set(), todos: [] }).length, 0);
});

test('a cycle routine pings on its date only, not on the days it waits to be checked off', () => {
  const quarterly = { id: 3, title: 'Review budget', notes: '', days: '0123456', repeat_unit: 'month', repeat_every: 3, start_date: '2027-01-01', remind_at: '09:00', due_by: null };
  const base = { now: new Date(), routines: [quarterly], doneToday: new Set(), todos: [] };
  const on = (date) => ({ date, minutes: 9 * 60, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() });
  assert.deepEqual(keys(dueReminders({ ...base, local: on('2027-04-01') })), ['routine:3:2027-04-01:remind']);
  assert.equal(dueReminders({ ...base, local: on('2027-04-02') }).length, 0);
  assert.equal(dueReminders({ ...base, local: on('2026-10-01') }).length, 0);
});

test('a cycle routine can ping days ahead of its date, instead of on the day', () => {
  const quarterly = { id: 3, title: 'Review budget', notes: 'Bring receipts', days: '0123456', repeat_unit: 'month', repeat_every: 3, start_date: '2027-01-01', remind_at: '09:00', remind_days_before: 3, due_by: '17:00' };
  const base = { now: new Date(), routines: [quarterly], todos: [] };
  const on = (date, minutes = 9 * 60) => ({ date, minutes, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() });

  const pings = dueReminders({ ...base, doneToday: new Set(), local: on('2027-03-29') });
  assert.deepEqual(keys(pings), ['routine:3:2027-04-01:remind']);
  assert.equal(pings[0].title, 'Coming up in 3 days: Review budget');
  assert.equal(pings[0].body, 'Due Apr 1. Bring receipts');

  assert.equal(dueReminders({ ...base, doneToday: new Set(), local: on('2027-03-30') }).length, 0);
  assert.equal(dueReminders({ ...base, doneToday: new Set(), local: on('2027-04-01') }).length, 0);
  // The overdue ping still belongs to the date itself.
  assert.deepEqual(keys(dueReminders({ ...base, doneToday: new Set(), local: on('2027-04-01', 17 * 60) })), ['routine:3:2027-04-01:overdue']);
  // Finishing today's occurrence doesn't silence the heads-up for the next one on a short cycle.
  const short = { ...quarterly, repeat_unit: 'day', repeat_every: 2, remind_days_before: 2, start_date: '2027-01-01' };
  assert.deepEqual(keys(dueReminders({ now: new Date(), routines: [short], todos: [], doneToday: new Set([3]), local: on('2027-01-03') })), ['routine:3:2027-01-05:remind']);
});

test('to-do reminder and overdue pings; rescheduling changes the key', () => {
  const now = new Date('2026-10-12T15:00:00Z');
  const todo = { id: 7, title: 'Call mom', notes: '', completed_at: null, remind_at: '2026-10-12T14:55:00.000Z', due_at: '2026-10-12T15:00:00.000Z' };
  const local = at(10 * 60);
  assert.deepEqual(keys(dueReminders({ now, local, routines: [], doneToday: new Set(), todos: [todo] })), [
    'todo:7:remind:2026-10-12T14:55:00.000Z',
    'todo:7:overdue:2026-10-12T15:00:00.000Z',
  ]);
  const future = { ...todo, remind_at: '2026-10-12T16:00:00.000Z', due_at: null };
  assert.equal(dueReminders({ now, local, routines: [], doneToday: new Set(), todos: [future] }).length, 0);
  const done = { ...todo, completed_at: '2026-10-12T14:00:00.000Z' };
  assert.equal(dueReminders({ now, local, routines: [], doneToday: new Set(), todos: [done] }).length, 0);
});

test('localParts reads wall-clock time in the given zone', () => {
  // 11:30 UTC on Monday Oct 12 2026 = 6:30 AM in Chicago (CDT, UTC-5)
  assert.deepEqual(localParts(new Date('2026-10-12T11:30:00Z'), 'America/Chicago'), { date: '2026-10-12', minutes: 390, weekday: 1 });
  // 03:00 UTC Monday = still Sunday evening in Chicago
  assert.deepEqual(localParts(new Date('2026-10-12T03:00:00Z'), 'America/Chicago'), { date: '2026-10-11', minutes: 22 * 60, weekday: 0 });
});

test('date helpers', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.ok(isValidDate('2026-10-12'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('nope'));
});
