# Conformance

Cases every agent-host implementation must pass, as data. A runner per language reads them.

| File | Checks | Runner (TypeScript) |
|---|---|---|
| `status.json` | inputs → status (`spec/status.md`) | `packages/hive-agents/tests/conformance.test.ts` |
| `hook-reports.json` | hook environment + agent payload → reported event | `apps/desktop/tests/unit/agent-event-hook.test.ts` |
