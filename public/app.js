import { api } from './api.js';
import { isCycleUnit, nextOccurrence, upcomingOccurrences } from './schedule.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const state = {
  today: null, // server's notion of today's date (user's timezone)
  viewDate: null, // date shown in the Daily card
  daily: null,
  todos: { open: [], done: [] },
  routines: [],
  settings: null,
};

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3200);
}

function fail(err) {
  console.error(err);
  toast(err.message || 'Something went wrong');
}

function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function dateFromYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(ymd, delta) {
  const d = dateFromYMD(ymd);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysLabel(days) {
  const key = days.join('');
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return days.map((d) => DAY_SHORT[d]).join(', ');
}

function fmtDay(ymd, options = { month: 'short', day: 'numeric' }) {
  return dateFromYMD(ymd).toLocaleDateString([], options);
}

function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}

/** "Every 3 months on the 1st · Jan, Apr, Jul, Oct" */
function cycleLabel(r) {
  const every = r.repeat_every;
  const start = dateFromYMD(r.start_date);
  const dayOfMonth = `on the ${ordinal(start.getDate())}`;
  switch (r.repeat_unit) {
    case 'day':
      return every === 1 ? 'Every day' : `Every ${every} days`;
    case 'week':
      return `Every ${every === 1 ? 'week' : `${every} weeks`} on ${DAY_SHORT[start.getDay()]}`;
    case 'year':
      return `Every ${every === 1 ? 'year' : `${every} years`} on ${fmtDay(r.start_date)}`;
    default: {
      if (every === 1) return `Every month ${dayOfMonth}`;
      if (every !== 3) return `Every ${every} months ${dayOfMonth}`;
      const months = [0, 1, 2, 3]
        .map((k) => (start.getMonth() + k * 3) % 12)
        .sort((a, b) => a - b)
        .map((m) => new Date(2000, m, 1).toLocaleDateString([], { month: 'short' }));
      return `Every 3 months ${dayOfMonth} · ${months.join(', ')}`;
    }
  }
}

/** "today", "in 3 days", "in 2 months"… */
function fmtUntil(ymd, from) {
  const days = Math.round((dateFromYMD(ymd) - dateFromYMD(from)) / 86_400_000);
  const plural = (n, unit) => `in ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return plural(days, 'day');
  if (days < 60) return plural(Math.round(days / 7), 'week');
  if (days < 365) return plural(Math.round(days / 30.4), 'month');
  return plural(Math.round(days / 365), 'year');
}

/** ISO instant -> value for <input type="datetime-local"> in the browser's zone. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff === -1) return `Yesterday ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ` ${time}`;
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0" /></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.3 3.6-8.3.9 1.4 1.4 2.6 1.4 3.9 1.6-1.3 2.6-3.6 2.4-6.4 3.6 2.4 5.6 6.5 5.6 10.4 0 3.8-2.6 6.6-6.5 6.6z" /></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="0.75" /><circle cx="15" cy="6" r="0.75" /><circle cx="9" cy="12" r="0.75" /><circle cx="15" cy="12" r="0.75" /><circle cx="9" cy="18" r="0.75" /><circle cx="15" cy="18" r="0.75" /></svg>',
};

// ---------------------------------------------------------------- routing

function currentTab() {
  const tab = location.hash.replace('#', '');
  return ['routines', 'settings'].includes(tab) ? tab : 'today';
}

function route() {
  const tab = currentTab();
  for (const v of $$('[data-view]')) v.hidden = v.dataset.view !== tab;
  for (const a of $$('[data-tab]')) a.classList.toggle('active', a.dataset.tab === tab);
  if (location.hash === '#todos') $('#todos').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (tab === 'routines') loadRoutines();
  if (tab === 'settings') loadSettings();
}

function renderHeader() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  if (state.today) {
    $('#headline').textContent = dateFromYMD(state.today).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
}

// ---------------------------------------------------------------- daily

async function loadDaily() {
  const qs = state.viewDate ? `?date=${state.viewDate}` : '';
  const data = await api.get(`/api/today${qs}`);
  state.daily = data;
  state.today = data.today;
  state.viewDate ??= data.today;
  renderHeader();
  renderDaily();
}

