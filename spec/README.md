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
| `workspace-api.md` | What a workspace's host is asked for, over any transport; a community view shown on another device's screen | 0.17 |
| `identity.md` | Device, person and workspace keys, and device certificates | 0.1 |
| `network-profile.md` | Where a network's servers are, signed by its admin | 0.1 |
| `network-access.md` | Who may use a network's relays: enrolment, vouchers, registration | 0.1 |
| `pairing.md` | Two devices of one person: the code (and the way onto its network), the proofs, the person key handed over (a phone: a certificate and its network), the person's other devices learning of a phone, whose a phone is (their name and colour), and unpairing | 0.8 |
| `host-record.md` | Which device hosts a workspace now, signed by the workspace's key | 0.1 |
| `hosting.md` | Moving a workspace's hosting between the owner's devices, and who follows it | 0.4 |
| `agents.md` | Every agent of the person's, live, as their phone follows it; starting one from the phone, interrupting its turn with its agent's keys, closing it, what it changed, and what it and the person said to each other | 0.4 |
| `needs.md` | What waits on the person, on which machine, how their phone asks for it, answers it (a permission allowed or denied with the agent's own keys) and sends an agent a message | 0.5 |
| `push.md` | What a phone is told while the person is away, encrypted to it, a permission it may allow or deny said so; that a device it found away is back; and the network's push server, which passes on what the devices a phone named sign | 0.4 |

Versions are `major.minor`: a minor adds optional fields or enum values a reader may ignore; a
major changes or removes something. Until 1.0 anything may change.

The TypeScript constants in `packages/hive-agents/src/events.ts` and `status.ts` are checked
against these files by `packages/hive-agents/tests/spec-sync.test.ts`, and the pairing words in
`packages/workspace-host/src/pairing-words.ts` against `pairing-words.json` by
`packages/workspace-host/tests/pairing.test.ts`.
