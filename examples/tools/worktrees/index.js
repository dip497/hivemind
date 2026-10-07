// Every git worktree of the repository (`git worktree list --porcelain`), each read with `git -C`:
// what it has not committed, how far its branch is from the base, its last commit. A worktree whose
// branch the base already holds (nothing ahead) and that has nothing uncommitted loses nothing when
// removed; git refuses the rest. "Ask an agent to review" starts one in this tile's frame with a
// prompt you read before it is sent (permissions workspace:spawn and workspace:prompt).
import React, { useCallback, useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { PatchView, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, toast } from "hm-plugin://host/ui.js";

const h = React.createElement;
const SEP = "\u001f";
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const AT_ONCE = 8;

function parseList(out) {
  return out.split("\n\n").filter((b) => b.trim()).map((block, i) => {
    const w = { path: "", head: "", branch: null, main: i === 0, bare: false, prunable: false, locked: false };
    for (const line of block.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") w.path = value;
      else if (key === "HEAD") w.head = value;
      else if (key === "branch") w.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") w.bare = true;
      else if (key === "prunable") w.prunable = true;
      else if (key === "locked") w.locked = true;
    }
    return w;
  });
}

/** Run `fn` over `items`, at most AT_ONCE at a time. */
async function each(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function inspect(host, w, base) {
  if (w.bare || w.prunable) return { ...w, changed: [], ahead: null, behind: null, when: 0, ago: "", subject: "" };
  const [status, counts, last] = await Promise.all([
    host.run("git", ["-C", w.path, "status", "--porcelain=v1"]),
    host.run("git", ["-C", w.path, "rev-list", "--left-right", "--count", `${base}...HEAD`]),
    host.run("git", ["-C", w.path, "log", "-1", `--format=%ct${SEP}%cr${SEP}%s`]),
  ]);
  const changed = status.code === 0 ? status.stdout.split("\n").filter(Boolean) : [];
  const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
  const [when, ago, subject] = last.stdout.trim().split(SEP);
  return { ...w, changed, ahead, behind, when: Number(when) || 0, ago: ago ?? "", subject: subject ?? "" };
}

const removable = (w) => !w.main && !w.locked && !w.bare && w.changed.length === 0 && w.ahead === 0;

function Pill({ color, children, title }) {
  return h("span", { title, style: { fontSize: 10.5, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--color-line)", color, whiteSpace: "nowrap" } }, children);
}

function Worktrees({ tile, hm, host }) {
  const [base, setBase] = useState(hm.settings.base || "main");
  const [trees, setTrees] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useTileState(hm, "filter", "all");
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const [mode, setMode] = useTileState(hm, "mode", "changes");
  const [patch, setPatch] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => hm.on("settings", (s) => setBase(s.base || "main")), [hm]);
  useEffect(() => { const t = setInterval(refresh, 60_000); return () => clearInterval(t); }, [refresh]);

  useEffect(() => {
    let live = true;
    (async () => {
      const list = await host.run("git", ["worktree", "list", "--porcelain"]);
      if (list.code !== 0) throw new Error(list.stderr.trim() || "git worktree list failed");
      const read = await each(parseList(list.stdout), (w) => inspect(host, w, base));
      read.sort((a, b) => Number(b.main) - Number(a.main) || b.when - a.when);
      if (live) { setTrees(read); setError(null); }
    })().catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [host, base, tick]);

  // Paths are named from the folder holding the main worktree; one elsewhere keeps its whole path.
  const home = useMemo(() => {
    const main = trees?.find((w) => w.main)?.path ?? "";
    return main.slice(0, main.lastIndexOf("/") + 1);
  }, [trees]);
  const named = (p) => (home && p.startsWith(home) ? p.slice(home.length) : p);
  const counts = useMemo(() => ({
    all: trees?.length ?? 0,
    changed: trees?.filter((w) => w.changed.length).length ?? 0,
    merged: trees?.filter(removable).length ?? 0,
  }), [trees]);
  const shown = (trees ?? []).filter((w) => filter === "all" || (filter === "changed" ? w.changed.length > 0 : removable(w)));
  const tree = trees?.find((w) => w.path === chosen) ?? null;

  const treeState = tree ? `${tree.head}:${tree.changed.length}` : "";
  useEffect(() => {
    if (!tree) return;
    let live = true;
    setPatch(null);
    const args = mode === "changes" ? ["-C", tree.path, "diff", "HEAD"] : ["-C", tree.path, "diff", `${base}...HEAD`];
    host.run("git", args).then((r) => { if (live) setPatch(r.code === 0 ? r.stdout : ""); }, () => { if (live) setPatch(""); });
    return () => { live = false; };
  }, [host, chosen, mode, base, treeState]);

  const choose = (path) => setChosen(path);
  // An agent asks what is here (`hive ctl plugin call dip497/worktrees list`).
  useEffect(() => hm.onCommand("list", () => {
    if (!trees) throw new Error("the worktrees are still being read");
    return trees.map((w) => ({
      path: w.path, branch: w.branch, main: w.main, uncommitted: w.changed.length,
      ahead: w.ahead, behind: w.behind, merged: removable(w), lastCommit: w.subject, when: w.ago,
    }));
  }), [hm, trees]);
  const review = () => hm.commands.spawnAgent(null, tile.frameId, {
    name: `Review ${tree.branch ?? named(tree.path)}`,
    prompt: `Review the branch ${tree.branch ?? tree.head} in the worktree ${tree.path} against ${base}: read \`git -C ${tree.path} diff ${base}...HEAD\`${tree.changed.length ? ` and its uncommitted changes (\`git -C ${tree.path} diff HEAD\`)` : ""}. Report bugs, risks and missing tests, most serious first, with file:line references. Do not change any file.`,
  });
  const remove = async (w) => {
    setConfirm(null);
    const r = await host.run("git", ["worktree", "remove", w.path]);
    if (r.code !== 0) { toast.error("Could not remove the worktree", { description: r.stderr.trim() }); return; }
    if (w.branch) {
      const b = await host.run("git", ["branch", "-d", w.branch]);
      if (b.code !== 0) toast.warning(`Removed the worktree; kept the branch ${w.branch}`, { description: b.stderr.trim() });
      else toast.success(`Removed ${named(w.path)} and its branch ${w.branch}`);
    } else toast.success(`Removed ${named(w.path)}`);
    if (chosen === w.path) setChosen(null);
    refresh();
  };

  if (error && !trees) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16 } }, error);
  const tab = (id, label) => h(Button, { key: id, size: "2xs", variant: filter === id ? "secondary" : "ghost", "aria-pressed": filter === id, onClick: () => setFilter(id) }, `${label} ${counts[id]}`);
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(300px, 38%) 1fr", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--color-line)" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--color-line)" } },
        tab("all", "All"), tab("changed", "Uncommitted"), tab("merged", "Merged"),
        h("span", { style: { flex: 1 } }),
        h(Button, { size: "2xs", variant: "ghost", onClick: refresh }, "Refresh")),
      h("div", { style: { overflow: "auto", minHeight: 0 } },
        trees === null ? h(Loading, { label: "Reading the worktrees" })
          : shown.length === 0 ? h("p", { style: { ...muted, padding: 12 } }, "None.")
            : shown.map((w) => h("button", {
              key: w.path, onClick: () => choose(w.path), "data-worktree": named(w.path), "aria-current": w.path === chosen || undefined,
              style: {
                display: "block", width: "100%", textAlign: "left", padding: "7px 12px", border: 0, cursor: "pointer", color: "var(--color-fg)",
                borderBottom: "1px solid var(--color-line)", background: w.path === chosen ? "var(--color-bg3)" : "transparent",
              },
            },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" } }, w.branch ?? "(detached)"),
              w.main && h(Pill, { color: "var(--color-fg3)" }, "main worktree"),
              w.path === host.repoPath && h(Pill, { color: "var(--color-info)" }, "this frame"),
              w.changed.length > 0 && h(Pill, { color: "var(--color-warn)", title: "files changed and not committed" }, `${w.changed.length} uncommitted`),
              w.ahead > 0 && h(Pill, { color: "var(--color-fg)", title: `commits not in ${base}` }, `↑${w.ahead}`),
              w.behind > 0 && h(Pill, { color: "var(--color-fg3)", title: `commits in ${base} it does not have` }, `↓${w.behind}`),
              removable(w) && h(Pill, { color: "var(--color-ok)", title: `nothing here that ${base} does not have` }, "merged"),
              w.prunable && h(Pill, { color: "var(--color-err)" }, "folder missing")),
            h("div", { style: { ...muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              `${named(w.path)}${w.ago ? ` · ${w.ago} · ${w.subject}` : ""}`))))),
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      !tree ? h("p", { style: { ...muted, padding: 16 } }, "Choose a worktree.") : [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" } }, tree.branch ?? tree.head.slice(0, 10)),
            h("div", { style: { ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, tree.path)),
          hm.capabilities.includes("workspace:spawn") && h(Button, { size: "xs", variant: "outline", onClick: review }, "Ask an agent to review"),
          h(Button, { size: "xs", variant: "ghost", onClick: () => navigator.clipboard.writeText(tree.path).then(() => toast.success("Copied the path")) }, "Copy path"),
          removable(tree) && h(Button, { size: "xs", variant: "ghost-destructive", onClick: () => setConfirm(tree) }, "Remove")),
        h("div", { key: "modes", style: { display: "flex", gap: 4, padding: "6px 12px", borderBottom: "1px solid var(--color-line)" } },
          h(Button, { size: "2xs", variant: mode === "changes" ? "secondary" : "ghost", "aria-pressed": mode === "changes", onClick: () => setMode("changes") }, `Uncommitted ${tree.changed.length}`),
          h(Button, { size: "2xs", variant: mode === "branch" ? "secondary" : "ghost", "aria-pressed": mode === "branch", onClick: () => setMode("branch") }, `Branch vs ${base}${tree.ahead ? ` ↑${tree.ahead}` : ""}`),
          mode === "changes" && tree.changed.some((l) => l.startsWith("??")) && h("span", { style: { ...muted, alignSelf: "center", marginLeft: 8 } },
            `New, not shown: ${tree.changed.filter((l) => l.startsWith("??")).map((l) => l.slice(3)).join(", ")}`)),
        h("div", { key: "diff", style: { flex: 1, minHeight: 0, overflow: "auto" } },
          patch === null ? h(Loading, { label: "Loading the diff" }) : h(PatchView, { patch })),
      ]),
    confirm && h(Dialog, { open: true, onOpenChange: (o) => { if (!o) setConfirm(null); } },
      h(DialogContent, null,
        h(DialogTitle, null, `Remove ${named(confirm.path)}?`),
        h(DialogDescription, null, `Its folder is deleted${confirm.branch ? ` and its branch ${confirm.branch} too` : ""}. It has nothing uncommitted and nothing ${base} does not have.`),
        h(DialogFooter, null,
          h(Button, { variant: "ghost", onClick: () => setConfirm(null) }, "Keep it"),
          h(Button, { variant: "destructive", onClick: () => remove(confirm) }, "Remove")))));
}

export default { tiles: { worktrees: Worktrees } };
