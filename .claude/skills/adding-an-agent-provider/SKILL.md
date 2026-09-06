---
name: adding-an-agent-provider
description: Wire a new CLI coding agent (gemini, amp, cursor, …) into hivemind end to end — capability research on the real binary, ONE provider def (+ node half) in the @hivemind/agents catalog, and the lifecycle proof that decides when it is actually done. Use when adding a new agent, completing a half-wired one, or reviewing a PR that does either.
---

# Adding an agent provider

## Why this exists

A provider is one directory — a def, plus a plugin object if it injects hooks or
resumes — and one line per list. That is not where provider PRs go wrong. They go wrong one step earlier — in what
the author *believed* about the CLI.

A real example: a PR added an agent and stated "no hook system exposed, status is
screen-scrape only". That CLI ships `agentSpawn` / `userPromptSubmit` / `preToolUse` /
`postToolUse` / `stop` hooks with a JSON stdin contract and a blocking exit code — the
same shape hivemind already consumes for claude. Nobody had run `--help`. The result
would have shipped as a "fully-wired agent" that silently cannot be driven.

Today the capabilities you declare are what the control plane *believes*: declare
`turnSignal: true` for a runtime that never reports a turn and `hive ctl read` times
out on it; declare `false` and `hive ctl workflow --agent <id>` refuses up front with
exit 7. **A wrong capability is a wrong contract.** This skill is the procedure that
makes the declaration true: research first, tier second, code third, and a lifecycle
proof that says out loud what works.

## The rule

An agent is **done** when a human can drive it on the canvas **and** the control plane
can drive it as a worker. If you can only reach the first, that is a legitimate PR —
but it ships with `turnSignal: false` and a `note`, so the UI, the CLI and HCP all
say so, never silently.

---

## Phase 1 — Probe the CLI (never skip, never infer)

Three rules:

1. **Probe the binary that is actually installed.** `--help` beats memory, every time.
2. **Cite a source per answer** — a doc URL, a `--help` line, a file you grepped.
3. **"I could not find it" is a valid answer.** Write it that way. Never write "X does
   not exist" unless you looked and can say where you looked.

Never infer a capability from another agent's shape. Two CLIs that look alike in the
TUI can differ completely in hooks, session storage, and shell access.

```bash
which <bin>; <bin> --version; <bin> --help
<bin> <subcommand> --help          # chat/run/agent — whatever the entry command is
npx ctx7@latest library "<Product> CLI" "<your question>"
npx ctx7@latest docs /<org>/<project> "hooks, session resume, running shell commands"
```

When docs are thin, read the shipped package: `ls -l $(readlink -f $(which <bin>))`,
then grep its `dist/` for flag strings. Finish with one adversarial search per topic.

### The capability probe → the `caps` you will write

Answer all ten with a source. Each answer decides a field of `AgentProviderDef`.

