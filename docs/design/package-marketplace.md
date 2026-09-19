# Packages, marketplace, and startup

Status: design + read-only inspection prototype. No remote installer or package runner
ships in this phase. Visual design comes after the runtime and trust boundaries.
The priority order, configurable views, and target agent-plugin lifecycle are defined
in [plugin-configuration.md](plugin-configuration.md).

## Product model

A package can contain views, agent presets, or both. A combined package can propose a
startup layout and several agents. Users install once, then use **Start** to review and
launch that setup in a chosen workspace. Opening the app, changing views, visiting a
marketplace page, and installing a package must not start agents.

Keep three concepts separate:

| Component | Meaning | Execution boundary |
|---|---|---|
| View | A renderer over existing frames and tiles | Current sandboxed view protocol |
| Agent preset | Provider id, prompt, optional supported model | Existing installed CLI; its permissions apply |
| Provider adapter | Code for spawning, status, hooks, and resume | Host integration; not downloadable code in v1 |

A view permission does not sandbox an agent. A prompt that says “read only” does not
enforce read-only access. Skills and workflow prompts are also executable instructions
by proxy; they need content review and explicit workspace scope before support is added.

## Package format and current prototype

`hivemind-package.json` wraps existing `hivemind-view.json` components. It does not
change the working view SDK. The strict schema and limits live in
`packages/hive-core/src/packages.ts`.

- `apiVersion: 1`, publisher/name id, display name, immutable version.
- Up to 8 embedded view directories and 16 agent presets.
- Optional startup: one included view, up to 8 distinct preset ids, concurrency 1–4.
- Presets reference the host's enabled provider catalog. Unsupported model overrides
  fail; omitting a model keeps the provider's default.
- No scripts, lifecycle hooks, custom executables, shell arguments, environment values,
  permission-mode overrides, workspace paths, provider modules, or auto-start fields.

`hive packages inspect <dir> --json` validates local files, checks component references,
reports view permissions and every agent prompt, and produces a startup plan. It does
not contact the app, probe binaries, install, or run anything. The result includes a
SHA-256 digest over sorted file paths, sizes, and hashes. It is an inspection snapshot,
not a publisher signature, security certification, or future execution grant.

Limits: 4,096 directory entries, depth 16, 128 MiB total, 16 MiB per file, 64 KiB per
manifest. Symlinks, hardlinks, special files, traversal, unknown fields, reserved view
ids, future view protocols, and missing references are rejected. The inspector is not
an archive extractor or a hardened importer for a concurrently hostile local tree.

`examples/packages/review-room` combines the existing Orbit view with Pi and Claude
presets. It builds an inspectable package without installing or starting it.

## Installation and updates: next boundary

Use a content-addressed immutable store. Verify an archive into a private staging
directory before exposing it to a renderer or parsing its startup plan for execution.
Reject traversal, links, device files, duplicate/ambiguous paths, excessive entries,
and decompression bombs. Never run npm install or lifecycle scripts for a package.

Activation changes a single package-version pointer after all components validate.
Keep the previous version for explicit rollback. This is atomic activation of files,
not an atomic promise about external agent work. A failed start can already have made
model requests or edits; rollback cannot undo those effects.

Existing single-view installs are a local, user-selected-folder flow. Their review
receipt compares manifests; it does not bind every asset or verify publisher identity.
Do not expose that flow directly to arbitrary marketplace downloads. Embedded view ids
also need namespacing or explicit collision refusal before bundle installation: one
package must not silently replace another package's view.

An update may not silently expand permissions or change the reviewed startup plan.
Bind grants to publisher identity, full content digest, capability set, workspace
scope, and effective provider configuration. Re-review changed grants. Names and version
strings alone are not authority. Uninstall revokes future starts; stopping live agents
is an explicit action affecting only that package run's recorded tile ids.

## One-action start

The eventual desktop action and `hive packages start` must call the same host command:

1. Resolve the immutable installed digest and validate current grants.
2. Ask the user to choose a local/worktree/remote workspace; never take that path or
   SSH destination from a package. Show prompts, agent count, effective models, and
   available supervision. Credentials remain with the existing provider setup.
3. Preflight provider availability, required hooks, and workspace access before any
   spawn. Missing binaries/authentication require setup, not a downloaded shell command.
4. Create a run id, activate the selected view, and spawn with bounded concurrency.
5. Persist receipts as steps complete. Repeating the same request id returns the
   existing run instead of creating duplicate agents. Record partial failures and offer
   retry or stopping the agents created by that run.

Installation and start are distinct grants. A previously reviewed, unchanged plan can
start with one action within its granted workspace scope. The workspace and CLI remain
usable if the catalog is offline or a view fails.

## Marketplace on the project website

Use the repo-owned website for discovery: Views, Agent presets, and Bundles. Each entry
shows publisher, source, version, license, host compatibility, contents, permissions,
startup plan, digest, and provenance status. Search and metadata can be static. Do not
create a cloud workspace service or upload local repository data.

A website link may open the desktop review flow; it must never execute a shell command
or silently install/start a package. Catalog descriptions, previews, Markdown, and
prompts are untrusted content. Render them without scripts or unrestricted HTML.

Publisher identity and release metadata need authenticated signing, pinned trust roots,
key rotation, revocation, and rollback/expiry checks before remote updates. Use an
established update-verification library instead of inventing a signature scheme.
[TUF](https://theupdateframework.github.io/specification/) provides a reference for
versioned metadata, expiry, and rollback resistance. These checks govern fetching new
versions; offline use of an already accepted version needs a documented revocation
policy, and cannot learn about new revocations without connectivity.

Build provenance links an artifact to its source/build; it does not prove the code is
safe. Keep that distinction visible, as [npm's provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
also does. Signing keys and credentials never live in the static website bundle.

## Performance and isolation

No registry fetches, archive hashing, signature verification, or package scans on a
frame, input, or view-switch hot path. Load only the active view's renderer; inactive
views must stop animation/subscriptions. Existing input-latency gates still apply.

Provider adapters must not be imported from downloaded packages into Electron main or
the PTY daemon. A future adapter host needs a narrow brokered API and OS-enforced
restrictions; a separate process or Node VM alone is not a security boundary. Keep
Electron's sandbox/context-isolation and validate IPC senders, following the
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Sequence

1. Strict local inspection and plan output — this change.
2. Hardened staged import, immutable storage, collision handling, and bound grants.
3. Host-side start/stop receipts, idempotency, failure recovery, and integration tests.
4. Signed catalog/downloads and website discovery; then visual design.
5. Separately evaluate third-party provider adapters and skill packs.

Each phase needs failure tests before becoming an execution path. The inspector is
useful now for reviewing a proposal; it does not make marketplace execution safe yet.
