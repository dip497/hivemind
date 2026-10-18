---
title: Connect and call
description: Open the drive socket, say hello with your token, call a method, and hear events.
---

Every message is one line of JSON. The first line you send says who you are; after that you send
calls and receive answers and events.

## 1. Find the socket

`hive grant create` prints its path (`socket` with `--json`). By default:

| System | Drive socket |
|---|---|
| Linux | `~/.config/hivemind/drive.sock` (or `$XDG_CONFIG_HOME/hivemind/drive.sock`) |
| macOS | `~/Library/Application Support/hivemind/drive.sock` |
| Windows | a named pipe; use the path `hive grant create` prints |

The app or `hive host` must be running, with the workspace open.

## 2. Say hello

Send within 10 seconds of connecting:

```json
{"hello": {"token": "hgr_…", "workspace": "/home/you/work/api"}}
```

`workspace` is the workspace's folder. Leave it out when the token reaches only one workspace.

| You get back | Means |
|---|---|
| `{"hello": {"api": "0.30", "as": {"client": "dashboard", "role": "view", "workspace": "/home/you/work/api"}}}` | you are in; `role` is what you may do |
| `{"error": {"code": "FORBIDDEN", "message": "…"}}` | wrong, revoked or expired token, or a workspace it does not reach; the connection closes |
| `{"error": {"code": "BAD_REQUEST", "message": "…"}}` | no hello, no workspace named, or the workspace is not open; the connection closes |

## 3. Call a method

A call has an `id` you choose, a `method` and a list of `params`. The answer carries the same `id`
and either a `result` or an `error`:

```json
{"id": 1, "method": "agent.list", "params": ["/home/you/work/api"]}
{"id": 1, "result": {"seq": 0, "agents": []}}
```

```json
{"id": 2, "method": "agent.start", "params": ["/home/you/work/api", {"program": "claude", "prompt": "Run the tests"}]}
{"id": 2, "error": {"code": "FORBIDDEN", "message": "agent.start is not open to your role on this workspace"}}
```

Wherever a method takes a folder (`repo`), give the workspace's folder. Answers can come out of
order, so match them by `id`.

## 4. Hear events

Lines without an `id` are events, `{"event": "…", "params": [...]}`, about the workspace's tiles
only. Several events from one moment may arrive as a JSON list on one line. Useful ones:

| Event | Tells you |
|---|---|
| `agent.changed` | an agent appeared, changed or went |
| `agent.event` | a turn ended, an agent is waiting, was answered, or reported |
| `status.changed` | an agent's status changed |
| `terminal.data` | output of a terminal you opened |
| `file.changed` | files changed in the workspace |

## A whole example in Python

This connects, lists the agents and tries to start one. With a `view` token, as here, the start
is refused. It runs on Linux and macOS (a Unix socket).

```python
import json, os, socket

SOCK = os.environ["HIVE_DRIVE_SOCK"]       # the path hive grant create printed
TOKEN = os.environ["HIVE_DRIVE_TOKEN"]     # the token
FOLDER = os.environ["HIVE_WORKSPACE"]      # the workspace's folder

s = socket.socket(socket.AF_UNIX)
s.connect(SOCK)
f = s.makefile("rw")

def send(msg):
    f.write(json.dumps(msg) + "\n")
    f.flush()

def call(id, method, *params):
    send({"id": id, "method": method, "params": list(params)})
    while True:
        msg = json.loads(f.readline())
        if isinstance(msg, dict) and msg.get("id") == id:   # skip events
            return msg

send({"hello": {"token": TOKEN, "workspace": FOLDER}})
print(f.readline())                        # {"hello": {"api": "0.30", "as": {…}}}
print(call(1, "agent.list", FOLDER))       # {'id': 1, 'result': {'seq': 0, 'agents': []}}
print(call(2, "agent.start", FOLDER, {"program": "claude", "prompt": "Run the tests"}))
```

## The same in Node

```js
import net from "node:net";
import readline from "node:readline";

const { HIVE_DRIVE_SOCK, HIVE_DRIVE_TOKEN, HIVE_WORKSPACE } = process.env;
const socket = net.connect(HIVE_DRIVE_SOCK);
const waiting = new Map();
let next = 1;

const call = (method, ...params) => new Promise((resolve) => {
  const id = next++;
  waiting.set(id, resolve);
  socket.write(JSON.stringify({ id, method, params }) + "\n");
});

readline.createInterface({ input: socket }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  else console.log(line);                // the hello, then events
});

socket.write(JSON.stringify({ hello: { token: HIVE_DRIVE_TOKEN, workspace: HIVE_WORKSPACE } }) + "\n");
console.log(await call("agent.list", HIVE_WORKSPACE));
socket.end();
```

## Start an agent and wait for its reply

With an `agents` token:

```json
{"id": 3, "method": "agent.start", "params": ["/home/you/work/api", {"program": "claude", "prompt": "Run the tests"}]}
{"id": 3, "result": {"tile": "…"}}
{"id": 4, "method": "agent.read", "params": ["<tile>", 600000]}
{"id": 4, "result": {"text": "…", "finalStatus": "turn", "truncated": false}}
```

`agent.read` waits up to the milliseconds you give for the turn to end. `finalStatus` is `turn`
(the reply), `timeout` (ask again), `closed`, `waiting` (it asks something: answer with
`agent.answer`) or `asleep`.

## Error codes

| Code | Means |
|---|---|
| `FORBIDDEN` | the role does not allow it; nothing ran |
| `BAD_REQUEST` | wrong params, or a path outside the workspace |
| `NOT_FOUND` | no such tile, frame or workspace |
| `UNSUPPORTED` | the agent cannot do that (no turn signal, no sessions) |
| `TIMEOUT` | what it waited on did not come in time |
| `UNAVAILABLE` | it needs one of your windows open |
| `RATE_LIMITED` | too many started at once; ask again later |
| `FAILED` | it ran and failed; `message` says why |
