# hivemind-api

The Python client for the [Hivemind](https://hivemind.griiken.com/) API: a program of yours lists
a workspace's agents, starts one, reads its reply and answers what it waits on. Python 3.9+,
standard library only.

How to use it: https://hivemind.griiken.com/guide/api-connect/ (every method:
https://hivemind.griiken.com/guide/api-methods/).

## Install

It ships with the app, at the app's version; it is not on PyPI.

```sh
pip install ~/.hivemind-app/sdk/python        # Windows: %LOCALAPPDATA%\hivemind\sdk\python
pip install https://github.com/dip497/hivemind/releases/download/v<version>/hivemind_api-<version>-py3-none-any.whl   # a computer without Hivemind

hive grant create my-bot -w ~/work/api --role agents --expires 30d   # prints the token, once
```

## Example

```python
from hivemind_api import connect

# HIVE_DRIVE_TOKEN=<the token> HIVE_WORKSPACE=~/work/api python bot.py
with connect() as hive:
    tile = hive.agents.start({"program": "claude", "prompt": "Run the tests and fix what fails"})["tile"]
    reply = hive.agents.read(tile, timeout_ms=600_000)
    print(reply["text"])
```

With asyncio, import `connect` from `hivemind_api.aio` and await the same methods.

The same client in TypeScript:
[packages/sdk](https://github.com/dip497/hivemind/tree/main/packages/sdk).

## Contributing

The client follows the drive socket in
[`spec/workspace-api.md`](https://github.com/dip497/hivemind/blob/main/spec/workspace-api.md#drive-socket).

```sh
cd packages/sdk-python
PYTHONPATH=src python -m unittest discover -s tests
```

`tests/test_conformance.py` plays `conformance/drive.json`; `tests/test_live.py` starts a real
`hive host` from source, so it needs bun and `pnpm install` at the repo's root (it skips without
bun).
