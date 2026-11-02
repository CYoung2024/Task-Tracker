import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCycleUnit, latestOccurrence } from '../public/schedule.js';
import { getSetting, setSetting, transaction } from './db.js';
import { isValidUserId, isValidWebhookUrl, mentionUserId, sendDiscord, webhookUrl } from './discord.js';
import { userTimeZone } from './scheduler.js';
import { addDays, isValidDate, isValidTimeZone, localParts, parseHHMM, weekdayOf } from './time.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

function cleanTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw bad('Title is required');
  if (title.length > 200) throw bad('Title is too long');
  return title;
}

function cleanNotes(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw bad('Notes must be text');
  return value.trim().slice(0, 2000);
}

function cleanTime(value, field) {
  if (value == null || value === '') return null;
  if (parseHHMM(value) === null) throw bad(`${field} must be HH:MM`);
  return value;
}

function cleanInstant(value, field) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(t)) throw bad(`${field} must be a date/time`);
  return new Date(t).toISOString();
}

function cleanDays(value) {
  if (!Array.isArray(value)) throw bad('Days must be a list of weekdays');
  const days = [...new Set(value.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) throw bad('Pick at least one day');
  return days.sort().join('');
}

function cleanSchedule(body, today) {
  const unit = body.repeat_unit ?? 'weekdays';
  const start_date = body.start_date || today;
  if (!isValidDate(start_date)) throw bad('Start date must be a real date');
  if (unit === 'weekdays') return { days: cleanDays(body.days), repeat_unit: unit, repeat_every: 1, start_date, remind_days_before: 0 };
  if (!isCycleUnit(unit)) throw bad('Repeat must be days of the week, or every so many days, weeks, months or years');
  const every = Number(body.repeat_every);
  if (!Number.isInteger(every) || every < 1 || every > 999) throw bad('Repeat every must be a whole number from 1 to 999');
  const ahead = Number(body.remind_days_before ?? 0);
  if (!Number.isInteger(ahead) || ahead < 0 || ahead > 365) throw bad('Days ahead must be a whole number from 0 to 365');
  if (ahead > 0 && !body.remind_at) throw bad('Pick a "Ping me at" time for the days-ahead ping');
  return { days: '0123456', repeat_unit: unit, repeat_every: every, start_date, remind_days_before: ahead };
}

function routineInput(body, today) {
  return {
    title: cleanTitle(body.title),
    notes: cleanNotes(body.notes),
    ...cleanSchedule(body, today),
    remind_at: cleanTime(body.remind_at, 'Reminder time'),
    due_by: cleanTime(body.due_by, 'Due-by time'),
  };
}

function routineOut(r) {
  return { ...r, days: [...r.days].map(Number) };
}

const ROUTINE_ORDER = `ORDER BY COALESCE(remind_at, due_by, '99:99'), sort_order, id`;
// Dated items first, soonest on top; sort_order only arranges the undated ones (and ties on a date).
const TODO_ORDER = 'ORDER BY due_at IS NULL, due_at, sort_order, id DESC';

export function createApp(db) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // No login: the app is meant to be reachable only from your own network/VPN.
  const api = express.Router();
  app.use('/api', api);

  // ---- today (daily checklist) -------------------------------------------
  api.get('/today', (req, res) => {
    const tz = userTimeZone(db);
    const now = localParts(new Date(), tz);
    const date = req.query.date ?? now.date;
    if (!isValidDate(date)) throw bad('Invalid date');
    const weekday = weekdayOf(date);

    const routines = db.prepare(`SELECT * FROM routines ${ROUTINE_ORDER}`).all();
    const completions = db.prepare('SELECT routine_id, date, completed_at FROM routine_completions').all();
    const doneByRoutine = new Map();
    for (const c of completions) {
      if (!doneByRoutine.has(c.routine_id)) doneByRoutine.set(c.routine_id, new Map());
      doneByRoutine.get(c.routine_id).set(c.date, c.completed_at);
    }

    const items = routines.flatMap((r) => {
      const done = doneByRoutine.get(r.id) ?? new Map();
      const occurrence = occurrenceShownOn(r, date, done, tz);
      if (!occurrence) return [];
      const completedAt = done.get(occurrence) ?? null;
      let status = 'pending';
      if (completedAt) status = 'done';
      else if (date < now.date) status = occurrenceShownOn(r, now.date, done, tz) === occurrence ? 'overdue' : 'missed';
      else if (occurrence < date) status = 'overdue';
      else if (date === now.date && r.due_by && now.minutes > parseHHMM(r.due_by)) status = 'overdue';
      return [{ ...routineOut(r), occurrence, completed_at: completedAt, status, streak: streak(r, done, date, tz) }];
    });

    res.json({ date, weekday, today: now.date, timezone: tz, routines: items });
  });

  api.put('/today/:id', (req, res) => {
    const id = Number(req.params.id);
    const { date, done } = req.body ?? {};
    if (!isValidDate(date)) throw bad('Invalid date');
    const routine = db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
    if (!routine) throw new HttpError(404, 'Not found');
    // Checking off a routine that has been waiting since an earlier date completes that occurrence.
    const occurrence = latestOccurrence(routine, date) ?? date;
    if (done) {
      db.prepare('INSERT OR IGNORE INTO routine_completions (routine_id, date) VALUES (?, ?)').run(id, occurrence);
    } else {
      db.prepare('DELETE FROM routine_completions WHERE routine_id = ? AND date = ?').run(id, occurrence);
    }
    res.json({ ok: true });
  });

  // ---- routines (configuration) ------------------------------------------
  api.get('/routines', (req, res) => {
    res.json(db.prepare(`SELECT * FROM routines ${ROUTINE_ORDER}`).all().map(routineOut));
  });

  const todayDate = () => localParts(new Date(), userTimeZone(db)).date;

  api.post('/routines', (req, res) => {
    const r = routineInput(req.body ?? {}, todayDate());
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO routines (title, notes, days, repeat_unit, repeat_every, start_date, remind_at, remind_days_before, due_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.title, r.notes, r.days, r.repeat_unit, r.repeat_every, r.start_date, r.remind_at, r.remind_days_before, r.due_by);
    res.status(201).json(routineOut(db.prepare('SELECT * FROM routines WHERE id = ?').get(lastInsertRowid)));
  });

  api.put('/routines/:id', (req, res) => {
    const r = routineInput(req.body ?? {}, todayDate());
    const { changes } = db
      .prepare(
        `UPDATE routines SET title = ?, notes = ?, days = ?, repeat_unit = ?, repeat_every = ?, start_date = ?, remind_at = ?, remind_days_before = ?, due_by = ?
         WHERE id = ?`
      )
      .run(r.title, r.notes, r.days, r.repeat_unit, r.repeat_every, r.start_date, r.remind_at, r.remind_days_before, r.due_by, Number(req.params.id));
    if (!changes) throw new HttpError(404, 'Not found');
    res.json(routineOut(db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(req.params.id))));
  });

  api.delete('/routines/:id', (req, res) => {
    db.prepare('DELETE FROM routines WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- to-do list (persistent) -------------------------------------------
  const getTodo = (id) => db.prepare('SELECT * FROM todos WHERE id = ?').get(id);

  api.get('/todos', (req, res) => {
    const open = db.prepare(`SELECT * FROM todos WHERE completed_at IS NULL ${TODO_ORDER}`).all();
    const done = db
      .prepare('SELECT * FROM todos WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 100')
      .all();
    res.json({ open, done });
  });

  api.post('/todos', (req, res) => {
    const b = req.body ?? {};
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO todos (title, notes, due_at, remind_at, sort_order)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM todos))`
      )
      .run(cleanTitle(b.title), cleanNotes(b.notes), cleanInstant(b.due_at, 'Due'), cleanInstant(b.remind_at, 'Reminder'));
    res.status(201).json(getTodo(lastInsertRowid));
  });

  api.put('/todos/order', (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) throw bad('ids must be a list of to-do ids');
    transaction(db, () => {
      const open = db.prepare(`SELECT id FROM todos WHERE completed_at IS NULL ${TODO_ORDER}`).all().map((t) => t.id);
      const listed = [...new Set(ids.map(Number))].filter((id) => open.includes(id));
      // Anything the client didn't know about (added on another device) stays on top, like any new item.
      const ordered = [...open.filter((id) => !listed.includes(id)), ...listed];
      const update = db.prepare('UPDATE todos SET sort_order = ? WHERE id = ?');
      ordered.forEach((id, position) => update.run(position, id));
    });
    res.json({ ok: true });
  });

  api.patch('/todos/:id', (req, res) => {
    const id = Number(req.params.id);
    const todo = getTodo(id);
    if (!todo) throw new HttpError(404, 'Not found');
    const b = req.body ?? {};
    const next = {
      title: 'title' in b ? cleanTitle(b.title) : todo.title,
      notes: 'notes' in b ? cleanNotes(b.notes) : todo.notes,
      due_at: 'due_at' in b ? cleanInstant(b.due_at, 'Due') : todo.due_at,
      remind_at: 'remind_at' in b ? cleanInstant(b.remind_at, 'Reminder') : todo.remind_at,
      completed_at: 'done' in b ? (b.done ? (todo.completed_at ?? new Date().toISOString()) : null) : todo.completed_at,
    };
    db.prepare('UPDATE todos SET title = ?, notes = ?, due_at = ?, remind_at = ?, completed_at = ? WHERE id = ?').run(
      next.title,
      next.notes,
      next.due_at,
      next.remind_at,
      next.completed_at,
      id
    );
    res.json(getTodo(id));
  });

  api.delete('/todos/completed', (req, res) => {
    db.prepare('DELETE FROM todos WHERE completed_at IS NOT NULL').run();
    res.json({ ok: true });
  });

  api.delete('/todos/:id', (req, res) => {
    db.prepare('DELETE FROM todos WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- settings & Discord notifications -----------------------------------
  api.get('/settings', (req, res) => {
    const url = webhookUrl(db);
    res.json({
      timezone: userTimeZone(db),
      timezoneSaved: Boolean(getSetting(db, 'timezone')),
      discord: {
        configured: Boolean(url),
        // Only show the start of the webhook ID; the token at the end is the secret part.
        hint: url ? url.replace(/\/webhooks\/(\d{4})\d*\/.*$/, '/webhooks/$1…') : '',
        fromEnv: Boolean(url) && !getSetting(db, 'discord_webhook_url'),
        userId: mentionUserId(db),
      },
    });
  });

  api.put('/settings', (req, res) => {
    const { timezone, discord_webhook_url: hook, discord_user_id: userId } = req.body ?? {};
    if (timezone !== undefined) {
      if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) throw bad('Unknown timezone');
      setSetting(db, 'timezone', timezone);
    }
    if (hook !== undefined) {
      const url = String(hook ?? '').trim();
      if (url && !isValidWebhookUrl(url)) {
        throw bad('That doesn\'t look like a Discord webhook URL. It should start with https://discord.com/api/webhooks/');
      }
      setSetting(db, 'discord_webhook_url', url);
    }
    if (userId !== undefined) {
      const id = String(userId ?? '').trim();
      if (id && !isValidUserId(id)) throw bad('A Discord user ID is a long number, like 123456789012345678');
      setSetting(db, 'discord_user_id', id);
    }
    res.json({ ok: true });
  });

  api.post('/notify/test', async (req, res) => {
    if (!webhookUrl(db)) throw bad('Add your Discord webhook URL first');
    try {
      await sendDiscord(db, {
        title: 'Reminders are working',
        body: 'This is what a ping from your task tracker looks like.',
        url: '/#settings',
      });
    } catch (err) {
      throw new HttpError(502, `Couldn't reach Discord: ${err.message}`);
    }
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- static front end --------------------------------------------------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500 && status !== 502) console.error(err);
    res.status(status).json({ error: status >= 500 && status !== 502 ? 'Something went wrong' : err.message });
  });

  return app;
}

