# HCP Fix Verification

**Role:** fix-verification reviewer. **Input plan:** `docs/reviews/hcp-fix-plan.md`. **Method:** each P0 checked against the *current* tree with file:line evidence; unit suite run.

**Verdict:** 5 of 6 listed P0 items PASS. **P0-2 FAILS** (forwarding still no-ops at the write step). One plan-promoted P0 (**P0-7 cycle detection**) is NOT addressed. Unit tests: **165 pass**.

---

## Per-P0 results

### P0-1 · Centralized id seam — **PASS**
- `apps/desktop/src/shared/tile-id.ts` exists; exports `HM_PREFIX`, `toPtyId` (`:18`), `toBareId` (`:21`), both idempotent.
- `apps/desktop/src/main/hcp/methods.ts:16` — `import { toPtyId as ptyId, toBareId as bareOf } from "../../shared/tile-id.js"`. No local string-surgery left; all conversions go through `ptyId(...)` / `bareOf(...)` (`:62,74,88,105,116,122,131,153`).
- `apps/desktop/src/main/index.ts:77` — `import { toBareId } from "../shared/tile-id.js"`; used at `:915,:939,:1190`.
- **Incomplete vs plan (non-blocking):** the planned `isAddressable(tile)` helper was NOT added to `tile-id.ts` (no guard for non-persistent `${tileId}-${reactId}` tiles). `useSpawn.ts:334` and `pty-daemon.ts` legacy-key paths were outside this task's check scope — not re-verified.

