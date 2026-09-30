# Specs

Language-neutral contracts for the agent host and the workspace host. Implementations follow
these; the cases in `../conformance/` decide whether they do. Design:
`docs/design/agent-host-oss-2026-09-25.md` (agent host), `docs/design/multiplayer-2026-09-28.md`
(workspace API).

| File | What | Version |
|---|---|---|
| `agent-event.schema.json` | One canonical event, as a hook reports it | 0.1 |
| `status.schema.json` | A session's status | 0.1 |
| `status.md` | How events and host facts fold into that status | 0.1 |
| `hook-protocol.md` | What a hook sends the host, and the environment it gets | 0.2 |
| `wire-protocol.md` | What any client speaks to the host (JSON-RPC 2.0) | 2 |
| `workspace-api.md` | What a workspace's host is asked for, over any transport | 0.3 |
| `identity.md` | Device, person and workspace keys, and device certificates | 0.1 |

Versions are `major.minor`: a minor adds optional fields or enum values a reader may ignore; a
major changes or removes something. Until 1.0 anything may change.

The TypeScript constants in `packages/hive-agents/src/events.ts` and `status.ts` are checked
against these files by `packages/hive-agents/tests/spec-sync.test.ts`.
