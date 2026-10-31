# Hook protocol

How a hook invocation talks to the host. A hook is a short-lived process the agent CLI runs;
it reads the agent's payload on stdin, sends one or two lines, and exits 0 — it never blocks the
agent on the host being there. One that answers what the agent asks (`agent.await_answer`) waits
for that answer, and exits 0 printing nothing when the host is not there.

## Environment

| Variable | Set on | Meaning |
|---|---|---|
| `HIVEMIND_TILE` | every hook | the session the hook reports for |
| `HCP_TOKEN` | the agent's spawn env | authorizes requests |
| `HIVE_EVENT`, `HIVE_EVENT_OUTCOME`, `HIVE_EVENT_KIND` | `emit:` entries | the canonical event the generic script reports |
| `HIVE_EVENT_ANSWER` | `emit:` entries with `answer:` | `1`: the script waits for the answer and prints it |
| `HIVE_EVENT_REPLY` | `emit: turn.ended` entries with `reply:` | the payload's field that holds the turn's reply |
| `HIVE_EVENT_KEEP` | the spawn env of an agent with hooks; `emit:` entries with `answer:` | the payload's keys the native hook passes on, comma separated |
| `HIVE_SDK` | a plugin's own scripts; the spawn env of an agent with `launch.hcp`, for a plugin that runs inside it | path of the SDK to `require` |
| `HIVE_HOOK_SOCK` | the same | the host socket |
| `HIVE_PLAN_SOCK` | a plugin's own scripts | the plan-review socket |
| `HIVE_SUPERVISE` | a plugin's own scripts, supervised sessions | `all` or a comma list of tools the supervisor brokers |

## Messages (JSON-RPC 2.0, one per line, on `HIVE_HOOK_SOCK`)

Every connection signs in first: `initialize {"token": HCP_TOKEN}`, the tile's own token. Sent as
a notification (no `id`) it asks for no reply, which is how a hook that reads nothing signs in: a
reply written to a connection whose writer already ended is never let go of on some runtimes. The
host hears nothing else from a connection that has not signed in, notifications included. A tile's token speaks
only for its tile: a notification naming another tile is dropped, a request refused with
`FORBIDDEN`. The person's token may name any tile.

`HIVE_HOOK_SOCK` is the machine's control-plane socket, and the PTY daemon that runs the session
holds it, whether the app or `hive host` serves the control plane: it passes each connection on to
that control plane's own socket, and tells every other device watching it each event and reply it
heard there (`agent.event`, `agent.reply`, and the session's `agent.status`, see `status.md`). With
no control plane behind it, the daemon hears events itself and refuses every request at once.

- **Event** — the notification `{"jsonrpc":"2.0","method":"agent.event","params":{…}}`, `params`
  per `agent-event.schema.json`, after `initialize`. No reply. The host drops fields outside the
  schema.
- **Requests**, after `initialize`:
  - `agent.reply {"tileId","text"}` → `{"ok":true}`. The turn's reply for `hive ctl read`, sent
    before the `turn.ended` it belongs to. Never forwarded on the event stream or to push. A hook
    for an entry with `reply:` sends it as a notification after `initialize`, then the event, on
    one connection: the host handles notifications in order, so the turn end carries it. A line
    longer than the host takes (1 MB) ends the connection, turn end and all, so the hook cuts the
    reply to its first 256 KB as written.
  - `agent.await_approval {"callerTile","tool_name","tool_input"}` →
    `{"decision":"allow"|"deny"|"ask","reason"?}`. `ask`: nobody decided; the script falls
    back to the agent's own prompt, or refuses if the agent has none.
  - `agent.await_answer {"callerTile","hook","tool","input","agentId"?}`, sent after the
    `agent.event` it answers, on the same connection → `{"stdout"?: "<what the hook prints>"}`.
    Held while the agent waits on that event (`needs.md` "Answering"); no `stdout` when it
    stopped waiting, or when the host leaves it to the agent's own prompt. Refused where no
    desktop answers: the script prints nothing.

## The native hook (`hive-net hook <door>`)

Where the daemon has hive-net, an `emit:` entry runs `hive-net hook` instead of the generic script:
a pipe with no logic of its own, which starts no runtime. It reads stdin to its end, connects to the
pty daemon's hook door (a 0600 unix socket, `hook-door.sock` beside `hcp.sock`), and sends one line,
`{"env": {…}, "stdin": "<the agent's payload>"}`, where `env` holds `HIVEMIND_TILE`, `HCP_TOKEN` and
the `HIVE_EVENT*` variables and nothing else. `stdin` holds only the payload's keys `HIVE_EVENT_KEEP`
names, each as the agent wrote it, so a tool's output never reaches the door; all of it when nothing
is named or the payload is not a JSON object. It prints whatever the door sends back before closing.

The door says on `HIVE_HOOK_SOCK` what the script would have (`hook-lines.ts` builds both), and
sends back the answer's `stdout` for an entry that answers, nothing otherwise. A hook that asks for
nothing gives the door 1.5 s; one that answers waits until the agent ends it, and that end lets go of
the wait. No door, or nothing sent back: it prints nothing and exits 0.

The daemon runs the hive-net its starter names in `HIVEMIND_HIVE_NET` (the app and `hive daemon`
name the one they found), after one empty hook went through it. On Windows, and without one, the
script runs.

## Plan review (on `HIVE_PLAN_SOCK`)

`{"tileId":…,"plan":…,"cwd":…}` → `{"decision":"deny","feedback":…}` or any other decision to
proceed. No answer: proceed.

## What a hook counts

`background` on an event counts the payload's `background_tasks` with `status` `running`. `awaiting`
counts those that come back to the agent when they finish: `status` `running` or `pending`, `type`
`subagent`, `workflow`, `cloud session` or `MCP task`. A `shell` or a `monitor` may run for as long as
it likes and a `teammate` is `running` while it sits idle, and a type not listed counts for nothing.
A `turn.ended` leaves out either count at 0; a `subagent.stopped` whose payload has the list says
`awaiting` at 0 too, and says none of it without the list. `status.md` says what `awaiting` does.

The SDK (`packages/agent-sdk`) wraps all of this; a plugin in another language can speak it
directly.