### P0-2 · Pipe forwarding — **FAIL (incomplete)**
- `index.ts:1190` — `const dests = hcpPipes.dests(toBareId(d.tileId));` ✓ (lookup key now correctly bare; matches the bare ids `tile.connect` stores).
- `index.ts:1188` — `recordTurn(d.tileId, safeTp)` with `d.tileId` already `hm:` ✓.
- **Bug — write target never converted to pty id.** `index.ts:1196-1198`:
  ```ts
  for (const dst of dests) {
    hcpWriteToTile(dst, reply);                       // dst is BARE
    setTimeout(() => hcpWriteToTile(dst, "\r"), 90);
  }
  ```
  `dests` returns **bare** ids (`pipes.ts` stores the driver's bare `src`/`dst`; `methods.ts:166-171` `tile.connect` passes raw driver ids straight through). `hcpWriteToTile(tileId)` keys on the **pty** namespace: `hasSession`/`writePty` do `ptys.has(tileId)` (`pty-host.ts:77-82`) / `specs.has(tileId)` (`daemon-client.ts:251-255`), and persistent agent ptys are keyed `hm:<bare>`. So `hasSession(bare)` is `false`, `hcpWriteToTile` returns `false`, and the forward **silently no-ops** (return value is ignored).
- The plan's own P0-2 snippet had this right: `const pid = toPtyId(dst); hcpWriteToTile(pid, reply)`. The applied code dropped the `toPtyId(dst)` conversion.
- Contrast `agent.send`, which is correct: `methods.ts:105` `deps.writeToTile(ptyId(tileId), text)`.
- **Net effect:** the `dests`/`safeTp` half of the forwarding fix landed, but pipe forwarding is **still 100% non-functional** because the reply is written to a key no pty owns. The fix must wrap both writes in `toPtyId(dst)`.

### P0-3 · Dead-tile sends fail loud — **PASS**
- `hasSession` exported: `pty-host.ts:77` and `daemon-client.ts:251`; imported in `index.ts:45`.
- `index.ts:892-896` — `hcpWriteToTile` returns `true` only if `hasRemotePty` or `hasSession`, else `return false;` for an unknown tile.
- `methods.ts:105-106` — `const ok = deps.writeToTile(ptyId(tileId), text); if (!ok) throw new HcpError("TILE_NOT_FOUND", …)`. The throw is now live (was dead code).

### P0-4 · Spawn-depth gate — **PASS (core); partial vs plan**
- `methods.ts:20` `const MAX_SPAWN_DEPTH = 3;`, `:59` `const depthOf = new Map<string, number>();`.
- `methods.ts:74-78` — `const callerDepth = p.callerTile ? (depthOf.get(bareOf(String(p.callerTile))) ?? 0) : 0; const childDepth = callerDepth + 1; if (childDepth > MAX_SPAWN_DEPTH) throw new HcpError("DEPTH_EXCEEDED", …)`. Enforced from main-side bookkeeping via `depthOf` (not the wire), as the plan's second-pass correction required.
- `methods.ts:89` records `depthOf.set(res.tileId, childDepth)`; key namespace is consistent (bookkeeping bare-keyed, lookups `bareOf(...)`).
- **Incomplete vs plan (non-blocking):** plan also asked for a **per-parent spawn quota** and a **max-concurrent-agents population cap** — neither implemented; only the global per-minute `spawnAllowed()` rate gate remains alongside the depth gate. `MAX_SPAWN_DEPTH=3` vs plan's suggested ~5 — acceptable, behavior correct.

### P0-5 · `timeout_ms` to the wire client — **PASS**
- `packages/hive-mcp/src/index.ts:579-580` — `const readMs = a.timeout_ms ?? 120_000; return jsonResult(await hcpCall("agent.read", { tileId: a.tileId, timeoutMs: readMs }, readMs + 15_000));`. Client ceiling sits above the server read timeout; long reads no longer die at the client's 130s default (`hcp-client.ts:18`).

### P0-6 · Forged-event constraint — **PASS (transcript); P0-6b token NOT done**
- `index.ts:1186-1188` — `const tp = d.transcriptPath; const safeTp = tp && tp.startsWith(path.join(os.homedir(), ".claude") + path.sep) && tp.endsWith(".jsonl") ? tp : null; hcpTurns.recordTurn(d.tileId, safeTp);`. A forged `turn` event cannot make `agent.read` return an arbitrary user-readable file: a path outside `~/.claude/**.jsonl` becomes `null` → recorder fallback (`:1191-1192` gate on `safeTp`).
- **Not addressed (plan P0-6b):** token write failure is still swallowed — `token.ts:23-25` `catch { /* read-only fs — token still works in-memory */ }`. The cross-process mismatch (main mints B, daemon injects A → silent `UNAUTHORIZED`) is unfixed and the misleading comment remains. No loud log / "HCP disabled" surface.

---

## P0 NOT addressed (beyond the 6 listed)

- **P0-7 · Connect-time cycle detection** (plan second-pass §3, *promoted to P0*): `pipes.ts:6-8` still documents "Cycles are the caller's responsibility"; `connect()` (`:13-19`) refuses only self-loops (`src === dst`). An `A→B→A` ping-pong pump is still one `hive_connect` away. Latent today only because P0-2's write step is broken — it becomes a live money-pump the moment P0-2 is actually fixed. Fix P0-7 in the same change as P0-2.

---

## Regressions

- None observed in the test suite (165/165 pass). The P0-2 defect is an *incomplete* fix, not a regression of prior behavior — pipe forwarding was non-functional before and remains non-functional.

---

## Test run

`pnpm --filter @hivemind/desktop test:unit` → `# tests 165 / # pass 165 / # fail 0`. Matches the expected 165.

---

## Remaining P1 / P2 (none applied — orchestrator scope was P0 only)

**P1:** P1-1 turn-read settle window · P1-2 per-request epoch + spawn-epoch TOCTOU · P1-3 tail-read transcript + honest fallback label · P1-4 pipe/state lifecycle (forget-on-close, prune epochs, persist graph — `PipeManager.forget` still has no caller) · P1-5 pipe cost controls (forward-rate cap, cycle break, budget, actor attribution) · P1-6 single `SUBMIT_DELAY_MS` constant (90ms still hard-coded ×4: `methods.ts:107,123`, `index.ts:1198`, +renderer) · P1-7 verify `agent` allowlist · P1-8 contract smoke test + instrument fail-open paths.

**P2:** P2-1 dedupe socket client + NDJSON reader · P2-2 remove dead code (`hcpAvailable` `hcp-client.ts:14` still exported, zero callers) · P2-3 dispatch-boundary type safety · P2-4 unify the two socket servers (plan-bridge + hcp-server) · P2-5 build-stamp respawn race · P2-6 remote-frame HCP limitation doc · P2-7 low-severity (review.open restart hole, plan-review fail-open UI, spawn-slot-before-spawn, output-recorder rebuild).

---

## Required follow-up before "P0 complete" stands

1. **P0-2:** wrap both pipe writes in `toPtyId(dst)` — `index.ts:1196-1198`. Without it forwarding is dead.
2. **P0-7:** refuse cycles at `tile.connect` (`pipes.ts`/`methods.ts` connect case) — cheap, caps the worst case before P0-2 makes forwarding live.
3. **P0-6b:** make token-write failure loud (or mint per-run in memory) — `token.ts:23-25`.

VERIFY DONE
