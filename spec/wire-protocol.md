# Wire protocol (HCP 2)

What an agent's own plugin and hooks say to the host that started it, from its tile: a turn's
reply, a report to its starter, a tool use its starter approves, a plan a person reviews.
JSON-RPC 2.0, one message per line, over a unix socket only its owner can open (a named pipe on
Windows). The socket and token are `HIVE_HCP_SOCK` and `HCP_TOKEN` inside an agent the host
started, else `<config>/hivemind/hcp.sock` and `hcp.token`. Everything else — starting, sending,
reading, closing, naming, pipes, tools — is the workspace API on the drive socket
(`workspace-api.md`, "Drive socket"), which `hive ctl` speaks.

## Connection

1. `initialize {"token"}` → `{"protocolVersion": 2, "rendererUp"}`; sent as a notification it
   signs in with no reply. Every other request before it is refused with `FORBIDDEN`. The token says who calls: the
   host's own (`hcp.token`) is the person at the machine; an agent the host started is given one
   of its own, `<tile>.<MAC>`, which names its tile. A call made with a tile's token is that
   tile's: a `callerTile` naming another tile is refused with `FORBIDDEN`, and one naming none
   is taken as the tile's own. The person may name any tile.
2. Then requests and notifications, in any order. A notification from a connection that has not
   signed in is dropped, a hook's `agent.event` too (see `hook-protocol.md`), and so is one from a
   tile's token that names another tile.

## Errors

`{"code": -32000, "message", "data": {"code"}}` for the host's own failures, `data.code` one of
the workspace API's error codes (`workspace-api.md`, "Errors"): `BAD_REQUEST`, `UNKNOWN_METHOD`,
`FORBIDDEN`, `NOT_FOUND`, `NO_AGENT`, `ASLEEP`, `UNSUPPORTED`, `RATE_LIMITED`, `DEPTH_EXCEEDED`, `TIMEOUT`,
`UNAVAILABLE`, `FAILED`.
`-32601` for an unknown method, `-32600` for a malformed message, `-32700` for bad JSON.

## Methods

Each is the caller's tile's, and each but `agent.reply` is recorded in the host's audit log
(`audit.jsonl` beside `hcp.token`): who asked, what, of what, and whether it happened. Any other
method is `UNKNOWN_METHOD`.

- `agent.reply {"tileId", "text"}` → `{"ok": true}`: the reply of the turn the agent is ending,
  sent before the `turn.ended` event it belongs to. What `agent.read` answers with.
- `agent.report {"message"}` → `{"delivered": true, "parent"}`: a message to the agent or program
  that started this one, put in its starter's inbox (an `agent.event` of kind `reported` for a
  program). This turn's reply is then not forwarded to it
  as well. `NOT_FOUND` with no starter, or one that is gone. A starter asleep keeps it in its inbox
  and is told of it once woken: the answer adds `"asleep": true` and a `note` saying so (0.33).
- `agent.await_approval {"tool_name", "tool_input"}` → `{"decision": "allow" | "deny" | "ask",
  "reason"?}`: a supervised worker's hook, before a tool runs. Its starter is asked (an
  `approval` wait, answered with `agent.answer`); `ask` when nobody can answer, or nobody did in
  time. The wait ends when the connection that asked closes.
- `agent.inbox {"wait"?}` → `{"messages": [{"id", "at", "from", "name", "kind", "turn"?, "text"}],
  "dropped"}`: what other agents have for this one, oldest first, each given once. `kind` is
  `reply` (a turn of an agent it started or is piped from, unless read with `agent.read`),
  `report`, `waiting` (one it started waits on an answer) or `approval` (one it supervises asks
  to use a tool). With none, it waits up to `wait` ms (at most 10 minutes) for the first.
  `dropped`: how many older ones went unread past 500. Nothing an agent sends is typed into
  another's terminal: when its inbox gets a message, the agent is told once, at its prompt,
  `[hive] Your agents sent you messages. Read them: hive ctl inbox`.
- `review.open {"plan", "cwd"?}` → `{"decision": "allow" | "deny", "feedback"?}`: the agent waits
  on a person's review of its plan (a `plan` wait, answered with `agent.answer`). `TIMEOUT` when
  nobody reviews it, or the caller stops waiting.
