// Every agent that is waiting on you, longest first: press one to jump to it. It reads the
// workspace's agents and their status through hive.hm and needs no permission to do so.
const WHY = { permission: "wants permission", question: "asked you something", plan: "has a plan to review", approval: "wants approval", other: "needs you" };
const tiles = new Map();
const watching = new Map();
const waiting = new Map();

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

function waitingRows(entries, names, now) {
  return entries
    .map(([id, w]) => ({ id, name: names.get(id) ?? "an agent", why: WHY[w.reason] ?? WHY.other, since: w.since }))
    .sort((a, b) => a.since - b.since)
    .map((r) => ({ ...r, for: ago(now - r.since) }));
}

function draw() {
  const rows = waitingRows([...waiting], new Map([...tiles].map(([id, t]) => [id, t.name])), Date.now());
  const most = Number(hive.options.shown ?? 4);
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "number", value: rows.length, label: rows.length === 1 ? "agent waiting on you" : "agents waiting on you" },
      ] },
      ...(rows.length
        ? rows.slice(0, most).map((r) => ({ type: "button", label: `${r.name} ${r.why} · ${r.for}`, action: { focus: r.id } }))
        : [{ type: "text", text: `All ${[...tiles.values()].length} agents are getting on with it.`, muted: true }]),
      ...(rows.length > most ? [{ type: "text", text: `and ${rows.length - most} more`, muted: true }] : []),
    ],
  });
}

function seen(id, status, info) {
  const agent = info && info.agent;
  const asks = status === "blocked" || (agent && agent.state === "waiting");
  if (asks && !waiting.has(id)) {
    waiting.set(id, { since: (info && info.since) || Date.now(), reason: (agent && agent.waitingFor) || "other" });
    if (hive.options.notify) hive.notify(`${tiles.get(id)?.name ?? "An agent"} ${WHY[(agent && agent.waitingFor) || "other"] ?? WHY.other}`);
  } else if (!asks) waiting.delete(id);
  draw();
}

hive.on("start", () => {
  draw();
  hive.hm.on("structure", ({ tiles: all }) => {
    tiles.clear();
    for (const t of all) if (t.agent) tiles.set(t.id, t);
    for (const [id, stop] of watching) if (!tiles.has(id)) { stop(); watching.delete(id); waiting.delete(id); }
    for (const id of tiles.keys()) if (!watching.has(id)) watching.set(id, hive.hm.subscribeStatus(id, (s, info) => seen(id, s, info)));
    draw();
  });
  // The "for 3m" beside each one keeps counting.
  setInterval(() => { if (waiting.size) draw(); }, 15_000);
});

hive.on("action", (a) => { if (a && typeof a.focus === "string") hive.hm.commands.focusTile(a.focus); });

hive.hm.onCommand("list", () => waitingRows([...waiting], new Map([...tiles].map(([id, t]) => [id, t.name])), Date.now()));
