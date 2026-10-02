# Conformance

Cases every implementation must pass, as data. A runner per language reads them.

| File | Checks | Runner (TypeScript) |
|---|---|---|
| `status.json` | inputs → status (`spec/status.md`) | `packages/hive-agents/tests/conformance.test.ts` |
| `hook-reports.json` | hook environment + agent payload → reported event | `apps/desktop/tests/unit/agent-event-hook.test.ts` |
| `identity.json` | seeds → ids, signatures, device certificates and workspace keys (`spec/identity.md`); made with ed25519-dalek and RustCrypto's hkdf | `packages/workspace-host/tests/identity.test.ts` |
| `network-profile.json` | signed network profiles → used or not, and their links (`spec/network-profile.md`); signed with Node's Ed25519 | `crates/hive-net/tests/profile.rs` (Rust) |
| `agents.json` | a device's boards, statuses and plans, and what its manifests say of each tile → every agent there, and what a phone shows of several devices' lists (`spec/agents.md`); written by hand from the spec | `packages/host/tests/agent-list.test.ts` (a device's side), `crates/hive-phone/tests/agents.rs` (Rust, the phone's side) |
| `needs.json` | a device's boards, statuses and plans → what waits on the person, and what a phone shows of several devices' answers (`spec/needs.md`); written by hand from the spec | `packages/host/tests/needs.test.ts` (a device's side), `crates/hive-phone/tests/needs.rs` (Rust, the phone's side) |
| `pairing.json` | proofs, codes and links, a phone pairing with an app message by message, and the networks an app's answer may give a phone (`spec/pairing.md` 0.5); made with Python's hmac and OpenSSL's Ed25519, the networks taken from `network-profile.json` | `packages/workspace-host/tests/pairing-conformance.test.ts` (the app's side), `crates/hive-phone/tests/conformance.rs` (Rust, the phone's side) |
| `push.json` | RFC 8291's example, which a device encrypts byte for byte and a phone decrypts, and bodies a phone refuses though they decrypt (`spec/push.md`); taken from the RFC's text, the refusals made with node:crypto apart from the code | `packages/host/tests/web-push.test.ts` (a device's side), `crates/hive-phone/tests/push.rs` (Rust, the phone's side) |
