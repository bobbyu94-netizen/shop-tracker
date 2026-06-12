/* Shop Tracker — time clock + self-repairing scheduler
   Data lives in localStorage on this device. Export backups from the More tab. */
'use strict';

const STORE_KEY = 'shoptracker.v1';

const DEFAULT_STATE = {
  settings: {
    workDays: [2, 3, 4, 5],          // Tue–Fri
    adminDays: [1],                  // Mon = supplies & admin
    dayStart: '09:00',
    dayEnd: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    tz: null,                        // set from the device; calendar feed needs it
  },
  icsKey: null,      // secret in the calendar-feed URL
  jobs: [],          // {id, name, status:'active'|'pending'|'done', tasks:[{id,name,estHours,done}]}
  timeEntries: [],   // {id, taskId, jobId, start(ms), stop(ms|null)}
  blocks: [],        // {date:'YYYY-MM-DD', portion:'full'|'morning'|'afternoon'}
  adminTodos: [],    // {id, text, done}
};

// Aggregated per-cabinet operations from cabinet-system labor standards (baseline widths).
// hours: [base, upper, pantry] per cabinet; per-door/per-drawer ops computed separately.
const CABINET_OPS = [
  { name: 'Plywood Cutting',     per: 'cab',    hours: [0.50, 0.50, 0.50] },
  { name: 'Face Frame Cutting',  per: 'cab',    hours: [0.50, 0.50, 0.50] },
  { name: 'Door Cutting',        per: 'door',   rate: 0.50 },
  { name: 'Door Routing',        per: 'door',   rate: 0.50 },
  { name: 'Drawer Cutting',      per: 'drawer', rate: 0.50 },
  { name: 'Drawer Routing',      per: 'drawer', rate: 0.50 },
  { name: 'Face Frame Assembly', per: 'cab',    hours: [0.50, 0.50, 0.50] },
  { name: 'Pocket Holes',        per: 'cab',    hours: [0.50, 0.50, 0.50] },
  { name: 'Edge Banding',        per: 'cab',    hours: [0.25, 0.20, 0.40] },
  { name: 'Cabinet Assembly',    per: 'cab',    hours: [1.50, 1.00, 2.50] },
  { name: 'Drawer Assembly',     per: 'drawer', rate: 0.50 },
  { name: 'Front Installation',  per: 'cab',    hours: [0.25, 0.25, 0.50] },
  { name: 'Sanding and Prep',    per: 'cab',    hours: [0.50, 0.40, 0.75] },
  { name: 'Spray Finish',        per: 'cab',    hours: [2.00, 2.00, 2.00], finishOnly: true },
];
const DOORS_PER = [2, 2, 2];   // base, upper, pantry
const DRAWERS_PER = [1, 0, 0];

let S = load();
let nav = { tab: 'today', jobId: null, blockMenuDate: null };

/* ---------- cloud sync (Supabase) ----------
   Whole app state lives as one JSONB row per user. Last write wins —
   single-user shop, so the simplest sync that can't corrupt anything. */
const SB_URL = 'https://oahgaqgvqgqsdfmbryli.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9haGdhcWd2cWdxc2RmbWJyeWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyODIyNjgsImV4cCI6MjA5Njg1ODI2OH0.SDqzs2vBXbd_lFys5-NpqbaK10iXEEtdGh0mKO6KR4A';
const sb = window.supabase ? window.supabase.createClient(SB_URL, SB_ANON) : null;
let session = null;
let localOnly = !sb;       // CDN blocked → keep working off localStorage
let cloudStatus = 'local'; // local | pending | ok | offline | setup
let cloudStamp = null;
let pushTimer = null;
let authMsg = '';

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(structuredClone(DEFAULT_STATE), JSON.parse(raw));
  } catch (e) { /* corrupted store falls back to defaults */ }
  return structuredClone(DEFAULT_STATE);
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(S)); queuePush(); }
function uid() { return Math.random().toString(36).slice(2, 10); }

function tableMissing(error) { return error && (error.code === '42P01' || error.code === 'PGRST205'); }

