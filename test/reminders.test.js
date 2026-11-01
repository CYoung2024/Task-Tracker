import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, GRACE_MINUTES } from '../server/reminders.js';
import { localParts, addDays, isValidDate } from '../server/time.js';

const bible = { id: 1, title: 'Read my Bible', notes: '', days: '0123456', remind_at: '06:00', due_by: '08:00' };
const trash = { id: 2, title: 'Take out trash', notes: '', days: '1', remind_at: '19:00', due_by: null };

const at = (minutes, weekday = 1) => ({ date: '2026-10-12', minutes, weekday });
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
