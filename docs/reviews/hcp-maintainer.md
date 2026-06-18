# HCP — Long-term maintainer review

**Scope:** the Hivemind Control Plane (HCP) as it lands in `[Unreleased]`.
**Question:** what does this cost to keep alive 6–12 months out, and what breaks first?
**Reviewer stance:** long-term maintainer. Optimising for "still works after Claude Code ships 30 more releases," not for "ships clean today."

Files read: `apps/desktop/src/main/hcp/*`, `daemon-client.ts`, `claude-resume.ts` (settings/env injection), `pty-daemon.ts` (build stamp + hook emission), `index.ts` (control-plane wiring), `plan-bridge.ts`, `packages/hive-mcp/src/{hcp-client,index}.ts`, `tests/unit/hcp.test.ts`, CHANGELOG `[Unreleased]`.

---

## Verdict

The core is well-built. The transport, dispatch, turn-tracking and subscription/backpressure design are clean, small, and genuinely well-tested at the unit level. The architecture (deterministic turn completion via a Stop hook + transcript read, instead of screen-scraping) is the right call and is the feature's main asset.

**The maintenance burden is not in the code that's tested. It is concentrated in the seams to systems HCP does not own** — Claude Code's hook contract, its transcript schema, its TUI input timing — and those seams are exactly the parts with zero automated coverage, silent fail-open behaviour, and no telemetry. That combination (high external-churn surface + invisible failure) is the thing that will quietly rot.

Priorities below are ordered by *expected-pain-over-12-months*, not by severity-in-isolation.

---

## P0 — Harden first

### 1. Claude Code contract coupling is undocumented, untested, and fails silently

HCP depends on at least six separate Claude Code internal contracts, every one of which fails *open and quiet*:

| Dependency | Where | Failure mode if Claude changes it |
|---|---|---|
| Stop hook stdin `{ transcript_path }` | `stop-hook-source.ts` | `agent.read` always times out → ANSI-scrape fallback |
| `PreToolUse` matcher name `ExitPlanMode` | `claude-resume.ts:83` | plan review never opens; agents silently auto-proceed |
| Plan hook stdin `tool_input.plan` | `plan-review-hook-source.ts` | review auto-allows every plan |
| Hook output `hookSpecificOutput.permissionDecision` | both hook sources | deny becomes a no-op; "request changes" silently does nothing |
| Transcript JSONL `{type:assistant, message:{content:[{type:text}]}}` | `transcript.ts` | every `hive_read` returns garbled fallback |
| `--settings` merge semantics + hook timeout-in-seconds | `claude-resume.ts` | hooks silently not installed |

Claude Code ships roughly weekly. Any one of these renames/reshapes and **HCP degrades with no error surfaced to anyone** — the user just sees `hive_read` time out, or plans silently executing without review. The fail-open posture is correct for availability but actively hostile to *diagnosis*: there is no log line, no metric, no "contract mismatch" signal anywhere.

**Harden:**
- Add a **contract smoke test** that runs a real (or recorded-fixture) `claude` once and asserts: a Stop event fires with `transcript_path`, the transcript parses to a non-null assistant message, and an ExitPlanMode handoff reaches the bridge. Run it in CI nightly (not per-PR — it needs a real binary) so a Claude release that breaks the contract is caught within a day, not by a user.
- **Instrument the fail-open paths.** When the plan hook can't reach the bridge, when `readLastAssistantMessage` returns null after a recorded turn, or when `agent.read` falls through to the recorder — emit a counter / log. Today these are `catch {}` voids. Fail-open should still be fail-*loud-in-logs*.
- Pin the verified-against version. The plan-review doc says "verified against current docs"; record *which* Claude Code version, so a future maintainer knows the baseline to diff against.

### 2. `agent.read` fallback is near-useless for the one agent it targets

