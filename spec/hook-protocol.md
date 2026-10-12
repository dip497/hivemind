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

## Over http

An `emit:` entry with `via: http` is the agent's own http hook, where the agent has one
(`hooks.http` in its manifest) and the daemon opened its door: it says the same lines, said by the
daemon on its behalf, so nothing is started per event.

- `POST <door>/event?event=…&kind=…&outcome=…&answer=1`, the query in place of `HIVE_EVENT*`, the
  agent's payload as the body, `Authorization: Bearer <HCP_TOKEN>`. The token names the tile.
- `200` with an empty body: reported, or nothing to print. `200` with a JSON body: what the hook
  prints (`agent.await_answer`'s `stdout`), sent once the answer is there.
- `403` without a tile's token; `404` for anything but that POST, or a request that names an
  origin or another host than the door's (a page in a browser).
- The agent closing the request ends the wait, as closing the connection does.
- The door is loopback, on a port the daemon picks at start; with none, the entry is rendered as
  the generic script.

## Plan review (on `HIVE_PLAN_SOCK`)

`{"tileId":…,"plan":…,"cwd":…}` → `{"decision":"deny","feedback":…}` or any other decision to
proceed. No answer: proceed.

The SDK (`packages/agent-sdk`) wraps all of this; a plugin in another language can speak it
directly.
