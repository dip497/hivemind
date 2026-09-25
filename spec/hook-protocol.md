# Hook protocol

How a hook invocation talks to the host. A hook is a short-lived process the agent CLI runs;
it reads the agent's payload on stdin, sends one or two lines, and exits 0 — it never blocks the
agent on the host being there.

## Environment

| Variable | Set on | Meaning |
|---|---|---|
| `HIVEMIND_TILE` | every hook | the session the hook reports for |
| `HCP_TOKEN` | the agent's spawn env | authorizes requests |
| `HIVE_EVENT`, `HIVE_EVENT_OUTCOME`, `HIVE_EVENT_KIND` | `emit:` entries | the canonical event the generic script reports |
| `HIVE_SDK` | a plugin's own scripts | path of the SDK to `require` |
| `HIVE_HOOK_SOCK` | a plugin's own scripts | the host socket |
| `HIVE_PLAN_SOCK` | a plugin's own scripts | the plan-review socket |
| `HIVE_SUPERVISE` | a plugin's own scripts, supervised sessions | `all` or a comma list of tools the supervisor brokers |

## Messages (one JSON object per line, on `HIVE_HOOK_SOCK`)

- **Event** — `{"t":"event","topic":"agent.event","data":{…}}`, `data` per
  `agent-event.schema.json`. No reply. The host drops fields outside the schema.
- **Reply** — `{"t":"req","id":…,"method":"agent.reply","token":…,"params":{"tileId":…,"text":…}}`
  → `{"t":"res","id":…,"ok":true}`. The turn's reply for `hive ctl read`; sent before the
  `turn.ended` it belongs to. Never forwarded on the event stream or to push.
- **Approval** — `{"t":"req",…,"method":"agent.await_approval","params":{"callerTile":…,"tool_name":…,"tool_input":…}}`
  → `result: {"decision":"allow"|"deny"|"ask","reason"?}`. `ask`: nobody decided; the script
  falls back to the agent's own prompt, or refuses if the agent has none.

## Plan review (on `HIVE_PLAN_SOCK`)

`{"tileId":…,"plan":…,"cwd":…}` → `{"decision":"deny","feedback":…}` or any other decision to
proceed. No answer: proceed.

The SDK (`packages/agent-sdk`) wraps all of this; a plugin in another language can speak it
directly.
