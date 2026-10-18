// How the workspace's agents are doing right now: how many work, wait on you or sit idle, and how
// many turns they finished today. All of it read through hive.hm; it needs no permission.
const states = new Map();
const watching = new Map();
let turns = 0;
let day = "";

function stateOf(status, info) {
  const s = info && info.agent && info.agent.state;
  if (s === "waiting" || status === "blocked") return "waiting";
  if (s === "working" || status === "working") return "working";
  if (s === "failed" || s === "limited") return "stuck";
  if (status === "exited" || s === "exited") return "exited";
  return "idle";
}

/** Today's count starts again at midnight. */
function rollOver() {
  const d = today();
  if (d !== day) { day = d; turns = 0; }
}

function draw() {
  rollOver();
  const count = { working: 0, waiting: 0, idle: 0, stuck: 0 };
  for (const s of states.values()) if (s in count) count[s]++;
  const live = count.working + count.waiting + count.idle + count.stuck;
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "number", value: count.working, label: "working" },
        { type: "number", value: count.waiting, label: "waiting" },
        { type: "number", value: count.idle, label: "idle" },
        { type: "number", value: turns, label: "turns today" },
      ] },
      { type: "meter", value: count.working, max: Math.max(live, 1), label: live ? `${Math.round((count.working / live) * 100)}% of ${live} agents busy` : "No agents yet" },
      ...(count.stuck ? [{ type: "text", text: `${count.stuck} stopped on an error or a limit`, muted: true }] : []),
    ],
  });
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

hive.on("start", async () => {
  draw();
  hive.hm.on("structure", ({ tiles }) => {
    const agents = new Set(tiles.filter((t) => t.agent).map((t) => t.id));
    for (const [id, stop] of watching) if (!agents.has(id)) { stop(); watching.delete(id); states.delete(id); }
    for (const id of agents) if (!watching.has(id)) watching.set(id, hive.hm.subscribeStatus(id, (s, info) => { states.set(id, stateOf(s, info)); draw(); }));
    draw();
  });
  hive.hm.onEvents(["turn"], () => { rollOver(); turns++; draw(); });
  try {
    const asked = day;
    const history = await hive.hm.history(asked);
    if (asked !== day) return;
    turns += history.tiles.reduce((n, t) => n + t.turns.length, 0);
    draw();
  } catch { /* an app without history counts from now */ }
});

hive.hm.onCommand("status", () => {
  rollOver();
  const out = { working: 0, waiting: 0, idle: 0, stuck: 0, turnsToday: turns };
  for (const s of states.values()) if (s in out) out[s]++;
  return out;
});
