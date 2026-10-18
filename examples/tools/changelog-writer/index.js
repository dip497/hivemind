// The commits since the last tag (`git describe`, `git log` through host.run), grouped by their
// conventional-commit type into a Markdown changelog draft, shown beside the grouped list. Copy it,
// or ask an agent to write it into CHANGELOG.md (a prompt you read before it is sent).
import React, { useCallback, useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { Button, Loading, Markdown, useTileState } from "hm-plugin://host/sdk.js";
import { toast } from "hm-plugin://host/ui.js";
import { LOG_FORMAT, SECTIONS, groupCommits, parseLog, renderMarkdown } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
const COLOR = {
  breaking: "var(--color-err)", added: "var(--color-ok)", fixed: "var(--color-select)", performance: "var(--color-warn)",
  changed: "var(--color-fg)", documentation: "var(--color-fg3)", other: "var(--color-fg3)",
};

async function readDraft(host, count) {
  const tag = await host.run("git", ["describe", "--tags", "--abbrev=0"], { maxAgeMs: 5_000 });
  const since = tag.code === 0 ? tag.stdout.trim() : null;
  const range = since ? [`${since}..HEAD`] : ["-n", String(count)];
  const log = await host.run("git", ["log", "--no-merges", `--format=${LOG_FORMAT}`, ...range], { maxAgeMs: 5_000 });
  if (log.code !== 0) throw new Error(log.stderr.trim() || "git log failed");
  const commits = parseLog(log.stdout);
  return { since, count: commits.length, groups: groupCommits(commits) };
}

function Changelog({ tile, hm, host }) {
  const [opts, setOpts] = useState({ count: hm.settings.count ?? 50, hashes: hm.settings.hashes ?? true });
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useTileState(hm, "tab", "preview");
  useEffect(() => hm.on("settings", (s) => setOpts({ count: s.count ?? 50, hashes: s.hashes ?? true })), [hm]);

  const load = useCallback(() => {
    setError(null);
    return readDraft(host, opts.count).then((d) => { setDraft(d); return d; }, (e) => { setError(e.message); throw e; });
  }, [host, opts.count]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const markdown = useMemo(() => draft ? renderMarkdown(draft.groups, { since: draft.since, hashes: opts.hashes }) : "", [draft, opts.hashes]);
  useEffect(() => hm.onCommand("draft", async () => {
    const d = await load();
    const md = renderMarkdown(d.groups, { since: d.since, hashes: opts.hashes });
    return {
      since: d.since, commits: d.count, markdown: md,
      groups: Object.fromEntries(SECTIONS.filter((s) => d.groups[s.key].length).map((s) => [s.title, d.groups[s.key].map((c) => ({ hash: c.hash, type: c.type, scope: c.scope, text: c.text }))])),
    };
  }), [hm, load, opts.hashes]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown); toast.success("Copied the draft"); }
    catch { toast("Could not reach the clipboard: switch to Markdown and copy it from there"); setTab("source"); }
  };
  const canAsk = hm.capabilities.includes("workspace:spawn");
  const ask = () => hm.commands.spawnAgent(null, tile.frameId, {
    name: "Write the changelog",
    prompt: `Here is a draft changelog for the commits ${draft.since ? `since ${draft.since}` : `(the last ${draft.count})`}, grouped by conventional-commit type:\n\n${markdown}\nWrite it into CHANGELOG.md under the Unreleased section (create the file or the section if missing), in the style the file already uses: merge with entries already there, drop internal-only lines, and word each entry for the people who use the project. Show me the result before committing.`,
  });

  if (error && !draft) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16, fontSize: 13 } }, error);
  if (!draft) return h(Loading, { label: "Reading the commits" });
  const present = SECTIONS.filter((s) => draft.groups[s.key].length);
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--color-line)" } },
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: 13, fontWeight: 600 } }, draft.since ? h(React.Fragment, null, "Since ", h("span", { style: mono }, draft.since)) : `The last ${draft.count} commits`),
        h("div", { style: muted }, `${draft.count} commit${draft.count === 1 ? "" : "s"}${draft.since ? "" : " (no tag yet)"} · ${present.map((s) => `${draft.groups[s.key].length} ${s.title.toLowerCase()}`).join(" · ") || "nothing to list"}`)),
      h(Button, { size: "xs", variant: "ghost", onClick: () => load().catch(() => {}) }, "Read again"),
      h(Button, { size: "xs", variant: "outline", onClick: copy }, "Copy"),
      canAsk && h(Button, { size: "xs", variant: "default", onClick: ask }, "Ask an agent to write it into CHANGELOG.md")),
    h("div", { style: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(300px, 46%) 1fr" } },
      h("div", { style: { overflow: "auto", borderRight: "1px solid var(--color-line)", padding: "4px 0" } },
        !present.length ? h("p", { style: { ...muted, padding: 14 } }, "No commits since the last tag.")
          : present.map((s) => h("section", { key: s.key, "data-section": s.key, style: { padding: "8px 14px" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--color-fg3)", marginBottom: 4 } },
              h("span", { style: { width: 8, height: 8, borderRadius: 4, background: COLOR[s.key] } }), s.title,
              h("span", { style: { fontWeight: 400 } }, draft.groups[s.key].length)),
            draft.groups[s.key].map((c) => h("div", { key: c.hash, style: { display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", fontSize: 12 } },
              h("span", { style: { ...mono, ...muted, flex: "none" } }, c.hash),
              c.scope && h("span", { style: { ...mono, fontSize: 10.5, padding: "0 6px", borderRadius: 4, background: "var(--color-bg3)", flex: "none" } }, c.scope),
              h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: c.subject }, c.text)))))),
      h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
        h("div", { style: { display: "flex", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--color-line)" } },
          h(Button, { size: "2xs", variant: tab === "preview" ? "secondary" : "ghost", onClick: () => setTab("preview") }, "Preview"),
          h(Button, { size: "2xs", variant: tab === "source" ? "secondary" : "ghost", onClick: () => setTab("source") }, "Markdown")),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "10px 16px" } },
          tab === "source"
            ? h("pre", { "data-markdown": true, style: { ...mono, margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", userSelect: "text" } }, markdown)
            : h(Markdown, { text: markdown })))));
}

export default { tiles: { "changelog-writer": Changelog } };
