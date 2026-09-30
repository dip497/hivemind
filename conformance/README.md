# Conformance

Cases every implementation must pass, as data. A runner per language reads them.

| File | Checks | Runner (TypeScript) |
|---|---|---|
| `status.json` | inputs → status (`spec/status.md`) | `packages/hive-agents/tests/conformance.test.ts` |
| `hook-reports.json` | hook environment + agent payload → reported event | `apps/desktop/tests/unit/agent-event-hook.test.ts` |
| `identity.json` | seeds → ids, signatures, device certificates and workspace keys (`spec/identity.md`); made with ed25519-dalek and RustCrypto's hkdf | `packages/workspace-host/tests/identity.test.ts` |
