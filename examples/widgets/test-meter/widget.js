// The test suite's last runs, reported by whoever ran them: an agent after `bun test`, a git hook,
// a CI step (`hive ctl plugin call @dip497/test-meter report '{"passed":412,"failed":3}'`). The
// meter is the share that passed; the rows are the runs before it, so a trend shows.
const runs = () => (hive.state && Array.isArray(hive.state.runs) ? hive.state.runs : []);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const line = (r) => `${r.failed ? "✗" : "✓"} ${r.passed} passed${r.failed ? ` · ${r.failed} failed` : ""}${r.skipped ? ` · ${r.skipped} skipped` : ""} · ${ago(r.at)}`;

function draw() {
  const list = runs();
  const last = list[0];
  if (!last) {
    hive.render({ type: "stack", children: [
      { type: "text", text: "Tests", size: "large" },
      { type: "text", text: "No run reported yet. An agent reports one with the report command.", muted: true },
    ] });
    return;
  }
  const total = last.passed + last.failed;
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "image", src: last.failed ? "failing.svg" : "passing.svg", w: 34, h: 34, label: last.failed ? "failing" : "passing" },
        { type: "number", value: total ? `${Math.floor((last.passed / total) * 1000) / 10}%` : "–", label: last.suite ? `${last.suite} passing` : "passing" },
        { type: "number", value: last.failed, label: "failing" },
      ] },
      { type: "meter", value: last.passed, max: Math.max(total, 1), label: line(last) },
      ...(last.failing.length ? [{ type: "text", text: `Failing: ${last.failing.join(", ")}`, muted: true }] : []),
      ...list.slice(1, 4).map((r) => ({ type: "text", text: line(r), muted: true })),
    ],
  });
}

function report(a) {
  if (!a || typeof a !== "object") throw new Error("report needs { passed, failed }");
  if (!Number.isFinite(a.passed) || !Number.isFinite(a.failed)) throw new Error("passed and failed must be numbers");
  const run = {
    passed: count(a.passed), failed: count(a.failed), skipped: count(a.skipped),
    suite: typeof a.suite === "string" ? a.suite.slice(0, 40) : undefined,
    failing: Array.isArray(a.failing) ? a.failing.filter((f) => typeof f === "string").slice(0, 5).map((f) => f.slice(0, 80)) : [],
    at: Date.now(),
  };
  const before = runs()[0];
  hive.setState({ runs: [run, ...runs()].slice(0, 20) });
  if (run.failed && !(before && before.failed)) hive.notify(`${run.failed} test${run.failed === 1 ? "" : "s"} failing`);
  draw();
  return { runs: runs().length };
}

hive.on("start", () => { draw(); setInterval(draw, 60_000); });
hive.hm.onCommand("report", report);
hive.hm.onCommand("history", () => runs());
hive.hm.onCommand("clear", () => { hive.setState({ runs: [] }); draw(); return { runs: 0 }; });
