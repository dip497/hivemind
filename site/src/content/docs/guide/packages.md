---
title: Packages
description: Inspect a bundle of views and agent presets.
---

**Development preview.** `hive packages inspect` is in the CLI. Installing a package, downloading
one from HiveHub and starting it are not implemented.

A package (`hivemind-package.json`) can include up to eight views, up to sixteen agent
presets, or both. A preset names an installed agent as its `provider`, with a prompt and an
optional model; a package cannot add an agent, install binaries, supply credentials, or set a
permission mode.

## Inspect the example

It lives in [the published plugins](https://github.com/dip497/hivemind-plugins). From a clone:

```sh
npm install && npm run build
node packages/review-room/build.mjs
hive packages inspect packages/review-room/dist --json
```

This combines the Board view with Pi and Claude presets. The report includes:

- Every agent prompt, provider, and available supervision.
- View permissions and a proposed startup plan.
- File hashes and a digest covering the entire package.

Nothing is installed or started. Inspection does not verify publisher identity or code
safety. Agent prompts can lead to file edits and commands under the agent CLI's own
permissions; the view sandbox does not constrain them.

The proposed startup flow is: install a reviewed version, choose a workspace, then
start its view and agents in one action. Visual design and marketplace publishing come
after the installation and execution boundaries are implemented.
