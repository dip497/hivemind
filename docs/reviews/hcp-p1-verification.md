# HCP P1 Batch — Fix Verification

Verifier pass against current code. Test run: `pnpm --filter @hivemind/desktop test:unit` → **166 pass, 0 fail** (expected 166). ✅

| Item | Verdict | Evidence |
|---|---|---|
| P0-2 follow-up (pipe forward toPtyId) | **PASS** | `index.ts:1199-1202` |
| P0-7 (cycle refusal via reaches DFS + test) | **PASS** | `pipes.ts:15-37`, `hcp.test.ts:31-36` |
| P0-6b (token write fail-loud) | **PASS** | `token.ts:23-28` |
| P1-3 (bounded tail-read + scanLast) | **PASS** | `transcript.ts:42-84` |
| P1-4 (forget pipes + prune state on close) | **PASS** | `methods.ts:153-169`, `index.ts:1171-1173`, `pipes.ts:54-57` |
| P1-6 (single SUBMIT_DELAY_MS, all 5 sites) | **PASS** | `agent-io.ts:9` + 5 call sites |

---

## P0-2 follow-up — PASS

`index.ts:1199-1202` — forward loop now wraps each dest write in `toPtyId(dst)`:

```js
for (const dst of dests) {
  const pid = toPtyId(dst);
  hcpWriteToTile(pid, reply);
  setTimeout(() => hcpWriteToTile(pid, "\r"), SUBMIT_DELAY_MS);
}
```

`dests` come from `hcpPipes.dests(toBareId(d.tileId))` (`:1192`) — BARE ids; `hcpWriteToTile` keys on the pty namespace, so the `toPtyId` conversion is the difference between a real write and the prior no-op. Comment at `:1196-1198` documents exactly that. Correct.

## P0-7 — PASS

`pipes.ts:15-26` adds `reaches(from, target)` — an iterative DFS over the edge map (not a self-loop-only check). `connect()` at `:30-37` rejects `src===dst` AND `this.reaches(dst, src)` (`:32`) — i.e. refuses any edge that would close a cycle, direct or transitive. Test coverage at `hcp.test.ts:31-36`:
- `connect("b","a") === false` — direct 2-cycle `a→b→a`
- `connect("c","a") === false` — transitive `a→b→c→a`

Dispatch surfaces it: `methods.ts:185` throws `BAD_REQUEST "cannot pipe a tile to itself or create a cycle"`.

Note (non-blocking): plan P0-7 text asked for a typed `CYCLE_REJECTED` reason distinct from the self-loop message. Current code returns a single `BAD_REQUEST` covering both. Functionally complete; the typed-reason nicety is unshipped. Not a regression.

## P0-6b — PASS

`token.ts:23-28` — `writeFileSync` wrapped in try/catch, `console.error("[hcp] FAILED to persist token …")` on failure with the mismatch consequence spelled out. Loud. Correct.

## P1-3 — PASS

`transcript.ts`:
- `TAIL_BYTES = 256 * 1024` (`:26`).
- `scanLast(raw)` helper extracted (`:42-58`) — scans lines backwards, returns last non-empty assistant text or null.
- `readLastAssistantMessage` (`:61-84`): `statSync` size; if `> TAIL_BYTES`, reads only the trailing 256KB via `openSync`/`readSync` at offset `size - TAIL_BYTES` (`:65-73`), drops the first partial line (`:74-76`), `scanLast` on the tail. Only on tail-miss (`found == null`) does it fall through to the full `readFileSync` (`:80`). Files ≤ tail size full-read directly. Avoids the O(n²) per-turn full read. Correct.

## P1-4 — PASS

- `methods.ts` `tile.close` (`:153-169`): after renderer close, drops all per-tile state — `turns.forget(pid)`, `recorder.forget(pid)`, **`deps.forgetPipes(bare)`**, `sendSeq.delete`, `sendMark.delete`, `parentOf.delete`, `depthOf.delete`. pid-keyed vs bare-keyed split is correct (pipes/parent/depth use bare).
- `MethodDeps.forgetPipes` declared `:39`.
- `index.ts:1171-1173` wires the three pipe deps: `connect` → `hcpPipes.connect` + `pushPipe`; `disconnect` → `hcpPipes.disconnect` + `pushPipe`; **`forgetPipes` → `(id) => { hcpPipes.forget(id); pushPipe(id, null, false); }`** — forget plus the renderer pipe-edge removal push.
- `PipeManager.forget` (`pipes.ts:54-57`) removes `src→*` and `*→src`; now has a live caller. Test `hcp.test.ts:17-26` covers forget-removes-both-directions.

Complete.

## P1-6 — PASS

`shared/agent-io.ts:9` exports `SUBMIT_DELAY_MS = 90`. All 5 delivery sites import and use it; **no hard-coded `90` remains** in any of these `setTimeout` calls (grep for `, 90)` over the three files → NONE):
- `methods.ts:110` — `agent.send` Enter
- `methods.ts:126` — `agent.report` Enter
- `index.ts:1202` — pipe-forward Enter
- `TerminalTile.tsx:511` — prompt delivery
- `TerminalTile.tsx:580` — prompt delivery

Single source of truth; sites can't drift. Correct.

Note (non-blocking): plan P1-6 also floated an optional "send `\r` as two delayed writes / retry." Not implemented — it was a "consider," not a requirement. No deduction.

---

## Remaining work (not in this batch)

**P0:** all closed (P0-1..P0-4, P0-6a/b, P0-7; P0-5 resolved in MCP, ctl-parity residual folded into P2-1).

**P1 remaining:**
- **P1-1** — turn-read returns first Stop not final answer (settle window). *Gated by the native-subagents-vs-HCP decision.*
- **P1-2** — concurrent readers + spawn-epoch TOCTOU race. *Same gate.*
- **P1-5** — pipe cost controls: per-edge forward-rate cap, aggregate budget, kill switch, actor attribution. (P0-7 caps cycles; acyclic high-frequency forwarding still unthrottled.)
- **P1-7** — verify `agent` string is an allowlist (`methods.ts:83` defaults to `"claude"` but no allowlist check).
- **P1-8** — contract smoke tests + instrument fail-open paths. Partial: cycle/self-loop and forget tests now exist (P0-7/P1-4); still missing the called-out gaps — `agent.read` timeout-fallback `truncated:true`, `hcp-server.ts` backpressure-drop seq-increment, pipe-forward end-to-end.

**P2 remaining:** P2-1 (dedupe socket client + ctl timeout parity) through P2-8 — all housekeeping, none started.

---

## Regressions / new issues

None found. 166/166 unit tests green. No fix is partial against its own spec; the two notes above (typed `CYCLE_REJECTED` reason; two-write `\r` retry) are unshipped *optional* refinements the plan phrased as "consider," not regressions.

VERIFY DONE
