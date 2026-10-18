// The workspace's open issues, day by day: one bar per day for the last week, so you see the pile
// go down (or not). Read live through hive.hm.onIssues (permission workspace:issues). An issue
// counts as closed from the day it was last changed while done or cancelled, which is when an
// agent or a person closed it unless it was edited after.
const CLOSED = new Set(["done", "cancelled"]);
const DAY = 86_400_000;
let issues = [];

function openOn(list, end) {
  return list.filter((i) => Date.parse(i.created) < end && !(CLOSED.has(i.state) && Date.parse(i.updated) < end)).length;
}

function days(n, now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Array.from({ length: n }, (_, k) => {
    const start = midnight - (n - 1 - k) * DAY;
    return { start, end: k === n - 1 ? Date.now() + 1 : start + DAY, label: new Date(start).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) };
  });
}

function draw() {
  const n = Number(hive.options.days ?? 7);
  const rows = days(n).map((d) => ({ ...d, open: openOn(issues, d.end) }));
  const most = Math.max(1, ...rows.map((r) => r.open));
  const by = (s) => issues.filter((i) => i.state === s).length;
  const first = rows[0].open, last = rows[rows.length - 1].open;
  const closedThisWeek = issues.filter((i) => CLOSED.has(i.state) && Date.parse(i.updated) >= rows[0].start).length;
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "number", value: last, label: "open" },
        { type: "number", value: by("in_progress"), label: "in progress" },
        { type: "number", value: by("in_review"), label: "in review" },
        { type: "number", value: closedThisWeek, label: `closed in ${n} days` },
      ] },
      ...rows.map((r) => ({ type: "meter", value: r.open, max: most, label: `${r.label} · ${r.open}` })),
      { type: "text", muted: true, text: last < first ? `Down ${first - last} since ${rows[0].label}` : last > first ? `Up ${last - first} since ${rows[0].label}` : `Level since ${rows[0].label}` },
    ],
  });
}

hive.on("start", () => {
  draw();
  hive.hm.onIssues((list) => { issues = Array.isArray(list) ? list : []; draw(); });
});
hive.on("options", draw);

hive.hm.onCommand("burndown", () => days(Number(hive.options.days ?? 7)).map((d) => ({ day: new Date(d.start).toISOString().slice(0, 10), open: openOn(issues, d.end) })));
