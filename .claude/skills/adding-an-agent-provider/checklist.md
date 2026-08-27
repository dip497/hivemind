# Agent provider — definition of done

Paste both tables into the PR description and fill every row. ✅ / ❌ / N/A plus a
one-line note. **A row you did not test is ❌, not ✅** — a blank row reads as "wired"
to the next person, which is exactly how a half-wired agent ships.

## Capability probe (Phase 1)

Every answer needs a source: a doc URL, a `--help` line, or the file you grepped.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Binary name / same-named other product? | | |
| 2 | Bare binary starts interactive? default subcommand? | | |
| 3 | Positional prompt? stays interactive after? | | |
| 4 | Permission model + trust flags | | |
| 5 | Hook system: events, stdin, exit codes, can it block? | | |
| 6 | Session ids: assignable / discoverable / resume by id or cwd? | | |
| 7 | Config-home override env var | | |
| 8 | MCP support + config location | | |
| 9 | Headless / non-interactive mode | | |
| 10 | TUI text while working / while awaiting approval | | |

**Tier chosen:** 0 raw · 1 resume · 2 injected runtime · 3 native — and one line on why
that is the highest tier the CLI supports.

## Lifecycle

| Stage | Mechanism | Status | Note |
|---|---|---|---|
| Spawn from the launcher | `AgentDef` in `agents.tsx` | | |
| Permission posture at spawn | `defaultArgs` | | |
| Initial prompt delivery | argv (`ARGV_PROMPT_AGENTS`) or typed-on-idle | | |
| Status: working / idle | scrape detector, or hooks | | |
| Status: waiting on approval | `blocked` branch in the detector | | |
| Turn signal | hooks / injected extension | | |
| `hive_send` lands at the prompt | mailbox turn-gate | | |
| `hive_read` returns a reply | turn tracker | | |
| `hive_report` / auto-report | hive MCP inside the worker | | |
| `hive_workflow` with this runtime | turn-tracker gather | | |
| Approvals / `supervise` | blocking pre-tool hook | | |
| Session resume after a daemon restart | `transformSpecOnRestore` | | |
| Per-tile resume (not just per-cwd) | spawn-time id binding, or captured session id | | |
| Close / teardown | `onPtyExit` → `forgetTile` | | |
| Notification wording is correct | status bus → `agent-notify-core` | | |
| Remote (`ssh://`) tile | generic transport | | |

## Registries touched

- [ ] `renderer/src/agents.tsx` — `AgentDef` + icon
- [ ] `renderer/src/agent-state.ts` — `ALIASES` + `DETECTORS` (+ `blocked` branch)
- [ ] `main/<id>-resume.ts` — pure transforms, exports the matcher
- [ ] `main/providers/<id>.ts` — imports that matcher, does not re-implement it
- [ ] `main/providers/registry.ts` — `PROVIDERS`
- [ ] `main/hcp/<id>-home.ts` + `pty-daemon.ts` + `providers/types.ts` — Tier 2+ only
- [ ] `apps/cli/src/commands/agent.ts` — `KNOWN_AGENTS`
- [ ] `apps/cli/src/parse.ts` — `KNOWN_AGENTS`
- [ ] `packages/hive-mcp/src/index.ts` — runtime lists in the tool descriptions
- [ ] `README.md` — agent lists
- [ ] `CHANGELOG.md` — `## [Unreleased]`

Verify nothing was missed:

```bash
grep -rn '"droid"' --include=*.ts --include=*.tsx --include=*.md . \
  | grep -v node_modules | grep -v '/out/'
```

## Tests

- [ ] `tests/unit/<id>-resume.test.ts` — matcher (true **and** false), spawn, restore
      (already-resuming → untouched, no session → untouched), retry
- [ ] `tests/unit/agent-state.test.ts` — working / idle / blocked, from real screen text
- [ ] `tests/unit/provider-registry.test.ts` — `providerFor(bin)`, `providerFor(/abs/bin)`, order
- [ ] Unit-test count went **up** (`pnpm test:unit`)
- [ ] `pnpm run typecheck && pnpm test:unit && pnpm run build` — all green, actually run

## If this is Tier 0 or 1

The limitation is stated in all three places:

- [ ] `AgentDef` comment in `agents.tsx`
- [ ] provider docblock
- [ ] CHANGELOG line

Suggested wording: *"scrape-only status and no turn signal — drive it by hand on the
canvas; `hive_read` / `hive_workflow` cannot gather from it yet."*
