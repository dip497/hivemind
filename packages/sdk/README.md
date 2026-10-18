# hivemind-api

Drive a [Hivemind](https://github.com/dip497/hivemind) workspace from a program: list its agents,
start one with a prompt, read its reply, answer what it waits on, open frames and type into
terminals. It talks to the drive socket of the Hivemind app or `hive host` on the same machine,
with a token (`spec/workspace-api.md`, "Drive socket"). Node 20+ or Bun; no dependencies.

It ships with the app, at the app's version; it is not on the npm registry. Install it from the
copy the installer put beside `hive`, or from a release:

```sh
npm install ~/.hivemind-app/sdk/hivemind-api.tgz        # Windows: %LOCALAPPDATA%\hivemind\sdk\hivemind-api.tgz
npm install https://github.com/dip497/hivemind/releases/download/v<version>/hivemind-api-<version>.tgz

hive grant create my-bot --workspace ~/work/api --role agents   # prints the token, once
```

## Example

```ts
import { connect, ApiError } from "hivemind-api";

// HIVE_DRIVE_TOKEN=<the token> HIVE_WORKSPACE=~/work/api node bot.mjs
const hive = await connect();
console.log(hive.as); // { client: "my-bot", role: "agents", workspace: "/home/you/work/api" }

for (const agent of (await hive.agents.list()).agents) console.log(agent.name, agent.state);

const { tile } = await hive.agents.start({ program: "claude", prompt: "Run the tests and fix what fails" });
let reply = await hive.agents.read(tile, { timeoutMs: 600_000 });
while (reply.finalStatus === "waiting" && reply.waiting) {
  // It asks to run a tool: allow it, then wait for the rest of its turn.
  await hive.agents.answer(tile, reply.waiting.since, { decision: "allow" });
  reply = await hive.agents.read(tile, { timeoutMs: 600_000 });
}
console.log(reply.text);

try {
  await hive.call("git.commit", [hive.workspace!, "wip"]); // any method, by name
} catch (e) {
  if (e instanceof ApiError && e.code === "FORBIDDEN") console.log("this role may not commit");
}
hive.close();
```

## Connecting

`connect({ token?, workspace?, socket? })` says hello and resolves once the host says who you are.
Each option has a default:

| Option | Default |
|---|---|
| `token` | `HCP_TOKEN` (an agent in a tile), `HIVE_DRIVE_TOKEN` (a grant), else the person's token on this machine |
| `workspace` | `HIVE_WORKSPACE`; needed only when the token reaches several workspaces |
| `socket` | `HIVE_DRIVE_SOCK`, else the app's: `~/.config/hivemind/drive.sock` on Linux, `~/Library/Application Support/hivemind/drive.sock` on a Mac, a named pipe on Windows |

A refused hello rejects with an `ApiError`: `FORBIDDEN` for a token that is no grant (or was taken
back), `BAD_REQUEST` when the workspace must be named; `UNAVAILABLE` when nothing serves the socket.

## The client

| | |
|---|---|
| `as` | who the host says you are: `"person"`, or `{ client \| agent, role, workspace }` |
| `workspace` | the workspace's folder, which the helpers below pass as `repo` |
| `call(method, params, { timeoutMs })` | any method of `spec/workspace-api.md`; typed where the API names it |
| `notice(method, params)` | a message the host does not answer (`terminal.write`, `terminal.resize`) |
| `on(event, listener)` | hear an event (`agent.event`, `agent.changed`, `status.changed`, `terminal.data`); returns the function that stops |
| `closed`, `close()` | resolves when the connection closes, from either end; close it |
| `agents.list()`, `agents.since(seq)` | the agents now, and each change after `seq` |
| `agents.start({ program, prompt, … })` | start one: `{ tile }` |
| `agents.read(tile, { timeoutMs })` | its reply at the end of its turn; `finalStatus` `turn`, `waiting`, `timeout`, `closed` or `asleep` |
| `agents.send(tile, text)`, `agents.answer(tile, since, answer)` | send it a message; answer what it waits on |
| `agents.output(tile, lines)`, `agents.interrupt(tile)`, `agents.close(tile)` | |
| `frames.open(spec)`, `frames.close(frame, options)` | a frame on a folder or a new worktree |
| `terminals.write(tile, data)`, `terminals.close(tile)` | type into a terminal; end it |

What a call may do is the token's role: `view`, `edit`, `terminals` or `agents`. Anything else is
answered `FORBIDDEN`. Every failure is an `ApiError` with a `code`: the host's (`FORBIDDEN`,
`NOT_FOUND`, `BAD_REQUEST`, `UNSUPPORTED`, `RATE_LIMITED`, `FAILED`, …) or the client's own
(`UNAVAILABLE` when the connection is gone, `TIMEOUT` when no answer came in time).

The same client in Python: [packages/sdk-python](../sdk-python/README.md).
