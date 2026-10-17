// The repository's TODO notes, found by `git grep` in the tile's folder (host.run), so ignored
// files stay out. A note opens in the editor beside the tile (host.openFile); "Hand to an agent"
// starts one with a prompt you read first (hm.commands.spawnAgent). Its markers are a setting.
import React, { useCallback, useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const words = (pattern) => pattern.split("|").map((w) => w.trim()).filter((w) => /^[A-Za-z0-9_-]+$/.test(w));

function parse(out, markers) {
  const marker = new RegExp(`\\b(${markers.join("|")})\\b`);
  const notes = [];
  for (const line of out.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const found = marker.exec(m[3]);
    if (found) notes.push({ file: m[1], line: Number(m[2]), marker: found[1], text: m[3].trim().slice(0, 200) });
  }
  return notes;
}

function Todos({ tile, hm, host }) {
  const [pattern, setPattern] = useState(hm.settings.pattern ?? "TODO|FIXME|HACK|XXX");
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState(null);
  const [only, setOnly] = useTileState(hm, "only", null);
  useEffect(() => hm.on("settings", (s) => setPattern(s.pattern ?? "TODO|FIXME|HACK|XXX")), [hm]);
  const markers = useMemo(() => words(pattern), [pattern]);
  const scan = useCallback(() => {
    if (!markers.length) { setNotes([]); return; }
    setError(null);
    host.run("git", ["grep", "-n", "-I", "-w", "-E", markers.join("|")], { maxAgeMs: 5_000 }).then((r) => {
      // git grep ends 1 when nothing matched.
      if (r.code > 1) setError(r.stderr.trim() || "git grep failed");
      else setNotes(parse(r.stdout, markers));
    }, (e) => setError(e.message));
  }, [host, markers]);
  useEffect(scan, [scan]);
  const shown = (notes ?? []).filter((n) => !only || n.marker === only);
  const byFile = useMemo(() => {
    const m = new Map();
    for (const n of shown) m.set(n.file, [...(m.get(n.file) ?? []), n]);
    return [...m];
  }, [shown]);
  const counts = useMemo(() => Object.fromEntries(markers.map((k) => [k, (notes ?? []).filter((n) => n.marker === k).length])), [markers, notes]);
  const hand = (n) => hm.commands.spawnAgent(null, tile.frameId, {
    name: `${n.marker} in ${n.file.split("/").pop()}`,
    prompt: `In ${n.file}, line ${n.line}, there is this note: "${n.text}". Do what it asks, or explain why it should stay.`,
  });
  if (error) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16 } }, error);
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
      h(Button, { size: "xs", variant: only === null ? "secondary" : "ghost", onClick: () => setOnly(null) }, `All ${notes?.length ?? ""}`),
      ...markers.map((k) => h(Button, { key: k, size: "xs", variant: only === k ? "secondary" : "ghost", onClick: () => setOnly(k), "data-marker": k }, `${k} ${counts[k] ?? 0}`)),
      h("span", { style: { flex: 1 } }),
      h(Button, { size: "xs", variant: "ghost", onClick: scan }, "Scan again")),
    h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 0" } },
      notes === null ? h(Loading, { label: "Looking for notes" })
        : !byFile.length ? h("p", { style: { ...muted, padding: 12 } }, "Nothing to do.")
        : byFile.map(([file, list]) => h("section", { key: file, style: { padding: "6px 12px" } },
          h("div", { style: { ...muted, fontFamily: "var(--font-mono)" } }, file),
          list.map((n) => h("div", { key: `${n.line}`, style: { display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }, "data-note": `${file}:${n.line}` },
            h("button", {
              onClick: () => host.openFile(file), title: "Open in the editor",
              style: { flex: 1, minWidth: 0, textAlign: "left", border: 0, background: "transparent", color: "var(--color-fg)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
            }, h("span", { style: muted }, `${n.line}  `), n.text),
            hm.capabilities.includes("workspace:spawn") && h(Button, { size: "xs", variant: "ghost", onClick: () => hand(n) }, "Hand to an agent")))))));
}

export default { tiles: { "todo-finder": Todos } };
