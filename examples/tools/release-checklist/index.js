// Checks a repository is ready to release, each through host.run: git for the working tree, branch,
// remote, changelog and the TODOs added since the last tag; the test command (a setting) for the
// tests. "Ask an agent to fix" on a failed check starts one with a prompt you read first.
import React, { useCallback, useEffect, useRef, useState } from "hm-plugin://host/react.js";
import { Button, useTileState } from "hm-plugin://host/sdk.js";
import { addedMarkers, changelogTop, splitCommand, tally, upToDate, workingTree } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
// An agent's call waits 30 s; past this it is told the checks go on.
const COMMAND_WAIT_MS = 25_000;

const CHECKS = [
  { id: "tree", label: "Working tree is clean" },
  { id: "branch", label: "On the release branch" },
  { id: "remote", label: "Up to date with its remote" },
  { id: "tests", label: "Tests pass" },
  { id: "changelog", label: "Changelog has an entry" },
  { id: "markers", label: "No TODO or FIXME added since the last tag" },
];

async function git(host, args) {
  return host.run("git", args);
}

/** One check: its state (pass, fail, skip) and what it found. */
async function runCheck(id, host, opts) {
  if (id === "tree") {
    const r = await git(host, ["status", "--porcelain"]);
    if (r.code !== 0) return { state: "fail", detail: r.stderr.trim() };
    const w = workingTree(r.stdout);
    return { state: w.pass ? "pass" : "fail", detail: w.detail };
  }
  if (id === "branch") {
    const r = await git(host, ["branch", "--show-current"]);
    const b = r.stdout.trim();
    if (!b) return { state: "fail", detail: "Not on a branch (a detached HEAD)" };
    return b === opts.branch ? { state: "pass", detail: `On ${b}` } : { state: "fail", detail: `On ${b}, not ${opts.branch}` };
  }
  if (id === "remote") {
    const f = await git(host, ["fetch", "--quiet"]);
    if (f.code !== 0) return { state: "fail", detail: `Could not fetch the remote: ${f.stderr.trim().split("\n")[0] || `git fetch ended ${f.code}`}` };
    const r = await git(host, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    if (r.code !== 0) return { state: "fail", detail: /no upstream/i.test(r.stderr) ? "The branch has no remote branch to compare with" : r.stderr.trim().split("\n")[0] };
    const u = upToDate(r.stdout);
    return { state: u.pass ? "pass" : "fail", detail: u.detail };
  }
  if (id === "tests") {
    const cmd = splitCommand(opts.testCommand);
    if (!cmd) return { state: "skip", detail: "No test command set" };
    const began = Date.now();
    const r = await host.run(cmd.bin, cmd.args);
    const tail = `${r.stdout}\n${r.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" · ");
    const took = `${((Date.now() - began) / 1000).toFixed(1)} s`;
    return r.code === 0 ? { state: "pass", detail: `${opts.testCommand} passed in ${took}` } : { state: "fail", detail: `${opts.testCommand} ended ${r.code} after ${took}: ${tail.slice(0, 240)}` };
  }
  if (id === "changelog") {
    const ls = await git(host, ["ls-files"]);
    const file = ls.stdout.split("\n").find((f) => /^(CHANGELOG|CHANGES|HISTORY)(\.md)?$/i.test(f));
    if (!file) return { state: "fail", detail: "No CHANGELOG.md in the repository" };
    const r = await host.run("cat", ["--", file]);
    const c = changelogTop(r.stdout);
    return { state: c.pass ? "pass" : "fail", detail: `${file}: ${c.detail}`, file };
  }
  if (id === "markers") {
    const tag = await git(host, ["describe", "--tags", "--abbrev=0"]);
    if (tag.code !== 0) return { state: "skip", detail: "No tag yet to compare with" };
    const t = tag.stdout.trim();
    const r = await git(host, ["diff", "--no-color", "--no-ext-diff", `${t}..HEAD`]);
    const found = addedMarkers(r.stdout);
    return found.length
      ? { state: "fail", detail: `${found.length} added since ${t}`, items: found.slice(0, 50) }
      : { state: "pass", detail: `None added since ${t}` };
  }
  return { state: "skip", detail: "" };
}

function Mark({ state }) {
  const s = {
    pass: ["✓", "var(--color-ok)"], fail: ["✕", "var(--color-err)"], skip: ["–", "var(--color-fg3)"],
    running: ["", "var(--color-select)"], idle: ["", "var(--color-line)"],
  }[state];
  return h("span", {
    "data-state": state,
    style: {
      width: 22, height: 22, borderRadius: 11, flex: "none", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
      color: state === "skip" || state === "idle" ? s[1] : "var(--color-bg)", background: state === "pass" || state === "fail" ? s[1] : "transparent",
      border: state === "pass" || state === "fail" ? "none" : `2px ${state === "running" ? "dashed" : "solid"} ${s[1]}`,
      animation: state === "running" ? "spin 1.2s linear infinite" : undefined,
    },
  }, s[0]);
}

function Checklist({ tile, hm, host }) {
  const [opts, setOpts] = useState({ branch: hm.settings.branch ?? "main", testCommand: hm.settings.testCommand ?? "" });
  const [results, setResults] = useTileState(hm, "results", {});
  const [at, setAt] = useTileState(hm, "at", null);
  const [running, setRunning] = useState({});
  const [lastTag, setLastTag] = useState(null);
  const latest = useRef(results);
  useEffect(() => hm.on("settings", (s) => setOpts({ branch: s.branch ?? "main", testCommand: s.testCommand ?? "" })), [hm]);
  useEffect(() => {
    host.run("git", ["describe", "--tags", "--abbrev=0"], { maxAgeMs: 5_000 }).then((r) => setLastTag(r.code === 0 ? r.stdout.trim() : ""));
  }, [host, at]);

  const one = useCallback(async (id) => {
    setRunning((r) => ({ ...r, [id]: true }));
    let res;
    try { res = await runCheck(id, host, opts); } catch (e) { res = { state: "fail", detail: e.message }; }
    latest.current = { ...latest.current, [id]: { ...res, at: new Date().toISOString() } };
    setResults(latest.current);
    setAt(new Date().toISOString());
    setRunning((r) => ({ ...r, [id]: false }));
    return res;
  }, [host, opts, setResults, setAt]);
  // The git checks are quick; the tests go last so the rest show at once.
  const all = useCallback(async () => {
    await Promise.all(CHECKS.filter((c) => c.id !== "tests").map((c) => one(c.id)));
    await one("tests");
    return latest.current;
  }, [one]);

  const list = (r) => CHECKS.map((c) => ({ check: c.label, id: c.id, ...(r[c.id] ?? { state: "not run" }) }));
  useEffect(() => hm.onCommand("check", async () => {
    const r = await Promise.race([all(), new Promise((ok) => setTimeout(() => ok(null), COMMAND_WAIT_MS))]);
    return r ? { ready: CHECKS.every((c) => r[c.id]?.state !== "fail"), checks: list(r) } : { running: true, note: "Still checking (the tests take a while); call status shortly." };
  }), [hm, all]);
  useEffect(() => hm.onCommand("status", () => ({
    at, running: Object.keys(running).filter((k) => running[k]), ready: CHECKS.every((c) => results[c.id]?.state === "pass" || results[c.id]?.state === "skip"), checks: list(results),
  })), [hm, results, running, at]);

  const rows = CHECKS.map((c) => ({ ...c, ...(results[c.id] ?? { state: "idle", detail: "Not checked yet" }), state: running[c.id] ? "running" : results[c.id]?.state ?? "idle" }));
  const t = tally(rows);
  const busy = Object.values(running).some(Boolean);
  const failed = rows.filter((r) => r.state === "fail").length;
  const canAsk = hm.capabilities.includes("workspace:spawn");
  const fix = (r) => hm.commands.spawnAgent(null, tile.frameId, {
    name: `Release: ${r.label}`,
    prompt: `Before releasing, the check "${r.label}" failed: ${r.detail}${r.items ? `\n${r.items.map((i) => `- ${i.file}:${i.line} ${i.text}`).join("\n")}` : ""}\n\nMake it pass (do the work, or tell me why it should wait). Do not commit, push or tag without asking me first.`,
  });

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("style", null, "@keyframes spin { to { transform: rotate(360deg) } }"),
    h("div", { style: { display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderBottom: "1px solid var(--color-line)" } },
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: 13, fontWeight: 600 } },
          busy ? "Checking…" : !at ? "Ready to release?" : failed ? `${failed} check${failed === 1 ? "" : "s"} to fix` : "Ready to release"),
        h("div", { style: muted }, `Last tag `, h("span", { style: mono }, lastTag === null ? "…" : lastTag || "none"), ` · release branch `, h("span", { style: mono }, opts.branch),
          at ? ` · checked ${new Date(at).toLocaleTimeString()}` : "")),
      h("div", { style: { textAlign: "right" } },
        h("div", { style: { fontSize: 18, fontWeight: 700, color: failed ? "var(--color-err)" : t.ran ? "var(--color-ok)" : "var(--color-fg3)" } }, `${t.passed}/${t.total}`),
        h("div", { style: muted }, "passed")),
      h(Button, { size: "xs", variant: "default", disabled: busy, onClick: () => { all(); } }, "Run all")),
    h("div", { "data-meter": true, style: { display: "flex", gap: 3, padding: "0 16px", marginTop: 10 } },
      rows.map((r) => h("div", {
        key: r.id, title: r.label,
        style: { flex: 1, height: 6, borderRadius: 3, background: r.state === "pass" ? "var(--color-ok)" : r.state === "fail" ? "var(--color-err)" : r.state === "running" ? "var(--color-select)" : "var(--color-bg3)" },
      }))),
    h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "8px 0" } },
      rows.map((r) => h("div", { key: r.id, "data-check": r.id, style: { padding: "10px 16px", borderBottom: "1px solid var(--color-line)" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
          h(Mark, { state: r.state }),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 500 } }, r.label),
            h("div", { style: { ...muted, color: r.state === "fail" ? "var(--color-err)" : "var(--color-fg3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: r.detail },
              r.state === "running" ? "Checking…" : r.detail)),
          canAsk && r.state === "fail" && h(Button, { size: "2xs", variant: "outline", onClick: () => fix(r) }, "Ask an agent to fix"),
          h(Button, { size: "2xs", variant: "ghost", disabled: !!running[r.id], onClick: () => one(r.id) }, "Run again")),
        r.items && r.state !== "running" && h("div", { style: { margin: "6px 0 0 34px", display: "flex", flexDirection: "column", gap: 2 } },
          r.items.slice(0, 8).map((i) => h("button", {
            key: `${i.file}:${i.line}`, onClick: () => host.openFile(i.file), title: "Open in the editor",
            style: { ...mono, fontSize: 11, textAlign: "left", border: 0, padding: 0, background: "transparent", color: "var(--color-fg)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, h("span", { style: { color: "var(--color-fg3)" } }, `${i.file}:${i.line}  `), i.text)),
          r.items.length > 8 && h("span", { style: muted }, `and ${r.items.length - 8} more`))))));
}

export default { tiles: { "release-checklist": Checklist } };
