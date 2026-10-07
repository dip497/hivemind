// Pull requests of the tile's repository, through the `gh` you are signed in to.
// It runs `gh` in the tile's folder (host.run), draws diffs with the app's own
// diff view (PatchView), and reads which PRs to list from its settings (hm.settings).
import React, { useCallback, useEffect, useState } from "hm-plugin://host/react.js";
import { Button, Markdown, PatchView, Loading, useTileState } from "hm-plugin://host/sdk.js";

const h = React.createElement;
const LIST = ["number", "title", "author", "headRefName", "isDraft", "updatedAt", "reviewDecision"].join(",");
const VIEW = ["number", "title", "body", "author", "url", "state", "comments", "reviews", "statusCheckRollup", "mergeable"].join(",");

async function gh(host, args, opts) {
  const r = await host.run("gh", args, opts);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args[0]} ${args[1] ?? ""} failed`);
  return r.stdout;
}

const muted = { color: "var(--color-fg3)", fontSize: 11 };
const pane = { overflow: "auto", minHeight: 0 };

function List({ prs, chosen, onChoose }) {
  if (!prs.length) return h("p", { style: { ...muted, padding: 12 } }, "No pull requests.");
  return h("div", { style: pane }, prs.map((p) => h("button", {
    key: p.number, onClick: () => onChoose(p.number), "data-pr": p.number,
    style: {
      display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: 0, cursor: "pointer",
      background: p.number === chosen ? "var(--color-bg3)" : "transparent", color: "var(--color-fg)",
      borderBottom: "1px solid var(--color-line)",
    },
  }, h("div", { style: { fontSize: 13 } }, `#${p.number} ${p.title}`),
     h("div", { style: muted }, `${p.author?.login ?? "?"} · ${p.headRefName}${p.isDraft ? " · draft" : ""}${p.reviewDecision ? ` · ${p.reviewDecision.toLowerCase().replace("_", " ")}` : ""}`))));
}

function Checks({ rollup }) {
  if (!rollup?.length) return h("p", { style: muted }, "No checks.");
  return h("ul", { style: { margin: 0, paddingLeft: 18 } }, rollup.map((c, i) => h("li", { key: i },
    `${c.conclusion || c.status || c.state || "?"} — ${c.name || c.context || "check"}`)));
}

