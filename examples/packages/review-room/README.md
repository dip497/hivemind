# Review room bundle (inspection prototype)

One bundle contains the Board view — sessions moving from doing, to review, to done — and two
reviewer agent presets. It references existing Pi
and Claude integrations; it does not install their binaries or provide credentials.

From the repository root:

```sh
pnpm --filter @hivemind/example-view-board build
node examples/packages/review-room/build.mjs
bun apps/cli/src/index.ts packages inspect examples/packages/review-room/dist --json
```

The result includes all prompts, view permissions, provider supervision, the proposed
startup selection, and a digest of every file. Nothing is installed or started.
"Do not edit" in a prompt is an instruction, not an enforced filesystem restriction.

Installation, trusted updates, and running the reviewed plan are subsequent phases.
See `docs/design/package-marketplace.md`.
