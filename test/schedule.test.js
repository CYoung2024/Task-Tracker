import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestOccurrence, nextOccurrence, occursOn, upcomingOccurrences } from '../public/schedule.js';

const cycle = (repeat_unit, repeat_every, start_date) => ({ repeat_unit, repeat_every, start_date });

test('quarterly lands on the first day of each quarter', () => {
  const r = cycle('month', 3, '2027-01-01');
  assert.deepEqual(upcomingOccurrences(r, '2026-11-01', 5), ['2027-01-01', '2027-04-01', '2027-07-01', '2027-10-01', '2028-01-01']);
  assert.ok(occursOn(r, '2027-04-01'));
  assert.ok(!occursOn(r, '2027-04-02'));
  assert.ok(!occursOn(r, '2027-05-01'));
  assert.equal(latestOccurrence(r, '2027-06-30'), '2027-04-01');
});

test('nothing happens before the start date', () => {
  for (const r of [cycle('month', 1, '2027-01-15'), cycle('day', 10, '2027-01-15'), cycle('year', 1, '2027-01-15')]) {
    assert.equal(latestOccurrence(r, '2027-01-14'), null);
    assert.equal(latestOccurrence(r, '2020-06-01'), null);
    assert.equal(latestOccurrence(r, '2027-01-15'), '2027-01-15');
    assert.equal(nextOccurrence(r, '2020-06-01'), '2027-01-15');
  }
});

test('months too short for the day land on their last day, then go back', () => {
  const r = cycle('month', 1, '2027-01-31');
  assert.deepEqual(upcomingOccurrences(r, '2027-01-01', 4), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.equal(latestOccurrence(r, '2027-03-30'), '2027-02-28');
  assert.deepEqual(upcomingOccurrences(cycle('month', 1, '2028-01-31'), '2028-02-01', 1), ['2028-02-29']);
});

test('yearly, including from a leap day', () => {
  assert.deepEqual(upcomingOccurrences(cycle('year', 1, '2027-03-15'), '2027-03-16', 2), ['2028-03-15', '2029-03-15']);
  assert.deepEqual(upcomingOccurrences(cycle('year', 1, '2028-02-29'), '2028-03-01', 4), ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  assert.deepEqual(upcomingOccurrences(cycle('year', 2, '2027-03-15'), '2027-03-16', 1), ['2029-03-15']);
});

test('every so many days or weeks, across a month and year end', () => {
  const r = cycle('day', 45, '2026-12-01');
  assert.deepEqual(upcomingOccurrences(r, '2026-12-01', 3), ['2026-12-01', '2027-01-15', '2027-03-01']);
  assert.equal(latestOccurrence(r, '2027-01-14'), '2026-12-01');
  assert.deepEqual(upcomingOccurrences(cycle('week', 2, '2026-12-22'), '2026-12-23', 2), ['2027-01-05', '2027-01-19']);
});

test('weekday routines work from a digit string or a list of numbers', () => {
  for (const days of ['1', [1]]) {
    const r = { repeat_unit: 'weekdays', days };
    assert.ok(occursOn(r, '2026-10-12')); // a Monday
    assert.ok(!occursOn(r, '2026-10-13'));
    assert.equal(latestOccurrence(r, '2026-10-15'), '2026-10-12');
    assert.equal(nextOccurrence(r, '2026-10-13'), '2026-10-19');
  }
});

test('weekday routines wait for their start date', () => {
  const r = { repeat_unit: 'weekdays', days: '1', start_date: '2026-10-19' }; // a Monday
  assert.ok(!occursOn(r, '2026-10-12'));
  assert.equal(latestOccurrence(r, '2026-10-18'), null);
  assert.ok(occursOn(r, '2026-10-19'));
  assert.equal(nextOccurrence(r, '2026-10-01'), '2026-10-19');
  assert.equal(nextOccurrence({ ...r, start_date: '2026-10-20' }, '2026-10-01'), '2026-10-26');
});
