# Status

A session's status is a fold over its inputs, in order, starting from
`{state: "idle", subagents: [], background: 0, compacting: false}`. Inputs are canonical events
(`agent-event.schema.json`) and two facts the host observes itself: `exited` (the process ended)
and `interrupt` (the user sent an interrupt key during a turn).

States: `idle`, `working`, `waiting`, `done`, `failed`, `interrupted`, `limited`, `exited`.

| From | Input | To |
|---|---|---|
| `exited` | anything | `exited` (final) |
| any | `turn.started` | `working` |
| any | `input.requested {kind}` | `waiting`, with `kind` |
| `waiting` | `input.resolved` | `working` |
| any | `turn.ended {outcome}` | the outcome's state; `background` = the event's count, or 0 |
| `working`, `waiting` | fact `interrupt` | `interrupted` |
| any | fact `exited` | `exited` |

`kind` is present only while `waiting`. `subagent.started`/`subagent.stopped` add and remove
their `agentId` from `subagents` (a repeated start is one subagent). `compacting.started`/`ended`
set `compacting`. `session.*` events change nothing: they are facts for the session record, and
some agents report a session start mid-turn.

A host may read a session's screen until the session's first event, and only then: from the
first event the fold alone decides, starting from the initial status, not from what the screen
last read.

Cases: `../conformance/status.json`.
