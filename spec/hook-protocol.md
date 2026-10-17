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
| `HIVE_EVENT_KEEP` | the spawn env of an agent with hooks; `emit:` entries with `answer:` | the payload's keys the native hook passes on, comma separated |
| `HIVE_SDK` | a plugin's own scripts; the spawn env of an agent with `launch.hcp`, for a plugin that runs inside it | path of the SDK to `require` |
| `HIVE_HOOK_SOCK` | the same | the host socket |
| `HIVE_PLAN_SOCK` | a plugin's own scripts | the plan-review socket |
| `HIVE_SUPERVISE` | a plugin's own scripts, supervised sessions | `all` or a comma list of tools the supervisor brokers |

## Messages (JSON-RPC 2.0, one per line, on `HIVE_HOOK_SOCK`)

- **Event** — the notification `{"jsonrpc":"2.0","method":"agent.event","params":{…}}`, `params`
  per `agent-event.schema.json`. No token: the socket is the owner's alone. No reply. The host
  drops fields outside the schema.
- **Requests** need the connection introduced first: `initialize {"token": HCP_TOKEN}`, then
  - `agent.reply {"tileId","text"}` → `{"ok":true}`. The turn's reply for `hive ctl read`, sent
    before the `turn.ended` it belongs to. Never forwarded on the event stream or to push.
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

The SDK (`packages/agent-sdk`) wraps all of this; a plugin in another language can speak it
directly.