/**
 * The occurrence a routine shows for on `date`, or null if it isn't on that day's list. A cycle routine
 * waits on the list until it's checked off or the next one comes around, so a quarterly task missed on
 * the day isn't gone for three months. Occurrences from before the routine was added don't count.
 */
function occurrenceShownOn(routine, date, done, tz) {
  const occurrence = latestOccurrence(routine, date);
  if (!occurrence || occurrence === date) return occurrence;
  if (!isCycleUnit(routine.repeat_unit)) return null;
  const completedAt = done.get(occurrence);
  if (completedAt) return localParts(new Date(completedAt), tz).date >= date ? occurrence : null;
  return occurrence >= localParts(new Date(routine.created_at), tz).date ? occurrence : null;
}

/** Consecutive occurrences completed, counting back from `date`. The current one not being done yet doesn't break it. */
function streak(routine, done, date, tz) {
  const first = routine.start_date ?? localParts(new Date(routine.created_at), tz).date;
  const before = (d) => latestOccurrence(routine, addDays(d, -1));
  let count = 0;
  let d = latestOccurrence(routine, date);
  if (d && !done.has(d)) d = before(d);
  for (let i = 0; i < 400 && d && d >= first; i++, d = before(d)) {
    if (!done.has(d)) break;
    count++;
  }
  return count;
}
