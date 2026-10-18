// Runs the test command (a setting) several times, one after another, through host.run, reads
// each test's outcome from what the runner printed, and shows how often each passed. A test that
// both passed and failed is flaky; "Ask an agent to fix" starts one with a prompt you read first.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { parseRun, splitCommand, summarize } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
// An agent's call waits 30 s; past this it is told the runs go on.
const COMMAND_WAIT_MS = 25_000;
const KEEP = 300;
const SHOW = [["all", "All"], ["flaky", "Flaky"], ["failing", "Always failing"], ["passing", "Passing"]];

function Dot({ passed }) {
  const color = passed === null ? "var(--color-line)" : passed ? "var(--color-ok)" : "var(--color-err)";
  return h("span", { title: passed === null ? "not run" : passed ? "passed" : "failed", style: { width: 10, height: 10, borderRadius: 3, background: color, flex: "none" } });
}

function Flaky({ tile, hm, host }) {
  const [opts, setOpts] = useState({ command: hm.settings.command ?? "bun test", runs: hm.settings.runs ?? 5 });
  const [last, setLast] = useTileState(hm, "last", null);
  const [show, setShow] = useTileState(hm, "show", "all");
  const [progress, setProgress] = useState(null);
  const stop = useRef(false);
  const going = useRef(null);
  const lastRef = useRef(last);
  lastRef.current = last;
  useEffect(() => hm.on("settings", (s) => setOpts({ command: s.command ?? "bun test", runs: s.runs ?? 5 })), [hm]);

  const start = useCallback(() => {
    if (going.current) return going.current;
    const cmd = splitCommand(opts.command);
    const total = Math.min(Math.max(Math.round(opts.runs), 2), 20);
    stop.current = false;
    const p = (async () => {
      if (!cmd) throw new Error("Set a test command first.");
      const runs = [], outcomes = [], problems = [];
      setProgress({ done: 0, total, outcomes: [] });
      for (let i = 0; i < total && !stop.current; i++) {
        const began = Date.now();
        const r = await host.run(cmd.bin, cmd.args);
        const run = parseRun(`${r.stdout}\n${r.stderr}`);
        if (!run.size) problems.push({ run: i + 1, code: r.code, output: (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n") });
        runs.push(run);
        outcomes.push({ failed: [...run.values()].filter((x) => !x).length, tests: run.size, ms: Date.now() - began });
        setProgress({ done: i + 1, total, outcomes: [...outcomes] });
      }
      const all = summarize(runs);
      // Kept with the tile, which holds 64 KB: flaky and failing tests sort first, so they stay.
      const result = { command: opts.command, at: new Date().toISOString(), runs: outcomes, problems, tests: all.slice(0, KEEP), testCount: all.length };
      lastRef.current = result;
      setLast(result);
      return result;
    })();
    going.current = p;
    p.catch(() => {}).finally(() => { going.current = null; setProgress(null); });
    return p;
  }, [host, opts, setLast]);

  const brief = (r) => ({
    command: r.command, at: r.at, runs: r.runs.length, tests: r.testCount ?? r.tests.length,
    flaky: r.tests.filter((t) => t.flaky).map((t) => ({ name: t.name, passed: t.passed, failed: t.failed })),
    alwaysFailing: r.tests.filter((t) => !t.flaky && t.failed).map((t) => t.name),
    problems: r.problems,
  });
  useEffect(() => hm.onCommand("run", async () => {
    const p = start();
    const r = await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), COMMAND_WAIT_MS))]);
    return r ? brief(r) : { running: true, note: "The runs go on in the tile; call flaky when they are done." };
  }), [hm, start]);
  useEffect(() => hm.onCommand("flaky", () => {
    if (!lastRef.current) throw new Error("no runs yet: call run first");
    return { ...brief(lastRef.current), running: !!going.current };
  }), [hm]);

  const tests = last?.tests ?? [];
  const counts = useMemo(() => ({
    all: tests.length, flaky: tests.filter((t) => t.flaky).length,
    failing: tests.filter((t) => !t.flaky && t.failed).length, passing: tests.filter((t) => !t.failed).length,
  }), [tests]);
  const shown = tests.filter((t) => show === "all" || (show === "flaky" ? t.flaky : show === "failing" ? !t.flaky && t.failed : !t.failed));
  const canAsk = hm.capabilities.includes("workspace:spawn");
  const fix = (t) => hm.commands.spawnAgent(null, tile.frameId, {
    name: `Fix flaky: ${t.name.slice(0, 40)}`,
    prompt: `The test "${t.name}" is flaky: run ${t.runs} times with \`${last.command}\`, it passed ${t.passed} and failed ${t.failed} (in order: ${t.history.map((x) => (x === null ? "-" : x ? "pass" : "fail")).join(", ")}). Find why it depends on timing, order, shared state or the environment, make it pass every time without weakening what it checks, run it many times to show it is steady, and say what the cause was.`,
  });

  const header = h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--color-line)" } },
    h("div", { style: { flex: 1, minWidth: 0 } },
      h("div", { style: { ...mono, fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `$ ${opts.command}`),
      h("div", { style: muted }, progress ? `Run ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
        : last ? `${last.testCount ?? last.tests.length} tests · ${last.runs.length} runs · ${new Date(last.at).toLocaleString()}${(last.testCount ?? 0) > KEEP ? ` · showing the first ${KEEP}` : ""}` : `Runs it ${opts.runs} times, one after another`)),
    progress
      ? h(Button, { size: "xs", variant: "outline", onClick: () => { stop.current = true; } }, "Stop after this run")
      : h(Button, { size: "xs", variant: last ? "ghost" : "default", onClick: () => start().catch(() => {}) }, `Run ${opts.runs} times`));

  const meter = progress && h("div", { "data-progress": true, style: { padding: "10px 14px", borderBottom: "1px solid var(--color-line)" } },
    h("div", { style: { display: "flex", gap: 4 } },
      Array.from({ length: progress.total }, (_, i) => {
        const o = progress.outcomes[i];
        const now = i === progress.done;
        return h("div", {
          key: i, title: o ? `${o.tests} tests, ${o.failed} failed, ${(o.ms / 1000).toFixed(1)} s` : now ? "running" : "waiting",
          style: {
            flex: 1, height: 8, borderRadius: 4,
            background: o ? (o.failed || !o.tests ? "var(--color-err)" : "var(--color-ok)") : now ? "var(--color-select)" : "var(--color-bg3)",
            opacity: now ? 0.6 : 1, transition: "background-color 200ms",
          },
        });
      })),
    h("div", { style: { ...muted, marginTop: 6 } }, `${progress.done} of ${progress.total} runs done`));

  if (!last) {
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } }, header, meter,
      progress ? h(Loading, { label: "Running the tests" })
        : h("div", { style: { padding: 24, textAlign: "center" } },
          h("div", { style: { fontSize: 13 } }, "Run the tests a few times to find the ones that only fail sometimes."),
          h("div", { style: { ...muted, marginTop: 4 } }, "It reads bun, node --test, TAP, pytest -v, jest --verbose, vitest's verbose reporter and cargo test.")));
  }
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } }, header, meter,
    h("div", { style: { display: "flex", gap: 4, alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--color-line)" } },
      SHOW.map(([k, label]) => h(Button, { key: k, size: "xs", variant: show === k ? "secondary" : "ghost", onClick: () => setShow(k), "data-show": k },
        k === "flaky" && counts.flaky ? h("span", { style: { width: 7, height: 7, borderRadius: 4, background: "var(--color-warn)" } }) : null,
        `${label} ${counts[k]}`))),
    last.problems.length > 0 && h("div", { role: "alert", style: { padding: "8px 14px", borderBottom: "1px solid var(--color-line)", fontSize: 12, color: "var(--color-warn)" } },
      `No test results read from run ${last.problems.map((p) => p.run).join(", ")}`,
      h("pre", { style: { ...mono, ...muted, margin: "4px 0 0", whiteSpace: "pre-wrap" } }, last.problems[0].output)),
    h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
      !shown.length ? h("p", { style: { ...muted, padding: 16 } }, show === "flaky" ? "No flaky test in these runs." : "Nothing here.")
        : shown.map((t) => h("div", { key: t.name, "data-test": t.name, style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderBottom: "1px solid var(--color-line)" } },
          h("span", { style: { ...mono, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: t.name }, t.name),
          t.flaky && h("span", { style: { fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 999, color: "var(--color-warn)", background: "color-mix(in srgb, var(--color-warn) 16%, transparent)" } }, "flaky"),
          h("div", { style: { display: "flex", gap: 3 } }, t.history.map((x, i) => h(Dot, { key: i, passed: x }))),
          h("div", { style: { width: 90, display: "flex", alignItems: "center", gap: 6 } },
            h("div", { style: { flex: 1, height: 4, borderRadius: 2, background: "var(--color-bg3)", overflow: "hidden" } },
              h("div", { style: { width: `${Math.round(t.passRate * 100)}%`, height: "100%", background: t.flaky ? "var(--color-warn)" : t.failed ? "var(--color-err)" : "var(--color-ok)" } })),
            h("span", { style: { ...muted, ...mono, width: 34, textAlign: "right" } }, `${Math.round(t.passRate * 100)}%`)),
          canAsk && t.flaky ? h(Button, { size: "2xs", variant: "outline", onClick: () => fix(t) }, "Ask an agent to fix") : null))));
}

export default { tiles: { "flaky-tests": Flaky } };
