// The repository's GitHub Actions runs, through `gh` in the tile's folder (host.run). The list is
// read again every 15 seconds while a run is going, every minute otherwise. A failed job's log is
// `gh run view --job <id> --log-failed`. "Ask an agent to fix" starts one in this tile's frame with
// a prompt you read before it is sent (permissions workspace:spawn and workspace:prompt).
import React, { useCallback, useEffect, useRef, useState } from "hm-plugin://host/react.js";
import { Loading, useTileState } from "hm-plugin://host/sdk.js";
import { Button, toast } from "hm-plugin://host/ui.js";

const h = React.createElement;
const RUN_FIELDS = "databaseId,displayTitle,headBranch,status,conclusion,workflowName,createdAt,event,url";
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const LOG_LINES = 4000;

/** What a run or job is now, as one word and its color. */
function outcome({ status, conclusion }) {
  if (status !== "completed") return { word: status === "in_progress" ? "running" : status, color: "var(--color-warn)" };
  if (conclusion === "success") return { word: "passed", color: "var(--color-ok)" };
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return { word: conclusion === "failure" ? "failed" : conclusion.replace("_", " "), color: "var(--color-err)" };
  return { word: conclusion || "done", color: "var(--color-fg3)" };
}

function Dot({ of }) {
  const o = outcome(of);
  return h("span", { title: o.word, style: { display: "inline-block", width: 8, height: 8, borderRadius: 4, flex: "none", background: o.color } });
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** `gh`'s log lines are "job<TAB>step<TAB>time message": the messages, under a line naming each step. */
function readable(log) {
  const lines = [];
  let last = null;
  for (const l of log.split("\n")) {
    const [, step, rest] = l.split("\t");
    if (rest === undefined) { lines.push(l); continue; }
    if (step !== last && step !== "UNKNOWN STEP") lines.push(`── ${step}`);
    last = step;
    lines.push(rest.replace(/^﻿?\S+Z\s?/, ""));
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.length > LOG_LINES ? [`… ${lines.length - LOG_LINES} lines above`, ...lines.slice(-LOG_LINES)] : lines;
}

async function gh(host, args, maxAgeMs = 0) {
  const r = await host.run("gh", args, { maxAgeMs });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args[0]} ${args[1]} failed`);
  return r.stdout;
}

function Runs({ tile, hm, host }) {
  const [opts, setOpts] = useState({ count: hm.settings.count ?? 40, branch: hm.settings.branch ?? "all" });
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const [jobs, setJobs] = useState(null);
  const [job, setJob] = useTileState(hm, "job", null);
  const [log, setLog] = useState(null);
  const logBox = useRef(null);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => hm.on("settings", (s) => setOpts({ count: s.count ?? 40, branch: s.branch ?? "all" })), [hm]);

  useEffect(() => {
    let live = true;
    (async () => {
      const args = ["run", "list", "--limit", String(opts.count), "--json", RUN_FIELDS];
      if (opts.branch === "current") {
        const b = (await host.run("git", ["branch", "--show-current"])).stdout.trim();
        if (b) args.push("--branch", b);
      }
      const list = JSON.parse(await gh(host, args));
      if (live) { setRuns(list); setError(null); }
    })().catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [host, opts, tick]);

  const going = (runs ?? []).some((r) => r.status !== "completed");
  useEffect(() => {
    const t = setInterval(refresh, going ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [going, refresh]);

  const run = runs?.find((r) => r.databaseId === chosen) ?? null;
  const runState = run ? `${run.status}/${run.conclusion}` : "";
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    gh(host, ["run", "view", String(chosen), "--json", "jobs"]).then(
      (out) => {
        if (!live) return;
        const list = JSON.parse(out).jobs;
        setJobs(list);
        if (!list.some((x) => x.databaseId === job)) setJob(list.find((x) => outcome(x).color === "var(--color-err)")?.databaseId ?? null);
      },
      (e) => { if (live) { setJobs([]); toast.error("Could not read the run's jobs", { description: e.message }); } });
    return () => { live = false; };
  }, [host, chosen, runState, tick]);

  const theJob = jobs?.find((j) => j.databaseId === job) ?? null;
  const failed = theJob && outcome(theJob).color === "var(--color-err)";
  useEffect(() => {
    setLog(null);
    if (!failed) return;
    let live = true;
    gh(host, ["run", "view", "--job", String(job), "--log-failed"], 300_000).then(
      (out) => { if (live) { const lines = readable(out); setLog(lines.length ? lines : ["No failed lines in this job's log."]); } },
      (e) => { if (live) setLog([`Could not read the log: ${e.message}`]); });
    return () => { live = false; };
  }, [host, job, failed]);

  // Open the log at its first error line, which GitHub marks `##[error]`; without one, at its end.
  useEffect(() => {
    const box = logBox.current;
    if (!log || !box) return;
    const first = box.querySelector("[data-error]");
    if (first) box.scrollTop += first.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    else box.scrollTop = box.scrollHeight;
  }, [log]);

  // An agent asks what failed (`hive ctl plugin call dip497/ci-runs failures`).
  useEffect(() => hm.onCommand("failures", async () => {
    if (!runs) throw new Error("the runs are still loading");
    const failed = runs.filter((r) => outcome(r).color === "var(--color-err)");
    return Promise.all(failed.map(async (r) => {
      const jobs = JSON.parse(await gh(host, ["run", "view", String(r.databaseId), "--json", "jobs"], 60_000)).jobs
        .filter((j) => outcome(j).color === "var(--color-err)");
      return {
        run: r.databaseId, title: r.displayTitle, workflow: r.workflowName, branch: r.headBranch, url: r.url, when: r.createdAt,
        jobs: jobs.map((j) => ({ job: j.databaseId, name: j.name, log: `gh run view --job ${j.databaseId} --log-failed` })),
      };
    }));
  }), [hm, host, runs]);

  const choose = (id) => { setChosen(id); setJobs(null); setJob(null); };
  const act = async (what, args) => {
    try { await gh(host, args); toast.success(what); refresh(); } catch (e) { toast.error(`${what} failed`, { description: e.message }); }
  };
  const fix = () => hm.commands.spawnAgent(null, tile.frameId, {
    name: `Fix CI: ${theJob.name}`,
    prompt: `The CI run ${run.url} ("${run.displayTitle}", workflow ${run.workflowName}, branch ${run.headBranch}) failed in the job "${theJob.name}". Read the failure with \`gh run view --job ${theJob.databaseId} --log-failed\`, find the cause in this repository, fix it, and say what you changed and how you checked it.`,
  });

  if (error && !runs) {
    return h("div", { role: "alert", style: { padding: 16, color: "var(--color-err)", fontSize: 13 } },
      h("p", null, error),
      h("p", { style: muted }, "This tile drives the GitHub CLI: install `gh` and run `gh auth login`."));
  }
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(280px, 36%) 1fr", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--color-line)" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--color-line)" } },
        h("span", { style: { ...muted, flex: 1 } }, runs ? `${runs.length} runs${opts.branch === "current" ? " on this branch" : ""}${going ? " · refreshing every 15s" : ""}` : "Loading…"),
        h(Button, { size: "2xs", variant: "ghost", onClick: refresh }, "Refresh")),
      h("div", { style: { overflow: "auto", minHeight: 0 } },
        (runs ?? []).map((r) => h("button", {
          key: r.databaseId, onClick: () => choose(r.databaseId), "data-run": r.databaseId, "aria-current": r.databaseId === chosen || undefined,
          style: {
            display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left", padding: "7px 12px", border: 0, cursor: "pointer",
            color: "var(--color-fg)", borderBottom: "1px solid var(--color-line)", background: r.databaseId === chosen ? "var(--color-bg3)" : "transparent",
          },
        },
        h(Dot, { of: r }),
        h("span", { style: { minWidth: 0, flex: 1 } },
          h("div", { style: { fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.displayTitle),
          h("div", { style: muted }, `${r.workflowName} · ${r.headBranch} · ${r.event} · ${ago(r.createdAt)}`)))))),
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      !run ? h("p", { style: { ...muted, padding: 16 } }, "Choose a run.") : [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, run.displayTitle),
            h("div", { style: muted }, `${outcome(run).word} · ${run.workflowName} · ${run.headBranch} · ${ago(run.createdAt)}`)),
          run.status !== "completed"
            ? h(Button, { size: "xs", variant: "outline", onClick: () => act("Cancelled the run", ["run", "cancel", String(run.databaseId)]) }, "Cancel")
            : outcome(run).color === "var(--color-err)" && h(Button, { size: "xs", variant: "outline", onClick: () => act("Rerunning the failed jobs", ["run", "rerun", String(run.databaseId), "--failed"]) }, "Rerun failed"),
          h(Button, { size: "xs", variant: "ghost", onClick: () => host.openUrl(run.url) }, "Open on GitHub")),
        h("div", { key: "jobs", style: { display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
          jobs === null ? h(Loading, { label: "Loading the jobs", className: "min-h-0" })
            : jobs.map((j) => h("button", {
              key: j.databaseId, onClick: () => setJob(j.databaseId), "data-job": j.name, "aria-pressed": j.databaseId === job,
              style: {
                display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11.5,
                color: "var(--color-fg)", border: "1px solid var(--color-line)", background: j.databaseId === job ? "var(--color-bg3)" : "transparent",
              },
            }, h(Dot, { of: j }), j.name))),
        theJob && h("div", { key: "job", style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--color-line)" } },
          h("span", { style: { ...muted, flex: 1 } }, failed
            ? `Failed at: ${theJob.steps.filter((s) => s.conclusion === "failure").map((s) => s.name).join(", ") || "a step"}`
            : `${outcome(theJob).word} · ${theJob.steps.length} steps`),
          failed && hm.capabilities.includes("workspace:spawn") && h(Button, { size: "xs", variant: "outline", onClick: fix }, "Ask an agent to fix")),
        h("div", { key: "log", ref: logBox, "data-log-box": true, style: { flex: 1, minHeight: 0, overflow: "auto" } },
          !theJob ? h("p", { style: { ...muted, padding: 12 } }, "Choose a job.")
            : !failed ? h("ol", { style: { margin: 0, padding: "8px 12px 8px 32px", fontSize: 12 } },
              theJob.steps.map((s) => h("li", { key: s.number, style: { padding: "2px 0" } }, h(Dot, { of: s }), " ", s.name)))
            : log === null ? h(Loading, { label: "Loading the log" })
              : h("pre", { "data-log": true, style: { margin: 0, padding: 12, fontSize: 11.5, lineHeight: 1.45, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
                log.map((line, i) => line.includes("##[error]")
                  ? h("div", { key: i, "data-error": true, style: { color: "var(--color-err)", fontWeight: 600 } }, line.replace("##[error]", ""))
                  : h("div", { key: i }, line)))),
      ]));
}

export default { tiles: { "ci-runs": Runs } };