function Detail({ hm, host, number, onChanged }) {
  const [pr, setPr] = useState(null);
  const [tab, setTab] = useTileState(hm, "tab", "conversation");
  const [diff, setDiff] = useState(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    setError(null);
    gh(host, ["pr", "view", String(number), "--json", VIEW], { maxAgeMs: 15_000 }).then((t) => setPr(JSON.parse(t)), (e) => setError(e.message));
  }, [host, number]);
  useEffect(() => { setPr(null); setDiff(null); setTab("conversation"); load(); }, [load]);
  useEffect(() => {
    if (tab !== "files" || diff !== null) return;
    gh(host, ["pr", "diff", String(number)], { maxAgeMs: 60_000 }).then(setDiff, (e) => setError(e.message));
  }, [tab, diff, host, number]);
  const act = async (args, stdin) => {
    setBusy(true); setError(null);
    try { await gh(host, args, stdin === undefined ? undefined : { stdin }); load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  if (!pr) return error ? h("p", { style: { ...muted, padding: 12 } }, error) : h(Loading, { label: "Loading the pull request" });
  const tabs = ["conversation", "files", "checks"];
  return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" } },
    h("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--color-line)" } },
      h("div", { style: { fontSize: 14, fontWeight: 600 } }, `#${pr.number} ${pr.title}`),
      h("div", { style: { ...muted, display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
        `${pr.author?.login ?? "?"} · ${pr.state.toLowerCase()} · ${pr.mergeable?.toLowerCase() ?? ""}`,
        h(Button, { size: "xs", variant: "ghost", onClick: () => host.openUrl(pr.url) }, "Open on GitHub")),
      h("div", { style: { display: "flex", gap: 4, marginTop: 8 } }, tabs.map((t) => h(Button, {
        key: t, size: "xs", variant: tab === t ? "secondary" : "ghost", onClick: () => setTab(t), "data-pr-tab": t,
      }, t[0].toUpperCase() + t.slice(1))))),
    error && h("p", { role: "alert", style: { color: "var(--color-err)", padding: "6px 12px", margin: 0 } }, error),
    h("div", { style: { ...pane, flex: 1, padding: tab === "files" ? 0 : 12 } },
      tab === "conversation" && h("div", { style: { display: "grid", gap: 12 } },
        h(Markdown, { text: pr.body || "_No description._" }),
        ...pr.comments.map((c, i) => h("div", { key: `c${i}`, style: { borderTop: "1px solid var(--color-line)", paddingTop: 8 } },
          h("div", { style: muted }, c.author?.login ?? "?"), h(Markdown, { text: c.body }))),
        ...pr.reviews.filter((r) => r.body || r.state !== "COMMENTED").map((r, i) => h("div", { key: `r${i}`, style: muted },
          `${r.author?.login ?? "?"} ${r.state.toLowerCase().replace("_", " ")}${r.body ? `: ${r.body}` : ""}`)),
        h("textarea", {
          value: comment, onChange: (e) => setComment(e.target.value), placeholder: "Leave a comment", rows: 3,
          style: { width: "100%", background: "var(--color-bg)", color: "var(--color-fg)", border: "1px solid var(--color-line)", borderRadius: 6, padding: 8 },
        }),
        h("div", { style: { display: "flex", gap: 6 } },
          h(Button, { size: "sm", disabled: busy || !comment.trim(), onClick: () => act(["pr", "comment", String(number), "--body-file", "-"], comment).then(() => setComment("")) }, "Comment"),
          h(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => act(["pr", "review", String(number), "--approve"]) }, "Approve"),
          h(Button, { size: "sm", variant: "outline", disabled: busy || !comment.trim(), onClick: () => act(["pr", "review", String(number), "--request-changes", "--body-file", "-"], comment) }, "Request changes"),
          h(Button, { size: "sm", variant: "destructive", disabled: busy || pr.state !== "OPEN", onClick: () => act(["pr", "merge", String(number), "--squash"]) }, "Squash and merge"))),
      tab === "files" && (diff === null ? h(Loading, { label: "Loading the diff" }) : h(PatchView, { patch: diff })),
      tab === "checks" && h(Checks, { rollup: pr.statusCheckRollup })));
}

function PullRequests({ hm, host }) {
  const [state, setState] = useState(hm.settings.state ?? "open");
  const [prs, setPrs] = useState(null);
  const [error, setError] = useState(null);
  // Which PR was open comes back after a restart: the tile's saved state.
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const choose = (n) => setChosen(n);
  useEffect(() => hm.on("settings", (s) => setState(s.state ?? "open")), [hm]);
  const load = useCallback(() => {
    setError(null);
    gh(host, ["pr", "list", "--state", state, "--limit", "100", "--json", LIST], { maxAgeMs: 30_000 }).then((t) => setPrs(JSON.parse(t)), (e) => setError(e.message));
  }, [host, state]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  if (!host.repoPath) return h("p", { style: { padding: 16 } }, "Open this in a frame bound to a repository.");
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(240px, 32%) 1fr", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--color-line)" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
        h("strong", { style: { fontSize: 12, flex: 1 } }, `Pull requests · ${state}`),
        h(Button, { size: "xs", variant: "ghost", onClick: load }, "Refresh")),
      error ? h("p", { role: "alert", style: { color: "var(--color-err)", padding: 12 } }, error)
        : prs === null ? h(Loading, { label: "Loading the pull requests" })
        : h(List, { prs, chosen, onChoose: choose })),
    chosen ? h(Detail, { hm, host, number: chosen, onChanged: load }) : h("p", { style: { ...muted, padding: 16 } }, "Choose a pull request."));
}

export default { tiles: { "github-prs": PullRequests } };
