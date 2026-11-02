// When a routine comes around. Pure date math on YYYY-MM-DD strings, shared by the server and the browser.
//
// A routine either runs on weekdays (repeat_unit 'weekdays', using `days`) or on a cycle: every
// repeat_every days/weeks/months/years, counted from start_date. Either way nothing happens before
// start_date. Month cycles keep start_date's day of the month, landing on the last day of shorter months.

const DAY_MS = 86_400_000;
const CYCLE_UNITS = ['day', 'week', 'month', 'year'];

const toDayNumber = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

export const isCycleUnit = (unit) => CYCLE_UNITS.includes(unit);

/** Occurrence number k's date, and the number of the last occurrence on or before a date (negative if none). */
function cycleOf(r) {
  if (r.repeat_unit === 'day' || r.repeat_unit === 'week') {
    const step = r.repeat_every * (r.repeat_unit === 'week' ? 7 : 1);
    const first = toDayNumber(r.start_date);
    return {
      at: (k) => fromDayNumber(first + k * step),
      lastIndex: (date) => Math.floor((toDayNumber(date) - first) / step),
    };
  }
  const step = r.repeat_every * (r.repeat_unit === 'year' ? 12 : 1);
  const [startYear, startMonth, startDay] = r.start_date.split('-').map(Number);
  const first = startYear * 12 + startMonth - 1;
  const at = (k) => {
    const months = first + k * step;
    const year = Math.floor(months / 12);
    const month = months % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return `${year}-${pad(month + 1)}-${pad(Math.min(startDay, lastDay))}`;
  };
  return {
    at,
    lastIndex: (date) => {
      const [year, month] = date.split('-').map(Number);
      const k = Math.floor((year * 12 + month - 1 - first) / step);
      return at(k) > date ? k - 1 : k;
    },
  };
}

// `days` is a digit string on database rows and a list of numbers once it has been through the API.
const runsOnWeekday = (r, date) => [...r.days].map(Number).includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/** The most recent occurrence on or before `date`, or null if there hasn't been one. */
export function latestOccurrence(r, date) {
  if (isCycleUnit(r.repeat_unit)) {
    const cycle = cycleOf(r);
    const k = cycle.lastIndex(date);
    return k < 0 ? null : cycle.at(k);
  }
  for (let i = 0, d = toDayNumber(date); i < 7; i++, d--) {
    if (runsOnWeekday(r, fromDayNumber(d))) {
      const found = fromDayNumber(d);
      return r.start_date && found < r.start_date ? null : found;
    }
  }
  return null;
}

/** The next `count` occurrences on or after `from`. */
export function upcomingOccurrences(r, from, count) {
  const out = [];
  if (isCycleUnit(r.repeat_unit)) {
    const cycle = cycleOf(r);
    const last = cycle.lastIndex(from);
    let k = Math.max(0, cycle.at(last) === from ? last : last + 1);
    while (out.length < count) out.push(cycle.at(k++));
    return out;
  }
  if (r.days.length === 0) return out;
  const first = r.start_date && r.start_date > from ? r.start_date : from;
  for (let d = toDayNumber(first); out.length < count; d++) {
    if (runsOnWeekday(r, fromDayNumber(d))) out.push(fromDayNumber(d));
  }
  return out;
}

export const nextOccurrence = (r, from) => upcomingOccurrences(r, from, 1)[0] ?? null;

export const occursOn = (r, date) => latestOccurrence(r, date) === date;