function queuePush() {
  if (!session) return;
  cloudStatus = 'pending'; paintSync();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1200);
}
async function pushNow() {
  if (!session) return;
  clearTimeout(pushTimer);
  const stamp = new Date().toISOString();
  try {
    const { error } = await sb.from('app_state').upsert({ user_id: session.user.id, data: S, updated_at: stamp });
    if (error) cloudStatus = tableMissing(error) ? 'setup' : 'offline';
    else { cloudStatus = 'ok'; cloudStamp = stamp; }
  } catch { cloudStatus = 'offline'; }
  paintSync();
}
async function cloudLoad() {
  try {
    const { data, error } = await sb.from('app_state').select('data,updated_at').eq('user_id', session.user.id).maybeSingle();
    if (error) { cloudStatus = tableMissing(error) ? 'setup' : 'offline'; return; }
    if (data) {
      S = Object.assign(structuredClone(DEFAULT_STATE), data.data);
      cloudStamp = data.updated_at;
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
      cloudStatus = 'ok';
    } else {
      await pushNow(); // first sign-in: this device's data becomes the cloud copy
    }
  } catch { cloudStatus = 'offline'; }
}
async function checkRemote() {
  if (!session || cloudStatus === 'pending' || document.hidden) return;
  try {
    const { data, error } = await sb.from('app_state').select('updated_at').eq('user_id', session.user.id).maybeSingle();
    if (!error && data && cloudStamp && data.updated_at > cloudStamp) { await cloudLoad(); render(); }
    else if (!error && cloudStatus === 'offline') { cloudStatus = 'ok'; paintSync(); }
  } catch { /* still offline */ }
}
async function doAuth(kind) {
  const email = document.getElementById('li-email').value.trim();
  const pass = document.getElementById('li-pass').value;
  if (!email || pass.length < 6) { authMsg = 'Enter your email and a password of at least 6 characters.'; render(); return; }
  authMsg = 'Working…'; render();
  try {
    if (kind === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password: pass });
      if (error) throw error;
      if (!data.session) {
        authMsg = 'Account created. Check your email for the confirmation link, then come back and tap Sign In.';
        render(); return;
      }
      session = data.session;
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      session = data.session;
    }
    authMsg = '';
    cloudStatus = 'pending';
    await cloudLoad();
  } catch (e) { authMsg = e.message || 'Sign-in failed.'; }
  render();
}
const SYNC_INFO = {
  local:   ['dim',   'Local only'],
  pending: ['amber', 'Saving…'],
  ok:      ['green', 'Synced'],
  offline: ['red',   'Offline — saved on phone'],
  setup:   ['blue',  'Cloud setup needed'],
};
function paintSync() {
  const dot = document.getElementById('sync-dot');
  if (dot) { dot.className = SYNC_INFO[cloudStatus][0]; dot.title = SYNC_INFO[cloudStatus][1]; }
}

