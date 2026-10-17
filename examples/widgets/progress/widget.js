// A task's progress, kept by the agents doing it (`hive ctl plugin call @dip497/progress add
// '{"text":"Write the tests"}'`) and by anyone here, who can tick a step by pressing it. What it
// keeps is the widget's state: saved with the workspace and seen by everyone in it.
const title = () => (hive.state && hive.state.title) || "Progress";
const steps = () => (hive.state && Array.isArray(hive.state.steps) ? hive.state.steps : []);

function save(next) {
  hive.setState({ title: title(), steps: steps(), ...next });
  draw();
}

function draw() {
  const list = steps();
  const done = list.filter((s) => s.done).length;
  hive.render({
    type: "stack",
    children: [
      { type: "text", text: title() },
      { type: "meter", value: done, max: Math.max(list.length, 1), label: `${done} of ${list.length} done` },
      ...(list.length ? list.map((s, i) => ({ type: "button", label: `${s.done ? "✓" : "○"}  ${s.text}`, action: { tick: i } }))
        : [{ type: "text", text: "No steps yet: an agent adds them.", muted: true }]),
    ],
  });
}

function tick(index, done) {
  const list = steps().slice();
  if (!Number.isInteger(index) || !list[index]) throw new Error(`there is no step ${index}; there are ${list.length}`);
  list[index] = { ...list[index], done };
  save({ steps: list });
  return list[index];
}

hive.on("start", draw);
hive.on("action", (a) => { if (a && Number.isInteger(a.tick)) tick(a.tick, !steps()[a.tick]?.done); });

hive.hm.onCommand("set-title", (a) => {
  if (!a || typeof a.title !== "string" || !a.title.trim()) throw new Error("title is required");
  save({ title: a.title.trim().slice(0, 80) });
  return { title: title() };
});
hive.hm.onCommand("add", (a) => {
  if (!a || typeof a.text !== "string" || !a.text.trim()) throw new Error("text is required");
  save({ steps: [...steps(), { text: a.text.trim().slice(0, 120), done: false }] });
  return { index: steps().length - 1 };
});
hive.hm.onCommand("check", (a) => tick(a && a.index, !a || a.done !== false));
hive.hm.onCommand("list", () => ({ title: title(), steps: steps() }));
hive.hm.onCommand("clear", () => { save({ steps: [] }); return { steps: [] }; });
