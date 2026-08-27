---
name: adding-an-agent-provider
description: Wire a new CLI coding agent (kiro, gemini, amp, cursor, …) into hivemind end to end — capability research on the real binary, provider implementation, status detection, HCP worker wiring, and the lifecycle proof that decides when it is actually done. Use when adding a new agent, completing a half-wired one, or reviewing a PR that does either.
---

# Adding an agent provider

## Why this exists

`docs/agent-status-signals.md` already tells you the three files to edit. That is not
where provider PRs go wrong. They go wrong one step earlier — in what the author
*believed* about the CLI.

A real example: a PR added an agent and stated "no hook system exposed, status is
screen-scrape only". That CLI ships `agentSpawn` / `userPromptSubmit` / `preToolUse` /
`postToolUse` / `stop` hooks with a JSON stdin contract and a blocking exit code — the
same shape hivemind already consumes for claude. Nobody had run `--help`. The result
would have shipped as a "fully-wired agent" that silently cannot be driven: `hive_read`
returns `timeout` forever, `hive_workflow` gathers nothing, and a tile parked on an
approval prompt notifies **"Finished"**.

**A half-wired agent is worse than an absent one**, because the failure is silent. This
skill is the procedure that makes that impossible: research first, tier second, code
third, and a lifecycle table that says out loud what works.

## The rule

An agent is **done** when a human can drive it on the canvas **and** the control plane
can drive it as a worker. If you can only reach the first, that is a legitimate PR — but
it ships **explicitly labelled** as a manual tile, never silently.

---

## Phase 1 — Probe the CLI (never skip, never infer)

Three rules:

1. **Probe the binary that is actually installed.** `--help` beats memory, every time.
2. **Cite a source per answer** — a doc URL, a `--help` line, a file you grepped.
3. **"I could not find it" is a valid answer.** Write it that way. Never write "X does
   not exist" unless you looked and can say where you looked. Absence claims are what
   reviewers check first, because they are what gets a provider shipped half-wired.

Never infer a capability from another agent's shape. Two CLIs that look alike in the
TUI can differ completely in hooks, session storage, and MCP support.

```bash
which <bin>; <bin> --version; <bin> --help
<bin> <subcommand> --help          # chat/run/agent — whatever the entry command is
```

Then the vendor docs, via the repo's context7 rule:

```bash
npx ctx7@latest library "<Product> CLI" "<your question>"
npx ctx7@latest docs /<org>/<project> "hooks, session resume, mcp configuration"
```

When docs are thin, read the shipped package: `ls -l $(readlink -f $(which <bin>))`,
then grep its `dist/` for flag strings. Finish with one adversarial search per topic
("<agent> hooks", "<agent> resume session", "<agent> mcp server").

### The capability probe

Answer all ten with a source. This table goes in the PR description.