/* ---------- time helpers ---------- */
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fmtClock(min) {
  min = Math.round(min);
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
}
function fmtH(h) { return (Math.round(h * 100) / 100) + 'h'; }
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 3600)).padStart(2, '0') + ':' +
         String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' +
         String(s % 60).padStart(2, '0');
}
function dateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return dateStr(new Date()); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDaysStr(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(s) {
  const d = parseDate(s), t = todayStr();
  const name = DAY_NAMES[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  if (s === t) return 'Today · ' + name;
  if (s === addDaysStr(t, 1)) return 'Tomorrow · ' + name;
  return name;
}
function prettyDate(s) { const d = parseDate(s); return DAY_NAMES[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate(); }

/* ---------- lookups ---------- */
function jobById(id) { return S.jobs.find(j => j.id === id); }
function taskById(id) { for (const j of S.jobs) { const t = j.tasks.find(t => t.id === id); if (t) return { job: j, task: t }; } return null; }
function blockFor(date) { return S.blocks.find(b => b.date === date); }
function activeEntry() { return S.timeEntries.find(e => e.stop === null); }
function actualHours(taskId) {
  let ms = 0;
  for (const e of S.timeEntries) if (e.taskId === taskId) ms += (e.stop || Date.now()) - e.start;
  return ms / 3600000;
}
function jobActualHours(job) { return job.tasks.reduce((a, t) => a + actualHours(t.id), 0); }
function jobEstHours(job) { return job.tasks.reduce((a, t) => a + t.estHours, 0); }
function remainingHours(t) {
  if (t.done) return 0;
  const rem = t.estHours - actualHours(t.id);
  // Overrun tasks stay on the schedule with a half-hour placeholder until marked done.
  return rem > 0 ? rem : 0.5;
}

/* ---------- scheduler (pure: schedule is always recomputed, so it self-repairs) ---------- */
function workIntervals(date, clipToNow) {
  const st = S.settings;
  const dow = parseDate(date).getDay();
  if (!st.workDays.includes(dow)) return [];
  let ivs = [];
  const ds = toMin(st.dayStart), de = toMin(st.dayEnd), ls = toMin(st.lunchStart), le = toMin(st.lunchEnd);
  if (ls > ds && le < de && le > ls) ivs = [[ds, ls], [le, de]];
  else ivs = [[ds, de]];
  const b = blockFor(date);
  if (b) {
    if (b.portion === 'full') return [];
    if (b.portion === 'morning') ivs = ivs.filter(iv => iv[0] >= toMin(st.lunchStart));
    if (b.portion === 'afternoon') ivs = ivs.filter(iv => iv[1] <= toMin(st.lunchStart));
  }
  if (clipToNow) {
    const n = nowMin();
    ivs = ivs.map(iv => [Math.max(iv[0], n), iv[1]]).filter(iv => iv[1] - iv[0] >= 10);
  }
  return ivs;
}

function buildSchedule() {
  const byDate = {};
  const finishDates = {};
  const queue = [];
  for (const job of S.jobs.filter(j => j.status === 'active')) {
    for (const t of job.tasks) {
      const rem = remainingHours(t);
      if (rem > 0) queue.push({ jobId: job.id, taskId: t.id, remMin: rem * 60 });
    }
  }
  const start = todayStr();
  let qi = 0;
  for (let di = 0; di < 120 && qi < queue.length; di++) {
    const date = addDaysStr(start, di);
    const ivs = workIntervals(date, di === 0);
    const segs = [];
    for (const iv of ivs) {
      let cur = iv[0];
      while (cur < iv[1] - 0.5 && qi < queue.length) {
        const item = queue[qi];
        const take = Math.min(item.remMin, iv[1] - cur);
        segs.push({ jobId: item.jobId, taskId: item.taskId, start: cur, end: cur + take });
        item.remMin -= take;
        cur += take;
        if (item.remMin <= 0.5) { finishDates[item.jobId] = date; qi++; }
      }
    }
    if (segs.length) byDate[date] = segs;
  }
  return { byDate, finishDates, leftover: queue.slice(qi) };
}

/* ---------- time clock ---------- */
function punchIn(taskId) {
  punchOut();
  const found = taskById(taskId);
  if (!found) return;
  S.timeEntries.push({ id: uid(), taskId, jobId: found.job.id, start: Date.now(), stop: null });
  save();
}
function punchOut() {
  const e = activeEntry();
  if (e) { e.stop = Date.now(); save(); }
}

/* ---------- job templates ---------- */
function addCabinetTemplate(job, base, upper, pantry, finish) {
  const counts = [base, upper, pantry];
  const doors = base * DOORS_PER[0] + upper * DOORS_PER[1] + pantry * DOORS_PER[2];
  const drawers = base * DRAWERS_PER[0] + upper * DRAWERS_PER[1] + pantry * DRAWERS_PER[2];
  const cabs = base + upper + pantry;
  for (const op of CABINET_OPS) {
    if (op.finishOnly && !finish) continue;
    let hrs = 0;
    if (op.per === 'cab') hrs = op.hours[0] * counts[0] + op.hours[1] * counts[1] + op.hours[2] * counts[2];
    if (op.per === 'door') hrs = op.rate * doors;
    if (op.per === 'drawer') hrs = op.rate * drawers;
    hrs = Math.round(hrs * 100) / 100;
    if (hrs > 0) {
      const label = op.per === 'door' ? `${op.name} (${doors} doors)` :
                    op.per === 'drawer' ? `${op.name} (${drawers} drawers)` :
                    `${op.name} (${cabs} cabinets)`;
      job.tasks.push({ id: uid(), name: label, estHours: hrs, done: false });
    }
  }
}

/* ---------- rendering ---------- */
const $view = document.getElementById('view');
const $sub = document.getElementById('topbar-sub');

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function render() {
  const tabbar = document.getElementById('tabbar');
  if (!session && !localOnly) {
    tabbar.style.display = 'none';
    $sub.textContent = '';
    $view.innerHTML = renderLogin();
    return;
  }
  tabbar.style.display = '';
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === nav.tab));
  const sched = buildSchedule();
  let html = '';
  if (cloudStatus === 'setup') html += `<div class="banner">Cloud table isn't set up yet — your data is safe on this phone. Finish the one-time SQL step in Supabase.</div>`;
  if (nav.tab === 'today') html += renderToday(sched);
  else if (nav.tab === 'week') html += renderWeek(sched);
  else if (nav.tab === 'jobs') html += nav.jobId ? renderJobDetail(sched) : renderJobs(sched);
  else html += renderMore();
  $view.innerHTML = html;
  const todaySegs = sched.byDate[todayStr()] || [];
  const planned = todaySegs.reduce((a, s) => a + (s.end - s.start), 0) / 60;
  $sub.innerHTML = `<span id="sync-dot">&#9679;</span> ` + prettyDate(todayStr()) + (planned ? ' · ' + fmtH(planned) + ' planned' : '');
  paintSync();
}

function renderLogin() {
  return `<div class="card login-card">
    <div class="big" style="margin-bottom:4px">Shop Tracker</div>
    <div class="muted small" style="margin-bottom:14px">Sign in so your jobs and hours sync to the cloud.</div>
    <input type="email" id="li-email" placeholder="Email" autocomplete="username" inputmode="email">
    <input type="password" id="li-pass" placeholder="Password" autocomplete="current-password">
    ${authMsg ? `<div class="small amber" style="margin-top:10px">${esc(authMsg)}</div>` : ''}
    <button class="btn primary wide" data-act="login">Sign In</button>
    <button class="btn wide" data-act="signup">Create Account</button>
    <button class="btn wide ghost" data-act="skip-local">Skip — work on this phone only</button>
  </div>`;
}

function timerCard() {
  const e = activeEntry();
  if (!e) return '';
  const found = taskById(e.taskId);
  const name = found ? found.task.name : 'Unknown task';
  const jobName = found ? found.job.name : '';
  return `<div class="card timer-card">
    <div class="muted small">${esc(jobName)}</div>
    <div class="row"><div class="grow"><b>${esc(name)}</b></div></div>
    <div class="row mt">
      <div class="grow timer-elapsed green" id="elapsed">${fmtElapsed(Date.now() - e.start)}</div>
      <button class="btn stop" data-act="punch-out">Punch Out</button>
    </div>
  </div>`;
}

function renderToday(sched) {
  const t = todayStr();
  const dow = new Date().getDay();
  const st = S.settings;
  let html = timerCard();

  if (st.adminDays.includes(dow)) {
    html += `<h2>Supplies &amp; Admin Day</h2>`;
    html += `<div class="card">` + adminListHtml() + `</div>`;
  }

  const segs = sched.byDate[t] || [];
  html += `<h2>Today's Plan</h2>`;
  if (!segs.length) {
    const isWorkDay = st.workDays.includes(dow);
    const b = blockFor(t);
    let msg = 'Nothing scheduled today.';
    if (b && b.portion === 'full') msg = 'Today is blocked off. The schedule has rolled forward.';
    else if (!isWorkDay && !st.adminDays.includes(dow)) msg = 'Day off. Enjoy it — the schedule starts fresh next workday.';
    else if (!isWorkDay) msg = '';
    if (msg) html += `<div class="card flat">${msg}</div>`;
  } else {
    html += `<div class="card">`;
    const active = activeEntry();
    for (const s of segs) {
      const found = taskById(s.taskId);
      if (!found) continue;
      const { job, task } = found;
      const running = active && active.taskId === task.id;
      const act = actualHours(task.id);
      html += `<div class="seg">
        <input type="checkbox" data-act="toggle-done" data-task="${task.id}" ${task.done ? 'checked' : ''}>
        <div class="seg-time"><b>${fmtClock(s.start)}–${fmtClock(s.end)}</b><br>${fmtH((s.end - s.start) / 60)}</div>
        <div class="grow">
          <div${task.done ? ' class="strike"' : ''}>${esc(task.name)}</div>
          <div class="muted small">${esc(job.name)} · est ${fmtH(task.estHours)}${act > 0.005 ? ' · actual ' + fmtH(act) : ''}</div>
        </div>
        ${running ? '<span class="pill active">On clock</span>' :
          (task.done ? '' : `<button class="btn go tiny" data-act="punch-in" data-task="${task.id}">Punch In</button>`)}
      </div>`;
    }
    html += `</div>`;
  }

  const b = blockFor(t);
  html += `<div class="blockbtns">
    ${b ? `<button class="btn tiny" data-act="unblock" data-date="${t}">Unblock today (${b.portion})</button>`
        : `<button class="btn tiny ghost" data-act="block" data-date="${t}" data-portion="afternoon">Block this afternoon</button>
           <button class="btn tiny ghost" data-act="block" data-date="${t}" data-portion="full">Block rest of today</button>`}
  </div>`;
  return html;
}

function adminListHtml() {
  let html = '';
  if (!S.adminTodos.length) html += `<div class="muted small">No admin items yet. Add supply runs, invoicing, callbacks…</div>`;
  for (const td of S.adminTodos) {
    html += `<div class="seg">
      <input type="checkbox" data-act="toggle-todo" data-id="${td.id}" ${td.done ? 'checked' : ''}>
      <div class="grow${td.done ? ' strike' : ''}">${esc(td.text)}</div>
      <button class="icon-btn" data-act="del-todo" data-id="${td.id}">&#10005;</button>
    </div>`;
  }
  html += `<button class="btn tiny wide" data-act="add-todo">+ Add item</button>`;
  return html;
}

function renderWeek(sched) {
  const st = S.settings;
  let html = '';
  const t = todayStr();
  for (let i = 0; i < 14; i++) {
    const date = addDaysStr(t, i);
    const dow = parseDate(date).getDay();
    const isWork = st.workDays.includes(dow);
    const isAdmin = st.adminDays.includes(dow);
    if (!isWork && !isAdmin) continue;
    const b = blockFor(date);
    const segs = sched.byDate[date] || [];
    const total = segs.reduce((a, s) => a + (s.end - s.start), 0) / 60;
    const open = nav.blockMenuDate === date;
    html += `<div class="card">
      <div class="day-head" data-act="day-menu" data-date="${date}">
        <span class="day-name">${dayLabel(date)}</span>
        ${isAdmin ? '<span class="pill admin">Admin</span>' : ''}
        ${b ? `<span class="pill blocked">${b.portion === 'full' ? 'Blocked' : b.portion + ' blocked'}</span>` : ''}
        <span class="grow"></span>
        <span class="day-total">${total ? fmtH(total) : ''}</span>
      </div>`;
    if (isAdmin && !segs.length) html += `<div class="muted small">Supplies &amp; admin — see Today tab on Mondays.</div>`;
    for (const s of segs) {
      const found = taskById(s.taskId);
      if (!found) continue;
      html += `<div class="seg">
        <div class="seg-time"><b>${fmtClock(s.start)}–${fmtClock(s.end)}</b></div>
        <div class="grow"><div>${esc(found.task.name)}</div>
        <div class="muted small">${esc(found.job.name)}</div></div>
        <div class="muted small">${fmtH((s.end - s.start) / 60)}</div>
      </div>`;
    }
    if (open) {
      html += `<div class="blockbtns">
        ${b ? `<button class="btn tiny" data-act="unblock" data-date="${date}">Unblock</button>` : `
        <button class="btn tiny" data-act="block" data-date="${date}" data-portion="full">Block day</button>
        <button class="btn tiny" data-act="block" data-date="${date}" data-portion="morning">Block AM</button>
        <button class="btn tiny" data-act="block" data-date="${date}" data-portion="afternoon">Block PM</button>`}
      </div>`;
    }
    html += `</div>`;
  }
  if (sched.leftover.length) {
    const hrs = sched.leftover.reduce((a, q) => a + q.remMin, 0) / 60;
    html += `<div class="card flat">+ ${fmtH(hrs)} more work beyond this view</div>`;
  }
  if (!html) html = `<div class="card flat">No active jobs. Add one in the Jobs tab.</div>`;
  html = `<div class="muted small" style="margin:0 2px 10px">Tap a day to block it off — everything after reflows automatically.</div>` + html;
  return html;
}

function renderJobs(sched) {
  let html = `<button class="btn primary wide" data-act="add-job" style="margin:0 0 12px">+ New Job</button>`;
  if (!S.jobs.length) html += `<div class="card flat">No jobs yet. Tap “New Job” — you can load your standard cabinet steps automatically.</div>`;
  const order = { active: 0, pending: 1, done: 2 };
  const jobs = [...S.jobs].sort((a, b) => order[a.status] - order[b.status]);
  for (const j of jobs) {
    const est = jobEstHours(j), act = jobActualHours(j);
    const doneCt = j.tasks.filter(t => t.done).length;
    const fin = sched.finishDates[j.id];
    const pct = est ? Math.min(100, Math.round(act / est * 100)) : 0;
    html += `<div class="card" data-act="open-job" data-job="${j.id}">
      <div class="row">
        <div class="grow"><b>${esc(j.name)}</b></div>
        <span class="pill ${j.status}">${j.status}</span>
      </div>
      <div class="muted small mt">${doneCt}/${j.tasks.length} tasks · est ${fmtH(est)} · actual ${fmtH(act)}
        ${j.status === 'active' && fin ? ` · <span class="blue">finish ~${prettyDate(fin)}</span>` : ''}</div>
      <div class="bar"><div class="${act > est ? 'over' : ''}" style="width:${pct}%"></div></div>
    </div>`;
  }
  return html;
}

function renderJobDetail(sched) {
  const j = jobById(nav.jobId);
  if (!j) { nav.jobId = null; return renderJobs(sched); }
  const est = jobEstHours(j), act = jobActualHours(j);
  const fin = sched.finishDates[j.id];
  const active = activeEntry();
  let html = `<button class="btn tiny ghost" data-act="back-jobs">&#8592; All jobs</button>
  <div class="card mt">
    <div class="row"><div class="grow big">${esc(j.name)}</div><span class="pill ${j.status}">${j.status}</span></div>
    <div class="muted small mt">est ${fmtH(est)} · actual ${fmtH(act)}${j.status === 'active' && fin ? ` · projected finish <span class="blue">${prettyDate(fin)}</span>` : ''}</div>
    <div class="blockbtns">
      ${j.status === 'pending' ? `<button class="btn tiny go" data-act="job-status" data-job="${j.id}" data-status="active">Deposit received &mdash; start job</button>` : ''}
      ${j.status === 'active' ? `<button class="btn tiny" data-act="job-status" data-job="${j.id}" data-status="done">Mark complete</button>
        <button class="btn tiny ghost" data-act="job-status" data-job="${j.id}" data-status="pending">Back to pending</button>` : ''}
      ${j.status === 'done' ? `<button class="btn tiny" data-act="job-status" data-job="${j.id}" data-status="active">Reopen</button>` : ''}
      <button class="btn tiny ghost red" data-act="del-job" data-job="${j.id}">Delete</button>
    </div>
  </div>
  <h2>Tasks</h2><div class="card">`;
  if (!j.tasks.length) html += `<div class="muted small">No tasks yet.</div>`;
  j.tasks.forEach((t, i) => {
    const a = actualHours(t.id);
    const running = active && active.taskId === t.id;
    html += `<div class="seg">
      <input type="checkbox" data-act="toggle-done" data-task="${t.id}" ${t.done ? 'checked' : ''}>
      <div class="grow">
        <div${t.done ? ' class="strike"' : ''}>${esc(t.name)}</div>
        <div class="muted small" data-act="edit-est" data-task="${t.id}">est ${fmtH(t.estHours)} &#9998;${a > 0.005 ? ` · actual <span class="${a > t.estHours ? 'red' : 'green'}">${fmtH(a)}</span>` : ''}</div>
      </div>
      <div class="task-actions">
        ${running ? '<span class="pill active">On</span>' : (t.done ? '' : `<button class="icon-btn green" data-act="punch-in" data-task="${t.id}" title="Punch in">&#9654;</button>`)}
        <button class="icon-btn" data-act="task-up" data-task="${t.id}" ${i === 0 ? 'disabled' : ''}>&#8593;</button>
        <button class="icon-btn" data-act="task-down" data-task="${t.id}" ${i === j.tasks.length - 1 ? 'disabled' : ''}>&#8595;</button>
        <button class="icon-btn" data-act="del-task" data-task="${t.id}">&#10005;</button>
      </div>
    </div>`;
  });
  html += `<button class="btn tiny wide" data-act="add-task" data-job="${j.id}">+ Add task</button></div>`;
  html += `<h2>Cabinet Template</h2>
  <div class="card">
    <div class="muted small">Loads your standard steps with shop labor hours, batched per operation.</div>
    <div class="tpl-grid">
      <div>Base cabinets <span class="muted small">(2 doors, 1 drawer)</span></div><input type="number" id="tpl-base" min="0" value="0">
      <div>Upper cabinets <span class="muted small">(2 doors)</span></div><input type="number" id="tpl-upper" min="0" value="0">
      <div>Pantry cabinets <span class="muted small">(2 doors)</span></div><input type="number" id="tpl-pantry" min="0" value="0">
      <div>Include spray finish (2h/cabinet)</div><input type="checkbox" id="tpl-finish" style="justify-self:center">
    </div>
    <button class="btn primary wide" data-act="apply-template" data-job="${j.id}">Add steps to job</button>
  </div>`;
  return html;
}

function renderMore() {
  const st = S.settings;
  const dayChips = (key) => [0, 1, 2, 3, 4, 5, 6].map(d =>
    `<span class="daychip ${st[key].includes(d) ? 'on' : ''}" data-act="chip" data-key="${key}" data-day="${d}">${DAY_NAMES[d]}</span>`).join('');
  const acct = session
    ? `<div class="row"><div class="grow"><div>${esc(session.user.email)}</div>
       <div class="muted small">${SYNC_INFO[cloudStatus][1]}</div></div>
       <button class="btn tiny" data-act="signout">Sign out</button></div>`
    : `<div class="row"><div class="grow muted small">Working on this phone only — nothing is backed up to the cloud.</div>
       <button class="btn tiny primary" data-act="signin-again">Sign in</button></div>`;
  const icsUrl = SB_URL + '/functions/v1/calendar?key=' + (S.icsKey || '');
  const cal = session
    ? `<div class="muted small">Your scheduled tasks in Apple or Google Calendar, refreshed automatically. The link is private — anyone with it can see your schedule.</div>
       <div class="blockbtns">
         <a class="btn tiny primary" href="${icsUrl.replace('https://', 'webcal://')}">Subscribe (iPhone)</a>
         <button class="btn tiny" data-act="copy-ics">Copy link</button>
       </div>`
    : `<div class="muted small">Sign in to use the calendar feed.</div>`;
  return `<h2>Account</h2>
  <div class="card">${acct}</div>
  <h2>Calendar Feed</h2>
  <div class="card">${cal}</div>
  <h2>Work Schedule</h2>
  <div class="card">
    <label class="setting">Shop days<span class="daychips">${dayChips('workDays')}</span></label>
    <label class="setting">Admin days<span class="daychips">${dayChips('adminDays')}</span></label>
    <label class="setting">Day start <input type="time" data-set="dayStart" value="${st.dayStart}"></label>
    <label class="setting">Day end <input type="time" data-set="dayEnd" value="${st.dayEnd}"></label>
    <label class="setting">Lunch start <input type="time" data-set="lunchStart" value="${st.lunchStart}"></label>
    <label class="setting">Lunch end <input type="time" data-set="lunchEnd" value="${st.lunchEnd}"></label>
  </div>
  <h2>Data</h2>
  <div class="card">
    <div class="muted small">Data lives on this phone. Export a backup now and then.</div>
    <div class="blockbtns">
      <button class="btn tiny" data-act="export">Export backup</button>
      <button class="btn tiny ghost" data-act="import">Import backup</button>
      <input type="file" id="import-file" accept=".json" style="display:none">
    </div>
  </div>
  <div class="muted small" style="text-align:center;margin-top:18px">Shop Tracker v1 · session 1</div>`;
}

/* ---------- actions ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  // Inner controls inside a clickable card shouldn't trigger the card.
  if (el !== e.target.closest('[data-act]')) return;

  if (act === 'tab') { nav.tab = el.dataset.tab; nav.jobId = null; nav.blockMenuDate = null; }

  else if (act === 'login' || act === 'signup') { doAuth(act); return; }
  else if (act === 'skip-local') { localOnly = true; cloudStatus = 'local'; }
  else if (act === 'signin-again') { localOnly = false; authMsg = ''; }
  else if (act === 'signout') {
    if (!confirm('Sign out? The app will keep working from this phone’s local copy.')) return;
    if (sb) sb.auth.signOut();
    session = null; localOnly = true; cloudStatus = 'local'; cloudStamp = null;
  }

  else if (act === 'punch-in') { punchIn(el.dataset.task); }
  else if (act === 'punch-out') { punchOut(); }

  else if (act === 'toggle-done') {
    const found = taskById(el.dataset.task);
    if (found) {
      found.task.done = el.checked;
      const a = activeEntry();
      if (found.task.done && a && a.taskId === found.task.id) punchOut();
      save();
    }
  }

  else if (act === 'block') {
    S.blocks = S.blocks.filter(b => b.date !== el.dataset.date);
    S.blocks.push({ date: el.dataset.date, portion: el.dataset.portion });
    nav.blockMenuDate = null; save();
  }
  else if (act === 'unblock') { S.blocks = S.blocks.filter(b => b.date !== el.dataset.date); nav.blockMenuDate = null; save(); }
  else if (act === 'day-menu') { nav.blockMenuDate = nav.blockMenuDate === el.dataset.date ? null : el.dataset.date; }

  else if (act === 'add-job') {
    const name = prompt('Job name (customer / project):');
    if (!name) return;
    const j = { id: uid(), name: name.trim(), status: 'active', tasks: [] };
    S.jobs.push(j); nav.jobId = j.id; save();
  }
  else if (act === 'open-job') { nav.jobId = el.dataset.job; }
  else if (act === 'back-jobs') { nav.jobId = null; }
  else if (act === 'job-status') { const j = jobById(el.dataset.job); if (j) { j.status = el.dataset.status; save(); } }
  else if (act === 'del-job') {
    const j = jobById(el.dataset.job);
    if (j && confirm(`Delete "${j.name}" and its time records?`)) {
      const ids = new Set(j.tasks.map(t => t.id));
      S.timeEntries = S.timeEntries.filter(en => !ids.has(en.taskId));
      S.jobs = S.jobs.filter(x => x.id !== j.id);
      nav.jobId = null; save();
    }
  }

  else if (act === 'add-task') {
    const j = jobById(el.dataset.job); if (!j) return;
    const name = prompt('Task name:'); if (!name) return;
    const hrs = parseFloat(prompt('Estimated hours:', '1')) || 1;
    j.tasks.push({ id: uid(), name: name.trim(), estHours: hrs, done: false }); save();
  }
  else if (act === 'edit-est') {
    const found = taskById(el.dataset.task); if (!found) return;
    const v = parseFloat(prompt('Estimated hours for "' + found.task.name + '":', found.task.estHours));
    if (v > 0) { found.task.estHours = v; save(); }
  }
  else if (act === 'del-task') {
    const found = taskById(el.dataset.task); if (!found) return;
    if (confirm('Delete task "' + found.task.name + '"?')) {
      S.timeEntries = S.timeEntries.filter(en => en.taskId !== found.task.id);
      found.job.tasks = found.job.tasks.filter(t => t.id !== found.task.id); save();
    }
  }
  else if (act === 'task-up' || act === 'task-down') {
    const found = taskById(el.dataset.task); if (!found) return;
    const arr = found.job.tasks, i = arr.indexOf(found.task);
    const ni = act === 'task-up' ? i - 1 : i + 1;
    if (ni >= 0 && ni < arr.length) { [arr[i], arr[ni]] = [arr[ni], arr[i]]; save(); }
  }

  else if (act === 'apply-template') {
    const j = jobById(el.dataset.job); if (!j) return;
    const base = parseInt(document.getElementById('tpl-base').value) || 0;
    const upper = parseInt(document.getElementById('tpl-upper').value) || 0;
    const pantry = parseInt(document.getElementById('tpl-pantry').value) || 0;
    const finish = document.getElementById('tpl-finish').checked;
    if (base + upper + pantry === 0) { alert('Enter at least one cabinet.'); return; }
    addCabinetTemplate(j, base, upper, pantry, finish); save();
  }

  else if (act === 'add-todo') {
    const text = prompt('Admin / supply item:'); if (!text) return;
    S.adminTodos.push({ id: uid(), text: text.trim(), done: false }); save();
  }
  else if (act === 'toggle-todo') { const td = S.adminTodos.find(x => x.id === el.dataset.id); if (td) { td.done = el.checked; save(); } }
  else if (act === 'del-todo') { S.adminTodos = S.adminTodos.filter(x => x.id !== el.dataset.id); save(); }

  else if (act === 'chip') {
    const key = el.dataset.key, d = Number(el.dataset.day);
    const arr = S.settings[key];
    S.settings[key] = arr.includes(d) ? arr.filter(x => x !== d) : [...arr, d].sort();
    save();
  }

  else if (act === 'copy-ics') {
    navigator.clipboard.writeText(SB_URL + '/functions/v1/calendar?key=' + S.icsKey)
      .then(() => { el.textContent = 'Copied ✓'; })
      .catch(() => { prompt('Copy this link:', SB_URL + '/functions/v1/calendar?key=' + S.icsKey); });
    return;
  }
  else if (act === 'export') {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shop-tracker-backup-' + todayStr() + '.json';
    a.click();
    return; // no re-render needed
  }
  else if (act === 'import') { document.getElementById('import-file').click(); return; }

  else return;
  render();
});

document.addEventListener('change', (e) => {
  const set = e.target.dataset && e.target.dataset.set;
  if (set) { S.settings[set] = e.target.value; save(); render(); }
  if (e.target.id === 'import-file' && e.target.files[0]) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!data.jobs || !data.settings) throw new Error('bad file');
        if (confirm('Replace everything on this device with the backup?')) {
          S = Object.assign(structuredClone(DEFAULT_STATE), data); save(); render();
        }
      } catch { alert('That file is not a Shop Tracker backup.'); }
    };
    fr.readAsText(e.target.files[0]);
  }
});

// Live timer readout + roll the schedule across midnight/hour boundaries.
setInterval(() => {
  const e = activeEntry();
  const el = document.getElementById('elapsed');
  if (e && el) el.textContent = fmtElapsed(Date.now() - e.start);
}, 1000);
let lastMin = nowMin();
setInterval(() => { if (nowMin() !== lastMin) { lastMin = nowMin(); if ((session || localOnly) && (nav.tab === 'today' || nav.tab === 'week')) render(); } }, 15000);

// Pull newer cloud data when the app wakes up or periodically while open.
setInterval(checkRemote, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });

(async function boot() {
  if (sb) {
    try {
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((event, s) => {
        if (event === 'SIGNED_OUT') session = null;
        else if (s) session = s;
      });
      if (session) {
        cloudStatus = 'pending';
        render();          // show local data instantly…
        await cloudLoad(); // …then swap in the cloud copy if it's newer
      }
    } catch { /* auth unreachable — login screen still renders */ }
  }
  // Backfill device-derived fields (after cloudLoad so the cloud copy gets them too).
  let dirty = false;
  if (!S.settings.tz) { S.settings.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; dirty = true; }
  if (!S.icsKey) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    S.icsKey = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    dirty = true;
  }
  if (dirty) save();
  render();
})();
