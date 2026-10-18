// The HTTP endpoints the code declares, found by `git grep` (host.run) for the common Python,
// JavaScript, Go and Rust frameworks, grouped by path. "Try it" sends a request to the base address
// (a setting) through `curl` and shows the status, headers and body. A file opens with host.openFile.
import React, { useCallback, useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { GREP_PATTERN, endpointsIn, groupByPath, joinUrl, parseResponse, prettyBody } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
const METHOD_COLOR = { GET: "var(--color-ok)", POST: "var(--color-select)", PUT: "var(--color-warn)", PATCH: "var(--color-warn)", DELETE: "var(--color-err)" };
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function Method({ method, active, onClick }) {
  const c = METHOD_COLOR[method] ?? "var(--color-fg3)";
  return h(onClick ? "button" : "span", {
    onClick, "data-method": method,
    style: {
      ...mono, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, minWidth: 46, textAlign: "center", flex: "none",
      color: active ? "var(--color-bg)" : c, background: active ? c : `color-mix(in srgb, ${c} 15%, transparent)`, border: 0, cursor: onClick ? "pointer" : "default",
    },
  }, method);
}

async function send(host, base, method, path, body) {
  const url = joinUrl(base, path);
  const args = ["-s", "-S", "-i", "-X", method, "--max-time", "10"];
  const withBody = typeof body === "string" && body.trim() !== "";
  if (withBody) args.push("-H", "Content-Type: application/json", "--data-binary", "@-");
  const began = Date.now();
  const r = await host.run("curl", [...args, url], withBody ? { stdin: body } : {});
  const ms = Date.now() - began;
  if (r.code !== 0) {
    const why = r.code === 7 ? `Nothing answered at ${base}. Is the server running?` : r.code === 28 ? "No answer within 10 seconds." : r.stderr.trim() || `curl ended ${r.code}`;
    throw new Error(why);
  }
  return { url, ms, ...parseResponse(r.stdout) };
}

function statusColor(s) {
  return s >= 500 ? "var(--color-err)" : s >= 400 ? "var(--color-warn)" : s >= 300 ? "var(--color-select)" : "var(--color-ok)";
}

function Explorer({ hm, host }) {
  const [base, setBase] = useState(hm.settings.baseUrl ?? "http://127.0.0.1:8000");
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useTileState(hm, "search", "");
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [answer, setAnswer] = useState(null);
  const [sending, setSending] = useState(false);
  const [showHeaders, setShowHeaders] = useTileState(hm, "headers", false);
  useEffect(() => hm.on("settings", (s) => setBase(s.baseUrl ?? "http://127.0.0.1:8000")), [hm]);

  const scan = useCallback(() => host.run("git", ["grep", "-n", "-I", "-E", GREP_PATTERN], { maxAgeMs: 10_000 }).then((r) => {
    // git grep ends 1 when nothing matched.
    if (r.code > 1) throw new Error(r.stderr.trim() || "git grep failed");
    const found = endpointsIn(r.stdout);
    setList(found);
    return found;
  }).catch((e) => { setError(e.message); throw e; }), [host]);
  useEffect(() => { scan().catch(() => {}); }, [scan]);

  const choose = (e) => {
    setChosen({ method: e.method, path: e.path });
    setMethod(METHODS.includes(e.method) ? e.method : "GET");
    setPath(e.path);
    setAnswer(null);
  };
  useEffect(() => { if (chosen) { setMethod(METHODS.includes(chosen.method) ? chosen.method : "GET"); setPath(chosen.path); } }, []);

  const go = () => {
    setSending(true);
    send(host, base, method, path, WITH_BODY.has(method) ? body : "")
      .then((a) => setAnswer(a), (e) => setAnswer({ error: e.message }))
      .finally(() => setSending(false));
  };

  useEffect(() => hm.onCommand("endpoints", async () => (list ?? await scan()).map(({ method, path, file, line }) => ({ method, path, file, line }))), [hm, list, scan]);
  useEffect(() => hm.onCommand("request", async (args) => {
    const m = String(args?.method ?? "GET").toUpperCase();
    if (!/^[A-Z]{3,7}$/.test(m)) throw new Error("method is GET, POST, PUT, PATCH, DELETE …");
    if (typeof args?.path !== "string") throw new Error('pass { "method": "GET", "path": "/items/1" }');
    const b = args.body === undefined ? "" : typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    const a = await send(host, base, m, args.path, b);
    return { url: a.url, status: a.status, ms: a.ms, headers: Object.fromEntries(a.headers), body: a.body.slice(0, 100_000) };
  }), [hm, host, base]);

  const q = search.trim().toLowerCase();
  const groups = useMemo(() => groupByPath((list ?? []).filter((e) => !q || `${e.method} ${e.path} ${e.file}`.toLowerCase().includes(q))), [list, q]);

  if (error && !list) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16 } }, error);
  if (!list) return h(Loading, { label: "Looking for endpoints" });
  const field = { ...mono, fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--color-line)", background: "var(--color-bg)", color: "var(--color-fg)" };
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(300px, 42%) 1fr", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--color-line)" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
        h("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search paths, methods, files", "aria-label": "Search", spellCheck: false, style: { ...field, flex: 1 } }),
        h(Button, { size: "xs", variant: "ghost", onClick: () => scan().catch(() => {}) }, "Scan again")),
      h("div", { style: { ...muted, padding: "6px 12px", borderBottom: "1px solid var(--color-line)" } },
        `${list.length} endpoint${list.length === 1 ? "" : "s"} on ${groupByPath(list).length} path${groupByPath(list).length === 1 ? "" : "s"} in ${new Set(list.map((e) => e.file)).size} files`),
      h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
        !list.length ? h("p", { style: { ...muted, padding: 14 } }, "No endpoints found. It reads FastAPI and Flask decorators, Express, Hono and Fastify routes, Go's HandleFunc, gin and echo, and axum's .route.")
          : !groups.length ? h("p", { style: { ...muted, padding: 14 } }, "Nothing matches.")
          : groups.map((g) => h("div", { key: g.path, "data-path": g.path, style: { padding: "7px 12px", borderBottom: "1px solid var(--color-line)" } },
            h("div", { style: { ...mono, fontSize: 12.5, fontWeight: 600, marginBottom: 3 } }, g.path),
            g.endpoints.map((e) => h("div", { key: `${e.method}${e.file}${e.line}`, style: { display: "flex", alignItems: "center", gap: 8, padding: "1px 0" } },
              h(Method, { method: e.method, active: chosen?.method === e.method && chosen?.path === e.path, onClick: () => choose(e) }),
              h("button", {
                onClick: () => host.openFile(e.file), title: "Open in the editor",
                style: { ...mono, ...muted, border: 0, padding: 0, background: "transparent", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              }, `${e.file}:${e.line}`))))))),
    h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      h("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--color-line)", display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("span", { style: { fontSize: 13, fontWeight: 600, flex: 1 } }, "Try it"),
          METHODS.map((m) => h(Method, { key: m, method: m, active: m === method, onClick: () => setMethod(m) }))),
        h("div", { style: { display: "flex", gap: 6 } },
          h("span", { style: { ...field, color: "var(--color-fg3)", borderRight: 0, borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: -6, whiteSpace: "nowrap" } }, base.replace(/\/+$/, "")),
          h("input", {
            value: path, onChange: (e) => setPath(e.target.value), "aria-label": "Path", spellCheck: false,
            onKeyDown: (e) => { if (e.key === "Enter") go(); },
            style: { ...field, flex: 1, minWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
          }),
          h(Button, { size: "xs", variant: "default", disabled: sending, onClick: go }, sending ? "Sending…" : "Send")),
        WITH_BODY.has(method) && h("textarea", {
          value: body, onChange: (e) => setBody(e.target.value), rows: 4, spellCheck: false, placeholder: '{ "name": "…" }   (sent as JSON)', "aria-label": "Body",
          style: { ...field, resize: "vertical" },
        })),
      h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
        !answer ? h("p", { style: { ...muted, padding: 14 } }, sending ? "" : `Choose an endpoint, or write a path, and send it to ${base}.`)
          : answer.error ? h("div", { role: "alert", style: { padding: 14, color: "var(--color-err)", fontSize: 12.5 } }, answer.error)
          : h("div", { "data-response": answer.status },
            h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--color-line)" } },
              h("span", { style: { ...mono, fontWeight: 700, fontSize: 12, padding: "1px 8px", borderRadius: 4, color: "var(--color-bg)", background: statusColor(answer.status) } }, `${answer.status} ${answer.statusText}`),
              h("span", { style: muted }, `${answer.ms} ms · ${answer.body.length.toLocaleString()} bytes`),
              h("span", { style: { flex: 1 } }),
              h(Button, { size: "2xs", variant: "ghost", onClick: () => setShowHeaders(!showHeaders) }, `${showHeaders ? "Hide" : "Show"} ${answer.headers.length} headers`)),
            showHeaders && h("div", { style: { padding: "6px 12px", borderBottom: "1px solid var(--color-line)", display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", ...mono, fontSize: 11 } },
              answer.headers.flatMap(([k, v], i) => [h("span", { key: `k${i}`, style: { color: "var(--color-fg3)" } }, k), h("span", { key: `v${i}`, style: { wordBreak: "break-all" } }, v)])),
            h("pre", { style: { ...mono, margin: 0, padding: 12, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, prettyBody(answer.body) || h("span", { style: muted }, "(no body)"))))));
}

export default { tiles: { "api-explorer": Explorer } };