function renderDaily() {
  const { routines, date } = state.daily;
  const isToday = date === state.today;
  const doneCount = routines.filter((r) => r.status === 'done').length;

  const dayName = dateFromYMD(date).toLocaleDateString([], { weekday: 'long' });
  const prefix = isToday ? '' : `${dateFromYMD(date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · `;
  $('#daily-sub').textContent = routines.length
    ? `${prefix}${doneCount} of ${routines.length} done`
    : `${prefix}Nothing scheduled`;
  $('#daily-progress').style.width = routines.length ? `${(doneCount / routines.length) * 100}%` : '0%';
  $('#daily').classList.toggle('all-done', routines.length > 0 && doneCount === routines.length);
  $('#day-today').hidden = isToday;
  $('#day-next').disabled = date >= state.today;

  if (!routines.length) {
    $('#daily-list').innerHTML = `
      <li class="empty">
        <p>No routines for ${esc(dayName)}.</p>
        <a class="btn small" href="#routines">Set up routines</a>
      </li>`;
    return;
  }

  $('#daily-list').innerHTML = routines
    .map((r) => {
      const meta = [];
      const waiting = r.occurrence !== date;
      if (waiting) meta.push(`<span class="meta ${r.status === 'overdue' ? 'bad' : ''}">${ICON.clock}Due ${esc(fmtDay(r.occurrence))}</span>`);
      if (r.remind_at && !r.remind_days_before) meta.push(`<span class="meta">${ICON.bell}${fmtClock(r.remind_at)}</span>`);
      if (r.due_by && !waiting) meta.push(`<span class="meta ${r.status === 'overdue' ? 'bad' : ''}">${ICON.clock}${r.status === 'overdue' ? 'Overdue · ' : 'by '}${fmtClock(r.due_by)}</span>`);
      if (r.status === 'missed') meta.push('<span class="meta muted">Missed</span>');
      if (r.streak > 1) meta.push(`<span class="meta streak" title="${r.streak} in a row">${ICON.flame}${r.streak}</span>`);
      return `
        <li class="item ${r.status}" data-id="${r.id}">
          <button class="check" role="checkbox" aria-checked="${r.status === 'done'}" aria-label="${esc(r.title)}">${ICON.check}</button>
          <div class="item-body">
            <span class="item-title">${esc(r.title)}</span>
            ${r.notes ? `<span class="item-notes">${esc(r.notes)}</span>` : ''}
          </div>
          <div class="item-meta">${meta.join('')}</div>
        </li>`;
    })
    .join('');
}

async function toggleRoutine(id) {
  const r = state.daily.routines.find((x) => x.id === id);
  if (!r) return;
  const done = r.status !== 'done';
  // Optimistic update; the reload below settles the real status & streak.
  r.status = done ? 'done' : 'pending';
  renderDaily();
  try {
    await api.put(`/api/today/${id}`, { date: state.daily.date, done });
    await loadDaily();
  } catch (err) {
    fail(err);
    loadDaily().catch(() => {});
  }
}

// ---------------------------------------------------------------- to-dos

async function loadTodos() {
  state.todos = await api.get('/api/todos');
  renderTodos();
}

function todoItem(t) {
  const done = Boolean(t.completed_at);
  const overdue = !done && t.due_at && Date.parse(t.due_at) < Date.now();
  const meta = [];
  if (t.due_at) meta.push(`<span class="meta ${overdue ? 'bad' : ''}">${ICON.clock}${overdue ? 'Overdue · ' : ''}${esc(fmtWhen(t.due_at))}</span>`);
  if (t.remind_at && !done && Date.parse(t.remind_at) > Date.now()) meta.push(`<span class="meta">${ICON.bell}${esc(fmtWhen(t.remind_at))}</span>`);
  return `
    <li class="item ${done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${t.id}">
      ${done ? '' : t.due_at ? '<span class="drag-spacer"></span>' : `<button class="drag-handle" aria-label="Reorder ${esc(t.title)}. Use the up and down arrow keys." title="Drag to reorder">${ICON.grip}</button>`}
      <button class="check" role="checkbox" aria-checked="${done}" aria-label="${esc(t.title)}">${ICON.check}</button>
      <button class="item-body as-button" data-edit>
        <span class="item-title">${esc(t.title)}</span>
        ${t.notes ? `<span class="item-notes">${esc(t.notes)}</span>` : ''}
      </button>
      <div class="item-meta">${meta.join('')}</div>
    </li>`;
}

