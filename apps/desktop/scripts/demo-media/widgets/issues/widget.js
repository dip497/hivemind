// This workspace's issues by state, and the share of them done.
let issues = [];

const draw = () => {
  const count = (...states) => issues.filter((i) => states.includes(i.state)).length;
  const done = count("done");
  hive.render({ type: "stack", children: [
    { type: "text", text: "Issues", muted: true },
    { type: "row", children: [
      { type: "number", value: count("backlog", "todo"), label: "to do" },
      { type: "number", value: count("in_progress", "in_review"), label: "in progress" },
      { type: "number", value: done, label: "done" },
    ] },
    { type: "meter", value: done, max: Math.max(issues.length, 1), label: `${done} of ${issues.length} done` },
  ] });
};

hive.on("start", () => {
  draw();
  hive.hm.onIssues((list) => { issues = list; draw(); });
});
