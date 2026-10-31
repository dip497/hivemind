# Status

A session's status is a fold over its inputs, in order, starting from
`{state: "idle", subagents: [], background: 0, compacting: false}`. Inputs are canonical events
(`agent-event.schema.json`) and three facts the host observes itself: `exited` (the process ended),
`interrupt` (the user sent an interrupt key during a turn) and `quiet` (see "Waiting on background
work").

States: `idle`, `working`, `waiting`, `done`, `failed`, `interrupted`, `limited`, `exited`.

| From | Input | To |
|---|---|---|
| `exited` | anything | `exited` (final) |
| any | `turn.started` | `working` |
| any | `input.requested {kind}` | `waiting`, with `kind` |
| `waiting` | `input.resolved` | `working` |
| any | `turn.ended {outcome}` | the outcome's state; `background` = the event's count, or 0 |
| any | `turn.ended {outcome: done, awaiting: n}`, n > 0 | `working`, with `awaiting` = n |
| `working` with `awaiting` | `subagent.stopped {awaiting: n}`, n > 0 | `working`, with `awaiting` = n |
| `working` with `awaiting` | `subagent.stopped {awaiting: 0}` | `done` |
| `working` with `awaiting` | fact `quiet` | `idle` |
| `working`, `waiting` | fact `interrupt` | `interrupted` |
| any | fact `exited` | `exited` |

`kind` is present only while `waiting`. `subagent.started`/`subagent.stopped` add and remove
their `agentId` from `subagents` (a repeated start is one subagent). `compacting.started`/`ended`
set `compacting`. `session.*` events change nothing: they are facts for the session record, and
some agents report a session start mid-turn.

A host may read a session's screen until the session's first event, and only then: from the
first event the fold alone decides, starting from the initial status, not from what the screen
last read. Two readings of the agent's own screen still count, because no event reports them: a
chooser shown while the fold says `working` is `waiting` until the screen moves on or an event
comes, and a `waiting` status ends (`idle`) when the screen moves from a chooser to the agent's
prompt.

## Waiting on background work

An agent can end its turn and still wait on work it started, which comes back to it when it
finishes: it is `working` until then, and `awaiting` says how many tasks. `background` counts every
task left running, `awaiting` only those: `turn.ended` without it is `done`, whatever `background`
says, so a dev server holds nothing. `awaiting` is present only while `working` or `waiting`, and
`turn.started`, an interrupt and an exit clear it.

The work usually comes back as a turn of its own, whose `turn.ended` counts again. Work stopped from
the agent's own screen can end with no turn and no hook, so a host folds the fact `quiet` once it
has heard no hook from a session with `awaiting` for 30 minutes. `quiet` leaves it `idle`, not `done`:
nothing says the work finished, so nothing is announced.

## Who keeps it

One place folds a session's status: the PTY daemon of the machine the session runs on, since every
hook it runs reports there (`hook-protocol.md`). It sends the status as `agent.status` to every
connection that asked for events, and each of them, the app on the same machine included, shows that
status as it is sent and folds nothing of its own into it but the session's end.

Cases: `../conformance/status.json`.