| # | Question | Decides |
|---|---|---|
| 1 | Exact binary name. Same-named binary from a **different product**? | `bin`; `aliases` (identification only — a bare `kiro` is the Kiro IDE) |
| 2 | Does the bare binary start an interactive session? Default subcommand? | `bin` / `defaultArgs`; whether restore must inject the subcommand |
| 3 | Positional prompt (`<bin> "do X"`)? Stays interactive afterwards? | `caps.promptDelivery: "argv"` or `"typed"` |
| 4 | Permission / trust model. Per-tool prompts? Flags to pre-trust? | `defaultArgs` (match the agent's own safe default); `caps.supervise: "human"` if it has prompts, `"none"` if it has no permission system at all |
| 5 | **Hook / event system**: events, stdin shape, exit-code semantics, can a hook block? | `caps.turnSignal`; `"broker"` supervise if a pre-tool hook can block |
| 6 | **Session ids**: assignable at spawn? discoverable after? resume by id or cwd? | `caps.resume: "tile"` / `"cwd"` / `"none"` and the node half's transforms |
| 7 | Config-home override env var (`FACTORY_HOME_OVERRIDE`, `KIRO_HOME`, …) | whether `prepare()` can inject config without touching the user's real home |
| 8 | Can the agent run shell commands + inherit the spawn env? | whether the worker can call `hive ctl report` (needs `hive` on PATH + HIVE_HCP_SOCK/HCP_TOKEN/HIVEMIND_TILE from the env) |
| 9 | `--model` flag? claude-style permission modes? | `caps.modelFlag`, `caps.permissionModes` |
| 10 | What the TUI prints while **working**, and while **waiting for approval** | `detect()` strings and `caps.blockedDetection` — capture real output, do not guess |

Row 10 needs a real run. If you cannot install the CLI, say so and set
`blockedDetection: false` rather than inventing prompt text — a wrong detector is
worse than a missing one, because it reports the wrong state confidently.

---

## Phase 2 — Pick the tier

Take the **highest** tier the probe supports. Tier 0 for an agent that has hooks means
the probe was wrong — go back to Phase 1.

| Tier | The CLI gives you | Declares | Copy from |
|---|---|---|---|
| **0 — raw** | nothing but a TUI | `turnSignal: false`, `resume: "none"`, a `note` | `providers/opencode/` |
| **1 — resume** | discoverable session files/ids | + `resume: "cwd"`, a plugin with restore transforms | `providers/codex/` |
| **2 — injected runtime** | a config-home override **or** an extension loader | + `turnSignal: true`; `prepare()` seeds the overlay / writes the extension | `providers/droid/` (overlay), `providers/pi/` (extension) |
| **3 — native** | pre-assignable session id + blocking permission hook | + `resume: "tile"`, `supervise: "broker"` | `providers/claude/`, `providers/kiro/` |

Tier 2 is the important line: **below it the agent cannot report back**, and the
catalog says so — `workerAgents()` excludes it, `hive ctl workflow` refuses it.

---

## Phase 3 — Implement (one directory)

Everything lives in `packages/hive-agents/src/providers/<id>/`.

1. **`index.ts` — the def** (browser-safe; no node imports). `id`, `label`, `bin`,
   `aliases?`, `defaultArgs?`, `enabled`, the full `caps` block, an inline-SVG
   `icon` (`{ viewBox, attrs, body }` using `currentColor`; `GENERIC_AGENT_ICON` until
   you have a mark), `detect(screen)` built from `detect-helpers.ts`, `spawnArgs(opts)`
   / `spawnLabel(n, opts)` if the runtime has its own flag vocabulary (see
   `claude/index.ts`), and a `note` if it cannot be a worker or cannot be supervised.
2. **`node.ts` — the plugin object** (tier 1+): `export const plugin: AgentPlugin =
   { def, prepare?, resume?, assets? }`. Export an `is<Id>(spec)` matcher (basename ===
   `bin`) and `make<Id>ResumeTransforms(deps)` from the same file. `prepare(paths)`
   returns a plain `Record<string, string>` of the paths it created; `resume(ctx)` reads
   them back from `ctx.providers[def.id]` — never touch the shared context type. Keep
   assets as sibling files (`home.ts`, `approval-hook-source.ts`, `ext-source.ts`)
   imported by `node.ts`.
3. **Register**: one line in `catalog.ts` (`CATALOG`) and, if there is a plugin object,
   one line in `node.ts` (`PLUGINS`).

That is all. The UI list, the status detector, prompt delivery, spawn args, the daemon,
HCP, `hive ctl --agent`, `hive agent detect` and `--assignee` all read the catalog. If
you find yourself naming the provider anywhere else, `no-hardcoded-providers.test.ts`
will find it first.

**Every transform must no-op for specs it does not own** (basename check). The
golden order-independence test composes all providers in reversed order and fails on
any transform that touches a foreign spec.

---

## Phase 4 — Tests

```bash
cd packages/hive-agents && pnpm typecheck && bun test        # drift guard: node half ↔ caps
cd apps/desktop && pnpm typecheck && pnpm test:unit          # golden, order-independence, no-hard-coded-names
cd apps/cli && bun test
```

Add for your provider:

- `apps/desktop/tests/unit/<id>-resume.test.ts` — mirror `droid-resume.test.ts`:
  matcher true **and** false, spawn transform, restore (already-resuming → untouched;
  no session → untouched), retry (strips the flag; `null` when nothing to strip).
- `apps/desktop/tests/unit/agent-state.test.ts` — one `working`, one `idle`, one
  `blocked` case from **real captured screen text**.
- Extend `provider-golden.test.ts`'s `PROVIDERS` + `SCREENS` with the new id and
  regenerate the fixture once (`UPDATE_GOLDEN=1`) — review the diff: it must add your
  provider's block and change nothing else.

If the unit-test count did not go up, you did not add a test.

---

## Phase 5 — Prove the lifecycle

Fill `checklist.md` (next to this file) into the PR description. Every row gets
✅ / ❌ / N/A with a one-line note — **no blanks**. A row you did not test is ❌.

The e2e suite runs this exact proof for a throwaway provider
(`tests/e2e/zz-sixth-provider.spec.ts`) through the scripted stand-in agent
(`tests/e2e/fixtures/fake-agent.cjs`). For a real runtime, run it by hand, in order:

1. Spawn from the frame launcher → the tile starts and shows **working**, then **idle**.
2. `hive ctl send` to it mid-turn → the message lands at its prompt, not mid-render.
3. `hive ctl read` from another agent → returns the reply, not `finalStatus:"timeout"`.
4. `hive ctl spawn` (report on by default) → the worker's reply reaches the spawner once.
5. Trigger a tool-approval prompt → tile status is **waiting**, notification says
   *Needs your input*.
6. Kill the PTY daemon, relaunch → the tile restores into its own prior session.
7. Close the tile → no leaked state, no hung reader.

---

## Anti-patterns

- **Declaring an absence you did not verify.** Run `--help`, read the docs page, then
  write it — with the source.
- **A capability that is a wish.** `turnSignal: true` because the hooks *should* work.
  Prove it with row 3 above before you ship it.
- **Matching a binary that belongs to another product.** `kiro` vs `kiro-cli`.
- **Two copies of the matcher** — the plugin's `node.ts` exports `is<Id>`; nothing else re-implements it.
- **Provider logic in `node.ts` or `useSpawn`.** The prepare body, the deps mapping and
  the flag vocabulary belong to the provider's directory.
- **Editing `ProviderSpawnContext`** for your overlay path. Return it from `prepare()`.
- **Default-on trust flags** (`--trust-all-tools`, `--yolo`). Match the agent's own
  safe default; the human on the canvas answers prompts.
- **Skipping the CHANGELOG** (`## [Unreleased]` — the release notes are cut from it).

## When the agent cannot be a worker

Tier 0 and 1 ship with `turnSignal: false` and a `note`. The catalog then does the
telling: the UI shows the note, `hive ctl workflow --agent <id>` exits 7 with it,
`hive ctl read` on its tile answers `UNSUPPORTED`. Wording that works:
*"scrape-only status and no turn signal — drive it by hand on the canvas;
`hive ctl read` / `hive ctl workflow` cannot gather from it."*
