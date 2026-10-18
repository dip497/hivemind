// How many agents here are working and how many wait on a person, as the app reports each one.
const status = new Map();
const watched = new Set();

const draw = () => {
  const all = [...status.values()];
  const working = all.filter((s) => s === "working").length;
  const waiting = all.filter((s) => s === "waiting").length;
  hive.render({ type: "stack", children: [
    { type: "text", text: "Agents", muted: true },
    { type: "row", children: [
      { type: "number", value: working, label: "working" },
      { type: "number", value: waiting, label: "wait on you" },
      { type: "number", value: all.length, label: "in all" },
    ] },
  ] });
};

hive.on("start", () => {
  draw();
  hive.hm.on("structure", ({ tiles }) => {
    for (const t of tiles) {
      if (!t.agent || watched.has(t.id)) continue;
      watched.add(t.id);
      hive.hm.subscribeStatus(t.id, (s) => { status.set(t.id, s); draw(); });
    }
  });
});
