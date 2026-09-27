# Wire protocol (HCP 2)

What a client — `hive ctl`, an agent plugin's scripts, a program in any language — speaks to a
running host. JSON-RPC 2.0, one message per line, over a unix socket only its owner can open
(a named pipe on Windows). The socket and token are `HIVE_HCP_SOCK` and `HCP_TOKEN` inside an
agent the host started, else `<config>/hivemind/hcp.sock` and `hcp.token`.

## Connection

1. `initialize {"token"}` → `{"protocolVersion": 2, "rendererUp", "capabilities": {"status"}}`.
   Every other request before it is refused with `UNAUTHORIZED`.
2. Requests and notifications, in any order. A hook's `agent.event` notification needs no
   `initialize` (see `hook-protocol.md`).

## Errors

`{"code": -32000, "message", "data": {"code"}}` for the host's own failures, `data.code` one of
`BAD_REQUEST`, `UNKNOWN_METHOD`, `UNAUTHORIZED`, `APP_NO_RENDERER`, `RATE_LIMITED`,
`DEPTH_EXCEEDED`, `TILE_NOT_FOUND`, `TIMEOUT`, `UNSUPPORTED`, `UNAVAILABLE`, `INTERNAL`.
`-32601` for an unknown method, `-32600` for a malformed message, `-32700` for bad JSON.

## Streams

- `status/subscribe {"since"?}` → `{"cursor", "snapshot"}` (every session's status) or, when
  `since` is still in the host's log, `{"cursor", "changes"}` (what changed after it). Then
  `status/changed {"seq","tileId","status"}` notifications, `status` per
  `status.schema.json` plus `source` (`hooks` | `screen`) and `since` (ms). `status/unsubscribe`.
- `agent.stream/subscribe {"tileId","since"?,"lines"?}` → `{"subscriptionId","offset"}`, then
  `agent.stream {"subscriptionId","seq","chunk","offset","replay"?}` notifications: a tile's
  output as text, `seq` 0 for the catch-up. A gap in `seq` means chunks were dropped for a slow
  reader. `agent.stream/unsubscribe {"subscriptionId"}`.

## Methods

The verbs `hive ctl` uses — `tile.spawn_agent`, `agent.send`, `agent.read`, `agent.report`,
`agent.approve`, `workflow.run`, … — take and return the shapes `hive ctl --json` prints.

`agent.sessions {"agent", "cwd"?, "limit"?}` → `{"agent", "resumable", "sessions": [{"id",
"cwd"?, "title"?, "updated"?}]}`, newest first; only sessions started in `cwd` when it is given.
`UNSUPPORTED` for an agent whose manifest does not say where its sessions are.
`tile.spawn_agent {"resume": id}` starts the agent on that session instead of a new one.
