// Finding HTTP endpoints in `git grep` output and reading a response. No imports: the tests load it as it is.

const VERBS = "get|post|put|patch|delete|head|options";

/** What `git grep -n -E` looks for: lines that may declare a route, read closely by `endpointsIn`. */
export const GREP_PATTERN = [
  `@[A-Za-z_][A-Za-z0-9_.]*\\.(${VERBS}|route|api_route|websocket)\\(`,
  `\\.(${VERBS}|all)\\([[:space:]]*['"\`]/`,
  `HandleFunc\\([[:space:]]*"`,
  `\\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\\([[:space:]]*"/`,
  `\\.route\\([[:space:]]*"/`,
].join("|");

const CLIENTS = /^(axios|client|http|https|request|cy|agent|ky|got|superagent|supertest|fetcher|\$|\$http)$/i;

const methodsList =(s) => (s.match(/['"]([A-Za-z]+)['"]/g) ?? []).map((m) => m.slice(1, -1).toUpperCase());

/** The endpoints one source line declares: `{ method, path }`. */
export function endpointsOn(code) {
  const found = [];
  let m;
  // Python: @app.get("/x"), @router.post('/x'), @app.route("/x", methods=["POST"])
  if ((m = new RegExp(`@[A-Za-z_][\\w.]*\\.(${VERBS}|api_route|route|websocket)\\(\\s*[rf]?['"]([^'"]*)['"](.*)$`).exec(code))) {
    const [, kind, path, rest] = m;
    if (kind === "route" || kind === "api_route") {
      const methods = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(rest);
      for (const method of methods ? methodsList(methods[1]) : ["GET"]) found.push({ method, path });
    } else found.push({ method: kind === "websocket" ? "WS" : kind.toUpperCase(), path });
    return found;
  }
  // Go: http.HandleFunc("GET /x", h) or HandleFunc("/x", h)
  if ((m = /HandleFunc\(\s*"(?:([A-Z]+)\s+)?([^"]+)"/.exec(code))) return [{ method: m[1] ?? "ANY", path: m[2] }];
  // Rust axum: .route("/x", get(a).post(b))
  if ((m = /\.route\(\s*"(\/[^"]*)"\s*,(.*)$/.exec(code))) {
    const verbs = [...m[2].matchAll(new RegExp(`(?:^|[\\s.:(])(${VERBS}|any)\\(`, "g"))].map((v) => v[1].toUpperCase());
    for (const method of verbs.length ? [...new Set(verbs)] : ["ANY"]) found.push({ method, path: m[1] });
    return found;
  }
  // Go gin / echo / chi: r.GET("/x", h), e.Post("/x", h)
  if ((m = /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/.exec(code))) return [{ method: m[1].toUpperCase(), path: m[2] }];
  // JavaScript: app.get('/x', …), router.post("/x"), fastify.delete(`/x`)
  for (const j of code.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.(${VERBS}|all)\\(\\s*(['"\`])(\\/[^'"\`]*)\\3`, "g"))) {
    // These call an endpoint rather than declare one.
    if (CLIENTS.test(j[1])) continue;
    found.push({ method: j[2] === "all" ? "ANY" : j[2].toUpperCase(), path: j[4] });
  }
  return found;
}

/** Every endpoint in `git grep -n` output, with its file and line, in path order. */
export function endpointsIn(grep) {
  const list = [];
  for (const line of grep.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    // Only code declares routes: tests, docs and comments only name them.
    if (!/\.(py|[cm]?js|jsx|tsx?|go|rs)$/.test(m[1])) continue;
    if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$/.test(m[1])) continue;
    if (/^\s*(\/\/|#(?!\[)|\*)/.test(m[3])) continue;
    for (const e of endpointsOn(m[3])) list.push({ ...e, file: m[1], line: Number(m[2]) });
  }
  const order = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const rank = (x) => (order.includes(x) ? order.indexOf(x) : order.length);
  return list.sort((a, b) => a.path.localeCompare(b.path) || rank(a.method) - rank(b.method));
}

/** Endpoints by path, each path once with its methods. */
export function groupByPath(list) {
  const groups = new Map();
  for (const e of list) groups.set(e.path, [...(groups.get(e.path) ?? []), e]);
  return [...groups].map(([path, endpoints]) => ({ path, endpoints }));
}

/** The base address and a path joined with one slash between. */
export const joinUrl = (base, path) => `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;

/**
 * A response as printed with `-i`: status, headers and body. An interim answer (100 Continue)
 * comes before the real one and is skipped.
 */
export function parseResponse(raw) {
  let rest = raw;
  for (;;) {
    const end = rest.search(/\r?\n\r?\n/);
    if (!/^HTTP\/[\d.]+ \d{3}/.test(rest) || end < 0) {
      if (/^HTTP\/[\d.]+ \d{3}/.test(rest)) return head(rest, "");
      return { status: null, statusText: "", headers: [], body: rest };
    }
    const block = rest.slice(0, end);
    const after = rest.slice(end).replace(/^\r?\n\r?\n/, "");
    const code = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(block)[1]);
    if (code >= 100 && code < 200 && /^HTTP\/[\d.]+ \d{3}/.test(after)) { rest = after; continue; }
    return head(block, after);
  }
}

function head(block, body) {
  const [first, ...lines] = block.split(/\r?\n/);
  const m = /^HTTP\/[\d.]+ (\d{3})\s*(.*)$/.exec(first);
  return {
    status: Number(m[1]), statusText: m[2].trim(),
    headers: lines.map((l) => { const i = l.indexOf(":"); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean),
    body,
  };
}

/** A JSON body laid out to read; anything else as it came. */
export function prettyBody(body) {
  const t = body.trim();
  if (!/^[[{]/.test(t)) return body;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return body; }
}
