# Hivemind Control Plane (HCP) — Architecture Review

*Reviewer role: software architect. Scope: `apps/desktop/src/main/hcp/`, `docs/plan-review-architecture.md`, the HCP plan (`melodic-skipping-umbrella.md`), and the wiring in `main/index.ts` / `claude-resume.ts` / `packages/hive-mcp/`.*

## Verdict

HCP is a well-conceived control plane with an unusually clean separation of concerns and a transport choice that is correct for its threat model. The core insight — *tiles are born in the renderer, bytes flow through main, therefore put transport + policy + agent I/O in main and let the renderer own only canvas verbs* — is load-bearing and the code honors it. The deterministic Stop-hook turn model is the right call over screen-scraping.

The gap between plan and implementation is where the risk lives: the depth-gate anti-fork-bomb control is **specified but not implemented**, the "per-session capability token" is actually a persisted per-install token that adds little over the socket permissions, and two correctness seams (turn-read epoch under multi-turn agents; pipe-cycle forwarding) are bounded only "in practice." None of these block Phase 1's hero path; all of them should be closed before HCP is treated as a hardened multi-agent substrate.

---

## 1. Separation of concerns — strong

The three-tier ownership split is principled and the code adheres to it:

| Tier | Owns | Evidence |
|---|---|---|
| **main** | transport, token policy, rate gate, pty writes, turn state, output ring, pipe graph | `hcp-server.ts`, `methods.ts` main verbs, `index.ts:881-1197` shared state fed from the pty `onData` relay |
| **renderer** | canvas verbs only (spawn / list / focus / close) | `Canvas.tsx:567-612` — a ~40-line switch behind `onHcpCommand` |
| **daemon** | ptys | unchanged; main relays `pty:data:<tile>` and tees it into the recorder |

The decisive move is serving `agent.send` and `agent.read` **in main** (`methods.ts:74-103`), not the renderer. Main already sees every pty byte and writes via `hcpWriteToTile`, so agent I/O has **no dependency on a tile staying mounted** — this directly resolves the recorder-fragility the design review flagged (plan §4). The recorder, turn-tracker, and pipe graph are instantiated as module-level singletons in `index.ts` and fed from the same `onData` callback that relays to the renderer (`index.ts:917,941`), so they are always-on. Correct.

`methods.ts` takes all collaborators as an injected `MethodDeps` interface — no direct imports of main internals. This keeps dispatch unit-testable in isolation (confirmed by `tests/unit/hcp.test.ts`) and is the right dependency direction.

**One leak:** the `hm:<tileId>` pty-id convention is hard-coded into `methods.ts` (`ptyId = t => t.startsWith("hm:") ? t : "hm:"+t`). That couples the dispatch layer to `TerminalTile`'s daemon-pty naming. It works, but the mapping belongs behind a dep (e.g. a `toPtyId` injected function) so the naming scheme stays owned by one place.

## 2. Transport choice — correct for the threat model

A `0600` unix socket carrying NDJSON, owned by main. This is the right pick:

- **vs loopback HTTP:** HTTP would need a port (collision management), CORS, and a token to reach the *same* same-uid trust the socket gets for free from filesystem permissions. The plan (§1) makes this argument and it holds.
- **vs existing patterns:** it is the *same* shape as `pty-daemon` and `plan-bridge` — NDJSON, `t` discriminator, `0600` under `userData`. Reusing the house style is real architectural value: one mental model, one security posture, proven framing code.
- **framing is defensive:** `takeLines` caps a single line at 1 MiB (`protocol.ts:62-77`) so a runaway client cannot OOM main; backpressure on streaming drops chunks and signals the gap via the monotonic `seq` rather than growing memory (`hcp-server.ts:144-150`). Both are the correct choices.

The subscription model deliberately multiplexes on a `subId` carried in event params, **not** the request id (`hcp-server.ts:12-15`) — because a stream outlives its request and JSON-RPC forbids two responses to one id. This follows LSP/CDP/MCP convention and is the right call.

**Limitation (acknowledged, deferred):** the socket is single-host. The remote-frames work (`ssh://` URI seam) and any devcontainer story will need an HCP transport that crosses a host boundary; the plan parks this in Phase 5 as a loopback-HTTP adapter. Fine to defer, but note that the `review.open` 24h hold and the keystroke-injection write model both assume low-latency local I/O — a remote adapter is not a drop-in.