function renderTodos() {
  if (todoDrag) return; // a background refresh must not yank the list out from under a drag; the drop re-renders
  const { open, done } = state.todos;
  const overdue = open.filter((t) => t.due_at && Date.parse(t.due_at) < Date.now()).length;
  $('#todo-sub').textContent = open.length
    ? `${open.length} open${overdue ? ` · ${overdue} overdue` : ''}`
    : 'All clear';
  $('#todo-list').innerHTML = open.length
    ? open.map(todoItem).join('')
    : '<li class="empty"><p>Nothing on your list. Add something above.</p></li>';
  $('#todo-done-group').hidden = done.length === 0;
  $('#todo-done-count').textContent = `Completed (${done.length})`;
  $('#todo-done-list').innerHTML = done.map(todoItem).join('');
}

function findTodo(id) {
  return [...state.todos.open, ...state.todos.done].find((t) => t.id === id);
}

async function toggleTodo(id) {
  const t = findTodo(id);
  if (!t) return;
  const done = !t.completed_at;
  const li = $(`#todos .item[data-id="${id}"]`);
  li?.classList.toggle('done', done);
  li?.querySelector('.check')?.setAttribute('aria-checked', String(done));
  try {
    await api.patch(`/api/todos/${id}`, { done });
    // Small pause so the check animation is visible before the item moves.
    setTimeout(() => loadTodos().catch(fail), done ? 350 : 0);
  } catch (err) {
    fail(err);
  }
}

async function addTodo(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const title = form.title.value.trim();
  if (!title) return form.title.focus();
  try {
    await api.post('/api/todos', {
      title,
      due_at: fromLocalInput(form.due_at.value),
      remind_at: fromLocalInput(form.remind_at.value),
    });
    form.reset();
    toggleAddMore(false);
    form.title.focus();
    await loadTodos();
  } catch (err) {
    fail(err);
  }
}

function toggleAddMore(open) {
  const btn = $('#todo-add-more');
  const panel = $('#todo-add .add-more');
  open ??= panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('on', open);
}

// Reordering. Uses pointer events rather than HTML drag-and-drop, which doesn't work on touch screens.
// The dragged row is never moved in the DOM (that would drop its pointer capture); its neighbours
// are moved around it instead. Items with a due date stay sorted by date above the rest, so they
// have no handle and nothing can be dragged above them.

const DRAG_SCROLL_EDGE = 90; // px from the top/bottom of the window where a drag starts scrolling
const DRAG_SCROLL_SPEED = 8;

let todoDrag = null;

function todoListIds() {
  return $$('#todo-list .item').map((li) => Number(li.dataset.id));
}

const isDatedRow = (li) => Boolean(li.querySelector('.drag-spacer'));

function startTodoDrag(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle || e.button !== 0 || todoDrag) return;
  const li = handle.closest('.item');
  const rect = li.getBoundingClientRect();
  handle.setPointerCapture(e.pointerId);
  todoDrag = { li, pointerId: e.pointerId, y: e.clientY, grabOffset: e.clientY - rect.top, height: rect.height, startIds: todoListIds() };
  li.classList.add('dragging');
  requestAnimationFrame(stepTodoDrag);
}

function stepTodoDrag() {
  if (!todoDrag) return;
  const { y } = todoDrag;
  if (y < DRAG_SCROLL_EDGE) window.scrollBy(0, -DRAG_SCROLL_SPEED);
  else if (y > window.innerHeight - DRAG_SCROLL_EDGE) window.scrollBy(0, DRAG_SCROLL_SPEED);
  layoutTodoDrag();
  requestAnimationFrame(stepTodoDrag);
}

