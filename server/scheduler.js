import { getSetting } from './db.js';
import { localParts } from './time.js';
import { dueReminders } from './reminders.js';
import { sendDiscord, webhookUrl } from './discord.js';

export function userTimeZone(db) {
  return getSetting(db, 'timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** One pass: find due reminders, claim each in sent_notifications, then send it to Discord. */
export async function tick(db, now = new Date()) {
  if (!webhookUrl(db)) return; // nowhere to send yet
  const local = localParts(now, userTimeZone(db));
  const routines = db.prepare('SELECT * FROM routines').all();
  const doneToday = new Set(
    db
      .prepare('SELECT routine_id FROM routine_completions WHERE date = ?')
      .all(local.date)
      .map((r) => r.routine_id)
  );
  const todos = db.prepare('SELECT * FROM todos WHERE completed_at IS NULL').all();

  const claim = db.prepare('INSERT OR IGNORE INTO sent_notifications (key) VALUES (?)');
  const release = db.prepare('DELETE FROM sent_notifications WHERE key = ?');
  for (const n of dueReminders({ now, local, routines, doneToday, todos })) {
    if (claim.run(n.key).changes === 0) continue; // already sent
    try {
      await sendDiscord(db, n);
      console.log(`[reminder] sent: ${n.title}`);
    } catch (err) {
      // Un-claim so the next tick retries (until the grace window runs out).
      release.run(n.key);
      console.error(`[reminder] failed: ${n.title}: ${err.message}`);
    }
  }
}

export function startScheduler(db, intervalMs = 30_000) {
  const run = () => tick(db).catch((err) => console.error('[scheduler]', err));
  run();
  const timer = setInterval(run, intervalMs);
  // Housekeeping: forget sent-notification keys older than two weeks.
  const prune = setInterval(() => {
    db.prepare("DELETE FROM sent_notifications WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')").run();
  }, 6 * 60 * 60_000);
  timer.unref();
  prune.unref();
  return () => {
    clearInterval(timer);
    clearInterval(prune);
  };
}
