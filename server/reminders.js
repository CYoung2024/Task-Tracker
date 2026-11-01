// Decides which reminders are due. Pure logic (no I/O) so it is easy to test.
import { parseHHMM } from './time.js';

// A reminder still fires if the server was down / asleep at its exact minute,
// as long as we notice within this window. Older ones are skipped rather than
// arriving as a stale burst (e.g. after creating a routine at 2pm with a 6am time).
export const GRACE_MINUTES = 30;

function formatHHMM(hhmm) {
  const mins = parseHHMM(hhmm);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * @param {object} p
 * @param {Date}   p.now
 * @param {{date: string, minutes: number, weekday: number}} p.local  `now` in the user's timezone
 * @param {Array}  p.routines         rows from `routines`
 * @param {Set<number>} p.doneToday   routine ids completed on local.date
 * @param {Array}  p.todos            open (not completed) rows from `todos`
 * @returns {Array<{key: string, title: string, body: string, kind: 'remind' | 'overdue', url: string}>}
 */
export function dueReminders({ now, local, routines, doneToday, todos }) {
  const out = [];
  const inWindow = (targetMinutes) =>
    targetMinutes !== null &&
    local.minutes >= targetMinutes &&
    local.minutes - targetMinutes <= GRACE_MINUTES;

  for (const r of routines) {
    if (!r.days.includes(String(local.weekday)) || doneToday.has(r.id)) continue;

    if (inWindow(parseHHMM(r.remind_at))) {
      out.push({
        key: `routine:${r.id}:${local.date}:remind`,
        title: `Time for: ${r.title}`,
        body: r.notes || `Scheduled for ${formatHHMM(r.remind_at)}`,
        kind: 'remind',
        url: '/#today',
      });
    }
    if (inWindow(parseHHMM(r.due_by))) {
      out.push({
        key: `routine:${r.id}:${local.date}:overdue`,
        title: `Overdue: ${r.title}`,
        body: `This was due by ${formatHHMM(r.due_by)} today.`,
        kind: 'overdue',
        url: '/#today',
      });
    }
  }

  const graceMs = GRACE_MINUTES * 60_000;
  const nowMs = now.getTime();
  const instantInWindow = (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && nowMs >= t && nowMs - t <= graceMs;
  };

  for (const t of todos) {
    if (t.completed_at) continue;
    // The timestamp is part of the key so that rescheduling a to-do re-arms its reminder.
    if (instantInWindow(t.remind_at)) {
      out.push({
        key: `todo:${t.id}:remind:${t.remind_at}`,
        title: `Reminder: ${t.title}`,
        body: t.notes || 'From your to-do list',
        kind: 'remind',
        url: '/#todos',
      });
    }
    if (instantInWindow(t.due_at)) {
      out.push({
        key: `todo:${t.id}:overdue:${t.due_at}`,
        title: `Overdue: ${t.title}`,
        body: t.notes || 'This to-do just passed its due time.',
        kind: 'overdue',
        url: '/#todos',
      });
    }
  }

  return out;
}
