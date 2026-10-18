// What the agents spent today, in dollars and tokens, against a daily budget. Agents (or a hook
// that runs when a turn ends) report what a turn cost with the add command; the day starts again
// at midnight. A widget cannot read an agent's usage itself, so it counts only what is reported.
const day = () => new Date().toDateString();
const st = () => {
  const s = hive.state || {};
  return s.day === day() ? { day: s.day, by: s.by || {} } : { day: day(), by: {} };
};
const money = (v) => `$${v.toFixed(2)}`;
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function totals(by) {
  let usd = 0, tok = 0;
  for (const v of Object.values(by)) { usd += v.usd; tok += v.tokens; }
  return { usd, tokens: tok };
}

function draw() {
  const { by } = st();
  const t = totals(by);
  const budget = Number(hive.options.budget ?? 20);
  const share = budget > 0 ? t.usd / budget : 0;
  const top = Object.entries(by).sort((a, b) => b[1].usd - a[1].usd).slice(0, 3);
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "number", value: money(t.usd), label: share >= 1 ? `over today's ${money(budget)}` : `spent today of ${money(budget)}` },
        { type: "number", value: tokens(t.tokens), label: "tokens" },
      ] },
      { type: "meter", value: Math.min(t.usd, budget), max: Math.max(budget, 0.01) },
      ...(top.length
        ? top.map(([who, v]) => ({ type: "text", text: `${who}  ${money(v.usd)} · ${tokens(v.tokens)} tokens`, muted: true }))
        : [{ type: "text", text: "Nothing reported today.", muted: true }]),
    ],
  });
}

function add(a) {
  const usd = Number(a && a.usd) || 0;
  const tok = Math.floor(Number(a && a.tokens) || 0);
  if (usd < 0 || tok < 0 || (!usd && !tok)) throw new Error("add needs usd or tokens, as positive numbers");
  const who = a && typeof a.agent === "string" && a.agent.trim() ? a.agent.trim().slice(0, 40) : "an agent";
  const s = st();
  const was = totals(s.by).usd;
  const v = s.by[who] || { usd: 0, tokens: 0 };
  const by = { ...s.by, [who]: { usd: v.usd + usd, tokens: v.tokens + tok } };
  hive.setState({ day: s.day, by });
  const budget = Number(hive.options.budget ?? 20);
  const now = totals(by).usd;
  if (budget > 0 && was < budget && now >= budget) hive.notify(`Today's agent budget of ${money(budget)} is spent.`);
  draw();
  return { today: totals(by), budget };
}

hive.on("start", () => {
  draw();
  // Past midnight the day starts again, even with nothing reported.
  setInterval(() => { if ((hive.state || {}).day !== day()) { hive.setState(st()); draw(); } }, 60_000);
});
hive.on("options", draw);
hive.hm.onCommand("add", add);
hive.hm.onCommand("today", () => ({ ...totals(st().by), byAgent: st().by, budget: Number(hive.options.budget ?? 20) }));
