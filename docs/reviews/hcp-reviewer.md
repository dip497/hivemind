# HCP correctness review

Reviewer: senior code review pass. Scope: `apps/desktop/src/main/hcp/*`, `plan-bridge.ts`, `claude-resume.ts`, `packages/hive-mcp/src/{index,hcp-client}.ts`, plus the wiring in `apps/desktop/src/main/index.ts` and the renderer HCP handler.

## Key-space map (the thing everything depends on)

Three id namespaces flow through HCP:

- **bare tile id** — `tile-claude-<ts>`. What the renderer returns from `tile.spawn_agent` / `tile.list`, what every MCP driver passes back in.
- **pty id** — `hm:<tileId>` (persistent daemon) per `TerminalTile.tsx:140`. The key for the pty, the `OutputRecorder`, the `TurnTracker`, and `HIVEMIND_TILE`.
- **in-process pty id** — `${tileId}-${reactId}` when `HIVEMIND_PTY_DAEMON=0` (`TerminalTile.tsx:140`). Neither bare nor `hm:`.

`methods.ts:48` `ptyId(t) = hm:${t}` bridges bare→pty for the MAIN verbs. `index.ts:892` `bareTileId` bridges pty→bare at the stream boundary. Two of the findings below are places where a value crosses a namespace boundary without being converted.

---

## HIGH

### H1 — Pipe forwarding is fully broken: dest lookup uses the pty id against a bare-keyed map
`index.ts:1185` (+ write at `1191-1193`), `methods.ts:129-134`, `pipes.ts`

`tile.connect` stores edges keyed by the **bare** id (the driver passes `srcTileId`/`dstTileId` straight from `hive_spawn_agent`, which returns bare — `Canvas.tsx` `hcpSpawnAgent` returns `newId = tile-claude-…`). But the turn handler looks them up with the **pty** id:

```ts
// index.ts:1183-1185 — d.tileId is HIVEMIND_TILE == `hm:<tileId>`
hcpTurns.recordTurn(d.tileId, …);          // correct: tracker is hm:-keyed
const dests = hcpPipes.dests(d.tileId);    // WRONG: pipes are bare-keyed → always []
```

`recordTurn` is right (tracker is `hm:`-keyed) but the *same* `d.tileId` is wrong for `dests()` because the pipe map is bare-keyed. Result: `dests` is always empty and `hive_connect` silently never forwards anything.

Second defect on the same path: even if a dest were found, the write target is not converted to a pty id:

```ts
for (const dst of dests) {            // dst is bare
  hcpWriteToTile(dst, reply);         // writePty(bare) → no pty under that key → no-op
  setTimeout(() => hcpWriteToTile(dst, "\r"), 90);
}
```

`agent.send` writes via `deps.writeToTile(ptyId(tileId), …)` (`methods.ts:83`), i.e. `hm:`-prefixed; the pipe path skips that conversion, so the write no-ops anyway.

**Fix:**
```ts
const src = bareTileId(d.tileId);
const dests = hcpPipes.dests(src);
if (dests.length === 0 || !d.transcriptPath) return;
const reply = readLastAssistantMessage(d.transcriptPath);
if (!reply) return;
for (const dst of dests) {
  const pid = dst.startsWith("hm:") ? dst : `hm:${dst}`;
  hcpWriteToTile(pid, reply);
  setTimeout(() => hcpWriteToTile(pid, "\r"), 90);
}
```

### H2 — `agent.send` dead-tile detection is dead code; sends to a nonexistent tile report success
`methods.ts:83-84`, `index.ts:894-898`, `pty-host.ts:76`

```ts
const ok = deps.writeToTile(ptyId(tileId), text);
if (!ok) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
```

`MethodDeps.writeToTile` is documented "Returns false if the tile has no live pty," but the impl can never return false:

```ts
const hcpWriteToTile = (tileId, data): boolean => {
  if (hasRemotePty(tileId)) { writeRemotePty(tileId, data); return true; }
  writePty(tileId, data);
  return true; // best-effort
};
```

`writePty` (`pty-host.ts:76`) is `void` and no-ops on an unknown tile (`ptys.get(tileId)` miss). So `hive_send` to a closed/typo tile returns `{ok:true}`, the text vanishes, and a paired `hive_read` then blocks to timeout for no reason — a confusing failure mode for the orchestration use case.

**Fix:** give the pty layer a liveness predicate and use it. `pty-host.ts` has `ptys.has(tileId)`; add `export function hasPty(id){return ptys.has(id)}` (and the daemon-client twin), then:
```ts
const hcpWriteToTile = (tileId, data) => {
  if (hasRemotePty(tileId)) { writeRemotePty(tileId, data); return true; }
  if (!hasPty(tileId)) return false;
  writePty(tileId, data); return true;
};
```

