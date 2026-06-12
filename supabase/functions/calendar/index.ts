// Calendar feed: serves the computed shop schedule as an ICS subscription.
// URL: /functions/v1/calendar?key=<icsKey>  (deployed with --no-verify-jwt;
// the per-user secret key in the URL is the auth, since calendar apps can't send headers).
// Scheduler logic mirrors app.js — if one changes, change the other.
import { createClient } from "npm:@supabase/supabase-js@2";

type Task = { id: string; name: string; estHours: number; done: boolean };
type Job = { id: string; name: string; status: string; tasks: Task[] };
type Entry = { taskId: string; start: number; stop: number | null };
type Block = { date: string; portion: "full" | "morning" | "afternoon" };
type State = {
  settings: {
    workDays: number[]; adminDays: number[]; tz: string | null;
    dayStart: string; dayEnd: string; lunchStart: string; lunchEnd: string;
  };
  jobs: Job[]; timeEntries: Entry[]; blocks: Block[];
  adminTodos: { text: string; done: boolean }[];
};

function toMin(hhmm: string) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

function localNow(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    min: parseInt(get("hour")) * 60 + parseInt(get("minute")),
  };
}
// Pure calendar math on YYYY-MM-DD strings (UTC internals, no tz drift).
function addDaysStr(s: string, n: number) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return dt.toISOString().slice(0, 10);
}
function dow(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function actualHours(state: State, taskId: string) {
  let ms = 0;
  for (const e of state.timeEntries) if (e.taskId === taskId) ms += (e.stop ?? Date.now()) - e.start;
  return ms / 3600000;
}
function remainingHours(state: State, t: Task) {
  if (t.done) return 0;
  const rem = t.estHours - actualHours(state, t.id);
  return rem > 0 ? rem : 0.5;
}
function workIntervals(state: State, date: string, clipMin: number | null) {
  const st = state.settings;
  if (!st.workDays.includes(dow(date))) return [] as number[][];
  const ds = toMin(st.dayStart), de = toMin(st.dayEnd), ls = toMin(st.lunchStart), le = toMin(st.lunchEnd);
  let ivs = ls > ds && le < de && le > ls ? [[ds, ls], [le, de]] : [[ds, de]];
  const b = state.blocks.find((x) => x.date === date);
  if (b) {
    if (b.portion === "full") return [];
    if (b.portion === "morning") ivs = ivs.filter((iv) => iv[0] >= ls);
    if (b.portion === "afternoon") ivs = ivs.filter((iv) => iv[1] <= ls);
  }
  if (clipMin !== null) {
    ivs = ivs.map((iv) => [Math.max(iv[0], clipMin), iv[1]]).filter((iv) => iv[1] - iv[0] >= 10);
  }
  return ivs;
}

type Seg = { jobId: string; taskId: string; date: string; start: number; end: number };
function buildSchedule(state: State, today: string, nowMin: number) {
  const segs: Seg[] = [];
  const queue: { jobId: string; taskId: string; remMin: number }[] = [];
  for (const job of state.jobs.filter((j) => j.status === "active")) {
    for (const t of job.tasks) {
      const rem = remainingHours(state, t);
      if (rem > 0) queue.push({ jobId: job.id, taskId: t.id, remMin: rem * 60 });
    }
  }
  let qi = 0;
  for (let di = 0; di < 120 && qi < queue.length; di++) {
    const date = addDaysStr(today, di);
    for (const iv of workIntervals(state, date, di === 0 ? nowMin : null)) {
      let cur = iv[0];
      while (cur < iv[1] - 0.5 && qi < queue.length) {
        const item = queue[qi];
        const take = Math.min(item.remMin, iv[1] - cur);
        segs.push({ jobId: item.jobId, taskId: item.taskId, date, start: cur, end: cur + take });
        item.remMin -= take;
        cur += take;
        if (item.remMin <= 0.5) qi++;
      }
    }
  }
  return segs;
}

function icsEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
// Floating local time — calendar apps show it in the device's timezone, which is shop time.
function icsDT(date: string, min: number) {
  min = Math.round(min);
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return date.replaceAll("-", "") + "T" + h + m + "00";
}

Deno.serve(async (req) => {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (key.length < 20) return new Response("missing key", { status: 401 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: rows, error } = await admin.from("app_state").select("data").eq("data->>icsKey", key).limit(1);
  if (error) return new Response("db error", { status: 500 });
  if (!rows || !rows.length) return new Response("unknown key", { status: 401 });

  const state = rows[0].data as State;
  const tz = state.settings.tz || "America/New_York";
  const now = localNow(tz);
  const segs = buildSchedule(state, now.date, now.min);

  const jobName = new Map(state.jobs.map((j) => [j.id, j.name]));
  const taskName = new Map(state.jobs.flatMap((j) => j.tasks.map((t) => [t.id, t.name] as [string, string])));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShopTracker//EN",
    "CALSCALE:GREGORIAN", "X-WR-CALNAME:Shop Schedule",
  ];
  for (const s of segs) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.taskId}-${s.date}-${Math.round(s.start)}@shop-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDT(s.date, s.start)}`,
      `DTEND:${icsDT(s.date, s.end)}`,
      `SUMMARY:${icsEscape(taskName.get(s.taskId) ?? "Shop task")}`,
      `DESCRIPTION:${icsEscape(jobName.get(s.jobId) ?? "")}`,
      "END:VEVENT",
    );
  }
  // All-day Supplies & Admin events for the next four admin days.
  const todos = state.adminTodos.filter((t) => !t.done).map((t) => t.text);
  for (let di = 0, found = 0; di < 28 && found < 4; di++) {
    const date = addDaysStr(now.date, di);
    if (!state.settings.adminDays.includes(dow(date))) continue;
    found++;
    lines.push(
      "BEGIN:VEVENT",
      `UID:admin-${date}@shop-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date.replaceAll("-", "")}`,
      "SUMMARY:Supplies & Admin",
      `DESCRIPTION:${icsEscape(todos.join("\n") || "Material pickup, invoicing, paperwork")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
});