function layoutTodoDrag() {
  const { li, y, grabOffset, height } = todoDrag;
  // Where the row should appear, kept within the list.
  const bounds = li.parentElement.getBoundingClientRect();
  const lastDated = $$('#todo-list .item').filter(isDatedRow).at(-1);
  const ceiling = lastDated ? lastDated.getBoundingClientRect().bottom : bounds.top;
  const top = Math.max(ceiling, Math.min(y - grabOffset, bounds.bottom - height));
  // Swaps go by the pointer, not the kept-within-the-list position, so the very ends stay reachable.
  const center = y - grabOffset + height / 2;
  const middle = (el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  let sibling;
  while ((sibling = li.nextElementSibling) && center > middle(sibling)) li.before(sibling);
  while ((sibling = li.previousElementSibling) && !isDatedRow(sibling) && center < middle(sibling)) li.after(sibling);

  li.style.transform = '';
  li.style.transform = `translateY(${top - li.getBoundingClientRect().top}px)`;
}

function moveTodoDrag(e) {
  if (todoDrag?.pointerId === e.pointerId) todoDrag.y = e.clientY;
}

function endTodoDrag(e) {
  if (todoDrag?.pointerId !== e.pointerId) return;
  const { startIds } = todoDrag;
  todoDrag.y = e.clientY;
  layoutTodoDrag(); // the pointer may have moved since the last frame
  const ids = e.type === 'pointerup' ? todoListIds() : startIds;
  todoDrag = null;
  sortOpenTodos(ids);
  renderTodos();
  if (ids.join() !== startIds.join()) saveTodoOrder(ids);
}

function sortOpenTodos(ids) {
  state.todos.open.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

async function saveTodoOrder(ids) {
  try {
    await api.put('/api/todos/order', { ids });
  } catch (err) {
    fail(err);
    loadTodos().catch(() => {});
  }
}

function moveTodoWithKeyboard(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle || todoDrag || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const li = handle.closest('.item');
  const sibling = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
  if (!sibling || isDatedRow(sibling)) return;
  if (e.key === 'ArrowUp') li.after(sibling);
  else li.before(sibling);
  const ids = todoListIds();
  sortOpenTodos(ids);
  saveTodoOrder(ids);
}

let editingTodo = null;

function openTodo(id) {
  const t = findTodo(id);
  if (!t) return;
  editingTodo = t;
  const form = $('#todo-form');
  form.title.value = t.title;
  form.notes.value = t.notes;
  form.due_at.value = toLocalInput(t.due_at);
  form.remind_at.value = toLocalInput(t.remind_at);
  $('#todo-error').hidden = true;
  $('#todo-dialog').showModal();
}

async function saveTodo(e) {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api.patch(`/api/todos/${editingTodo.id}`, {
      title: form.title.value,
      notes: form.notes.value,
      due_at: fromLocalInput(form.due_at.value),
      remind_at: fromLocalInput(form.remind_at.value),
    });
    $('#todo-dialog').close();
    await loadTodos();
  } catch (err) {
    $('#todo-error').textContent = err.message;
    $('#todo-error').hidden = false;
  }
}

async function deleteTodo() {
  if (!confirm(`Delete "${editingTodo.title}"?`)) return;
  try {
    await api.del(`/api/todos/${editingTodo.id}`);
    $('#todo-dialog').close();
    await loadTodos();
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- routines

async function loadRoutines() {
  try {
    state.routines = await api.get('/api/routines');
    renderRoutines();
  } catch (err) {
    fail(err);
  }
}

function routineTimes(r) {
  const meta = [];
  const ahead = r.remind_days_before;
  if (r.remind_at) meta.push(`<span class="meta">${ICON.bell}${ahead ? `${ahead} day${ahead === 1 ? '' : 's'} ahead, ` : ''}${fmtClock(r.remind_at)}</span>`);
  if (r.due_by) meta.push(`<span class="meta">${ICON.clock}by ${fmtClock(r.due_by)}</span>`);
  return meta;
}

function repeatSummary(r) {
  if (isCycleUnit(r.repeat_unit)) return `<span class="repeat-label">${esc(cycleLabel(r))}</span>`;
  return `<span class="days">${DAY_LETTER.map((l, d) => `<span class="${r.days.includes(d) ? 'on' : ''}">${l}</span>`).join('')}
    <span class="days-label">${esc(daysLabel(r.days))}</span></span>`;
}

function routineItem(r, next) {
  const fullDate = fmtDay(next, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `
    <li class="item routine" data-id="${r.id}">
      <span class="date-tile" title="${esc(fullDate)}">
        <span class="date-tile-month">${esc(fmtDay(next, { month: 'short' }))}</span>
        <span class="date-tile-day">${dateFromYMD(next).getDate()}</span>
      </span>
      <button class="item-body as-button" data-edit>
        <span class="item-title">${esc(r.title)}</span>
        ${repeatSummary(r)}
      </button>
      <div class="item-meta"><span class="meta" title="${esc(fullDate)}">${esc(fmtUntil(next, state.today))}</span>${routineTimes(r).join('')}<span class="chev">${ICON.chevron}</span></div>
    </li>`;
}

function renderRoutines() {
  const upcoming = state.routines
    .map((r) => ({ r, next: nextOccurrence(r, state.today) }))
    .sort((a, b) => a.next.localeCompare(b.next));
  $('#routine-list').innerHTML = upcoming.length
    ? upcoming.map(({ r, next }) => routineItem(r, next)).join('')
    : '<li class="empty"><p>No routines yet. Add things like "Read my Bible" every day, "Clean the house" on Saturdays, or "Review the budget" every 3 months.</p></li>';
}

let editingRoutine = null;
let repeatMode = 'weekly'; // the dialog's "Repeats" choice: 'weekly' or 'custom' (every so many days, weeks...)

function setRepeatMode(mode) {
  repeatMode = mode;
  const form = $('#routine-form');
  for (const b of $$('#repeat-picker button')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('#repeat-weekly').hidden = mode !== 'weekly';
  $('#repeat-custom').hidden = mode !== 'custom';
  $('#repeat-ping-ahead').hidden = mode !== 'custom';
  // A hidden, invalid number mustn't block saving.
  form.repeat_every.disabled = mode !== 'custom';
  form.remind_days_before.disabled = mode !== 'custom';
  renderRepeatPreview();
}

function scheduleFromForm() {
  const form = $('#routine-form');
  const start_date = form.start_date.value;
  if (repeatMode === 'weekly') return { repeat_unit: 'weekdays', days: pickedDays(), start_date };
  return {
    repeat_unit: form.repeat_unit.value,
    repeat_every: Number(form.repeat_every.value),
    remind_days_before: Number(form.remind_days_before.value) || 0,
    start_date,
  };
}

/** Spell out the coming dates so you can see the schedule is what you meant before saving. */
function renderRepeatPreview() {
  const el = $('#repeat-preview');
  const schedule = scheduleFromForm();
  const every = schedule.repeat_every;
  const valid = schedule.start_date && (schedule.days ? schedule.days.length > 0 : Number.isInteger(every) && every >= 1 && every <= 999);
  el.hidden = !valid;
  if (!valid) return;
  const dates = upcomingOccurrences(schedule, state.today, 4);
  let year = state.today.slice(0, 4);
  const parts = dates.map((d) => {
    const showYear = d.slice(0, 4) !== year;
    year = d.slice(0, 4);
    return fmtDay(d, { month: 'short', day: 'numeric', year: showYear ? 'numeric' : undefined });
  });
  el.innerHTML = `Next: <strong>${esc(parts[0])}</strong> · ${parts.slice(1).map(esc).join(' · ')}`;
}

function setPickedDays(days) {
  for (const b of $$('#daypicker button')) {
    const on = days.includes(Number(b.dataset.day));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function pickedDays() {
  return $$('#daypicker button.on').map((b) => Number(b.dataset.day));
}

function openRoutine(id) {
  editingRoutine = id ? state.routines.find((r) => r.id === id) : null;
  const r = editingRoutine;
  const form = $('#routine-form');
  $('#routine-dialog-title').textContent = r ? 'Edit routine' : 'New routine';
  form.title.value = r?.title ?? '';
  form.notes.value = r?.notes ?? '';
  form.remind_at.value = r?.remind_at ?? '';
  form.due_by.value = r?.due_by ?? '';
  setPickedDays(r?.days ?? []);
  form.repeat_every.value = r && isCycleUnit(r.repeat_unit) ? r.repeat_every : 30;
  form.repeat_unit.value = r && isCycleUnit(r.repeat_unit) ? r.repeat_unit : 'day';
  form.remind_days_before.value = r?.remind_days_before || '';
  form.start_date.value = r?.start_date ?? state.today;
  setRepeatMode(r && isCycleUnit(r.repeat_unit) ? 'custom' : 'weekly');
  $('#routine-delete').hidden = !r;
  $('#routine-error').hidden = true;
  $('#routine-dialog').showModal();
  if (!r) form.title.focus();
}

async function saveRoutine(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const body = {
    title: form.title.value,
    notes: form.notes.value,
    ...scheduleFromForm(),
    remind_at: form.remind_at.value || null,
    due_by: form.due_by.value || null,
  };
  try {
    if (editingRoutine) await api.put(`/api/routines/${editingRoutine.id}`, body);
    else await api.post('/api/routines', body);
    $('#routine-dialog').close();
    toast(editingRoutine ? 'Routine updated' : 'Routine added');
    await Promise.all([loadRoutines(), loadDaily()]);
  } catch (err) {
    $('#routine-error').textContent = err.message;
    $('#routine-error').hidden = false;
  }
}

async function deleteRoutine() {
  if (!confirm(`Delete "${editingRoutine.title}"? Its check-off history goes with it.`)) return;
  try {
    await api.del(`/api/routines/${editingRoutine.id}`);
    $('#routine-dialog').close();
    toast('Routine deleted');
    await Promise.all([loadRoutines(), loadDaily()]);
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- settings / Discord

async function loadSettings() {
  try {
    state.settings = await api.get('/api/settings');
    renderSettings();
  } catch (err) {
    fail(err);
  }
}

function renderSettings() {
  const s = state.settings;
  const d = s.discord;
  $('#discord-status').textContent = d.configured
    ? `Connected (${d.hint})${d.fromEnv ? ', set by the DISCORD_WEBHOOK_URL environment variable' : ''}. Paste a new URL to replace it.`
    : 'Not connected yet. Paste a webhook URL from your Discord channel to get reminders.';
  $('#discord-url').value = '';
  $('#discord-url').placeholder = d.configured ? 'Saved. Paste a new URL to replace it' : 'https://discord.com/api/webhooks/…';
  $('#discord-user').value = d.userId;
  $('#discord-remove').hidden = !d.configured || d.fromEnv;
  $('#notify-test').disabled = !d.configured;
  $('#discord-error').hidden = true;

  const select = $('#tz-select');
  if (!select.options.length) {
    const zones = Intl.supportedValuesOf?.('timeZone') ?? [s.timezone];
    select.innerHTML = zones.map((z) => `<option>${esc(z)}</option>`).join('');
  }
  if (![...select.options].some((o) => o.value === s.timezone)) select.add(new Option(s.timezone));
  select.value = s.timezone;
}

async function saveDiscord(e) {
  e.preventDefault();
  const url = $('#discord-url').value.trim();
  const body = { discord_user_id: $('#discord-user').value.trim() };
  if (url) body.discord_webhook_url = url; // blank means "keep the saved one"
  try {
    await api.put('/api/settings', body);
    toast(url ? 'Discord connected' : 'Saved');
    await loadSettings();
  } catch (err) {
    $('#discord-error').textContent = err.message;
    $('#discord-error').hidden = false;
  }
}

async function disconnectDiscord() {
  try {
    await api.put('/api/settings', { discord_webhook_url: '' });
    toast('Discord disconnected. Reminders are paused');
    await loadSettings();
  } catch (err) {
    fail(err);
  }
}

async function testNotify() {
  const btn = $('#notify-test');
  btn.disabled = true;
  try {
    await api.post('/api/notify/test');
    toast('Sent. Check your Discord channel');
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = !state.settings?.discord.configured;
  }
}

async function saveTimezone(e) {
  try {
    await api.put('/api/settings', { timezone: e.target.value });
    toast(`Time zone set to ${e.target.value}`);
    state.viewDate = null;
    await loadDaily();
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- boot

async function start() {
  // First visit: adopt this device's time zone so "6:00 AM" means what you expect.
  const settings = await api.get('/api/settings');
  if (!settings.timezoneSaved) {
    await api.put('/api/settings', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  await Promise.all([loadDaily(), loadTodos()]);
  route();
}

function bindEvents() {
  window.addEventListener('hashchange', route);

  // Daily
  $('#daily-list').addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (li) toggleRoutine(Number(li.dataset.id));
  });
  $('#day-prev').addEventListener('click', () => {
    state.viewDate = addDays(state.viewDate, -1);
    loadDaily().catch(fail);
  });
  $('#day-next').addEventListener('click', () => {
    state.viewDate = addDays(state.viewDate, 1);
    loadDaily().catch(fail);
  });
  $('#day-today').addEventListener('click', () => {
    state.viewDate = state.today;
    loadDaily().catch(fail);
  });

  // To-dos
  $('#todo-add').addEventListener('submit', addTodo);
  $('#todo-add-more').addEventListener('click', () => toggleAddMore());
  for (const list of ['#todo-list', '#todo-done-list']) {
    $(list).addEventListener('click', (e) => {
      const li = e.target.closest('.item');
      if (!li) return;
      if (e.target.closest('.check')) toggleTodo(Number(li.dataset.id));
      else if (e.target.closest('[data-edit]')) openTodo(Number(li.dataset.id));
    });
  }
  $('#todo-list').addEventListener('pointerdown', startTodoDrag);
  $('#todo-list').addEventListener('pointermove', moveTodoDrag);
  $('#todo-list').addEventListener('pointerup', endTodoDrag);
  $('#todo-list').addEventListener('pointercancel', endTodoDrag);
  $('#todo-list').addEventListener('keydown', moveTodoWithKeyboard);
  $('#todo-form').addEventListener('submit', saveTodo);
  $('#todo-delete').addEventListener('click', deleteTodo);
  $('#todo-clear').addEventListener('click', async () => {
    try {
      await api.del('/api/todos/completed');
      await loadTodos();
    } catch (err) {
      fail(err);
    }
  });

  // Routines
  $('#daypicker').innerHTML = DAY_SHORT.map((d, i) => `<button type="button" data-day="${i}" aria-pressed="false" aria-label="${d}">${DAY_LETTER[i]}</button>`).join('');
  $('#daypicker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    renderRepeatPreview();
  });
  $('#routine-new').addEventListener('click', () => openRoutine(null));
  $('#routine-list').addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (li) openRoutine(Number(li.dataset.id));
  });
  $('#repeat-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setRepeatMode(b.dataset.mode);
  });
  $('#routine-form').repeat_every.addEventListener('input', renderRepeatPreview);
  $('#routine-form').repeat_unit.addEventListener('change', renderRepeatPreview);
  $('#routine-form').start_date.addEventListener('input', renderRepeatPreview);
  $('#routine-form').addEventListener('submit', saveRoutine);
  $('#routine-delete').addEventListener('click', deleteRoutine);

  // Settings
  $('#discord-form').addEventListener('submit', saveDiscord);
  $('#discord-remove').addEventListener('click', disconnectDiscord);
  $('#notify-test').addEventListener('click', testNotify);
  $('#tz-select').addEventListener('change', saveTimezone);

  // Dialogs: cancel buttons + click on backdrop closes
  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }

  // Keep things fresh: overdue states, day rollover, edits from another device.
  const refresh = () => {
    if (document.hidden) return;
    const wasToday = state.viewDate === state.today;
    loadDaily()
      .then(() => {
        if (wasToday && state.viewDate !== state.today) {
          state.viewDate = state.today; // rolled past midnight
          return loadDaily();
        }
      })
      .catch(fail);
    loadTodos().catch(fail);
  };
  setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', refresh);
}

async function boot() {
  bindEvents();
  try {
    await start();
  } catch (err) {
    fail(err);
  }
}

boot();
