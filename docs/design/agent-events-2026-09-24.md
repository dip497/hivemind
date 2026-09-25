# Agent events — one vocabulary for what every agent reports

Status: design, 2026-09-24. Branch `feat/agent-events`, from `main` 6bbe87f.

## 1. Summary

1. Every agent already reports through hooks, but each hook is one of our scripts named after a
   Claude hook (`stop`, `userPrompt`, `notification`, `subagent`) that reads Claude's field names
   and posts one of four topics. Plugins, window titles, screen rules and process exit reach status
   by other routes, and status is rebuilt in the renderer from five channels.
2. This introduces a small **canonical event vocabulary** owned by the host — `session.started`,
   `session.ended`, `turn.started`, `turn.ended {outcome}`, `input.requested {kind}`,
   `subagent.started`, `subagent.stopped` — and lets a manifest **map a native event to a canonical
   one as data** (`emit:`), through one generic hook script.
3. Hooks that *decide* (plan review, the approval broker) stay as named scripts; the canonical layer
   is observe-only.
4. Main translates canonical events onto today's handlers, so nothing downstream changes in this
   step. The next step replaces those handlers with one status store in main, fed by every source.
5. What an agent can report becomes derivable from its manifest instead of a hand-set flag.

## 2. Why: what others do, from their source

Checked in source on 2026-09-23 (shallow clones; file:line from each repo at the commit named).

| | Superset (033439d) | Orca (641a7f36) | T3 Code (f5ef0ddb) | Ours |
|---|---|---|---|---|
| Normalized event | `AgentLifecycleEventType` = Start, Stop, PermissionRequest, Failed, Attached, Detached (`packages/host-service/src/events/map-event-type.ts:15-21`) | `AgentStatusEntry` with `stateStartedAt`, `stateHistory`, and a source facet hook/osc/title/process (`src/shared/agent-status-types.ts:84`, `agent-status-observation.ts:12-58`) | `ProviderRuntimeEventV2`: turn.started/completed/aborted, request.opened/resolved, user-input.requested… (`packages/contracts/src/providerRuntime.ts:1176-1228`) | four HCP topics named after Claude hooks |
| Where status is decided | host-service store, persisted (v1 kept it in the renderer; v2 moved it) (`terminal-agents/store.ts:143-240`) | main's hook server, persisted to `last-status.json`; renderer mirrors (`docs/reference/agent-status-store.md:69-79`) | server, event-sourced SQLite (`OrchestrationEngine.ts:245-327`) | renderer status bus |
| Per-agent mapping | TypeScript per agent (`packages/agent-setup/src/agent-setup.ts:83-161`) | TypeScript per agent; launch config is a static record (`src/shared/tui-agent-config.ts:324`) | adapter class per provider | **manifest data** — the one thing we already do better |
| Hook install | writes the user's global configs (`agent-wrappers-claude-codex-opencode.ts:70-72`) | global for Claude/Gemini, managed `CODEX_HOME` too (`src/main/claude/hook-settings.ts:114`) | — | per launch, never global |

Every host converged on one normalized event per agent state and one place that owns status. Ours
has the better mapping model (data, per launch) but not the normalized event.

## 3. What the agents on this machine actually fire

Probed read-only on 2026-09-23 (binary strings, bundled source, help output).

| Canonical | Claude 2.1.280 | Codex 0.155.1 | Gemini 0.59.0 | OpenCode 1.17.12 (plugin) | Hermes (source 637e6f4) |
|---|---|---|---|---|---|
| `turn.started` | UserPromptSubmit | UserPromptSubmit | BeforeAgent | `session.status` busy | `pre_llm_call` |
| `turn.ended` done | Stop | Stop | AfterAgent | `session.idle` | `post_llm_call` |
| `turn.ended` failed | StopFailure | — | — | `session.error` | — |
| `input.requested` | PermissionRequest (immediate); Notification `permission_prompt` only after ~6 s | PermissionRequest | Notification | `permission.asked` | `pre_approval_request` |
| `subagent.*` | SubagentStart/Stop | SubagentStart/Stop | — | — | `subagent_start/stop` |
| `session.*` | SessionStart/End | SessionStart/End | SessionStart/End | — | `on_session_start/finalize` |

Claude's docs say the `Notification` hook with `permission_prompt` runs only after the dialog has
waited about six seconds, and `PermissionRequest` runs the moment Claude asks
(code.claude.com/docs/en/hooks, "PermissionRequest").

## 4. The vocabulary

```ts
type AgentEventName =
  | "session.started" | "session.ended"
  | "turn.started" | "turn.ended"
  | "input.requested"
  | "subagent.started" | "subagent.stopped";
type TurnOutcome = "done" | "failed" | "interrupted";
type InputKind = "permission" | "question" | "plan" | "approval" | "other";
```

