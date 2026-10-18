// Follows a log file by running `tail -n` every 2 seconds through host.run, colours each line by its
// level (a level word, or a JSON logger's level field), and filters by text or /regex/ and level.
// "Ask an agent about these errors" starts one with the last error lines, in a prompt you read first.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { LEVELS, countLevels, makeFilter, messageOf, readLines } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
const COLOR = { error: "var(--color-err)", warn: "var(--color-warn)", info: "var(--color-select)", debug: "var(--color-fg3)" };
const WORD = { error: "Errors", warn: "Warnings", info: "Info", debug: "Debug" };
const POLL_MS = 2_000;

async function tail(host, file, lines) {
  const r = await host.run("tail", ["-n", String(lines), "--", file]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `tail ended ${r.code}`);
  return r.stdout;
}

function LogTail({ tile, hm, host }) {
  const [opts, setOpts] = useState({ file: hm.settings.file ?? "app.log", lines: hm.settings.lines ?? 500 });
  const [chosen, setChosen] = useTileState(hm, "file", null);
  const [filter, setFilter] = useTileState(hm, "filter", "");
  const [hidden, setHidden] = useTileState(hm, "hidden", []);
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const box = useRef(null);
  const atEnd = useRef(true);
  useEffect(() => hm.on("settings", (s) => setOpts({ file: s.file ?? "app.log", lines: s.lines ?? 500 })), [hm]);
  const file = chosen || opts.file;

  const read = useCallback(() => tail(host, file, opts.lines).then((t) => { setText(t); setError(null); }, (e) => setError(e.message)), [host, file, opts.lines]);
  useEffect(() => {
    setText(null);
    read();
  }, [read]);
  useEffect(() => {
    if (paused) return;
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [read, paused]);

  const lines = useMemo(() => readLines(text ?? ""), [text]);
  const counts = useMemo(() => countLevels(lines), [lines]);
  const test = useMemo(() => makeFilter(filter), [filter]);
  const shown = useMemo(() => lines.filter((l) => !(l.level && hidden.includes(l.level)) && test.test(l.text)), [lines, hidden, test]);
  const errors = lines.filter((l) => l.level === "error");

  // Stay at the newest line unless the person scrolled up to read.
  useLayoutEffect(() => {
    const b = box.current;
    if (b && atEnd.current) b.scrollTop = b.scrollHeight;
  }, [shown]);

  useEffect(() => hm.onCommand("errors", async () => {
    const all = readLines(await tail(host, file, opts.lines));
    return { file, errors: all.filter((l) => l.level === "error").slice(-50).map((l) => l.text) };
  }), [hm, host, file, opts.lines]);
  useEffect(() => hm.onCommand("tail", async (args) => {
    const n = Math.min(Math.max(Number(args?.lines) || 100, 1), 5000);
    const f = makeFilter(args?.filter);
    if (f.error) throw new Error(`the filter is not a regular expression: ${f.error}`);
    const all = readLines(await tail(host, file, n)).filter((l) => f.test(l.text));
    return { file, lines: all.map((l) => ({ level: l.level, text: l.text })) };
  }), [hm, host, file]);

  const canAsk = hm.capabilities.includes("workspace:spawn");
  const ask = () => {
    const last = errors.slice(-20).map((l) => l.text).join("\n");
    hm.commands.spawnAgent(null, tile.frameId, {
      name: `Errors in ${file.split("/").pop()}`,
      prompt: `These are the latest error lines from ${file}:\n\n${last}\n\nFind what causes them in this repository, say whether they are one problem or several, and propose a fix for each. Do not change anything until I agree.`,
    });
  };
  const toggle = (l) => setHidden(hidden.includes(l) ? hidden.filter((x) => x !== l) : [...hidden, l]);
  const field = { ...mono, fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--color-line)", background: "var(--color-bg)", color: "var(--color-fg)" };

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
      h("span", { title: paused ? "paused" : "following", style: { width: 8, height: 8, borderRadius: 4, flex: "none", background: paused || error ? "var(--color-fg3)" : "var(--color-ok)", boxShadow: paused || error ? "none" : "0 0 0 3px color-mix(in srgb, var(--color-ok) 25%, transparent)" } }),
      h("input", {
        value: draft ?? file, onChange: (e) => setDraft(e.target.value), "aria-label": "Log file", spellCheck: false,
        onKeyDown: (e) => { if (e.key === "Enter") { setChosen(draft?.trim() || null); setDraft(null); } if (e.key === "Escape") setDraft(null); },
        onBlur: () => { if (draft !== null) { setChosen(draft.trim() || null); setDraft(null); } },
        style: { ...field, width: 220 },
      }),
      h("input", {
        value: filter, onChange: (e) => setFilter(e.target.value), placeholder: "Filter: text or /regex/", "aria-label": "Filter", spellCheck: false,
        style: { ...field, flex: 1, minWidth: 120, borderColor: test.error ? "var(--color-err)" : "var(--color-line)" }, title: test.error ?? "",
      }),
      h(Button, { size: "xs", variant: paused ? "default" : "outline", onClick: () => setPaused(!paused) }, paused ? "Resume" : "Pause")),
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid var(--color-line)" } },
      LEVELS.map((l) => h("button", {
        key: l, onClick: () => toggle(l), "aria-pressed": !hidden.includes(l), "data-level": l,
        style: {
          display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 9px", borderRadius: 999, cursor: "pointer", fontSize: 11.5,
          border: "1px solid var(--color-line)", color: "var(--color-fg)", background: hidden.includes(l) ? "transparent" : "var(--color-bg3)", opacity: hidden.includes(l) ? 0.5 : 1,
        },
      }, h("span", { style: { width: 8, height: 8, borderRadius: 4, background: COLOR[l] } }), WORD[l], h("b", { style: { fontWeight: 600 } }, counts[l]))),
      h("span", { style: { ...muted, marginLeft: 6 } }, text === null ? "" : `${shown.length} of ${lines.length} lines${paused ? " · paused" : ""}`),
      h("span", { style: { flex: 1 } }),
      canAsk && errors.length > 0 && h(Button, { size: "xs", variant: "outline", onClick: ask }, "Ask an agent about these errors")),
    h("div", {
      ref: box, "data-log": true, onScroll: (e) => { const b = e.currentTarget; atEnd.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24; },
      style: { flex: 1, minHeight: 0, overflow: "auto", ...mono, fontSize: 11.5, lineHeight: 1.55, padding: "4px 0" },
    },
    error && text === null ? h("div", { role: "alert", style: { padding: 16, fontFamily: "inherit" } },
      h("div", { style: { color: "var(--color-err)" } }, error),
      h("div", { style: { ...muted, marginTop: 4 } }, "Type another file above (from the repository's top, or a full path) and press Enter."))
      : text === null ? h(Loading, { label: `Reading ${file}` })
        : !lines.length ? h("p", { style: { ...muted, padding: 16 } }, `${file} is empty. New lines show here as they are written.`)
          : shown.map((l) => h("div", {
            key: l.n, "data-level": l.level ?? "",
            style: {
              display: "flex", gap: 8, padding: "0 12px", whiteSpace: "pre-wrap", wordBreak: "break-word",
              background: l.level === "error" ? "color-mix(in srgb, var(--color-err) 8%, transparent)" : "transparent",
              color: l.level === "debug" ? "var(--color-fg3)" : "var(--color-fg)",
            },
          },
          h("span", { style: { width: 3, flex: "none", borderRadius: 2, background: l.level ? COLOR[l.level] : "transparent" } }),
          h("span", { style: { flex: 1, minWidth: 0, color: l.level === "error" ? "var(--color-err)" : l.level === "warn" ? "var(--color-warn)" : undefined } }, messageOf(l.text))))));
}

export default { tiles: { "log-tail": LogTail } };