`OutputRecorder` is a line-oriented ANSI-stripped ring. Claude's TUI is a full-screen repainting application — it rewrites the same cells continuously. So on the fallback path (Stop hook didn't fire within the timeout), `recorder.since()` returns a garbled soup of partial repaints, not the agent's reply. The fallback is fine for a plain shell and structurally wrong for `claude`, which is the primary case.

This compounds P0.1: if the Stop-hook contract ever breaks, the fallback doesn't save you — it returns junk that *looks* like a successful read (`truncated: true` is the only signal, easy to ignore).

**Harden:** either (a) accept that the fallback is a liveness signal only, not a content signal, and document/label it as such in the MCP tool response, or (b) on timeout, attempt a transcript read keyed off the most recent transcript path the tracker has *ever* seen for the tile, before falling to the recorder.

### 3. The fork-bomb defense the CHANGELOG claims does not actually bound recursion

`HIVE_AGENT_DEPTH` is injected (`claude-resume.ts:113`) and defaults to `"0"`, but **nothing reads it, nothing increments it, and `DEPTH_EXCEEDED` (defined in `protocol.ts:49`) is never thrown.** The comment is honest ("once spawn-env threading lands (Phase 2)"), but the practical state is: the *only* spawn defense is `hcpSpawnAllowed()` — a single global 16-per-rolling-minute counter shared across every agent and the human.

That global limit does not bound a recursive fan-out (A→B→C→…): depth is unbounded, and 16/min sustained is 960 spawns/hour with no total ceiling. It also has a usability failure: a legitimate orchestrator fanning out 20 workers hits the wall, while a slow runaway sails under it forever.