---

## MEDIUM

### M1 — `hive_read` ignores its own `timeout_ms` at the client; any read > ~125 s fails client-side
`hive-mcp/index.ts:564-567`, `hcp-client.ts:18,32`

```ts
case "hive_read":
  return jsonResult(await hcpCall("agent.read", { tileId, timeoutMs: a.timeout_ms }));
```

`hcpCall` uses its **default** `timeoutMs = 130_000` regardless of the requested `timeout_ms`. Server-side `agent.read` honors the caller's `timeoutMs` (`methods.ts:92`). So a driver that asks for a 10-minute read gets the socket torn down at 130 s ("HCP request timed out") while the server keeps waiting on the turn — the reply is lost and the tracker waiter lingers. The advertised `timeout_ms` parameter is effectively capped at ~130 s. (Contrast `hive_open_review`, which correctly passes an explicit 24 h client ceiling.)

**Fix:** derive the client ceiling from the request:
```ts
const ms = a.timeout_ms ?? 120_000;
return jsonResult(await hcpCall("agent.read", { tileId: a.tileId, timeoutMs: ms }, ms + 15_000));
```

### M2 — `tile.close` leaks pipe edges; `PipeManager.forget` is never called
`methods.ts:112-118`, `pipes.ts:37-40`

`tile.close` cleans the tracker and recorder but not the pipe graph:

```ts
deps.turns.forget(ptyId(String(p.tileId)));
deps.recorder.forget(ptyId(String(p.tileId)));
// hcpPipes is never touched
```

`PipeManager.forget()` exists but has no caller anywhere. Closing a piped tile leaves dangling edges (src→dead, dead→dst) plus a stale animated edge in the renderer. Once H1 is fixed this becomes a live correctness bug (forwarding to a dead dst).

**Fix:** add a `forgetPipes` dep wired to `hcpPipes.forget(bareId)` and a renderer `hcp:pipe` removal, and call it in `tile.close` with the **bare** id (the pipe map is bare-keyed).

### M3 — HCP turn/recorder pipeline silently assumes daemon (`hm:`) pty ids; in-process mode breaks it
`methods.ts:48`, `TerminalTile.tsx:140`, `index.ts:917,941`

`ptyId()` hardcodes `hm:${t}`. Under `HIVEMIND_PTY_DAEMON=0` the actual pty id is `${tileId}-${reactId}` (`TerminalTile.tsx:140`). In that mode:
- `OutputRecorder` is fed `record("${tileId}-${reactId}", …)` but `agent.read` reads `mark("hm:<tileId>")` → fallback always empty.
- `HIVEMIND_TILE` (hence `recordTurn`) carries the in-process id, while `agent.read` waits on `hm:<tileId>` → every read times out.

Default is daemon (`PERSIST_PTY = env !== "0"`), so prod is fine, but the coupling is undocumented and brittle — anyone toggling the flag (or a unit test) gets a silently dead control plane. Worth either gating HCP on `PERSIST_PTY` (refuse with a clear error) or threading the real pty id instead of reconstructing it with a string prefix.

### M4 — Token divergence on a read-only userData; docstring claim is false across processes
`token.ts:20-27`

```ts
const token = randomUUID();
try { fs.writeFileSync(file, token, { mode: 0o600 }); }
catch { /* read-only fs — token still works in-memory for this run */ }
return token;
```

The comment is wrong: main and the daemon are **separate processes** that each call `readOrCreateToken` (`index.ts:1162`, `pty-daemon.ts:76`). If the file can't be created (read-only/full userData), each process mints a *different* in-memory UUID. The daemon then injects `HCP_TOKEN=<A>` into agents while main validates against `<B>` → every driver `req` returns `UNAUTHORIZED`, with no diagnostic. Low-probability environment but a silent, total failure.

**Fix:** on write failure, log loudly; ideally fail fast / surface a one-line "HCP disabled: cannot persist token" rather than handing out a token that the other half won't accept.

---

## LOW

### L1 — Spawn read-epoch TOCTOU can skip the first turn
`methods.ts:62-70`

For `tile.spawn_agent`, `armRead(res.tileId)` runs *after* `callRenderer` returns (the renderer already created the tile and `queueWork`ed the prompt). If the agent's first turn completes before `armRead` executes, `recordTurn` bumps seq to 1, then `armRead` captures `sendSeq=1`, so the following `hive_read` waits for turn **2** and misses the first reply. Narrow window, but real. Capture the epoch *before* requesting the spawn, or have the renderer return a pre-spawn seq snapshot.

