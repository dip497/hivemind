# Agents driving plugins: one state machine per running plugin (2026-10-16)

**Verdict.** Give every running plugin (a tool's tile, a widget with code, a community view) one
lifecycle, `starting → ready → failed | stopped`, owned by the window that runs it. Every agent
verb reads that state: `plugin open` returns once the plugin can be called, `plugin call` waits for
a plugin that is still starting, `plugin list` shows every running plugin with its state, and
`plugin close` ends one. The error code, and one time budget, travel the whole way from the plugin
to the agent's exit status.

## Problem

**Goal.** An agent in a tile can find, start, call and stop the plugins in the app through
`hive ctl`, and can branch on what went wrong without parsing prose.

**Constraints.** Plugins run only in a window (`hive host` has none). The window is the only owner
of a plugin's link (`@hivemind/view-host/link`). The CLI's exit codes are a documented contract
(`apps/cli/src/hcp.ts` `EXIT`). Working rules: one owner per job, no seams for tests.

**The path a call takes today, and its numbers.** Six hops: CLI → drive socket → host
`ControlWork.pluginCall` (`packages/host/src/control/methods.ts`) → main `callWindow` (IPC,
`apps/desktop/src/main/index.ts`) → the window (`Workspace.tsx`, `plugin-commands.ts`) → the
plugin's link (`MessagePort`) → the plugin. Limits: a command's argument ≤ 64 KB
(`INVOKE_ARGS_MAX`), its answer ≤ 256 KB, 10 calls a second (`callBucket`). Running plugins in a
window: about 1 view + a handful of tool tiles and widgets; 20 is a busy board.

**What is broken, measured from the code.**

| Defect | Where | Effect on an agent |
|---|---|---|
| A plugin is listed only once ready *and* with commands | `plugin-link.tsx` offer effect | one starting, failed, or without commands is invisible |
| `plugin open` returns before the plugin connects | `Workspace.tsx` `plugin.open` | a `call` straight after says "is not running here"; the e2e spec polls 15 s to hide it |
| The window's error code is dropped | `hcp:result` carries a message only; main makes it `FAILED` | unknown plugin or command exits 1, not the documented 5 |
| `AMBIGUOUS` is not an `ErrorCode` | `plugin-commands.ts` | a code no client knows |
| Timeouts are inverted | CLI 30 s (`drive.ts`), link 30 s, host 35 s | a slow command ends in the CLI's generic TIMEOUT; the plugin's own answer is lost |
| A widget cannot be removed, a view not left, by an agent | no verb | the board fills with what agents opened |
| The views here are not discoverable | `hive views list` reads disk only | `view:windows`, `view:canvas` exist and nothing lists them |

**The known problem.** This is *remote object lifecycle with readiness*: the same problem as a
browser's debugging targets, a language server's start-up, and a pod that is running before it is
ready, plus *deadline propagation* across hops.

## What others do

- **Chrome DevTools Protocol, Target domain**
  ([reference](https://cdpstatus.reactnative.dev/devtools-protocol/tot/Target)): `getTargets`
  lists every target whatever it is doing, `closeTarget` ends one by id, and
  `targetCreated` / `targetInfoChanged` / `targetDestroyed` report each change. Teaches: list all
  instances, not only the useful ones; address them by an instance id; close by that id.
- **Language Server Protocol**
  ([3.19 spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.19/specification)):
  a request before `initialize` gets a *coded* error (`ServerNotInitialized`, −32002), not a
  generic failure. Teaches: "not ready yet" is its own state with its own code.
- **Kubernetes pods and `kubectl wait`**
  ([kubectl wait](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_wait)): phase
  (Pending, Running, Succeeded, Failed) is separate from the Ready condition, and clients wait
  for `condition=Ready` rather than polling. Teaches: running ≠ ready; give the caller the wait.
- **gRPC deadlines**
  ([deadline propagation](https://oneuptime.com/blog/post/2026-01-08-grpc-deadlines-timeouts/view)):
  one absolute deadline set by the caller; each hop forwards what is left, minus a margin, so
  the innermost hop fails first and its reason reaches the caller. A deadline exceeded does not
  mean nothing ran. Teaches: one budget, shrinking inward; outer timeouts strictly longer.

## Options

**A. Patch in place (the boring one).** Carry the code through `hcp:result`, raise the CLI's
timeout, add `plugin.list` over the current offers, add a close verb.

```
CLI ──► host ──► main ──► window: offers{ready && commands} ──► plugin
```

Breaks first: correctness, not size. A plugin still appears only once ready with commands, so
`list` cannot show a starting or failed one, and `open → call` still races.

**B. A lifecycle per running plugin, in the window that runs it (chosen).**

```
                       ┌──────────── window ─────────────┐
CLI ─► host ─► main ─► │ instances: Map<token, Instance> │ ─► link ─► plugin
 budget+10s  budget+5s │  starting ─connected─► ready    │
                       │     │ timedOut/disabled  │disabled│
                       │     ▼                    ▼        │
                       │   failed ──stopped──► (removed)   │
                       └─────────────────────────────────┘
```

The link's host (`usePluginLink`) feeds the machine: mounted → `starting`, connected → `ready`,
disabled → `failed`, unmounted → `stopped` (removed), and 15 s without connecting → `failed`.
Every verb reads it: `list` shows every instance, `open` and `call` wait (within the budget) for
one that is starting, `close` ends one by its instance id. Codes are thrown where the fact is
known and carried unchanged to the CLI.

**C. The registry in the host (the bold one).** The window reports each transition to the host
over IPC; the host keeps the state, answers `list` itself, and could stream transitions to agents
and serve several windows.

```
window ──transition events──► host registry ◄── CLI
```

Breaks first: two copies of the truth. A reloaded or crashed window leaves the host listing
plugins that no longer run, until a reconciliation the design must add; every transition costs
an IPC message.

**Scale.** The limiting number for each design, at today's size (≈20 running plugins in a
window, 10 calls a second), 10x and 100x:

| Design | Today (20) | 10x (200) | 100x (2,000) |
|---|---|---|---|
| A | list is blind to starting/failed: wrong at any size | same | same |
| B | `list` ≈ 20 × 0.4 KB = 8 KB; holds | 80 KB; holds | ≈ 800 KB: over a 256 KB answer, ceiling |
| C | 20 × ~4 transitions = 80 IPC messages per board load; holds | 800; holds | 8,000 per load, and the stale-entry risk grows with it |

Arithmetic: an instance listed is about 150 bytes of id, label, state and reason, plus about
250 bytes for a few declared commands with descriptions: ≈ 0.4 KB. Calls are capped at 10 a
second by the host whatever the design, so call rate never limits B or C. A's row is not a
number because A's failure is not one of size: it gives the wrong answer at 1 plugin.

## Choice

**B.** It fixes every defect at today's size with one owner of the truth: the window already owns
the link, so it owns the state. A lost because the visibility and race defects are structural,
not sizes. C lost because it duplicates the window's truth in the host to buy streaming and
multi-window answers nobody needs yet. B keeps the door open to them: the transition events it
fires are exactly what C would ship to the host.

**What was surprising.** The race was invisible from the CLI: `plugin open` succeeded, the plugin
loaded a few hundred milliseconds later, and the e2e spec papered over the gap with a 15 s poll.
An agent following the documented order (`open`, then `call`) fails every first call. And the
timeouts were not only out of order: the outermost (the CLI's) was the *shortest*, so the
plugin's own reason could never reach the agent.

## Pre-mortem

A year on, B failed. The likely reasons, and what changed:

1. **A plugin stuck in `starting` forever** (its code never connects; a tool tile's `connect`
   fails without disabling the link). → `starting` has its own timer: 15 s, then `failed` with
   "it did not start in 15 s". `open` and `call` never wait past their budget either.
2. **A remount crossing an unmount** (React's strict mode, a view switched away and back, which
   reuses the view id as the instance id). → Entries are keyed by a token per mount, not by
   instance id; a stale unmount removes only its own token. Lookups by instance id take the
   newest live entry.
3. **An agent waiting on a window that is not drawing** (a hidden window throttles timers, so a
   plugin connects late). → `open` never fails on a slow start: it answers the state it reached
   within its budget (`starting`), and the agent can `call` (which waits again) or `list`. A
   known ceiling: a hidden window can make a first call time out; the code says `TIMEOUT`, and
   the reason says it was still starting.

Ceiling written down: about 600 running plugins in one window before `plugin list` passes the
256 KB answer (600 × 0.4 KB); paging the list is the upgrade if a board ever gets there.

## Build order

1. **The machine and registry** (`renderer/src/workspace/plugin-instances.ts`, replacing
   `plugin-commands.ts`): the transition table, the start timer, waiting with a deadline, coded
   errors. Checked by unit tests driving every transition, each shown to fail when its rule is
   broken.
2. **Feed it from the link's host** (`plugin-link.tsx`): every instance, with or without
   commands. Checked by the e2e spec listing a starting and a ready plugin.
3. **Codes end to end**: `hcp:result` carries the code; main keeps a known one. Checked by the
   e2e spec asserting exit 5 for an unknown plugin and command.
4. **One budget**: `PLUGIN_CALL_MS` in `@hivemind/workspace-api`; the window uses it as a
   deadline, the host waits it + 5 s, the CLI it + 10 s. Checked by a CLI unit test on the
   timeout it asks for.
5. **Verbs**: `plugin.list` and `plugin.close` (workspace API 0.27), `open` answering the state
   reached; `hive ctl plugin list|close`. Checked by `ctl-drive.test.ts` against a fake socket
   and the e2e spec end to end (open → call with no poll; close removes the widget).
6. **Docs**: the spec table, the hivemind skill (the verbs, the states, the exit codes), the
   CHANGELOG.

## Unknown

- How long a heavy community view takes to connect on a slow machine: 15 s is a guess from the
  10 s the SDK's own `connect` waits. Check: log the time to `ready` in the e2e run and on a
  real desktop.
- Whether any third-party script drives `plugin.commands` and would notice instances without
  commands: none in this repository or HiveHub's examples do; the method is unchanged, so they
  would not.
- Events to agents (a plugin telling an agent something changed) are not built: the machine's
  transitions are the hook for a later `plugin watch`.
