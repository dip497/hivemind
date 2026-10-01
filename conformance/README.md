# Conformance

Cases every implementation must pass, as data. A runner per language reads them.

| File | Checks | Runner (TypeScript) |
|---|---|---|
| `status.json` | inputs → status (`spec/status.md`) | `packages/hive-agents/tests/conformance.test.ts` |
| `hook-reports.json` | hook environment + agent payload → reported event | `apps/desktop/tests/unit/agent-event-hook.test.ts` |
| `identity.json` | seeds → ids, signatures, device certificates and workspace keys (`spec/identity.md`); made with ed25519-dalek and RustCrypto's hkdf | `packages/workspace-host/tests/identity.test.ts` |
| `network-profile.json` | signed network profiles → used or not, and their links (`spec/network-profile.md`); signed with Node's Ed25519 | `crates/hive-net/tests/profile.rs` (Rust) |
| `needs.json` | a device's boards, statuses and plans → what waits on the person, and what a phone shows of several devices' answers (`spec/needs.md`); written by hand from the spec | `packages/host/tests/needs.test.ts` (a device's side), `crates/hive-phone/tests/needs.rs` (Rust, the phone's side) |
| `pairing.json` | proofs, codes and links, and a phone pairing with an app message by message (`spec/pairing.md` 0.3); made with Python's hmac and OpenSSL's Ed25519 | `packages/workspace-host/tests/pairing-conformance.test.ts` (the app's side), `crates/hive-phone/tests/conformance.rs` (Rust, the phone's side) |
