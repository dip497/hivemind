# Agent provider — definition of done

Paste both tables into the PR description and fill every row. ✅ / ❌ / N/A plus a
one-line note. **A row you did not test is ❌, not ✅** — a blank row reads as "wired"
to the next person, which is exactly how a half-wired agent ships.

## Capability probe (Phase 1) → the `caps` block

Every answer needs a source: a doc URL, a `--help` line, or the file you grepped.

| # | Question | Answer | Source | Writes |
|---|---|---|---|---|
| 1 | Binary name / same-named other product? | | | `bin`, `aliases` |
| 2 | Bare binary starts interactive? default subcommand? | | | `defaultArgs` |
| 3 | Positional prompt? stays interactive after? | | | `caps.promptDelivery` |
| 4 | Permission model + trust flags | | | `defaultArgs`, `caps.supervise` (`human` / `none`) |
| 5 | Hook system: events, stdin, exit codes, can it block? | | | `caps.turnSignal`, `caps.supervise: "broker"` |
| 6 | Session ids: assignable / discoverable / resume by id or cwd? | | | `caps.resume`, the node half |
| 7 | Config-home override env var | | | `prepare()` |
| 8 | Shell access + spawn-env inheritance (`hive` on PATH) | | | worker viability |
| 9 | `--model` flag / permission modes | | | `caps.modelFlag`, `caps.permissionModes`, `spawnArgs()` |
| 10 | TUI text while working / while awaiting approval | | | `detect()`, `caps.blockedDetection` |

**Tier chosen:** 0 raw · 1 resume · 2 injected runtime · 3 native — and one line on why
that is the highest tier the CLI supports.

## Lifecycle

| Stage | Mechanism | Status | Note |
|---|---|---|---|
| Appears in the launcher / island / `hive ctl spawn --help` | catalog def, `enabled: true` | | |
| Permission posture at spawn | `defaultArgs` | | |
| Initial prompt delivery | `caps.promptDelivery` | | |
| Status: working / idle | `detect()`, or hooks | | |
| Status: waiting on approval | `caps.blockedDetection` + a `blocked` branch | | |
| Turn signal | `caps.turnSignal` — hooks / injected extension | | |
| `hive ctl send` lands at the prompt | mailbox turn-gate | | |
| `hive ctl read` returns a reply (not UNSUPPORTED, not timeout) | turn tracker | | |
| `hive ctl report` / auto-report | `hive` CLI inside the worker (spawn env) | | |
| `hive ctl workflow --agent <id>` gathers | `workerAgents()` includes it | | |
| Approvals / `supervise` | `caps.supervise` — `broker` needs a blocking pre-tool hook | | |
| Session resume after a daemon restart | `caps.resume`, `transformSpecOnRestore` | | |
| Per-tile resume (not just per-cwd) | `caps.resume: "tile"` | | |
| Close / teardown | `onPtyExit` → `forgetTile` | | |
| Notification wording is correct | status bus → `agent-notify-core` | | |
| Remote (`ssh://`) tile | generic transport | | |

## Files touched (the complete list)

- [ ] `packages/hive-agents/src/providers/<id>/index.ts` — the def (identity, caps, icon, detector, spawn args, note)
- [ ] `packages/hive-agents/src/providers/<id>/node.ts` — tier 1+: the plugin object (`prepare`, `resume`, `assets`), assets as sibling files
- [ ] `packages/hive-agents/src/catalog.ts` — one line in `CATALOG`
- [ ] `packages/hive-agents/src/node.ts` — one line in `PLUGINS` (tier 1+)
- [ ] `README.md` — agent list
- [ ] `CHANGELOG.md` — `## [Unreleased]`

Nothing else. Verify:

```bash
cd apps/desktop && pnpm exec tsx --test tests/unit/no-hardcoded-providers.test.ts
```

## Tests

- [ ] `packages/hive-agents`: `bun test` — the drift guard accepts the new def/node pair
- [ ] `apps/desktop/tests/unit/<id>-resume.test.ts` — matcher (true **and** false), spawn, restore
      (already-resuming → untouched, no session → untouched), retry
- [ ] `apps/desktop/tests/unit/agent-state.test.ts` — working / idle / blocked, from real screen text
- [ ] `provider-golden.test.ts` — `PROVIDERS` + `SCREENS` extended; fixture regenerated once, diff reviewed
- [ ] Unit-test count went **up** (`pnpm test:unit`)
- [ ] `pnpm typecheck && pnpm test:unit && pnpm run build` — all green, actually run

## If this is Tier 0 or 1

- [ ] `caps.turnSignal: false` and a `note` on the def — the UI, `hive ctl workflow`
      (exit 7) and `hive ctl read` (`UNSUPPORTED`) then say so; nothing to write elsewhere
- [ ] CHANGELOG line says "manual tile, not an HCP worker"
