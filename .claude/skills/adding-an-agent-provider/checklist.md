# Agent provider — definition of done

Paste both tables into the PR description and fill every row. ✅ / ❌ / N/A plus a
one-line note. **A row you did not test is ❌, not ✅** — a blank row reads as "wired"
to the next person, which is exactly how a half-wired agent ships.

## Capability probe (Phase 1) → the `caps` block

Every answer needs a source: a doc URL, a `--help` line, or the file you grepped.

| # | Question | Answer | Source | Writes |
|---|---|---|---|---|
| 1 | Binary name / same-named other product? | | | `bin`, `aliases` |
| 2 | Bare binary starts interactive? default subcommand? | | | `spawn.args` |
| 3 | Positional prompt? stays interactive after? | | | `caps.promptDelivery` |
| 4 | Permission model + trust flags | | | `spawn.args`, `caps.supervise` (`human` / `none`) |
| 5 | Hook system: events, stdin, exit codes, can it block? | | | `caps.turnSignal`, `caps.supervise: "broker"` |
| 6 | Session ids: assignable / discoverable / resume by id or cwd? | | | `caps.resume`, the `session` block |
| 7 | Config-home override env var | | | `home` overlay |
| 8 | Shell access + spawn-env inheritance (`hive` on PATH) | | | worker viability |
| 9 | `--model` flag / permission modes | | | the `options` block |
| 10 | TUI text while working / while awaiting approval | | | the `detect` rules, `caps.blockedDetection` |

**Tier chosen:** 0 raw · 1 resume · 2 injected runtime · 3 native — and one line on why
that is the highest tier the CLI supports.

## Lifecycle

| Stage | Mechanism | Status | Note |
|---|---|---|---|
| Appears in the launcher / island / `hive ctl spawn --help` | manifest on disk, `enabled: true` | | |
| Permission posture at spawn | `spawn.args` | | |
| Initial prompt delivery | `caps.promptDelivery` | | |
| Status: working / idle | the `detect` rules, or hooks | | |
| Status: waiting on approval | `caps.blockedDetection` + a `blocked` branch | | |
| Turn signal | `caps.turnSignal` — `launch.hcp` + the hook asset | | |
| `hive ctl send` lands at the prompt | mailbox turn-gate | | |
| `hive ctl read` returns a reply (not UNSUPPORTED, not timeout) | turn tracker | | |
| `hive ctl report` / auto-report | `hive` CLI inside the worker (spawn env) | | |
| `hive ctl workflow --agent <id>` gathers | turn signal declared | | |
| Approvals / `supervise` | `caps.supervise` — `broker` needs a blocking pre-tool hook | | |
| Session resume after a daemon restart | `caps.resume`, the `session.resume` block | | |
| Per-tile resume (not just per-cwd) | `caps.resume: "tile"` | | |
| Close / teardown | no leaked PTY state | | |
| Notification wording is correct | status bus → agent notifications | | |
| Remote (`ssh://`) tile | generic transport | | |

## Files touched (the complete list)

- [ ] `agent.yaml` — the manifest (identity, caps, icon, detector, options, note)
- [ ] the hook/overlay asset it ships beside it (tier 2+ only)
- [ ] `dip497/hivemind-plugins` — the registry PR that lists the folder
- [ ] `CHANGELOG.md` — `## [Unreleased]`

Nothing else. Verify:

```bash
hive agents validate ./<id>   # what a user will be told about it, before it lands anywhere
hive agents list              # after installing: found, loaded, no load error
```

## Tests

- [ ] `hive agents validate` passes (or the failure is the intended refusal)
- [ ] Dropped into `~/.config/hivemind/agents/<id>/`, the running app shows the card with
      its options, install link and capability note — no rebuild
- [ ] `hive agents list` shows the CLI found (or the honest "not installed" reason)
- [ ] `apps/desktop` e2e read for shape: `tests/e2e/zz-sixth-provider.spec.ts` runs this
      exact lifecycle for a throwaway manifest
- [ ] `cd apps/desktop && pnpm typecheck && pnpm run build` — green, actually run

## If this is Tier 0 or 1

- [ ] `caps.turnSignal: false` and a `note` on the manifest — the UI, `hive ctl workflow`
      (exit 7) and `hive ctl read` (`UNSUPPORTED`) then say so; nothing to write elsewhere
- [ ] CHANGELOG line says "manual tile, not an HCP worker"