**Harden (this is the deferred "per-child spawn-depth limit," and it's a safety item, not a nicety):**
- Thread `HIVE_AGENT_DEPTH` into spawned children (`tile.spawn_agent` already receives `callerTile`; the caller's depth is knowable), increment per level, and throw `DEPTH_EXCEEDED` past a cap (e.g. 5). This is ~10 lines and closes the actual recursion hole.
- Consider a per-parent spawn budget in addition to the global rate, so one runaway can't starve everyone.

---

## P1 — Will bite within a couple of releases

### 4. The `hm:` prefix mapping is convention-by-string-surgery in 4+ places

The bare-id ↔ pty-id mapping (`hm:<tileId>`) is reimplemented independently in:
- `methods.ts:48` — `ptyId = t => t.startsWith("hm:") ? t : "hm:"+t`
- `index.ts` — `bareTileId()` / the `hcpWriteToTile` resolution
- `useSpawn.ts:334` — `callerTile.slice(3)`
- `pty-daemon.ts:149` — legacy-key migration (`hm:<path>:<tileId>` vs `hm:<tileId>`)

Four places independently encode the same rule, plus a legacy variant. Worse, **non-persistent tiles are keyed `${tileId}-${reactId}` (`TerminalTile.tsx:140`), not `hm:`-prefixed** — so the control plane, which assumes `hm:`, can only address *persistent* tiles. A non-persistent claude tile is silently unaddressable by `hive_send`/`hive_read` (the write no-ops, the read times out). Nothing flags this; it just looks broken.

**Harden:** centralise the mapping in one module (`ptyId(bare)` / `bareId(pty)` / `isAddressable(tile)`) and route every call site through it. Make "this tile can't be driven by HCP" an explicit `TILE_NOT_FOUND` rather than a silent no-op + timeout. This is the bug class the `[Unreleased]` "addresses the right tile" fix already had to chase once; it'll recur until the convention lives in exactly one place.

### 5. The 90 ms prompt-submit hack is a timing race with no feedback

`setTimeout(() => write("\r"), 90)` appears in `methods.ts:85`, the pipe-forward path in `index.ts`, and (per CHANGELOG) `useSpawn` and `send-to-claude`. It works around claude's TUI dropping a newline bundled with text. But 90 ms is a guess against composer-render latency. On a cold start, a large pasted prompt, or a loaded machine, the `\r` can fire before the text is in the composer → Enter on an empty/partial buffer → prompt sits unsubmitted (exactly the failure the fix was meant to cure, now intermittent instead of deterministic).

**Harden:** there's no clean ack from the TUI, so a magic constant may be unavoidable — but (a) define it **once** as a named constant shared by all four call sites instead of four copies of `90`, and (b) consider sending the `\r` as a small retry (e.g. two delayed writes) rather than a single shot. At minimum, one constant so the inevitable future tuning is a one-line change.

### 6. HCP control-plane state is ephemeral while the ptys it controls are persistent

`TurnTracker`, `PipeManager`, `OutputRecorder`, and the `sendSeq`/`sendMark` epochs all live in-memory in Electron **main**. The pty daemon survives app restart and `daemon-client` transparently re-attaches live sessions — but **none of the HCP state is re-hydrated.** After an app reload or main crash:
- pipes vanish (the animated edges *and* the forwarding silently stop),
- read epochs reset (a `hive_read` issued before reload, against a tile that finished during reload, can miss its turn),
- the recorder ring is empty.

So the system advertises "persistent agents" but the *mesh between them* is not persistent. That mismatch will surface as "my pipes disappeared after the app restarted" bug reports.

**Harden:** at minimum, persist the pipe graph (it's a tiny `Map<string,Set<string>>`) next to the session snapshots and rebuild it on startup, and push the edges back to the renderer. Turn epochs are harder; document that in-flight reads don't survive a reload.

### 7. `transcript.ts` re-reads the entire JSONL on every turn

`readLastAssistantMessage` does `fs.readFileSync(whole file)` then splits and walks backwards, **once per turn, and again per pipe destination.** For a long-running orchestrator tile the transcript grows without bound, so each read is O(file size) and the session is effectively O(n²) in turns. Also: if a turn ends on a `tool_use` block with no trailing text, it returns null and silently drops to the (broken-for-claude, see P0.2) fallback.

**Harden:** read the tail only (the last assistant message is near the end — reverse-read a bounded window, e.g. last 256 KiB, and only fall back to a full read if no assistant block is found). Cheap, removes the quadratic.

---

## P2 — Worth doing, lower urgency

### 8. Two near-identical socket servers

`plan-bridge.ts` and `hcp-server.ts` are both NDJSON-over-0600-unix-socket servers with their own stale-unlink, chmod, line-framing, and fail-open logic. `hcp-server.ts`'s header even says it "Generalizes plan-bridge.ts" — but plan-bridge was never folded in, and `review.open` now gives HCP a *second* path to open a review tile that overlaps plan-bridge's `PreToolUse` path. Two transports, two framing implementations, two review entry points to keep in sync.

**Harden:** fold plan-bridge into the HCP server as another event topic (it's already an unauthenticated hook `event` in everything but name), or at least share the framing/socket-setup helpers. Not urgent, but every divergence between the two is a latent inconsistency.

### 9. Build-stamp respawn is mtime-based and has a fixed-delay race

`ensureFreshDaemon` compares `statSync(daemonScript).mtimeMs` to the running daemon's reported stamp. mtime is not content identity: a `git checkout`, `touch`, restore-from-cache, or filesystem that doesn't preserve mtime can either skip a needed respawn or force a spurious one. And the replacement path does `write(shutdown); end(); await delay(300)` — a fixed 300 ms bet that the old daemon exits and unlinks the socket before the next connect. Under load that window can be too short → the next connect races a half-dead socket.

In production this is invisible (one matching daemon ships per build), so it's a *dev-ergonomics* surface, not a user one — hence P2. But it's the kind of thing that wastes an afternoon when it misfires.

**Harden:** stamp with a content hash (or the app version + a build id) rather than mtime, and replace the fixed 300 ms with a poll-until-socket-gone (bounded). Also note: the stamp covers `pty-daemon.js` only; if a hook source (`stop-hook-source.ts` etc.) changes without the daemon entrypoint's mtime moving, the respawn won't trigger — depends entirely on the bundler touching the output. Worth a comment at least.

### 10. Remote frames silently can't reach HCP

`hcpWriteToTile` already branches on `hasRemotePty`, so remote frames are a live feature. But `HIVE_HCP_SOCK` is a **local** path, and the socket is bound on the local box. An agent running in a remote/devcontainer frame gets a local socket path injected that doesn't exist on its host → every canvas tool fails. So the "deferred remote/HTTP adapter" is not just a future enhancement; it's a **correctness gap for an existing feature** (remote frames). At minimum this should be documented as a known limitation so it's not rediscovered as a bug.

### 11. `review.open` resolver can leak for up to 24h

`review.open` goes through `hcpCallRenderer` with a 24-hour timeout, holding an entry in `pendingHcp`. If the renderer reloads while a review is open, the plan-bridge side has `onAbort`, but the HCP-facing resolver sits in the map until the 24h timer fires (unless a destroyed-window check clears it). Low frequency, but it's an unbounded-ish hold. Confirm the reload path rejects pending HCP calls promptly.

---

## Testing assessment

**Good:** `hcp.test.ts` covers protocol framing, transcript parse, turn tracker (including timeout + already-past), recorder delta + ANSI strip, dispatch happy paths, rate-limit rejection, the `hm:` write mapping, and a real server round-trip incl. token gate, hook event, and subscription/backpressure. For the in-memory core, coverage is genuinely solid.

**The untested code is exactly the high-risk code:**
- The hook `.cjs` sources (`stop-hook-source`, `plan-review-hook-source`) are raw strings, **never executed in any test.** They are the most external-contract-coupled code in the feature and have zero coverage.
- No test asserts the Claude Code transcript schema against a real transcript (P0.1).
- Pipe forwarding end-to-end (`onEvent` → `readLastAssistantMessage` → write to dst) — the wiring lives in `index.ts` and is not exercised; only `PipeManager`'s edge bookkeeping is.
- The non-persistent-tile addressing gap (P1.4), the 90 ms race (P1.5), the remote-pty branch (P2.10), and the build-stamp respawn (P2.9) are all untested.

**Add, in priority order:** the nightly real-`claude` contract test (P0.1), an executed test of the hook `.cjs` scripts against fixture stdin (assert the JSON they emit), and a pipe-forward integration test.

---

## Documentation assessment

In-code header comments are excellent — among the best in the repo; the *why* is captured at every non-obvious decision. What's missing is **maintainer-facing, cross-cutting** documentation:
- The Claude Code contract surface (the P0.1 table) exists nowhere as a single list. A future maintainer debugging "reviews stopped opening" has to rediscover the ExitPlanMode coupling from scratch.
- The `hm:`-prefix convention and the persistent-vs-non-persistent addressability rule are folded into scattered comments; they deserve one authoritative paragraph.
- The phased-deferral state (depth limit injected-but-unused, remote adapter, `DEPTH_EXCEEDED` defined-but-unthrown) should be tracked somewhere durable, not only in a CHANGELOG bullet — it reads as done-ish when it's stubbed.

`docs/plan-review-architecture.md` is a good model; HCP deserves the equivalent.

---

## One-line priority list

1. **P0** — CI contract test + instrument the fail-open paths against Claude Code's hook/transcript surface.
2. **P0** — fix the `agent.read` fallback (recorder is wrong for claude's TUI).
3. **P0** — actually implement spawn-depth bounding (the injected env var that nothing reads).
4. **P1** — centralise the `hm:` mapping; make non-addressable tiles an explicit error.
5. **P1** — single named constant for the 90 ms submit delay; consider a retry.
6. **P1** — persist the pipe graph across app restart (state/transport persistence mismatch).
7. **P1** — tail-read the transcript (kill the O(n²)).
8. **P2** — unify plan-bridge + hcp-server; content-hash the build stamp; document the remote-frame gap; confirm the 24h resolver can't leak.

REVIEW DONE