A reported event carries the tile, the name, its qualifier, and a closed whitelist of payload
fields the host needs (`transcriptPath` for reading a reply, `agentId` for subagent counting,
`sessionId`, and on `turn.ended` a `background` count of shells the agent left running — Claude's
`Stop` payload lists them in `background_tasks`; no hook fires when one finishes, so the status
store treats a turn that ended with background work as still busy until a screen or hook signal
says otherwise). **Never** text the agent wrote (`last_assistant_message`, `message`, `prompt`): the
generic script does not read them.

Deliberately left out until a use case exists: tool-level events, message chunks, token usage,
`input.resolved` (resolution is the next `turn.started` or a status change).

## 5. Manifest: `emit` beside `hook`

```yaml
hooks:
  arg: --settings
  events:
    UserPromptSubmit: { emit: turn.started }
    Stop:             { emit: turn.ended, outcome: done }
    StopFailure:      { emit: turn.ended, outcome: failed }
    PermissionRequest: { emit: input.requested, kind: permission }
    PreToolUse:
    - { hook: plan, matcher: ExitPlanMode, timeout: 345600 }       # decides: stays a named script
    - { hook: approval, matcher: supervise, when: supervised, timeout: 600 }
```

- An entry has exactly one of `hook` (one of our scripts, or one the agent ships) or `emit` (a
  canonical event, rendered as the generic `event` script with the event in its environment).
- `emit` is observe-only by construction: the generic script never writes a decision to stdout.
- Old names keep working and are described in canonical terms (`stop` → `turn.ended`,
  `userPrompt` → `turn.started`, `notification` → `input.requested`, `subagent` → `subagent.*`), so
  what a manifest can report is derivable for old and new manifests alike.
- A manifest that uses `emit` needs an app that knows it; the registry gates it with
  `minAppVersion`, and an older app refuses it at validation rather than half-wiring it.

## 6. Transport and translation

The generic script posts HCP topic `agent.event` with `{ tileId, event, outcome?, kind?,
transcriptPath?, agentId?, sessionId? }`. `transcriptPath` stays top-level so the remote
sanitizer (`acceptRemoteEvent`) still drops it for another machine's tiles.

Main translates it onto today's handlers (`turn`, `status`, `notification`, `subagent`), so this
step changes no behaviour downstream. The standalone daemon (a remote machine) translates it
the same way before forwarding, so a desktop that predates canonical events still hears today's
topics, and phone pushes are named by the translated topic.

## 7. Stages

| # | Change | Owner | This branch |
|---|---|---|---|
| 1 | Vocabulary, `emit` in manifests, generic `event` script, translation in main and the standalone daemon | host + `hive-agents` | **done** (a281444, 369d24f) |
| 2 | Claude: PermissionRequest, StopFailure, SessionEnd through `emit`, in the published manifest | agent plugins | **blocked**: see below |
| 3 | Start a tile's terminal when the tile is created, not when a view first shows it | host | **done** (c56ee9f) |
| 4 | One status store in main, persisted, fed by every source (hooks, plugins, titles, screen, exit), with the renderer and views as mirrors; the view protocol's `since`/events become projections | host | next milestone |
| 5 | Codex, Gemini, OpenCode, Hermes mappings, each probed per launch, never touching global config | agent plugins | later |

## 8. Blocker for stage 2: the registry cannot hold an agent back from older apps

An app that predates `emit` refuses a manifest with an `emit` entry at validation. Installs and
updates are gated by the catalog's `minAppVersion` (`apps/desktop/src/main/plugin-catalog-ipc.ts:73`,
`:147`), but HiveHub writes `minAppVersion: null` for every agent (`hivehub/src/lib/registry.ts:111`).
Publishing Claude's new mappings today would make Claude fail validation on 2026.9.5 and older:
a fresh install would lose it and auto-install would skip it. Before stage 2 ships, HiveHub has
to carry a `minAppVersion` for agents (read from the manifest or set at publish), and the
maintainer has to decide what an older app gets: nothing with a clear message, or the previous
manifest.

## 9. Stage 3, as built

`tile-host.tsx` mounted a body only after a view's slot adopted it, so first mounts happened at
real size. A terminal no slot claims within `UNSEEN_MOUNT_MS` (1.5 s) now mounts in the park at
its kind's default size (`defaultSizeForKind`); the first view that shows it adopts the same live
terminal. Browsers and editors keep the old rule: a hidden `<webview>` costs a page load and
holds no session. Checked on the real app: two agents spawned with `hive ctl spawn` while a
community view that shows no tiles was active read `working` within 5 s (before: no status
after 30 s). `tests/e2e/unseen-terminal.spec.ts` fails without the change and passes with it.
