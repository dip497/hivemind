// The repository's commits. `git log` and `git show` run in the tile's folder (host.run); a diff
// is drawn by the app's own diff view (PatchView). "Ask an agent" starts one in this tile's frame
// with a prompt you read before it is sent (hm.commands.spawnAgent, permissions workspace:spawn
// and workspace:prompt).
import React, { useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { Button, PatchView, Loading, useTileState } from "hm-plugin://host/sdk.js";

const h = React.createElement;
const SEP = "\u001f";
const muted = { color: "var(--color-fg3)", fontSize: 11 };

function parse(out) {
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, short, author, when, subject] = line.split(SEP);
    return { hash, short, author, when, subject };
  });
}

function History({ tile, hm, host }) {
  const [count, setCount] = useState(hm.settings.count ?? 300);
  const [commits, setCommits] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useTileState(hm, "query", "");
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const [patch, setPatch] = useState(null);
  useEffect(() => hm.on("settings", (s) => setCount(s.count ?? 300)), [hm]);
  useEffect(() => {
    host.run("git", ["log", `-n${count}`, `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%ar${SEP}%s`], { maxAgeMs: 10_000 }).then(
      (r) => (r.code === 0 ? setCommits(parse(r.stdout)) : setError(r.stderr.trim() || "git log failed")),
      (e) => setError(e.message));
  }, [host, count]);
  useEffect(() => {
    if (!chosen) return;
    setPatch(null);
    host.run("git", ["show", "--format=", "--patch", chosen], { maxAgeMs: 300_000 }).then((r) => setPatch(r.code === 0 ? r.stdout : ""), () => setPatch(""));
  }, [host, chosen]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (commits ?? []).filter((c) => !q || `${c.subject} ${c.author} ${c.short}`.toLowerCase().includes(q));
  }, [commits, query]);
  const choose = (hash) => setChosen(hash);
  const commit = commits?.find((c) => c.hash === chosen);
  const explain = () => hm.commands.spawnAgent(null, tile.frameId, {
    name: `Explain ${commit.short}`,
    prompt: `Explain commit ${commit.hash} ("${commit.subject}") in this repository: what it changes and why. Read it with \`git show ${commit.hash}\`.`,
  });
  if (error) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16 } }, error);
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(260px, 34%) 1fr", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--color-line)" } },
      h("input", {
        value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search commits", "aria-label": "Search commits",
        style: { margin: 8, padding: "6px 8px", background: "var(--color-bg)", color: "var(--color-fg)", border: "1px solid var(--color-line)", borderRadius: 6 },
      }),
      h("div", { style: { overflow: "auto", minHeight: 0 } },
        commits === null ? h(Loading, { label: "Loading the commits" })
          : shown.map((c) => h("button", {
            key: c.hash, onClick: () => choose(c.hash), "data-commit": c.short,
            style: {
              display: "block", width: "100%", textAlign: "left", padding: "6px 12px", border: 0, cursor: "pointer", color: "var(--color-fg)",
              background: c.hash === chosen ? "var(--color-bg3)" : "transparent", borderBottom: "1px solid var(--color-line)",
            },
          }, h("div", { style: { fontSize: 12 } }, c.subject), h("div", { style: muted }, `${c.short} · ${c.author} · ${c.when}`))))),
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      commit
        ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
          h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 13, fontWeight: 600 } }, commit.subject), h("div", { style: muted }, `${commit.short} · ${commit.author} · ${commit.when}`)),
          hm.capabilities.includes("workspace:spawn") && h(Button, { size: "sm", variant: "outline", onClick: explain }, "Ask an agent to explain"))
        : h("p", { style: { ...muted, padding: 16 } }, "Choose a commit."),
      h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
        chosen && (patch === null ? h(Loading, { label: "Loading the diff" }) : h(PatchView, { patch })))));
}

export default { tiles: { "git-history": History } };