## 3. Request-id-correlated renderer-command channel — sound, mildly under-factored

`hcpCallRenderer` (`index.ts:1127-1138`) is a faithful twin of the proven `planReplies` pattern: a `pendingHcp` map keyed by id, a `hcp:command` push to the renderer, an `ipcMain.handle("hcp:result")` that resolves it, a per-entry timeout → `TIMEOUT`, and `APP_NO_RENDERER` when the window is gone. This is the correct way to do a blocking RPC across the IPC seam and it correctly degrades.

Two notes:

- The plan named a `renderer/src/useHcpBridge.ts` hook; in practice the dispatch is **inlined into `Canvas.tsx`**. Minor cohesion smell — canvas-verb dispatch now lives in a switch inside an already-large component. Extracting the planned hook would isolate it and make the renderer half independently testable. Not urgent.
- `review.open` holds a `pendingHcp` entry **and** the driver's socket connection open for up to 24h (`methods.ts:36,120-126`). That is by design (human review is slow) and renderer reload drops the pending entry, but it means a long-lived blocked connection per open review. Acceptable at expected concurrency; worth a cap if reviews ever fan out.

## 4. Stop-hook turn model — right idea, one real correctness gap

Using Claude Code's `Stop` hook as the turn-completion signal (`stop-hook-source.ts`, `turn-tracker.ts`) is the strongest design decision in the system. It replaces the screen-scrape heuristics of the prior art (tttt `wait_for_idle`, tmux-orchestrator `capture_pane`) with a **deterministic** signal, and it reuses the existing `--settings` injection so no user config is needed. The hook is self-contained CJS, zero-dep, and **fail-open** (1500ms timeout → exit 0, `stop-hook-source.ts:33`) so a missing/unreachable app never bricks the agent. `agent.read` then parses the **last assistant message from the transcript JSONL** (`transcript.ts`) — clean text, not ANSI bytes — with a buffered-output fallback on timeout. This ladder (deterministic primary → timeout fallback) is exactly right.

**The gap — multi-turn agents.** `agent.read` arms an epoch at send time (`armRead` captures `currentSeq`) and `waitForTurn` resolves on the **first** turn whose `seq > afterSeq` (`turn-tracker.ts:51-53, 40`). But Claude fires `Stop` at *every* turn boundary, and a single prompt can produce several (tool-use loops, sub-agent pauses, "let me continue"). So a driver that sends a complex prompt and reads can get woken by the **first intermediate Stop**, not the final answer — returning a half-finished reply. There is no quiescence/settle window and no notion of "the turn that ends the task." For the Phase 1 hero path (`compute 2+2 and explain` → one turn) this is invisible; for real orchestration it is a latent correctness bug. Consider an optional `settleMs` (resolve only after N ms of no new Stop) or a turn-count target.

**Concurrent readers on one tile.** `sendSeq`/`sendMark` are keyed by pty id (`methods.ts:41-42,50-54`). A second `agent.send` to the same tile overwrites the epoch for *all* in-flight reads on that tile. Two drivers addressing the same agent interfere. Either serialize per-tile or key the epoch per request.

## 5. Coupling / cohesion — high cohesion, coupling concentrated correctly

Each module is single-responsibility and tight: `protocol` (wire + framing), `token` (secret + path), `turn-tracker` (turn state + waiters), `output-recorder` (ANSI-stripped ring + delta counter), `pipes` (directed graph), `transcript` (JSONL parse), `methods` (dispatch), `hcp-server` (framing + auth + fan-out). The transcript parser is defensively coded against shape drift and never throws. The recorder strips ANSI and caps at 256 KiB with a monotonic total for deltas — clean.

Coupling is concentrated in `index.ts` as the **composition root** (it wires deps into `makeDispatch` and `startHcpServer`, owns the singletons, and bridges `onEvent` → `recordTurn` + pipe-forward). That is the correct place for wiring to live. The only stray couplings are the `hm:` prefix leak (§1) and the renderer dispatch inlined in `Canvas.tsx` (§3).

## 6. Scalability

In-memory per-tile maps, O(subs) fan-out per chunk, single socket, single main process — all fine for the intended scale (tens of agents on a canvas). The binding constraints are not the transport:

- **Rate gate is global, not per-agent:** `hcpSpawnAllowed` is a single 16-spawn/60s sliding window across the whole app (`index.ts:1151-1158`; the plan said 20). A legitimate fan-out burst from one orchestrator competes with every other agent's spawns. Per-parent quotas (the plan's "children/agent" cap) are not implemented.
- **Keystroke-injection write path** is the real scaling ceiling. `agent.send` and pipe-forward type text then schedule `\r` 90ms later (`methods.ts:85`, `index.ts:1191-1193`) to work around claude's TUI dropping a bundled newline. This is a timing heuristic coupled to TUI behavior — fine for a few agents, but at dozens of concurrent sends the 90ms timers and TUI write latency dominate, and a busy TUI can still race.

## 7. Fit with the rest of hivemind — excellent

HCP generalizes `plan-bridge` (a shipped, proven pattern) rather than inventing a new mechanism, and reuses the existing seams end-to-end: `claude-resume` `--settings`/env injection, `useSpawn.spawnTile` + `claude-bus` queueWork, the `agent-status-bus`, and the daemon→main pty relay. The 11 issue MCP tools stay file-only so they keep working headless; the canvas tools go through `hcp-client.ts`, which lazily dials and returns a clean "app not running" on `ECONNREFUSED`/`ENOENT`. The plan-review fold-in (`review.open`) supersedes the plan-bridge *transport* without touching the review UI. This is a textbook case of extending an existing pattern instead of bolting on a parallel one.

---

## Architectural risks (ranked)

1. **Depth gate is specified but absent.** `HIVE_AGENT_DEPTH` is hard-coded to `"0"` (`claude-resume.ts:113`, comment: "once spawn-env threading lands (Phase 2)"). `DEPTH_EXCEEDED` is defined in `protocol.ts:49` and **thrown nowhere**. The plan called depth-bounding "non-negotiable" (§6); in reality the only anti-fork-bomb control is the global 16/60s rate gate, which *slows* a fork bomb but does not *bound* recursion depth. A claude agent that reliably spawns one child per turn produces unbounded depth, rate-limited but never refused. **Close before multi-agent is exposed beyond the hero path.**

2. **"Per-session capability token" is actually per-install.** `token.ts` persists a UUID to `<userData>/hcp.token` (`0600`) and reuses it across runs — the header comment says "per-install secret," the plan §6 said "mints HCP_TOKEN at startup" / "per-session." Because the file is readable by any same-uid process and is never rotated, the token adds little over the `0600` socket permission that is the *actual* trust boundary (the plan's own risk #3 concedes this). Not a vulnerability under the same-uid model, but the "capability token" framing overstates the guarantee. Either rotate per-run (mint in memory at startup) or document it honestly as a same-uid socket with a static co-located secret.

3. **Turn-read returns the first turn, not the final answer** (§4). Latent for multi-turn agents. Add a settle window or turn target.

4. **Pipe cycles are unbounded in forwarding.** `pipes.ts` refuses self-loops but the comment concedes cycles are "the caller's responsibility, bounded in practice by per-turn forwarding + spawn/rate caps." The rate cap is on **spawn**, not on send/forward. An `A→B→A` pair ping-pongs each other's replies every turn with no forward-rate ceiling — a livelock, not caught by the spawn gate. Add a per-edge forward-rate cap or cycle detection.

5. **Concurrent readers on one tile interfere** (§4) — shared per-pty epoch map.

6. **Write path couples to claude TUI timing** (§6) — the 90ms `\r` heuristic is fragile and is the I/O scaling ceiling.

## Suggested improvements

- **Implement the depth gate now, not Phase 2.** Thread `HIVE_AGENT_DEPTH = parent+1` through the spawn env in `methods.ts:tile.spawn_agent`, read the caller's depth, and throw `DEPTH_EXCEEDED` past `MAX_DEPTH`. The error code and the env var already exist — only the threading and the check are missing. This is the single highest-value hardening.
- **Make the token per-run** (mint in memory at startup, no persisted file) *or* drop the token framing and lean explicitly on `0600`. Pick one; the current middle ground claims more than it delivers.
- **Add `settleMs` to `agent.read`** so it resolves on the final turn, not the first Stop.
- **Per-parent spawn quota + per-edge forward-rate cap** to replace the single global window.
- **Hide the `hm:` prefix behind an injected `toPtyId` dep** and **extract the planned `useHcpBridge` hook** out of `Canvas.tsx` — two small cohesion wins.
- **Document the local-only assumption** at the transport boundary so the Phase 5 remote adapter inherits the constraint list (24h holds, keystroke-injection latency) rather than rediscovering it.

REVIEW DONE
