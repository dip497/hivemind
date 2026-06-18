# HCP Code Quality Review

**Scope:** `apps/desktop/src/main/hcp/*.ts`, `packages/hive-mcp/src/index.ts`, `packages/hive-mcp/src/hcp-client.ts`, `apps/cli/src/commands/ctl.ts`, `apps/desktop/src/renderer/src/canvas-pipe-edge.tsx`
**Tests:** `apps/desktop/tests/unit/hcp.test.ts`, `plan-review.test.ts`, `plan-blocks.test.ts` — **163/163 pass** (`pnpm --filter @hivemind/desktop test:unit`, 4.9s)
**Verdict:** Strong. Small, single-purpose modules; excellent header comments; clean transport/dispatch split. Findings below are polish, not structural. No blocking issues.

---

## High-value cleanups

### 1. Duplicated HCP client — two near-identical socket clients
`packages/hive-mcp/src/hcp-client.ts:18-53` (`hcpCall`) and `apps/cli/src/commands/ctl.ts:32-60` (`call`) are the same code: connect to socket → write one `req` → buffer-parse NDJSON → skip `hello` → match `id` → resolve/reject, same timeout/settled guards, same three error strings. They have drifted slightly already (ctl's `timer` is not `.unref()`'d; hcp-client's is — `hcp-client.ts:33` vs `ctl.ts:43`), which is exactly the bug class duplication breeds.

**Fix:** extract one `hcpRequest(sock, token, method, params, timeoutMs)` into a shared module (e.g. `packages/hive-mcp/src/hcp-client.ts` already exists — export from there and have the CLI import it, or lift to a tiny `@hivemind/hcp-wire` package). The only real difference is where `sock`/`token` come from; pass them in.

### 2. `timeout_ms` does not reach the wire client → long reads cut off at 130s
`hive_read` / `ctl read` forward `timeout_ms` to the **server method** (`methods.ts:92`, `DEFAULT_READ_TIMEOUT = 120_000`) but the **client** call uses its own fixed default: `hcpCall(..., 130_000)` (`hcp-client.ts:18`) and `call(..., 130_000)` (`ctl.ts:32`). So a caller passing `timeout_ms: 300000` gets the server waiting 300s while the client gives up and rejects at 130s.
- `index.ts:566` — `hcpCall("agent.read", { tileId, timeoutMs })` never passes a client timeout.
- `ctl.ts:93` — same.

**Fix:** when a read timeout is requested, pass `timeoutMs + slack` as the client timeout too (the `review.open` path already does this correctly at `index.ts:581`). Otherwise document the 130s ceiling on the tool description.

### 3. Dead code
- `hcpAvailable()` — `hcp-client.ts:14`, exported, **zero callers** (grep-confirmed). Delete, or wire it into the "app not running" error path it was clearly meant for.
- `"DEPTH_EXCEEDED"` — `protocol.ts:49`, declared in `HcpErrorCode`, **never thrown** anywhere. Either remove from the union or implement the depth guard the pipes comment hints at (`pipes.ts:6` "Cycles are the caller's responsibility").
- `frame` spawn param — `methods.ts:64` forwards `frame: p.frame`, but no caller (MCP `SpawnAgentArgs` at `index.ts:401`, CLI `spawn` at `ctl.ts:76`) ever sends it; only `callerTile` is used. Vestigial — drop it or expose it.

---

## Type safety

### 4. Untyped params at the dispatch boundary
`methods.ts:57` casts `rawParams as Record<string, unknown>` then hand-coerces every field: `String(p.tileId ?? "")`, `p.submit !== false`, `typeof p.timeoutMs === "number" ? …`. The MCP layer (`index.ts`) already has zod schemas (`SendArgs`, `ReadArgs`, …) but the CLI and the hook path hit `dispatch` with no validation, so the coercion is load-bearing yet ad hoc.

**Fix (optional):** define one zod (or hand-written) param schema per method and parse at the top of each `case`. Removes the scattered `String(... ?? "")` and gives uniform `BAD_REQUEST` messages. At minimum, factor the repeated `const tileId = String(p.tileId ?? ""); if (!tileId) throw …` (appears at `methods.ts:75-77, 90-91, 109, 113, 130-132, 138`) into a `reqTileId(p)` helper.

### 5. `Promise<unknown>` / `any` leak through the client
`hcpCall` returns `Promise<unknown>` (`hcp-client.ts:18`) and every MCP call site wraps it in `jsonResult(...)` with no result typing — fine for passthrough, but `hive_read`'s `{ text, finalStatus, truncated }` shape (`methods.ts:98,102`) is never expressed as a type. The test `rpc` helper is `Promise<any>` (`hcp.test.ts:130`). Low priority; a shared `HcpResult<M>` map would document the surface.

### 6. Inline param cast in the server
`hcp-server.ts:105` — `String((msg.params as { tileId?: string })?.tileId ?? "")`. `HcpSub.params` is `unknown` (`protocol.ts:27`). Acceptable, but the same `{ tileId?: string }` shape is re-cast here and in `methods.ts`; a named `type TileParams = { tileId?: string }` in `protocol.ts` would centralize it.

---

## Duplication (NDJSON line-reader)

### 7. The `while ((nl = buf.indexOf("\n")) >= 0)` loop is copy-pasted 4×
`hcp-client.ts:39`, `ctl.ts:49`, `ctl.ts:131` (stream), `hcp.test.ts:138`. `protocol.ts` already owns the canonical splitter `takeLines()` (`protocol.ts:66`) — but it lives in the desktop package, so the MCP/CLI clients can't import it. Same shared-package fix as #1 lets all four reuse one framing helper. The hand-rolled loops also silently `continue` on JSON parse errors (`hcp-client.ts:42`, `ctl.ts:52`), unlike the server which surfaces `BAD_REQUEST` — fine for a client but worth one consistent helper.

---

## Minor / nits

- **`methods.ts:80-85`** — the comment block ("press Enter as a SEPARATE keystroke a tick later") sits above the immediate `writeToTile(text)` call but actually explains the `setTimeout(... "\r" ...)` two lines down. Move it adjacent to the `setTimeout`.
- **`methods.ts:133`** — `connect()` returning false is always reported as `"cannot pipe a tile to itself"`, but `PipeManager.connect` also returns false for empty src/dst (`pipes.ts:15`). The empty case is already guarded at `methods.ts:132`, so the message is correct today — but it's coupled to that guard staying in place. Consider returning a reason from `connect()` instead of a bare boolean.
- **`hcp-server.ts:78`** — bad-JSON reply uses a literal `id: "?"`. Harmless (client can't match it), but a client correlating strictly by id will never settle that frame; it relies on the eventual socket close. Fine given the conn is independent per request, just noting.
- **`output-recorder.ts:34`** — `cur.slice(cur.length - CAP)` rebuilds the whole string on every `record()` once over CAP; for a chatty agent this is O(n) per chunk. A real ring (array of chunks + running length) would avoid the re-slice, but at 256KiB CAP it's not hurting anything yet.
- **`hcp-client.ts:19-20`** — reads `HCP_TOKEN` but the "app not running" guard only checks `HIVE_HCP_SOCK` (`hcp-client.ts:21`). A present sock + missing token yields a server-side `UNAUTHORIZED` rather than the friendlier local message. Edge case.
- **`canvas-pipe-edge.tsx`** — clean. Math is the documented react-flow floating-edges formula; `a = 1/(… || 1)` and the `w===0||h===0` early-out (`:19`) both guard div-by-zero. No action.

---

## Test coverage

Good for the core: `hcp.test.ts` covers `takeLines`, transcript parse (incl. missing file), `TurnTracker` (resolve/immediate/timeout), `OutputRecorder` (ANSI strip + delta), `PipeManager` (self-loop + bidirectional forget), dispatch (`agent.send` two-keystroke timing, `agent.read` happy path, rate-limit), and a real server round-trip (token gate + hook event + stream broadcast with wrong-tile filtering). `plan-review.test.ts` round-trips the generated hook end-to-end including fail-open. Solid.

**Gaps worth a test each:**
1. **`agent.read` timeout fallback** (`methods.ts:100-102`) — the `finalStatus:"timeout", truncated:true` path that returns buffered recorder output is never exercised. This is the failure mode users hit most (agent crash / non-claude agent with no Stop hook); test that a read with no recorded turn returns the recorder delta and `truncated:true`.
2. **`tile.close` cleanup** (`methods.ts:115-116`) — assert it calls `turns.forget` + `recorder.forget` (no leak after close).
3. **Backpressure drop** (`hcp-server.ts:148`) — `isBackedUp()` true path (seq still increments, chunk skipped → client sees a seq gap) is untested. The happy broadcast path is covered; the drop path is the whole point of the mechanism.
4. **`tile.connect` self-loop → BAD_REQUEST** at the dispatch layer (`methods.ts:133`) — `PipeManager` is unit-tested for it, the verb is not.
5. **Client timeout** — a test pinning the #2 mismatch (read with `timeout_ms` > client default) would lock the fix.

---

## Summary

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 1 | Duplicated socket client (already drifting) | Med | `hcp-client.ts:18-53`, `ctl.ts:32-60` |
| 2 | `timeout_ms` not propagated to client → 130s ceiling | Med | `hcp-client.ts:18`, `ctl.ts:32`, `index.ts:566` |
| 3 | Dead code: `hcpAvailable`, `DEPTH_EXCEEDED`, `frame` | Low | `hcp-client.ts:14`, `protocol.ts:49`, `methods.ts:64` |
| 4 | Ad-hoc param coercion at dispatch boundary | Low | `methods.ts:57,75-138` |
| 5 | `unknown`/`any` result types through client | Low | `hcp-client.ts:18`, `hcp.test.ts:130` |
| 7 | NDJSON reader copy-pasted 4× | Low | `hcp-client.ts:39`, `ctl.ts:49,131` |
| — | Test gaps: read-timeout, close-cleanup, backpressure drop | Med | see above |

Overall craft is above bar: small modules, precise comments explaining *why* (the two-keystroke TUI quirk, the seq-gap backpressure, the 0600 socket gating), and a transport/dispatch separation that reads well. Prioritize #1 and #2 (shared client + timeout propagation) plus the read-timeout and backpressure tests; the rest is housekeeping.
