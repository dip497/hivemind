# Agent host — an open, multi-language library for running coding agents

Status: design, 2026-09-25. Supersedes the package split sketched in `session-host-2026-09-25.md`
(its goals stand; this is where the code lives and how it is specified).

## 1. What it is

A **session host for agent CLIs**: it runs them in real terminals, keeps their sessions alive
independent of any UI (locally or over ssh), turns each agent's native signals into **one
normalized event stream and status** through declarative adapters, and serves that to clients in
any language. The Hivemind desktop app and the `hive` CLI become two clients of it.

What it is not: a UI, a model, an orchestrator. Orchestration (workflows, pipes, reviews) stays in
the product and is built on the host's events.

## 2. Principles

1. **Spec first.** The wire protocol, the adapter manifest and the event vocabulary are versioned
   JSON Schemas with prose. Implementations follow the spec; a conformance suite decides.
2. **No agent in the host.** No agent names, file paths, transcript formats or output patterns in
   host code. Everything agent-specific is an **adapter**: manifest data, plus optional asset
   scripts that run inside the agent's own hook invocation and talk to the host through the SDK.
   Enforced by a test that fails on any agent name or agent path in the host packages.
3. **Signals, not guesses.** Status comes from hooks and from facts the host observes itself
   (process exit, the user's own keystrokes). Reading the screen is a *declared fallback* for
   agents that have no hooks, labelled as such in every status it produces. No regex anywhere.
4. **Privacy by construction.** Events carry ids, kinds, counts and times — never text the agent
   wrote. Replies (for `hive ctl read`) travel on a separate, token-gated request, never on the
   event stream.
5. **Clients draw only what is shown.** The host keeps every screen; a client subscribes to the
   terminal bytes of the sessions it displays and gets a snapshot when it starts showing one.
6. **Measure before optimizing.** Language choices are made by a benchmark against the
   conformance suite, not by preference.

## 3. Parts

| Part | Contents | Language | Consumers |
|---|---|---|---|
| **spec/** | JSON Schemas + prose: adapter manifest, event vocabulary, host wire protocol (JSON-RPC 2.0), hook→host message | language-neutral | everyone |
| **conformance/** | Recorded byte streams and hook payloads with expected events and status; protocol transcripts; the detector golden corpus (8041 screens today) | data + a thin runner per language | every implementation |
| `agents` (exists: `@hivemind/agents`) | Manifest validation, catalog, vocabulary types, hook rendering, fallback screen matcher | TypeScript | host, CLI, plugin authors |
| **`agent-sdk`** (new, tiny) | What adapter assets import: `emit(event)`, `reportReply(text)`, `requestApproval(req)`, `openPlanReview(plan)`; how a hook finds its session and the socket | TypeScript first; the protocol is small enough to port | adapter assets |
| **`agent-host`** (new) | The daemon: terminals, screen model, snapshots, persistence, event ingestion, status store, event log with sequence replay, interest per client, ssh bridge; plus a client library | TypeScript reference; Rust candidate (§6) | desktop, CLI, third parties |
| adapters | One folder per agent: `agent.yaml` + assets (the `hivemind-plugins` registry) | data + asset scripts using the SDK | host at runtime |

Monorepo first (`packages/agent-sdk`, `packages/agent-host`, `spec/`, `conformance/` here), split
into its own repository once the spec is at 1.0 and a second client exists.

## 4. The wire protocol (host ↔ client)

JSON-RPC 2.0 over a local socket (unix socket / named pipe; ssh stdio for remote), with a
separate binary data channel for terminal bytes so large output never goes through JSON.

- `initialize {protocolVersion, clientInfo, capabilities}` → host version + capabilities
  (negotiated like LSP/ACP; unknown capabilities are ignored, never errors).
- Sessions: `session/create`, `session/attach {id, since?}` → snapshot or delta, `session/input`,
  `session/resize`, `session/kill`, `session/list`.
- Interest: `session/watch {ids}` — the only sessions whose bytes this client receives.
- Events: `events/subscribe {since?}` → `events/notify` with a monotonic `seq`; `since` replays
  from the host's log, falling back to a status snapshot past its window.
- Status: `status/get`, and status changes as events (value + `since` + `source`).
- Control: approvals and plan reviews as requests the host routes to whichever client answers.
- `schema/get` returns the schemas the running host implements, and `agent-host schema` prints
  them: a client in another language generates types from the binary it talks to.

One socket, typed frames: a frame is either a JSON-RPC message or a raw byte chunk for one
session (`[type][session][len][bytes]`), so terminal output never pays for JSON and there is one
connection to authenticate, not two.

### Hook → host

A hook invocation is a short-lived client with one message: `event/report {id, session, token,
event, …}`.

- **Identity.** Each session gets a capability token at spawn (in its environment, alongside the
  session id). The host accepts a report only for the session the token was minted for — a hook
  cannot report for another session by setting an env var.
- **Delivery.** `id` is unique per report (the hook makes it), the host acks, and duplicates are
  dropped by id. If the host does not ack in 200 ms the hook appends the report to a spool file
  and exits 0; the host drains the spool when it next starts or when the session reconnects. A hook
  never blocks its agent.

## 5. Adapter model

- **Data** (most agents): launch args and env, prompt delivery (`argv | typed-when-ready`),
  resume (how to resume and what to do if resuming fails), hook mappings (`emit:`), capabilities,
  fallback screen rules, icon. Hook config is injected per launch, never into the user's global
  config.
- **Assets using the SDK** (when data is not enough): a turn-end hook that reads the agent's own
  transcript and calls `reportReply`; an approval hook in that agent's decision format calling
  `requestApproval`; a plan-review hook. The host never parses an agent's files.
- Found hardcoded today and moving out of the host: transcript roots and reader
  (`main/index.ts:1917`, `hcp/transcript.ts`), the resume-failure regex and `--resume`/`--session-id`
  swapping (`pty-session-manager.ts:150`, `pty-daemon.ts:363`), Claude-shaped hook scripts and
  notification types, the plan and approval scripts, `stabilizeClaudeStatus`, the 15 s staleness
  timeout, `isClaude` in `TerminalTile.tsx:255`.

### Naming: three namespaces, never mixed

```yaml
hooks:
  events:
    Stop:                     # native: the agent CLI's own event name, as its docs spell it
      - emit: turn.ended      # canonical: from the spec vocabulary, validated
    StopFailure:
      - emit: turn.ended
        outcome: limited
        matcher: rate_limit   # the agent's own matcher picks the case; the host adds nothing
      - emit: turn.ended
        outcome: failed
        matcher: overloaded|authentication_failed|billing_error|server_error|unknown
    PreToolUse:
      - run: hooks/approve.cjs          # script: a path inside the plugin, using the SDK
        matcher: ExitPlanMode
        produces: [input.requested]     # what it may emit — declared, so the host can check
```

A plugin author never invents a canonical name, and the host never learns a native one. `run:`
scripts may only emit what `produces:` declares; anything else is dropped and logged.

### Status: one state machine, one authority

Status is a fold over the session's events — the same events in the same order give the same
status in every implementation (the conformance suite checks exactly this).

Starts `idle`; `exited` is final.

| From | Input | To |
|---|---|---|
| any | `turn.started` | `working` |
| any | `input.requested {kind}` | `waiting {kind}` (a lost `turn.started` does not hide a question) |
| `waiting` | `input.resolved` | `working` |
| any | `turn.ended {outcome}` | `done` / `failed` / `interrupted` / `limited` |
| `working`, `waiting` | user sent interrupt (host observed) | `interrupted` |
| any | process exit (host observed) | `exited` |

`session.*` events change no state — Claude's `SessionStart` arrives mid-turn after an automatic
compaction. Reference: `packages/hive-agents/src/status.ts`.

Orthogonal to the state, and carried with it: `subagents` (count from `subagent.*`),
`background` (from `turn.ended`), `compacting` (bool), `source` (`hooks` | `protocol` | `screen`),
`since`.

**One authority per session.** A session's status comes from exactly one source. It is `hooks`
when the adapter declares hooks and they have reported since spawn; it is `screen` for an adapter
without hooks. If a hooked session prints steadily for 30 s with no hook report since spawn, the
host marks its hooks unhealthy, switches the session to `screen` (when the adapter has fallback
rules) and says so in the status. It never mixes sources within one session.

### Hook inventory (probed 2026-09-25)

| Canonical | Claude 2.1.280 | Codex 0.155.1 | Gemini 0.59.0 | OpenCode 1.17.12 (plugin) | Hermes |
|---|---|---|---|---|---|
| `session.started {source}` | SessionStart (startup/resume/clear/compact/fork) | SessionStart | SessionStart | — | — |
| `session.ended {reason}` | SessionEnd | SessionEnd | SessionEnd | — | — |
| `turn.started` | UserPromptSubmit; Notification `quota_auto_resume_fired` | UserPromptSubmit | BeforeAgent | `session.status` busy | `pre_llm_call` |
| `turn.ended` | Stop; StopFailure → `failed`/`limited` | Stop; `turn_aborted` → `interrupted` | AfterAgent | `session.idle`; `session.error` → `failed` | `post_llm_call` |
| interrupted | none (Stop does not run) → host-observed | Interrupt | host-observed | host-observed | host-observed |
| `input.requested {kind}` | PermissionRequest (immediate); Elicitation → `question`; PreToolUse ExitPlanMode → `plan` | PermissionRequest | Notification | `permission.asked` | `pre_approval_request` |
| `input.resolved` | PostToolUse, PostToolUseFailure, PermissionDenied, Notification `elicitation_response` | PostToolUse | AfterTool | — | — |
| `subagent.*` | SubagentStart/Stop | SubagentStart/Stop | — | — | `subagent_start`/`subagent_stop` |
| `compacting` | PreCompact / PostCompact | PreCompact | — | — | — |

Not events: `TaskCreated`/`TaskCompleted` are the agent's todo list; Claude's `Notification
permission_prompt` arrives ~6 s after `PermissionRequest` and is ignored when the latter is
mapped. Session facts that are not status — cost, context-window use, model — come from an
adapter's status-line hook (Claude runs one after every assistant message) and land on the session
record, never the event stream.

Protocol agents (ACP, Codex app-server) are sessions of kind `protocol`: their structured
updates are the source (`source: "protocol"`), mapped to the same vocabulary; the canonical names
follow ACP's where they overlap.

### New in the vocabulary

- `input.resolved` — the question was answered (either way).
- `session.ready` — the agent can take typed input; a prompt delivered `typed-when-ready` waits
  for it, instead of a fixed delay.
- `turn.ended` outcome `limited` (usage limit), picked by the agent's matcher.
- `compacting.started` / `compacting.ended`.

The host never touches an agent's login: it launches the user's own CLI as the user would.

## 6. Language and performance

Measured 2026-09-25 (100 streaming sessions): host-side cost is small — main 7–8 % CPU, daemon
5 % (TypeScript + node-pty + a headless xterm.js per session), hook invocation ~4 ms. The cost is
in the client renderer (54–77 %), which interest subscriptions address.

The reasons for a **Rust daemon** are distribution and footprint, not today's CPU:
one static binary per platform (no native Node addon rebuilt for Electron and Bun, which we shim
today), lower memory per session, first-class ConPTY on Windows, easy embedding for other
languages. Candidate building blocks: `portable-pty` (PTY + ConPTY), a VT screen model that can
serialize a redraw (`vt100`/`alacritty_terminal`/`wezterm-term` — to be chosen by snapshot
fidelity against xterm.js), `tokio`, `serde`.

Rule: the Rust daemon ships only when it passes the full conformance suite (byte streams → same
events, same status, snapshots that render identically in xterm.js) and beats the TypeScript
reference on a published benchmark (RSS and CPU at 100 and 500 sessions, attach latency).

## 7. Compatibility

- Protocol and manifest carry versions; `initialize` negotiates capabilities, and a manifest may
  declare `requires: [features]` so an old host refuses with a clear message instead of failing
  validation. (Today a manifest using `emit` fails on old apps, and the registry cannot hold it back
  — `hivehub/src/lib/registry.ts:111` writes `minAppVersion: null` for agents.)
- The desktop app keeps working throughout: each step below is a refactor behind the same
  behaviour until the step that changes it.

## 8. Steps

| # | Step | Gate |
|---|---|---|
| S0 | Draft `spec/` (schemas + prose) from today's behaviour; build `conformance/` by recording real sessions (bytes, hook payloads) with their expected events and status | the TS host passes the suite as it stands |
| S1 | Extract `packages/agent-host` from `apps/desktop/src/main` (daemon, session manager, protocol, event server) — no behaviour change | all unit and e2e tests green; desktop and CLI import from the package |
| S2 | `packages/agent-sdk`; move Claude's plan review, approval and transcript reply into Claude-adapter assets; host-agnostic test enforced | provider goldens green; `hive ctl read` and approvals e2e green |
| S3 | Declared resume with a signal-based failure path; delete the output regex | restore/resume tests green on the real Claude CLI |
| S4 | Status store in the host (hooks-first, `input.resolved`, interrupt-from-input, exit), event log with replay, JSON-RPC protocol v1 | status-bus tests ported; views and `hive ctl` read the host |
| S5 | Interest subscriptions in the desktop client; hidden terminals hold no renderer copy | re-profile at 100 sessions; renderer cost tracks visible terminals |
| S6 | Rust daemon prototype against the conformance suite; benchmark | switch only on a pass + a measured win |

### Where each step landed (2026-09-25, `feat/agent-events`)

- **S0** — `spec/` (event, status, hook and wire protocols), `conformance/` (status folds, hook
  reports), a sync test against the TS constants.
- **S1** — `packages/agent-host`: the daemon, session manager, protocol, hook scripts.
- **S2** — `packages/agent-sdk`, written by the host as `hive-sdk.cjs`. Claude's reply (from its
  Stop payload), plan review and approval broker, Droid's transcript reply, Kiro's broker and
  Pi's reply live in those agents' plugins. The host reads no transcript and ships no
  agent-shaped script. The naming model became `hook: <name>` on an `assets` entry with
  `produces:` rather than a separate `run:` key.
- **S3** — `session.resume.exists`; the output regex is gone. A restore that fails fast is still
  retried once, on the exit the host observes.
- **S4** — `StatusStore` in `agent-host`, run by main (and fed by remote daemons); one push to
  the renderer, `status/subscribe` for any client. The control plane is JSON-RPC 2.0 only
  (`spec/wire-protocol.md`); nothing speaks the old line format. The hook-health rule is the
  simplest one that holds: the screen stands in until a session's hooks first report.
- **S5** — the host reads agents' screens (the daemon's headless terminals, or the in-process
  host's), so the renderer scrapes nothing. A terminal no view shows gets no bytes; shown again,
  it is sent the host's screen, in order with the stream.
  Re-profiled 2026-09-25 with 100 streaming terminals (xvfb, so CPU shares only, on a box
  at load ~60): renderer 77% → 7.6% CPU with every terminal parked (xterm work: none), and
  62% → 19% on the canvas, where terminals outside the viewport now get nothing either;
  renderer RSS 632 → 355 MB. The `content-visibility` experiments add little on top (14% / 7%),
  so they stay out.

## 9. Decisions (defaults taken 2026-09-25, revisit before 1.0)

1. Package names `agent-host` and `agent-sdk`; repository name decided at the split.
2. Agents without hooks get the labelled screen fallback.
3. Canonical names align with ACP's where they overlap; a full ACP `session/update` projection is
   a client concern, not the host's.
