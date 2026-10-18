# hivemind-api

Drive a [Hivemind](https://github.com/dip497/hivemind) workspace from a Python program: list its
agents, start one with a prompt, read its reply, answer what it waits on, open frames and type into
terminals. It talks to the drive socket of the Hivemind app or `hive host` on the same machine,
with a token (`spec/workspace-api.md`, "Drive socket"). Python 3.9+, standard library only.

It ships with the app, at the app's version; it is not on PyPI. Install it from the copy the
installer put beside `hive`, from a release, or from the repository:

```sh
pip install ~/.hivemind-app/sdk/python        # Windows: %LOCALAPPDATA%\hivemind\sdk\python
pip install https://github.com/dip497/hivemind/releases/download/v<version>/hivemind_api-<version>-py3-none-any.whl
pip install "git+https://github.com/dip497/hivemind#subdirectory=packages/sdk-python"

hive grant create my-bot --workspace ~/work/api --role agents   # prints the token, once
```

## Example

```python
from hivemind_api import ApiError, connect

# HIVE_DRIVE_TOKEN=<the token> HIVE_WORKSPACE=~/work/api python bot.py
with connect() as hive:
    print(hive.as_)  # {'client': 'my-bot', 'role': 'agents', 'workspace': '/home/you/work/api'}

    for agent in hive.agents.list()["agents"]:
        print(agent["name"], agent["state"])

    tile = hive.agents.start({"program": "claude", "prompt": "Run the tests and fix what fails"})["tile"]
    reply = hive.agents.read(tile, timeout_ms=600_000)
    while reply["finalStatus"] == "waiting" and "waiting" in reply:
        # It asks to run a tool: allow it, then wait for the rest of its turn.
        hive.agents.answer(tile, reply["waiting"]["since"], {"decision": "allow"})
        reply = hive.agents.read(tile, timeout_ms=600_000)
    print(reply["text"])

    try:
        hive.call("git.commit", [hive.workspace, "wip"])  # any method, by name
    except ApiError as e:
        if e.code == "FORBIDDEN":
            print("this role may not commit")
```

With asyncio, the same methods are awaited:

```python
from hivemind_api import aio

async with await aio.connect() as hive:
    print((await hive.agents.list())["agents"])
```

## Connecting

`connect(token=None, workspace=None, socket=None)` says hello and returns once the host says who
you are. Each argument has a default:

| Argument | Default |
|---|---|
| `token` | `HCP_TOKEN` (an agent in a tile), `HIVE_DRIVE_TOKEN` (a grant), else the person's token on this machine |
| `workspace` | `HIVE_WORKSPACE`; needed only when the token reaches several workspaces |
| `socket` | `HIVE_DRIVE_SOCK`, else the app's: `~/.config/hivemind/drive.sock` on Linux, `~/Library/Application Support/hivemind/drive.sock` on a Mac, a named pipe on Windows |

A refused hello raises `ApiError`: `FORBIDDEN` for a token that is no grant (or was taken back),
`BAD_REQUEST` when the workspace must be named; `UNAVAILABLE` when nothing serves the socket.

## The client

| | |
|---|---|
| `as_` | who the host says you are: `"person"`, or `{"client" \| "agent", "role", "workspace"}` |
| `workspace` | the workspace's folder, which the helpers below pass as `repo` |
| `call(method, params, timeout_ms=None)` | any method of `spec/workspace-api.md` |
| `notice(method, params)` | a message the host does not answer (`terminal.write`, `terminal.resize`) |
| `on(event, listener)` | `listener(*params)` for each event (`agent.event`, `agent.changed`, `status.changed`, `terminal.data`), called on the client's own thread; returns the function that stops |
| `closed`, `close()` | an event set when the connection closes, from either end (`hive.closed.wait()`); close it |
| `agents.list()`, `agents.since(seq)` | the agents now, and each change after `seq` |
| `agents.start({"program", "prompt", …})` | start one: `{"tile": …}` |
| `agents.read(tile, timeout_ms=120_000)` | its reply at the end of its turn; `finalStatus` `turn`, `waiting`, `timeout`, `closed` or `asleep` |
| `agents.send(tile, text)`, `agents.answer(tile, since, answer)` | send it a message; answer what it waits on |
| `agents.output(tile, lines)`, `agents.interrupt(tile)`, `agents.close(tile)` | |
| `frames.open(spec)`, `frames.close(frame, options)` | a frame on a folder or a new worktree |
| `terminals.write(tile, data)`, `terminals.close(tile)` | type into a terminal; end it |

What a call may do is the token's role: `view`, `edit`, `terminals` or `agents`. Anything else is
answered `FORBIDDEN`. Every failure is an `ApiError` with a `code`: the host's (`FORBIDDEN`,
`NOT_FOUND`, `BAD_REQUEST`, `UNSUPPORTED`, `RATE_LIMITED`, `FAILED`, …) or the client's own
(`UNAVAILABLE` when the connection is gone, `TIMEOUT` when no answer came in time).

The same client in TypeScript: [packages/sdk](../sdk/README.md).

## Tests

```sh
cd packages/sdk-python
PYTHONPATH=src python -m unittest discover -s tests
```

`tests/test_conformance.py` plays `conformance/drive.json`; `tests/test_live.py` starts a real
`hive host` from source, so it needs bun and `pnpm install` at the repo's root (it skips without
bun).