### L2 — Unbounded driver-side maps; 24 h renderer-verb leak on window close
`methods.ts:41-42`, `index.ts:1126-1138`

- `sendSeq`/`sendMark` are never pruned (`tile.close` forgets the tracker/recorder but not these closure maps) — slow growth per distinct tile.
- `pendingHcp` entries for long verbs (`review.open`, 24 h timeout) are only cleared by `hcp:result` or their own timer. If the window closes mid-review, the entry — and the held HCP socket on the MCP side — sits for up to 24 h. On `window`/`before-quit`, reject all `pendingHcp` and clear their timers.

### L3 — Synchronous full-file transcript reads on the main loop, per turn and per read
`transcript.ts:39`, `index.ts:1187`, `methods.ts:97`

`readLastAssistantMessage` does `fs.readFileSync(entire transcript)` then splits. It runs in the main/daemon event loop on every Stop event (pipe forwarding) and every `agent.read`. Claude transcripts grow to MBs over a long session → measurable main-thread stalls. Read tail-first (reverse-chunked) or move to async with a size cap.

### L4 — Forged `turn` event can spoof a read reply and read an arbitrary user-readable file
`index.ts:1179-1194`, `stop-hook-source.ts`

Hook `event`s are unauthenticated by design (0600 socket = same-uid). Within that model, note that `transcriptPath` is taken verbatim and `readLastAssistantMessage(transcriptPath)` will read *any* path the user can read — it is not constrained to the tile's session dir. A same-uid process can forge `{t:"event",topic:"turn",data:{tileId:"hm:victim",transcriptPath:"/arbitrary"}}` to bump a blocked `agent.read` and feed it attacker-chosen "assistant text," or to trigger a pipe write. Same-uid is already game-over, so low — but constraining `transcriptPath` to the known sessions dir is cheap defense-in-depth.

### L5 — Plan-review gate fails OPEN with no UI
`index.ts:1100`, `plan-bridge.ts:65-69`

When the window is closed (or the hook payload won't parse / lacks `plan`), the bridge replies `allow` and the agent's `ExitPlanMode` proceeds unreviewed. Reasonable as a liveness default, but it means a human-approval gate auto-approves whenever the app isn't foregrounded. Flag explicitly; if plan review is ever treated as a guardrail (not just UX), this should be configurable to fail-closed.

### L6 — `DEPTH_EXCEEDED` is defined but never enforced; only the global rate cap bounds fork-bombs
`claude-resume.ts:111-114`, `protocol.ts:49`, `index.ts:1153-1158`

`HIVE_AGENT_DEPTH` is hardcoded `"0"` (the depth-threading is a documented Phase-2 TODO), so a spawned agent can recursively spawn, every child at depth 0. The only backstop is the global 16-spawns/rolling-minute cap (`hcpSpawnAllowed`). That does bound total throughput, but there is no per-lineage limit and `DEPTH_EXCEEDED` is dead. Acceptable for now given the rate cap; track it.

### L7 — Spawn rate slot is consumed before the renderer spawn can fail
`index.ts:1153-1158`, `methods.ts:60-66`

`spawnAllowed()` pushes a timestamp and returns true *before* `callRenderer("tile.spawn_agent")`. If the renderer verb then throws/times out, the slot is still burned against the 16/min budget. Minor; only matters under sustained spawn failures.

---

## Things checked that are correct

- Bare→`hm:` mapping for the **main** verbs (`agent.send`/`read`, `tile.close`) is consistent: `ptyId()` on the way in, tracker/recorder both `hm:`-keyed, `recordTurn` fed the `hm:` `HIVEMIND_TILE`. Turn-completion wakeups line up.
- `OutputRecorder` ring cap + `since()` delta math is sound (returns ≤ ring on rollover, `truncated:true`).
- `takeLines` enforces the 1 MiB line cap and the server drops the conn on overflow; JSON-parse failures don't wedge the reader.
- Backpressure in `broadcast` increments `seq` then skips the send when `writableLength > 4 MiB`, so a slow subscriber gets a detectable gap instead of OOMing main.
- `TurnTracker.waitForTurn` cleans its waiter on timeout and on resolve; `forget` clears timers. No waiter leak on the normal paths.
- `shq()` correctly POSIX-quotes the renderer-controlled `id` before it lands in the SessionStart/Stop hook command strings — no shell injection via tileId.
- `hcpCall` settles exactly once (`settled` guard) across `ok`/`fail`/`data`/`error`/`close`/timeout, and `timer.unref()` keeps it from pinning the agent process alive.
- MCP `CANVAS_TOOLS` correctly skip `.hivemind/` root resolution, so canvas tools work in a repo without an issue workspace.

REVIEW DONE
