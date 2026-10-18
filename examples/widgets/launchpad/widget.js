// Three jobs you hand to an agent often, one press each. Each press starts your default agent with
// that job as its first message; the app shows you the message, and you send or cancel it
// (permissions workspace:spawn and workspace:prompt). Change the jobs in its options.
const JOBS = [
  { name: "one", fallback: "Review my uncommitted changes: say what is wrong or risky, file by file." },
  { name: "two", fallback: "Run the tests. Fix what fails, and tell me what you changed." },
  { name: "three", fallback: "Write the changelog entry for the work since the last release." },
];
const jobs = () => JOBS.map((j, i) => {
  const text = String(hive.options[j.name] ?? "").trim() || j.fallback;
  return { index: i, label: String(hive.options[`${j.name}Label`] ?? "").trim() || text.split(/[.:]/)[0].slice(0, 32), text };
});

function draw() {
  const caps = hive.hm.capabilities;
  // Until the app sends the client's values, hive.hm answers every name with a call.
  const can = Array.isArray(caps) && caps.includes("workspace:spawn");
  hive.render({
    type: "stack",
    children: [
      { type: "text", text: "Hand it to an agent", size: "large" },
      ...jobs().map((j) => ({ type: "button", label: `▶  ${j.label}`, action: { launch: j.index } })),
      ...(can ? [] : [{ type: "text", text: "Allow it to start agents on its page in Settings ▸ Plugins.", muted: true }]),
    ],
  });
}

function launch(i) {
  const j = jobs()[i];
  if (!j) throw new Error(`there is no job ${i}; there are ${JOBS.length}`);
  return hive.hm.commands.spawnAgent(null, null, { name: j.label, prompt: j.text }).then(() => ({ started: j.label }));
}

hive.on("start", () => { draw(); setTimeout(draw, 500); });
hive.on("options", draw);
hive.on("action", (a) => { if (a && Number.isInteger(a.launch)) launch(a.launch).catch((e) => hive.notify(e.message)); });
hive.hm.onCommand("jobs", () => jobs());
