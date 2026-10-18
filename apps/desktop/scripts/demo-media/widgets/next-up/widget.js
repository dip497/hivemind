// The issues waiting to be picked up, newest first.
let issues = [];

const draw = () => {
  const next = issues.filter((i) => i.state === "todo").sort((a, b) => b.created.localeCompare(a.created)).slice(0, 4);
  hive.render({ type: "stack", children: [
    { type: "text", text: "Next up", muted: true },
    ...(next.length ? next.map((i) => ({ type: "text", text: i.title })) : [{ type: "text", text: "Nothing waiting", muted: true }]),
  ] });
};

hive.on("start", () => {
  draw();
  hive.hm.onIssues((list) => { issues = list; draw(); });
});