| # | Question | What it decides in hivemind |
|---|---|---|
| 1 | Exact binary name. Does a same-named binary belong to a **different product**? | `AgentDef.cmd`, `matches()`, the `ALIASES` entries |
| 2 | Does the bare binary start an interactive session? Is there a default subcommand? | `AgentDef.cmd` + whether restore must inject the subcommand |
| 3 | Positional prompt (`<bin> "do X"`)? Does it stay interactive afterwards, or exit? | `ARGV_PROMPT_AGENTS` in `shared/agent-io.ts` |
| 4 | Permission / trust model. Per-tool prompts? Flags to pre-trust? | `AgentDef.defaultArgs` (match the agent's own safe default) |
| 5 | **Hook / event system**: which events, stdin shape, exit-code semantics, can a hook block a tool? | Tier. Deterministic turn/status/approval, or none |
| 6 | **Session ids**: assignable at spawn? discoverable after? resume by id or by cwd? | `transformSpecOnSpawn` / `transformSpecOnRestore` |
| 7 | Config-home override env var (`FACTORY_HOME_OVERRIDE`, `KIRO_HOME`, …) | Whether we can inject config without touching the user's real home |
| 8 | MCP support + config file location and scope | Whether the worker can call `hive_report` / `hive_read` |
| 9 | Headless / non-interactive mode | Not used by tiles, but it reveals how args are parsed |
| 10 | What the TUI prints while **working**, and while **waiting for approval** | The scrape detector strings — capture real output, do not guess |

Row 10 needs a real run. If you cannot install the CLI, say so in the PR and leave the
`blocked` branch unwritten rather than inventing prompt text — a wrong detector is worse
than a missing one, because it reports the wrong state confidently.

---

## Phase 2 — Pick the tier

Take the **highest** tier the probe supports. Picking Tier 0 for an agent that has hooks
means the probe was wrong — go back to Phase 1.

| Tier | The CLI gives you | You get | Copy from |
|---|---|---|---|
| **0 — raw** | nothing but a TUI | scrape status only. **Not an HCP worker** — `hive_read` times out, workflows gather nothing | `providers/codex.ts` |
| **1 — resume** | discoverable session files/ids | Tier 0 + survives a daemon restart | `codex-resume.ts`, `pi-resume.ts`, `droid-resume.ts` (newest-session-for-cwd) |
| **2 — injected runtime** | a config-home override **or** an extension loader | deterministic `turn` / `status`, MCP inside the worker → a real HCP worker | `droid-resume.ts` + `hcp/droid-home.ts` (home overlay), `hcp/pi-ext-source.ts` (extension) |
| **3 — native** | pre-assignable session id + blocking permission hook | Tier 2 + per-tile resume + `supervise` approval brokering | `claude-resume.ts` |

Tier 2 is the important line: **below it the agent cannot report back**, so
`hive_spawn_agent` / `hive_workflow` with that runtime produce workers that look alive
and deliver nothing.

---

## Phase 3 — Implement

`docs/agent-status-signals.md` owns the architecture. This is the file map.

**Always:**

1. `renderer/src/agents.tsx` — `AgentDef` entry + icon (inline SVG, `currentColor`).
2. `renderer/src/agent-state.ts` — `ALIASES` + `DETECTORS` keyed by the **same id**.
   Include a `blocked` branch if the agent ever asks permission (see `detectDroid`,
   `detectAmp`). No `blocked` branch ⇒ an approval prompt reads as *idle* ⇒ the
   notification says "Finished".
3. `main/<id>-resume.ts` — pure spec transforms. Electron-free so it stays unit-testable.
   Export an `is<Id>(spec)` matcher here.
4. `main/providers/<id>.ts` — the adapter. **Import** the matcher from the resume module;
   do not re-implement it, or the two copies will drift.
5. `main/providers/registry.ts` — append to `PROVIDERS`.

**Tier 2+ also:**

6. `main/hcp/<id>-home.ts` — the config-home overlay. Copy `hcp/droid-home.ts`: symlink
   every child of the user's real config dir **except** the files we own, then write our
   own hooks/agent config into the overlay. Symlinking is what preserves the user's
   settings, steering, skills, and session history.
7. `main/pty-daemon.ts` — seed the overlay, pass paths into `composeResume`.
8. `main/providers/types.ts` — add the new `ProviderSpawnContext` field, documented.

**Registries that drift.** Find them all mechanically instead of trusting this list:

```bash
grep -rn '"droid"' --include=*.ts --include=*.tsx --include=*.md . \
  | grep -v node_modules | grep -v '/out/'
```

Every hit is a registry your agent probably belongs in too. Today that includes
`apps/cli/src/commands/agent.ts` and `apps/cli/src/parse.ts` (`KNOWN_AGENTS` — without
it `hive agent detect` misses the CLI and `--assignee <id>` resolves as a *member*, not
an agent), the runtime lists in `packages/hive-mcp/src/index.ts`, the agent lists in
`README.md`, and `CHANGELOG.md` under `## [Unreleased]` — required by the hand-off rule
in `CLAUDE.md`, because `scripts/release.sh` cuts the release notes from it.

---

## Phase 4 — Tests

Every provider before you shipped these. Match them.

- `tests/unit/<id>-resume.test.ts` — mirror `droid-resume.test.ts`: matcher true **and**
  false, spawn transform, restore transform (already-resuming → untouched; no session →
  untouched), retry transform (strips the flag; `null` when there is nothing to strip).
- `tests/unit/agent-state.test.ts` — one `working`, one `idle`, one `blocked` case built
  from **real captured screen text**.
- `tests/unit/provider-registry.test.ts` — `providerFor("<bin>")` and
  `providerFor("/usr/local/bin/<bin>")`, plus the `PROVIDERS` order assertion.

```bash
cd apps/desktop && pnpm run typecheck && pnpm test:unit && pnpm run build
```

If the unit-test count did not change, you did not add a test. Never write "tests pass"
into a PR description without running them.

---

## Phase 5 — Prove the lifecycle

Fill `checklist.md` (next to this file) into the PR description. Every row gets
✅ / ❌ / N/A with a one-line note — **no blanks**. A row you did not test is ❌, not ✅.

Manual pass, in order:

1. Spawn from the frame launcher → the tile starts and shows **working**, then **idle**.
2. `hive_send` to it mid-turn → the message lands at its prompt, not mid-render.
3. `hive_read` from another agent → returns the reply, not `finalStatus:"timeout"`.
4. `hive_spawn_agent` with `report:true` → the worker's reply reaches the spawner once
   (exactly once — not once from `read` and again from auto-report).
5. Trigger a tool-approval prompt → tile status is **waiting**, notification says
   *Needs your input*.
6. Kill the PTY daemon, relaunch → the tile restores into its own prior session.
7. Close the tile → no leaked state, no hung reader.

---

## Anti-patterns

Each of these has shipped, or nearly shipped, at least once:

- **Declaring an absence you did not verify.** "No hook system", "no addressable
  sessions". Run `--help`, read the docs page, then write it — with the source.
- **Matching a binary that belongs to another product.** `kiro` is the Kiro IDE (a VS
  Code fork); `kiro-cli` is the agent. An alias that nothing spawns can only misfire.
- **Two copies of the matcher** — one in the provider, one in the resume module.
- **A docblock asserting behaviour nobody tested.** Comments outlive their authors and
  are read as fact by the next contributor *and* their agent.
- **Calling a Tier 0/1 integration "fully wired".** Say "manual tile, not an HCP worker".
- **Default-on trust flags** (`--trust-all-tools`, `--yolo`). Match the agent's own safe
  default; the human on the canvas answers prompts. Autonomy is the operator's choice.
- **Skipping the CHANGELOG.**

## When the agent cannot be a worker

Tier 0 and Tier 1 are fine to ship — but the limitation goes in **three** places, so
nobody discovers it by watching a workflow return empty:

1. the `AgentDef` comment in `agents.tsx`,
2. the provider docblock,
3. the CHANGELOG line.

Wording that works: *"scrape-only status and no turn signal — drive it by hand on the
canvas; `hive_read` / `hive_workflow` cannot gather from it yet."*
