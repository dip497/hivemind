# HCP Consolidated Fix Plan

**Author:** fix architect. **Inputs:** the five reviews in `docs/reviews/` (`hcp-reviewer.md`, `hcp-architect.md`, `hcp-code-quality.md`, `hcp-maintainer.md`, `hcp-devils-advocate.md`).
**Method:** merged overlapping findings into clusters, ranked each by severity × likelihood × blast-radius, verified every claim against the *current* tree (not the review snapshot), and ordered the work so earlier fixes remove churn from later ones.

Priorities: **P0** = blocks calling HCP correct/secure; **P1** = bites within a couple of releases; **P2** = housekeeping.

> **Second-pass (ultrathink) corrections to this plan.** A deeper verification pass against the tree changed four things — read these before the body:
> 1. **P0-5 (timeout_ms) is largely already fixed** — `hive_read` honors `timeout_ms` correctly at `packages/hive-mcp/src/index.ts:575-581` (client ceiling = `readMs + 15_000`). The reviewers cited a pre-fix snapshot. Only the `ctl` CLI path may still lag → demoted to P2. Lesson: every "open" claim here was re-verified against current code; the ones below survived that pass.
> 2. **P0-4 depth gate must be enforced from main-side bookkeeping, not the wire/env.** Only `callerTile` crosses the wire (`index.ts:569`); the caller's `HIVE_AGENT_DEPTH` is never forwarded, and even if it were, the fork-bomb adversary is the child reporting its own depth. Enforce via the existing `parentOf` chain (`methods.ts:54`). Detail folded into P0-4.
> 3. **Connect-time cycle detection promoted to P0** (new P0-7) — an `A→B→A` pipe cycle is an unbounded real-money pump and is one `hive_connect` away; refusing cycles at connect (like self-loops already are) is cheap and caps the worst case. Rate-cap/budget stays P1.
> 4. **A scope decision (native subagents vs HCP) gates how much P1 turn-hardening is worth** — see the Decision Gate below. This is the devil's-advocate §5 point and it is the highest-leverage item in the whole review set.

---

## 0. Already addressed in current code (do NOT redo)

Verified present in the tree as of this plan:

