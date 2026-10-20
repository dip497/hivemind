# hivemind-api

The TypeScript client for the [Hivemind](https://hivemind.griiken.com/) API: a program of yours
lists a workspace's agents, starts one, reads its reply and answers what it waits on. Node 20+ or
Bun; no dependencies.

How to use it: https://hivemind.griiken.com/guide/api-connect/ (every method:
https://hivemind.griiken.com/guide/api-methods/).

## Install

It ships with the app, at the app's version; it is not on the npm registry.

```sh
npm install ~/.hivemind-app/sdk/hivemind-api.tgz        # Windows: %LOCALAPPDATA%\hivemind\sdk\hivemind-api.tgz
npm install https://github.com/dip497/hivemind/releases/download/v<version>/hivemind-api-<version>.tgz   # a computer without Hivemind

hive grant create my-bot -w ~/work/api --role agents --expires 30d   # prints the token, once
```

## Example

```ts
import { connect } from "hivemind-api";

// HIVE_DRIVE_TOKEN=<the token> HIVE_WORKSPACE=~/work/api node bot.mjs
const hive = await connect();
const { tile } = await hive.agents.start({ program: "claude", prompt: "Run the tests and fix what fails" });
const reply = await hive.agents.read(tile, { timeoutMs: 600_000 });
console.log(reply.text);
hive.close();
```

The same client in Python:
[packages/sdk-python](https://github.com/dip497/hivemind/tree/main/packages/sdk-python).

## Contributing

The client follows the drive socket in
[`spec/workspace-api.md`](https://github.com/dip497/hivemind/blob/main/spec/workspace-api.md#drive-socket).
`bun test` here plays the cases in `conformance/drive.json` and drives a real `hive host`.
