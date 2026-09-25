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

### Status without guesses, for agents with hooks

| State | Signal |
|---|---|
| turn started / ended / failed | `turn.started`, `turn.ended {outcome}` |
| needs you / answered | `input.requested {kind}` / `input.resolved` (PostToolUse, PostToolUseFailure) |
| interrupted | the agent's hook (Codex `Interrupt`), or the host seeing the user send Esc/Ctrl+C during a turn |
| subagents, background shells | `subagent.*`; `turn.ended {background}` |
| exited | process exit, observed by the host |

Agents without hooks get the fallback screen rules, and their statuses carry `source: "screen"`.

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

## 9. Open decisions

1. Names for the packages and the future repository.
2. Agents without hooks: labelled screen fallback (recommended) or running/exited/activity only.
3. Whether the event vocabulary should also be expressible as ACP `session/update` for clients
   that already speak ACP.
