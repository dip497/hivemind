---
name: adding-an-agent-provider
description: Add a new CLI coding agent (gemini, amp, cursor, …) to hivemind end to end — capability research on the real binary, ONE agent.yaml manifest published to the HiveHub registry (dip497/hivemind-plugins), and the lifecycle proof that decides when it is actually done. Use when adding a new agent, completing a half-wired one, or reviewing a PR that does either.
---

# Adding an agent provider

## Why this exists

An agent is one manifest — `agent.yaml`, plus the hook asset it ships if it injects
hooks or resumes. That is not where agent PRs go wrong. They go wrong one step earlier — in
what the author *believed* about the CLI.

A real example: a PR added an agent and stated "no hook system exposed, status is
screen-scrape only". That CLI ships `agentSpawn` / `userPromptSubmit` / `preToolUse` /
`postToolUse` / `stop` hooks with a JSON stdin contract and a blocking exit code — the
same shape hivemind already consumes for claude. Nobody had run `--help`. The result
would have shipped as a "fully-wired agent" that silently cannot be driven.

Today the capabilities you declare are what the control plane *believes*: declare
`turnSignal: true` for a runtime that never reports a turn and `hive ctl read` times
out on it; declare `false` and `hive ctl workflow --agent <id>` refuses up front with
exit 7. **A wrong capability is a wrong contract.** This skill is the procedure that
makes the declaration true: research first, tier second, manifest third, and a lifecycle
proof that says out loud what works.

## The rule

An agent is **done** when a human can drive it on the canvas **and** the control plane
can drive it as a worker. If you can only reach the first, that is a legitimate PR —
but it ships with `turnSignal: false` and a `note`, so the UI, the CLI and HCP all
say so, never silently.

Nothing agent-specific is compiled into the app. Agents are published to the HiveHub
registry and added to a user's machine automatically when their CLI is found. The
authoring format for a PR is the same format a user writes by hand — a manifest cannot
do anything a user's own file cannot.

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

Answer all ten with a source. Each answer decides a field of the manifest.

