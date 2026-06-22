# Agent status signals & the provider model

How hivemind knows what an agent tile is doing (working / idle / needs-you /
background) — and how to extend it to a new agent provider without touching the
core. Read this before adding a provider or a new status signal.

## Two layers

**1. Providers** decide how to *drive* and *observe* one agent CLI. A provider has
two capability surfaces, split by the Electron process boundary:

| Surface | Lives in | Responsibility |
|---|---|---|
| **Signal injection** (main) | `main/providers/` | spawn-time spec transforms: session resume **and** injecting the hooks that emit deterministic events |
| **Scrape detection** (renderer) | `renderer/src/agent-state.ts` | a screen-scrape status detector — the universal fallback every provider has |

Both surfaces are keyed by the same provider **`id`** (`"claude"`, `"codex"`, …).

**2. The signal bus** is provider-agnostic. Providers *produce* canonical events;
the bus *consumes* them and never knows which provider produced them.

## Canonical event vocabulary

A provider's deterministic signals all flow as HCP socket events
(`{t:"event", topic, data}`) into `main/index.ts`'s `onEvent`:

| topic | emitted by (claude hook) | main-side consumer | renderer effect |
|---|---|---|---|
| `status` | `UserPromptSubmit` | — | `hcp:turnstate` → tile reads `working` (turn started) |
| `turn` | `Stop` | `TurnTracker` | wakes `agent.read`; pipe-forwards reply; `hcp:turnstate` → `idle` (turn ended) |
| `subagent` | `SubagentStart` / `SubagentStop` | `SubagentTracker` | `hcp:subagent` → tile reads `working` while subagents run (incl. background) |
| `notification` | `Notification` | `notify-map` | `hcp:notify` → soft "needs you" (permission / question) |

**Working/idle is hook-driven for claude.** `UserPromptSubmit` (turn start → `working`) + `Stop` (turn end → `idle`) are the authoritative source for a claude tile's working/idle — NOT the screen-scrape. This is immune to claude's spinner-glyph/wording changes, to focus/scroll, and to the stale buffer replay on restart (a re-attached tile is seeded `idle` until a real turn fires, so it never shows the replayed buffer's stale "working"). The scrape remains the working/idle source for the 14 non-claude agents (no hooks) and the source of claude's instant permission/question detection.

These are the **deterministic** signals — event-driven, version-proof (a stable
hook contract, not a UI string), and correctly attributed (the hook runs inside
the spawning tile's own session, carrying `HIVEMIND_TILE`).

## The status precedence (renderer `agent-status-bus.ts`)

`effective(tile)` resolves one status from four inputs, highest first:

1. **explicit wait override** (`plan_review` / `awaiting_approval`) — a terminal
   pause the app set deliberately. Authoritative.
2. **needs-you** — a real human-required state: the scrape base
   (`permission` / `question` / `blocked`) or claude's `Notification` hook. A turn
   paused for you must read "needs you", never a stale "working".
3. **exited** — the process is gone; never masked as working/idle.
4. **subagent-busy** → `working` — covers a finished main turn that still has
   background agents running.
5. **liveTurn** (`working` / `idle`) — claude's HOOK-DRIVEN turn state
   (`UserPromptSubmit` / `Stop`). Set ONLY by a real hook event — never seeded —
   so it's authoritative over the scrape only once a hook has actually fired.
   Unset for non-claude agents AND for a claude process started before the hooks
   were injected → both fall through to the scrape. (An earlier version seeded
   `idle` on mount to mask the stale-replay "working" on restart, but the seed
   hard-overrode the scrape, so a hook-less running session got stuck reading idle
   while working — don't reintroduce it.)
6. **base scrape** — the per-tile screen-scrape (non-claude working/idle; claude
   before/without hooks).

Rule of thumb: **deterministic hooks are authoritative for the whole status
(working/idle via UserPromptSubmit/Stop, subagent, needs-you); the scrape is the
fallback for non-claude agents and for claude's instant permission/question.
Never remove the scrape** — 14 non-claude agents have no hooks.

## The hook-source factory

All three fire-and-forget hooks share one skeleton — connect, write one event,
fail-open — in `main/hcp/event-hook-source.ts`:

```ts
eventHookSource(topic, mapBody)   // mapBody: function(evt, tileId){ … return data | null }
```

`stop-hook-source`, `subagent-hook-source`, and `notification-hook-source` are
three lines each on top of it. (The approval-broker hook is separate — it
*blocks* on a req/res rather than firing an event.)

Every hook is **fail-open**: a missing socket/tile, a parse error, or a null
mapper result exits 0 without sending — the agent proceeds and the scrape covers
it. The HCP socket is `0600` (same-uid) so token-less events are trusted by the
socket boundary alone.

## Adding a provider

1. **main:** `providers/<name>.ts` implementing `AgentProvider`
   (`id`, `matches(cmd)`, optional `resume(ctx)` returning spec transforms). If
   the agent has a hook/event system, inject hooks in its spawn transform that
   emit the canonical `turn` / `subagent` / `notification` events. If it has none,
   omit `resume` — the scrape carries it.
2. Register it in `providers/registry.ts` `PROVIDERS`.
3. **renderer:** add a scrape detector in `agent-state.ts` keyed by the same `id`
   (an entry in `ALIASES` + `DETECTORS`).

Nothing in the daemon, the trackers, the status bus, or the IPC layer changes.
`composeResume()` folds the new provider in automatically (each provider no-ops
for specs it doesn't own, so composition is order-safe).

## Adding a new signal (existing provider)

1. A hook source via `eventHookSource(topic, mapBody)`.
2. A pure tracker/mapper module in `main/hcp/` (testable in isolation).
3. An `onEvent(topic)` branch in `index.ts` → push a typed IPC event.
4. An `HcpXEvent` type (`shared/ipc.ts`) + preload `onHcpX` + status-bus
   integration (decide: hard override vs. soft lift vs. tracker).
5. Tests at each layer; CHANGELOG entry.

This is the shape used by `turn`, `subagent`, and `notification` — follow it.