| Finding (review) | Status | Evidence |
|---|---|---|
| `agent.send`/`agent.read` main-verb id mapping | **Fixed** | `methods.ts:48` `ptyId()` used consistently for send/read/recordTurn; tracker + recorder both `hm:`-keyed; epochs aligned (`methods.ts:56-60,117-119`) |
| Prompt auto-submit (newline dropped by TUI) | **Fixed** | separate `\r` keystroke 90 ms later at `methods.ts:93`, `methods.ts:109`, `index.ts:1193` |
| Frame routing for spawned children | **Fixed** | `useSpawn.ts:334` strips `hm:` before `frameOf` lookup |
| Centralized id seam | **Built, NOT adopted** | `shared/tile-id.ts` exports `toPtyId`/`toBareId` (`:18`,`:21`) — but `methods.ts:48-49`, `index.ts:892`, `useSpawn.ts:334` still hand-roll the mapping |
| `agent.report` parent mailbox | **New, present** | `methods.ts:97-111`, `parentOf` map |
| `hive_read` `timeout_ms` → client ceiling (reviewer M1 / CQ #2) | **Fixed (MCP path)** | `packages/hive-mcp/src/index.ts:575-581` passes `readMs + 15_000`; only `ctl.ts` CLI parity remains (P2) |

> **Discrepancy flagged:** the hand-off claimed "pipe-forward bareTileId" was fixed. **It is not.** The `bareTileId` helper exists (`index.ts:892`) but was never applied at the forwarding site (`index.ts:1185`/`:1192`). H1 below is live.

---

## Decision Gate — resolve before investing in P1 turn-hardening

The devil's-advocate §5 is the single highest-leverage finding and it is **not a bug, it is a scope question**: for the *claude-orchestrating-claude* case, HCP reimplements — fragile-ly — what Claude Code's native subagents (`Task`) give for free (deterministic completion, structured return, one-level depth enforced by the runtime, no pty injection, no transcript scrape, no id namespaces). The expensive, bug-prone stack that P1-1 / P1-2 / P1-3 / P1-5 / P0-4 all exist to harden is precisely the turn-detection + keystroke-injection + transcript-scrape machinery.

HCP's *genuine, irreducible* value is narrow but real: **(a)** a human-visible canvas where the operator watches agents work, and **(b)** driving *heterogeneous* binaries (codex, opencode, …) the Claude SDK can't host in-process. The product premise of hivemind (watch agents on a canvas) defends (a) — invisible in-process subagents don't serve that UX. So HCP is not redundant; but the claim that it should carry *every* orchestration case is what inflates the P1 cost.

**Decision to make (owner: maintainer):** does `hive_spawn_agent` always create a visible canvas tile (HCP is right, build all of P1), or should the claude→claude *invisible-worker* case prefer native subagents and reserve the pty/socket path for heterogeneous binaries + explicitly-visible tiles (then P1-1/P1-2/P1-3 shrink to the narrow case)?

- This decision **does not gate any P0 item** — every P0 below is correctness/security that must be true regardless of the answer.
- It **does gate P1-1/P1-2/P1-3 scope.** If the invisible-worker case moves to native, those become "good enough for the heterogeneous/visible case" rather than "must be bulletproof for all orchestration." Answer it before sinking weeks into a settle-window/epoch/transcript-fidelity stack that a function call would obviate for the common path.

---

## P0 — fix first

### P0-1 · Adopt the `tile-id.ts` seam everywhere (FOUNDATION — do before any verb fix)
- **Files:** `apps/desktop/src/main/hcp/methods.ts:48-49` (local `ptyId`/`bareOf`), `apps/desktop/src/main/index.ts:892` (`bareTileId`), `apps/desktop/src/renderer/src/useSpawn.ts:334` (inline `.slice(3)`), `apps/desktop/src/main/pty-daemon.ts:144-149` (legacy key handling).
- **Root cause:** the bare↔`hm:` rule is reimplemented in 4+ places even though `shared/tile-id.ts` already centralizes it; values cross the namespace boundary unconverted. (Merges: reviewer H1 key-space map, architect §1 leak, maintainer P1.4, devil 2.2.)
- **Fix:** delete every local copy; import `toPtyId`/`toBareId` from `shared/tile-id.ts`. Add `isAddressable(tile)` there too (returns false for non-persistent `${tileId}-${reactId}` tiles that HCP cannot key).
- **Stronger option (devil 2.2):** make `PtyId`/`BareId` *branded* string types (`type PtyId = string & { readonly __pty: unique symbol }`) so `toPtyId`/`toBareId` are the only way to cross, and the compiler — not a future reviewer — catches a bare id passed where a pty id is required. Centralized converters stop the *recurrence*; branded types stop the *class*. Worth it given this is the bug family that produced H1, the frame-routing bug, and the `[Unreleased]` "addresses the right tile" fix.
- **Why first:** P0-2, P0-3, P1-1, P1-5 all rewrite the exact lines that do id conversion. Centralizing now means each later fix is a one-line call, not another bespoke `slice`/concat. This is the user's named "centralize the bare-vs-`hm:` mapping before touching the verbs" step.

### P0-2 · Fix pipe forwarding (reviewer H1) — depends on P0-1
- **File:** `apps/desktop/src/main/index.ts:1185` and write loop `:1191-1193`.
- **Root cause:** `hcpPipes.dests(d.tileId)` looks up the **pty** id (`d.tileId` = `HIVEMIND_TILE` = `hm:<bare>`) against a **bare**-keyed map (`tile.connect` stores the driver's bare ids), so `dests` is always `[]`; even if it weren't, the write target `dst` is bare and `writePty(bare)` no-ops. Forwarding never fires.
- **Fix:**
  ```ts
  const dests = hcpPipes.dests(toBareId(d.tileId));
  if (dests.length === 0 || !d.transcriptPath) return;
  const reply = readLastAssistantMessage(d.transcriptPath);
  if (!reply) return;
  for (const dst of dests) {
    const pid = toPtyId(dst);
    hcpWriteToTile(pid, reply);
    setTimeout(() => hcpWriteToTile(pid, "\r"), SUBMIT_DELAY_MS);
  }
  ```
  (`recordTurn(d.tileId, …)` at `:1183` stays as-is — tracker is `hm:`-keyed and `d.tileId` is already `hm:`.)
- **Blast:** the pipes/connect feature is 100% non-functional today; high severity, certain likelihood.
- **Proof it's live (not a judgment call):** line `:1183` calls `recordTurn(d.tileId, …)` and line `:1185` calls `dests(d.tileId)` with the *same* `d.tileId`. `recordTurn` requires it `hm:`-keyed (and demonstrably works — `agent.read` resolves), while `dests` requires it bare-keyed. One value cannot satisfy both. So forwarding is provably broken regardless of what `HIVEMIND_TILE` contains — no namespace assumption needed.

### P0-3 · Make dead-tile sends fail loud (reviewer H2 + maintainer P1.4) — depends on P0-1
- **Files:** `index.ts:894-898` (`hcpWriteToTile` always returns `true`), `methods.ts:91-92` (throw is dead code because `ok` is never false), pty layer (`pty-host.ts` / `daemon-client.ts`).
- **Root cause:** `writeToTile` is documented "false if no live pty" but `writePty` is `void` and no-ops on an unknown key, so `hcpWriteToTile` always returns `true`. `hive_send` to a closed/typo/non-persistent tile returns `{ok:true}`, the text vanishes, and the paired `hive_read` blocks to timeout for no reason.
- **Fix:** add `hasPty(id)` (and the daemon-client twin); `hcpWriteToTile` returns `false` when neither remote nor local pty exists; `agent.send` throws `TILE_NOT_FOUND`. Combined with `isAddressable` from P0-1, a non-persistent tile becomes an explicit error instead of a silent no-op.

### P0-4 · Implement the spawn-depth gate (reviewer L6 + architect risk 1 + maintainer P0.3 + devil 1.1)
- **Files:** `claude-resume.ts:113` (`HIVE_AGENT_DEPTH ?? "0"` — nothing increments it), `methods.ts:65` (`tile.spawn_agent` checks only `spawnAllowed()`), `protocol.ts:49` (`DEPTH_EXCEEDED` defined, thrown nowhere), `index.ts:1151-1158` (global 16/min rate gate).
- **Root cause:** the CHANGELOG-claimed anti-fork-bomb control does not bound recursion — every agent is depth 0 forever; the only brake is a single global rate counter that throttles rate but not population or depth, and lets one runaway starve siblings.
- **Fix (enforce main-side, NOT from the wire/env):** only `callerTile` crosses the wire (`index.ts:569`); the caller's `HIVE_AGENT_DEPTH` is never forwarded — and forwarding it would be self-defeating, since the fork-bomb adversary *is* the child reporting its own depth. So compute depth in main from the **existing `parentOf` chain** (`methods.ts:54`): `depth(child) = 1 + depth(parentOf.get(child))`, top-level/user-spawned = 0. In `tile.spawn_agent`, reject with `DEPTH_EXCEEDED` when `depth(callerTile) + 1 > MAX_DEPTH` (e.g. 5) *before* `spawnAllowed()`. Keep injecting `HIVE_AGENT_DEPTH` into the child env, but treat it as **informational only** (telemetry/UX), never as the gate input. Add a **per-parent** spawn quota and a **max-concurrent-agents** population cap alongside the global window. ~15 lines; closes the actual hole and stops the global-counter starvation.

### P0-5 · ~~Propagate `timeout_ms` to the wire client~~ — RESOLVED in MCP; residual is P2
- **Status:** the headline path is already fixed. `hive_read` does `const readMs = a.timeout_ms ?? 120_000; hcpCall("agent.read", {tileId, timeoutMs: readMs}, readMs + 15_000)` at `packages/hive-mcp/src/index.ts:575-581`, with a comment citing the exact bug. The reviewers (M1 / CQ #2) cited a pre-fix snapshot.
- **Residual (P2):** the `ctl` CLI read path (`apps/cli/src/commands/ctl.ts:32,93`) may still pass the fixed `130_000` default — verify and bring to parity. Naturally absorbed by the P2-1 client de-duplication (extract the corrected MCP behavior, delete the CLI copy). No P0 work remains here.

### P0-6 · Constrain forged-event blast radius + fail loud on token (reviewer L4/M4 + devil 1.3/1.5) — transcript constraint depends on P0-2
- **Files:** `index.ts:1179-1194` (`onEvent` takes `tileId`/`transcriptPath` verbatim from an unauthenticated `event`), `token.ts:20-27` (write failure swallowed; main + daemon are separate processes).
- **Root cause (event):** a same-uid process (incl. a spawned child) can forge `{t:"event",topic:"turn",data:{tileId,transcriptPath}}` to wake a blocked `agent.read` with attacker-chosen text and to trigger a pipe write that types injected text into sibling/parent tiles — cross-agent prompt injection with no identity at all. Same-uid is already the trust boundary, so likelihood is low, but the constraint is cheap defense-in-depth and required before the "secure" claim stands.
- **Root cause (token):** on a read-only/full userData, main and the daemon each mint a *different* in-memory UUID → daemon injects token A, main validates B → every driver call returns `UNAUTHORIZED` silently. The "still works in-memory" comment is false across processes.
- **Fix:** (a) reject any `transcriptPath` not under the known per-tile sessions dir before reading it; ideally validate the reporting connection owns the tile. (b) On token write failure, log loudly and surface "HCP disabled: cannot persist token" rather than handing out a token the other process won't accept.
- **Note (token framing):** separately, document honestly that the token is a static same-uid co-located secret (it adds little over the `0600` socket) **or** mint per-run in memory — architect risk 2 / devil 1.2. Pick one; P1.

### P0-7 · Refuse pipe cycles at connect time (architect risk 4 + devil 3) — depends on P0-2
- **Files:** `pipes.ts` (`connect` refuses self-loops only), reached via `methods.ts:153-159` (`tile.connect`).
- **Root cause:** `A→B→A` is allowed, and pipe forwarding has no throttle (the rate gate covers *spawn* only). Once P0-2 makes forwarding fire, a 2-cycle ping-pongs full *paid* model turns forever with no kill switch but a manual `tile.close` — an unbounded real-money pump that is one `hive_connect` away, from a natural pattern (A reviews B, B revises per A).
- **Fix:** in `PipeManager.connect(src, dst)`, before adding the edge, reject if the edge would create a cycle (DFS: is `src` reachable from `dst`?) — the same shape as the existing self-loop guard, generalized. Return a typed reason so `tile.connect` can surface `CYCLE_REJECTED` vs the current bare "cannot pipe a tile to itself" (code-quality nit on `methods.ts:157`). This caps the worst case cheaply; the bounded-budget that would *re-enable* controlled cycles is the P1-5 follow-on.
- **Why P0 not P1:** severity (unbounded spend) × likelihood (a plausible bidirectional-collaboration connect) is high, and the fix is ~10 lines. Don't ship live forwarding (P0-2) without it.

---

## P1 — within a couple of releases

### P1-1 · Turn-read returns the first Stop, not the final answer (architect risk 3/§4 + devil 2.1) — depends on P0-1
- **File:** `methods.ts:116-126` (`agent.read` resolves on the first turn with `seq > afterSeq`); `stop-hook-source.ts` (`stop_hook_active` carried but never read).
- **Root cause:** Claude fires `Stop` at every turn boundary; a multi-turn prompt (tool loops, "let me continue") wakes the reader on an intermediate turn → half-finished reply. No settle window; `stop_hook_active` ignored.
- **Fix:** add optional `settleMs` (resolve only after N ms of no new Stop) or a turn-count target; read `stop_hook_active` to skip nested/continued stops.

### P1-2 · Concurrent readers + spawn epoch race (reviewer L1 + architect §4) — depends on P0-1
- **File:** `methods.ts:41-42` (`sendSeq`/`sendMark` keyed per pty, shared across in-flight reads) and `methods.ts:78` (`armRead` runs *after* `callRenderer` returns).
- **Root cause:** a second `agent.send` overwrites the epoch for all in-flight reads on that tile (two drivers interfere); and a spawn whose first turn completes before `armRead` runs makes the next `hive_read` wait for turn 2, missing the first reply.
- **Fix:** key the epoch per request (or serialize per tile); capture the spawn epoch *before* requesting the renderer spawn.

### P1-3 · Tail-read the transcript + label the fallback honestly (reviewer L3 + maintainer P0.2/P1.7 + devil 2.1)
- **Files:** `transcript.ts:39` (`readFileSync` whole file), called per turn at `index.ts:1187` and per read at `methods.ts:121`; recorder fallback at `methods.ts:124-126`.
- **Root cause:** full-file sync read on the main/daemon loop every Stop and every read → O(n²) over a long session and main-thread stalls. And the recorder fallback returns ANSI-stripped repaint soup for claude's full-screen TUI — junk that looks like a successful read (`truncated:true` is the only signal).
- **Fix:** reverse-read a bounded tail window (e.g. last 256 KiB), full-read only if no assistant block found. Label the timeout/fallback result as a *liveness* signal, not content, in the MCP response; optionally retry a transcript read off the last-seen transcript path before falling to the recorder.

### P1-4 · Pipe + state lifecycle: forget on close, prune epochs, persist graph (reviewer M2/L2 + maintainer P1.6 + devil 2.4) — depends on P0-2
- **Files:** `methods.ts:139-140` (`tile.close` forgets tracker+recorder, never pipes — `PipeManager.forget` has no caller), `methods.ts:41-42` (`sendSeq`/`sendMark` never pruned), `index.ts:1126-1138` (`pendingHcp` 24 h entries), and the missing rehydrate path on app restart.
- **Root cause:** closing a piped tile leaves dangling edges (live once P0-2 lands → forwarding to a dead dst); per-tile maps grow for the session; tiles closed via UI/crash/detach never route through HCP `tile.close`; the pipe graph (and recorder/epochs) is in-memory in main and vanishes on reload while the ptys persist — "my pipes disappeared after restart."
- **Fix:** add a `forgetPipes` dep wired to `hcpPipes.forget(toBareId(id))` + a renderer `hcp:pipe` removal, called in `tile.close` and on any tile-close path; prune `sendSeq`/`sendMark` there too. On `window`/`before-quit`, reject all `pendingHcp` and clear timers. Persist the pipe graph (tiny `Map<string,Set<string>>`) next to session snapshots and rebuild + re-push edges on startup; document that in-flight reads don't survive a reload.

### P1-5 · Cost controls on pipes: forward-rate cap, aggregate budget, kill switch, attribution (architect risk 4 + devil 3) — depends on P0-2/P0-7
- **Files:** forwarding at `index.ts:1191-1194` (ungated), `actorTag()` `index.ts:~613` (falls back to `"agent"`).
- **Root cause:** cycle *rejection* is handled by P0-7, but acyclic graphs and high-frequency forwarding still have no throttle, no aggregate token/turn budget, and no per-agent attribution for spend or destructive acts (`hive_delete_issue` is callable by any spawned agent under the anonymous `"agent"` actor).
- **Fix:** per-edge forward-rate cap; an aggregate agent/turn budget with a single kill switch (which could later *re-enable* bounded cycles that P0-7 currently refuses outright); thread a real actor id so spend and destructive calls are attributable.

### P1-6 · Single named submit-delay constant + retry (architect risk 6 + maintainer P1.5 + devil 2.3)
- **Files:** the `90` literal at `methods.ts:93`, `methods.ts:109`, `index.ts:1193` (and per CHANGELOG `useSpawn`/`send-to-claude`).
- **Root cause:** four copies of a magic 90 ms bet against TUI composer-render latency; on cold start / large paste / load / remote pty the `\r` can fire on an empty buffer → unsubmitted prompt (the bug the fix was meant to cure, now intermittent).
- **Fix:** one shared `SUBMIT_DELAY_MS` constant routed through all sites (P0-2 already references it); consider sending `\r` as two delayed writes rather than one shot.

### P1-7 · Verify the `agent` string is an allowlist (devil 1.4)
- **Files:** `packages/hive-mcp/src/index.ts:401` (`agent: z.string().optional()`), forwarded through `methods.ts:67-70` to the renderer.
- **Root cause:** the agent name selects what binary spawns; the allowlist (if any) lives in the renderer's registry resolution, outside the reviewed surface — "any string" at the type level.
- **Fix:** confirm the renderer resolves agent names against a closed registry allowlist; if not, add one. **Escalate to P0 if no allowlist exists.**

### P1-8 · Contract smoke test + instrument fail-open paths (maintainer P0.1 + code-quality test gaps)
- **Files:** the hook sources (`stop-hook-source.ts`, `plan-review-hook-source.ts`) — raw strings, never executed in any test; the `catch {}` voids around `onEvent`/`readLastAssistantMessage`/the plan bridge.
- **Root cause:** HCP depends on ≥6 Claude Code contracts (Stop stdin `transcript_path`, `ExitPlanMode` matcher, plan `tool_input.plan`, `hookSpecificOutput.permissionDecision`, transcript JSONL shape, `--settings` merge + seconds-timeout), every one fails *open and silent* with no log/metric. Claude ships ~weekly.
- **Fix:** a nightly CI test that runs a real (or fixture) `claude` and asserts a Stop fires with `transcript_path`, the transcript parses to a non-null assistant message, and an `ExitPlanMode` handoff reaches the bridge. Execute the hook `.cjs` strings against fixture stdin and assert the JSON they emit. Emit a counter/log whenever a fail-open path triggers. Pin the verified-against Claude Code version in `docs/`.
- **Specific unit tests the reviews call out as the highest-value gaps** (each is one test): (1) `agent.read` timeout fallback returns the recorder delta with `truncated:true` (`methods.ts:124-126` — the failure mode users hit most); (2) backpressure drop in `hcp-server.ts` — `seq` still increments while the chunk is skipped (the *whole point* of the mechanism, untested); (3) pipe-forward end-to-end (`onEvent` → `readLastAssistantMessage` → write to dst) — locks P0-2; (4) `tile.close` cleanup asserts `turns.forget` + `recorder.forget` + (post P1-4) `forgetPipes`; (5) `tile.connect` self-loop **and** cycle → `BAD_REQUEST`/`CYCLE_REJECTED` at the dispatch layer (locks P0-7).

---

## P2 — housekeeping / lower urgency

### P2-1 · Deduplicate the socket client + NDJSON reader (code-quality #1/#7)
- `hcp-client.ts:18-53` and `ctl.ts:32-60` are the same client (already drifting — `ctl`'s timer isn't `.unref()`'d). The `while ((nl = buf.indexOf("\n")) …)` loop is copy-pasted 4× (`hcp-client.ts:39`, `ctl.ts:49`, `ctl.ts:131`, `hcp.test.ts:138`).
- **Fix:** extract one `hcpRequest(sock, token, method, params, timeoutMs)` shared module; reuse one framing helper. **Do P0-5 first** (timeout fix) so the extraction captures the corrected behavior rather than locking in the bug.

### P2-2 · Remove dead code (code-quality #3)
- `hcpAvailable()` `hcp-client.ts:14` (exported, zero callers), `DEPTH_EXCEEDED` `protocol.ts:49` (resolved by P0-4 — keep, now thrown), `frame` spawn param `methods.ts:70` (no caller sends it). Delete the unused, keep `DEPTH_EXCEEDED`.

### P2-3 · Type safety at the dispatch boundary (code-quality #4/#5/#6)
- `methods.ts:63` casts `as Record<string, unknown>` then hand-coerces every field. Factor the repeated `reqTileId(p)`; define a param schema per method; express the `hive_read` result shape as a type. Centralize `type TileParams = { tileId?: string }` in `protocol.ts`.

### P2-4 · Unify the two socket servers (maintainer P2.8 + architect §3)
- `plan-bridge.ts` and `hcp-server.ts` are both NDJSON-over-`0600`-socket servers with duplicate stale-unlink/chmod/framing/fail-open; `review.open` now overlaps plan-bridge's `PreToolUse` review path. Fold plan-bridge into HCP as another `event` topic (or at least share framing/socket-setup). Extract the planned `useHcpBridge` hook out of `Canvas.tsx`.

### P2-5 · Build-stamp respawn is mtime-based + fixed-delay race (maintainer P2.9)
- `ensureFreshDaemon` compares `mtimeMs` (not content identity) and bets on a fixed 300 ms for the old daemon to unlink the socket. Stamp with a content hash / app-version+build-id; poll-until-socket-gone (bounded). Note the stamp covers `pty-daemon.js` only — a hook-source change won't trigger respawn unless the bundler touches the output.

### P2-6 · Remote frames can't reach HCP (maintainer P2.10 + architect §2)
- `HIVE_HCP_SOCK` is a local path; an agent in a remote/`ssh://` frame gets a local socket that doesn't exist on its host → every canvas tool fails. Document as a known limitation now; the Phase-5 remote/HTTP adapter must inherit the constraint list (24 h holds, keystroke-injection latency).

### P2-8 · Maintainer-facing HCP architecture doc (maintainer "documentation assessment")
- **Gap:** in-code header comments are excellent, but there is no cross-cutting doc. A maintainer debugging "reviews stopped opening" must rediscover the `ExitPlanMode` coupling from scratch.
- **Fix:** write `docs/hcp-architecture.md` (model it on the existing `docs/plan-review-architecture.md`) containing: the Claude Code contract surface as a single table (the maintainer P0.1 list — Stop stdin, `ExitPlanMode` matcher, plan `tool_input.plan`, `permissionDecision`, transcript JSONL shape, `--settings`/seconds-timeout), one authoritative paragraph on the `hm:` convention + the persistent-vs-non-persistent addressability rule, and a durable tracker for the phased-deferral state (depth gate, remote adapter, cycle budget) so stubbed-but-unfinished work doesn't read as done.

### P2-7 · Remaining low-severity items
- **`review.open` restart hole (devil 2.5 / reviewer L2):** a 24 h blocking review evaporates on app restart with no record; covered partly by P1-4's `pendingHcp` rejection — confirm the reload path rejects promptly.
- **Plan-review fails open with no UI (reviewer L5):** when the window is closed or the payload won't parse, the bridge auto-allows `ExitPlanMode`. Fine as a liveness default, but make it configurable to fail-closed if plan review is ever a guardrail.
- **Spawn rate slot burned before renderer spawn (reviewer L7):** `methods.ts:66` consumes the slot before `callRenderer`; if the spawn throws the slot is still spent. Reserve-then-commit.
- **`output-recorder.ts:34`** rebuilds the whole string per `record()` once over CAP — switch to a chunk ring if it ever shows up in profiles.

---

## Sequence (ruthless ordering)

```
DECISION GATE  native-subagents vs HCP        ← answer in parallel with P0; gates P1-1/2/3 SCOPE
                                                 (does NOT block any P0)

P0-1  Adopt tile-id.ts seam everywhere         ← FOUNDATION, blocks the rest of the id work
  ├─ P0-2  Fix pipe forwarding (dests/write conversion)
  │     ├─ P0-7  Refuse pipe cycles at connect (before live forwarding ships)
  │     ├─ P0-6a constrain transcriptPath (same onEvent block — after P0-2 to avoid churn)
  │     └─ P1-4  pipe/state lifecycle (forget on close, prune, persist)
  │           └─ P1-5  pipe cost controls (rate cap, budget, kill switch, attribution)
  ├─ P0-3  Dead-tile sends fail loud (+ isAddressable)
  └─ P1-1 ─ P1-2   co-edit agent.read: settle window, then per-request epoch + TOCTOU
                   (serialize these two; gated in SCOPE by the Decision Gate)

P0-4  Depth gate (main-side via parentOf) + per-parent quota + population cap   (after P0-1)
P0-6b Token fail-loud                                  (independent)
~~P0-5~~  already fixed in MCP; ctl parity folds into P2-1

P1-3  Tail-read transcript + label fallback            (transcript.ts isolated; anytime)
P1-6  Single SUBMIT_DELAY_MS constant                  (P0-2 already references it)
P1-7  Verify agent allowlist                           (escalate to P0 if absent)
P1-8  Contract smoke test + instrument fail-open       (no churn dependency; schedule into CI)

P2-1  dedupe socket client (captures the MCP timeout fix, deletes ctl copy) → P2-2..P2-8 housekeeping
```

**The one ordering that matters most:** `P0-1` (adopt the existing `tile-id.ts` seam) before any verb touch. Every P0/P1 fix that converts an id (`P0-2`, `P0-3`, `P1-1`, `P1-2`, `P1-4`) otherwise re-hand-rolls `hm:`/`slice` surgery — the exact bug class that produced H1. Centralize, then `P0-2`'s pipe fix is a two-line `toBareId`/`toPtyId` call instead of a fifth copy of the convention. `P0-6a`'s transcript-path constraint edits the same `onEvent` block as `P0-2`, so it follows it. `P0-7` (cycle rejection), `P1-4` (lifecycle) and `P1-5` (cost) only matter once `P0-2` makes forwarding actually fire — sequence them after, not before; and do not ship live forwarding (`P0-2`) without `P0-7`, or the first bidirectional connect is an unbounded money pump.

**The decision that matters most:** the native-subagents-vs-HCP scope question. It blocks no P0, but it sets how bulletproof `P1-1/P1-2/P1-3` must be. Answer it before building the settle-window/epoch/transcript-fidelity stack — for the claude→claude invisible-worker case a function call obviates all three, and you only owe that hardening to the heterogeneous-binary and human-visible-canvas cases HCP alone can serve.