| # | Question | Decides |
|---|---|---|
| 1 | Exact binary name. Same-named binary from a **different product**? | `bin`; `aliases` (identification only — a bare `kiro` is the Kiro IDE) |
| 2 | Does the bare binary start an interactive session? Default subcommand? | `bin` / `spawn.args` |
| 3 | Positional prompt (`<bin> "do X"`)? Stays interactive afterwards? | `caps.promptDelivery: "argv"` or `"typed"` |
| 4 | Permission / trust model. Per-tool prompts? Flags to pre-trust? | `spawn.args` (match the agent's own safe default); `caps.supervise: "human"` if it has prompts, `"none"` if it has no permission system at all |
| 5 | **Hook / event system**: events, stdin shape, exit-code semantics, can a hook block? | `caps.turnSignal`; `"broker"` supervise if a pre-tool hook can block (`launch.hcp` + the hook asset) |
| 6 | **Session ids**: assignable at spawn? discoverable after? resume by id or cwd? | `caps.resume` and the `session` block (`bind` / `resume`) |
| 7 | Config-home override env var (`FACTORY_HOME_OVERRIDE`, `KIRO_HOME`, …) | whether a `home` overlay can inject config without touching the user's real home |
| 8 | Can the agent run shell commands + inherit the spawn env? | whether the worker can call `hive ctl report` (needs `hive` on PATH + HIVE_HCP_SOCK/HCP_TOKEN/HIVEMIND_TILE from the env) |
| 9 | `--model` flag? claude-style permission modes? | the `options` block (`model`, `mode`) |
| 10 | What the TUI prints while **working**, and while **waiting for approval** | the `detect` rules and `caps.blockedDetection` — capture real output, do not guess |

Row 10 needs a real run. If you cannot install the CLI, say so and set
`blockedDetection: false` rather than inventing prompt text — a wrong detector is
worse than a missing one, because it reports the wrong state confidently.

---

## Phase 2 — Pick the tier

Take the **highest** tier the probe supports. Tier 0 for an agent that has hooks means
the probe was wrong — go back to Phase 1.

| Tier | The CLI gives you | Declares | Copy from |
|---|---|---|---|
| **0 — raw** | nothing but a TUI | `turnSignal: false`, `resume: "none"`, a `note` | the `opencode` published manifest |
| **1 — resume** | discoverable session files/ids | + `resume: "cwd"`, a `session.resume` block | the `codex` published manifest |
| **2 — injected runtime** | a config-home override **or** an extension loader | + `turnSignal: true`, wiring `launch.hcp` with the hook asset | the `droid` (overlay) / `pi` (extension) manifests |
| **3 — native** | pre-assignable session id + blocking permission hook | + `resume: "tile"`, `supervise: "broker"` | the `claude` / `kiro` manifests |

The published manifests live in
`packages/hive-agents/tests/fixtures/published-agents/<id>/` — they are the exact files
the registry serves, so they are both reference material and fixtures.

Tier 2 is the important line: **below it the agent cannot report back**, and the
manifest says so — `hive ctl workflow` refuses it and `hive ctl read` answers
`UNSUPPORTED`.

---

## Phase 3 — Write the manifest (one directory)

The agent is one folder: `agent.yaml` plus, for tier 2+, the hook/overlay asset it
ships beside it. See
[the manifest guide](https://hivemind.griiken.com/guide/agent-providers/) for the full
field reference; `claude/agent.yaml` in the published fixtures is the richest example.

1. `id` — one bare name (lowercase, digits, dashes). Ids Hivemind has shipped are
   reserved for the command they have always launched: taking the name for another
   binary is refused when the manifest is read.
2. `caps` — every field is required; claim a tier-2/3 capability only with the wiring
   that delivers it (see Phase 2).
3. `options` — what Settings lets the user choose at launch; `model` and `mode` are
   what `hive ctl spawn --model/--mode` set.
4. `detect` — ordered rules over the rendered screen; the first match wins.
5. `icon` — shapes, not SVG markup; `viewBox` + `path`/`rect`/`circle`/`ellipse`.

**Try it before you publish**: drop the folder into
`~/.config/hivemind/agents/<id>/` (or run `hive agents install ./<id>`) — the running
app picks it up, `hive agents list` shows it with any validation error, and nothing
needs a rebuild.

**Publish**: one pull request to
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins) adding the folder
to the registry. Once merged, every machine with the agent's CLI gets it automatically,
and the site's agent strip picks the icon up from the published manifest.

If you find yourself naming the agent anywhere else — in UI code, in the CLI, in a
provider list — stop: that is a hardcoded provider, and `no-hardcoded-providers.test.ts`
will find it.

---

## Phase 4 — Tests

```bash
hive agents validate ./<id>                       # what a user will be told about it
cd apps/desktop && npx electron-vite build        # then drop it in and launch the app
```

- `hive agents list` — the agent appears, with its CLI found (or the reason it is not).
- Settings ▸ Agents — the card shows the launch options, the install link if the CLI is
  missing, and the capability note if it is not a worker.
- The e2e suite runs the full lifecycle for a throwaway manifest
  (`apps/desktop/tests/e2e/zz-sixth-provider.spec.ts`) — read it before claiming done.

---

## Phase 5 — Prove the lifecycle

Fill `checklist.md` (next to this file) into the PR description. Every row gets
✅ / ❌ / N/A with a one-line note — **no blanks**. A row you did not test is ❌.

For a real runtime, run it by hand, in order:

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
- **Wiring claimed without the asset.** `turnSignal: true` without `launch.hcp` plus the
  hook file is refused — and should be.
- **Naming the provider in product code.** Agents are data; the UI, the CLI and HCP read
  manifests. `no-hardcoded-providers.test.ts` fails on any exception.
- **Default-on trust flags** (`--trust-all-tools`, `--yolo`). Match the agent's own
  safe default; the human on the canvas answers prompts.
- **Skipping the CHANGELOG** (`## [Unreleased]` — the release notes are cut from it).

## When the agent cannot be a worker

Tier 0 and 1 ship with `turnSignal: false` and a `note`. The catalog then does the
telling: the UI shows the note, `hive ctl workflow --agent <id>` exits 7 with it,
`hive ctl read` on its tile answers `UNSUPPORTED`. Wording that works:
*"scrape-only status and no turn signal — drive it by hand on the canvas;
`hive ctl read` / `hive ctl workflow` cannot gather from it."*
