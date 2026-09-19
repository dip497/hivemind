# Pluggable agent providers — what's possible, tested

Status: **design, tested by spike.** Nothing implemented.
Question: agents are compile-time only while views are runtime plugins. Can agents be plugins too?

Answer: yes for the detector-and-identity tier, and the evidence is stronger than the
first analysis suggested. The blocker is not the schema. It is that `CATALOG` is a
synchronous module-scope constant snapshotted in four processes.

## What was actually measured

A spike built the proposed rule interpreter and re-expressed **all 15 in-tree
detectors as data**, then differential-tested data against code over a corpus of the
golden fixture screens plus 300k fuzzed screens generated from the detectors' own
string literals, plus 39 hand-written adversarial screens aimed at the scope and
numeric edges.

```
corpus 300061 screens · 15 detectors · 4500915 checks
EQUIVALENT: every manifest matches its code detector on every screen.
```

Three results that changed the design:

**1. The first grammar was wrong, and the fuzzer found it.** `antigravity` reads
`/(\d+)\s+task/` and compares the **first** match to zero. A `contains`-style rule
matches **any** occurrence, so `"/tasks 0 task then later 3 task"` returned `working`
where the code returns `idle` — 1 mismatch in 3,000,915 checks. Fixed by a
`numBeforeWord` primitive that reproduces first-match semantics.

**2. `claude`'s detector IS expressible** — the earlier claim that it was irreducibly
code was wrong. Its twelve regexes reduce to ordered rules once the grammar has
per-rule *scope* (`tail: 20` after dropping trailing empties, vs the whole screen for
the background-agent line), `not`, and a configurable default of `working`. What makes
claude non-pluggable is its **node half** — the session store scan, the hook templating
— not its detector.

**3. Plugins must not supply regex, and don't need to.** A manifest pattern is
attacker-controlled input to a backtracking engine on the renderer's main thread:

```
"(a+)+$" on 41 chars: 974 ms   <- one tile, one poll
```

Capping the input length does not help — 41 characters is already a freeze. So the
grammar was rebuilt around a bounded, linear-time line vocabulary (`contains`,
`startsWith`, `startsWithAny`, `gerundAfterPrefix`, `letterAfterPrefix`, `anyOf`,
`numBeforeWord`) and the port re-run. **14 of 15 detectors need no regex at all.** Only
`claude` does, and `claude` is built-in and reviewed. Plugins never reach a backtracking
engine.

Cost, worst case of the four measured, 50k iterations on a 60-line viewport:

| provider | code | rules | 40 tiles per 1200 ms tick |
|---|---|---|---|
| cursor | 32.4 µs | 58.6 µs | 2.34 ms |
| kiro | 22.8 µs | 32.6 µs | 1.31 ms |
| claude | 15.5 µs | 43.4 µs | 1.73 ms |
| amp | 14.2 µs | 10.6 µs | 0.42 ms |

Interpretation costs 1.4–2.8× the hand-written detector and is irrelevant at this poll
rate.

## The real blocker: a sync const in four processes

`contextIsolation: true` (`apps/desktop/src/main/index.ts:286`) means a provider def
must be structured-clonable to reach the renderer. Confirmed:

```
structuredClone(CATALOG.find(d => d.id === "claude"))
  -> DOMException: The object can not be cloned.      // detect() is a function
structuredClone({ ...identity, detect: MANIFESTS.claude })
  -> OK                                                // manifest-shaped
```

So the rule grammar is not a preference. It is the only shape a plugin detector can
take. Everything downstream of that is the actual project:

- `catalog.ts:35-46` — `BY_ID` / `BY_BIN` / `BY_ALIAS` built at module scope; must become rebuildable.
- `agents.tsx:59` — `export const AGENTS = CATALOG.map(...)`, a module-scope snapshot; a rescan is invisible. Must become a store.
- `apps/cli/src/parse.ts`, `ctl-args.ts` — sync consumption in a separately compiled bun binary with its own disk loader; every call site becomes awaited. Miss this and an agent spawns in the app but 404s on `hive ctl spawn --agent <id>`.
- `defaultAgent()` throws with no spawnable entry — a failed plugin scan must never reach it.

Manifest schema plus interpreter is ~400 lines. Converting a sync module const into an
async, rescannable, IPC-mirrored registry is the work.

## OS matrix

| | Linux | macOS | Windows |
|---|---|---|---|
| Tier A — data manifest, scrape-only | works | works | works after the `binOf` fix |
| Tier B — declarative hooks/resume | works | works | cannot work as designed |
| Tier C — plugin JS | ruled out by IPC | ruled out | ruled out |

### `binOf` is POSIX-only — a real bug today, independent of plugins

`catalog.ts:53` splits on `/` and does not strip an extension. Measured:

```
"/usr/local/bin/claude --x"                        -> bin "claude"                    provider claude
"C:\Program Files\claude\claude.exe --resume"      -> bin "C:\Program"                provider NONE
"C:\...\npm\claude.cmd"                            -> bin "C:\...\npm\claude.cmd"     provider NONE
"claude.exe"                                       -> bin "claude.exe"                provider NONE
"claude.cmd"                                       -> bin "claude.cmd"                provider NONE
```

Scope, stated precisely: hivemind's own spawn path passes the def's bare `bin`
(`useSpawn.ts:295`), so **spawned** agents still match on Windows. What breaks is the
case the catalog exists for — recognising an agent **the user ran themselves** — the
moment the command carries a backslash path or the `.cmd` shim npm actually installs.
`node.ts:43` (`matches:`) gates the resume and hook transforms on this, and
`index.ts:1225` gates the HCP agent binding, so both fail silently. `claude/node.ts:70`
repeats the same `.split("/").pop()`.

### Windows breaks Tier B at three more points

1. Hook commands are POSIX shell strings — `ELECTRON_RUN_AS_NODE=1 <exec> <hook>` (`kiro/node.ts:102`, `droid/node.ts:122`, `claude/node.ts:86`). That env-prefix syntax is invalid in cmd and PowerShell, and `shq()` is POSIX single-quoting. Consequence: on Windows no agent has a turn signal, so no HCP worker and no supervise broker.
2. Home overlays are symlink farms (`kiro/home.ts:70`, `symlinkSync` in a best-effort catch). Windows needs Developer Mode; without it the seed half-fails silently.
3. Config root is XDG-only (`views.ts:32`, `settings.ts:33`, `registry.ts:42`) — lands in `%USERPROFILE%\.config\hivemind`. An agents root should inherit that helper, and the helper belongs behind `platform.ts` next to `ipcPath()`.

`platform.ts` already solved the analogous problem for IPC, shells and installer paths.
There is no seam for **shell-command construction**, and that is exactly what Tier B
needs.

macOS: nothing structural. Ad-hoc signing does not affect data plugins; a downloaded
plugin folder carries `com.apple.quarantine`, which matters only if a plugin ships an
executable asset; APFS case-insensitivity makes the "dir name equals manifest id" check
behave differently than on Linux and lets two ids colliding only by case fight.

## Scenarios that must hold end to end

1. **Discovery/install** — mirror `packages/hive-core/src/views.ts`: `$XDG_CONFIG_HOME/hivemind/agents/<id>/` plus repo `.hivemind/agents/<id>/`, user shadows repo, `hive agents install|list|remove`, `agents.rescan` over HCP.
2. **Icon rendering** — `agents.tsx:39` renders `icon.body` with `dangerouslySetInnerHTML`, commented "app-owned constant, never user input". A plugin icon makes that user input in the privileged renderer. A manifest supplies path `d` strings only, never markup. Non-negotiable.
3. **Detector safety** — rule interpreter, no eval, and per the measurement above, no plugin-supplied regex.
4. **Spawn is RCE by design** — a provider's job is argv + env into a PTY in the user's cwd. There is no sandbox analogue to the view host's opaque iframe, so the story is trust prompt at install plus the `tool-plugins.ts` precedent: installed ≠ enabled.
5. **`bin` spoofing** — a plugin declaring `label: "Claude", bin: "/tmp/x"`. Enforce basename-only resolved from PATH; reject ids and bins colliding with built-ins, as views already does.
6. **Capability lying** — `workerAgents()` gates on `caps.turnSignal`. A manifest claiming it without delivering hooks produces exactly the failure `CLAUDE.md` warns about: `hive ctl read` times out, `workflow` gathers nothing, a tile blocked on approval notifies "Finished". Refuse `turnSignal: true` unless the runtime itself wrote the hook config; ship `hive agents doctor <id>`.
7. **Uninstall while tiles live** — layouts store the agent id. `agentById` already returns undefined and detect falls back to idle, so tiles degrade inert like view layouts; verify `transformSpecOnRestore` does not throw for an unknown id and that tile chrome tolerates a missing def.
8. **Remote ssh frames** — `remote/pty.ts` only `shq`s the argv; no `composeResume`, no hook injection. Plugin agents get identity and detect there, same as built-ins do today. Document, don't fix.
9. **Versioning** — an `AGENT_MANIFEST_VERSION` mirroring `@hivemind/view-sdk`'s `PROTOCOL_VERSION`, plus a semver row: breaking manifest change = major.
10. **Drift/golden tests** — `no-hardcoded-providers.test.ts`, `provider-golden.test.ts`, `agent-state.test.ts` assume a fixed `CATALOG`. The loader keeps built-ins first, plugins appended deterministically, and goldens run with plugin roots forced empty.

## Recommendation

**Order matters, and the first step is not the plugin system.**

1. **Fix `binOf` / `isClaude` behind `platform.ts`** — extension-stripping and separator-aware. A real Windows bug today, and every plugin story sits on it.
2. **Make the catalog async and rescannable**, mirrored to the renderer over IPC, built-ins first.
3. **Then the manifest and interpreter.** Tested to cover 14 of 15 in-tree detectors with no regex, `cursor` included — meaning `cursor` needs no plugin system at all, just a probe and a node half.

**Ship Tier A only.** Tier B waits for a `shellCommand()` seam in `platform.ts`, because
a declarative hook template that emits POSIX shell strings would bake a
Linux/macOS-only assumption into a user-facing manifest — much harder to walk back than
200 lines in `providers/`. Tier C stays out: plugin JS in the daemon runs with Electron
main privileges, and the IPC boundary rules it out for the renderer anyway.

## Acceptance gate

The differential harness is the definition of done for the interpreter: every built-in
detector re-expressed as a manifest must agree with its code detector on the golden
corpus plus fuzz, or the grammar is not expressive enough yet. It found the one real
divergence in this design; it should ship as a unit test beside
`provider-golden.test.ts` when the interpreter lands.

---

## Addendum, 2026-09-10: should the built-ins be plugins too?

Yes — and the split is **per half, not per provider**.

The differential spike already showed every built-in *def half* is expressible as
data: 14 of 15 detectors with no regex, `claude` the lone exception. The one gap was
`spawnArgs`, which is a function on `claude` and now on `cursor`. Both are the same
shape — a mode→flags table plus a model flag — so it reduces to data as well:

```jsonc
"spawnArgs": {
  "modeFlags": { "plan": ["--mode", "plan"], "bypassPermissions": ["--force"] },
  "modelFlag": "--model"
}
```

**Node halves cannot be data, and this session proved why.** Codex resume is a bounded
filesystem walk plus a chunked JSONL parse; cursor resume is an md5 of the cwd plus a
`meta.json` scan. Neither is expressible in any manifest that is also safe to load from
a user's config directory.

So: **every provider ships its def half as a manifest, built-ins included, loaded by the
same loader as a third-party plugin.** Node halves stay compiled and registered in
`PLUGINS`. A plugin with no node half is spawn-and-scrape only — which describes 10 of
the 16 providers in the catalog today.

Shipping the built-ins through that path is the point, not a nicety: a loader that only
ever runs for third-party plugins is a code path nobody exercises, and it rots. If the
built-ins go through it, every launch is a test of it.

**One hard constraint.** `defaultAgent()` throws when the catalog has no spawnable
entry, so a failed manifest load would leave hivemind unable to spawn anything at all.
Built-in manifests must therefore be bundled inside the app (loaded from the app
bundle, not from user config), so a parse failure is a build-time bug and can never be
a runtime state on a user's machine. User and repo plugin roots are additive on top and
are allowed to fail.

### Cursor, after probing the real binary (2026.09.08)

The in-tree def was wrong in every field that matters, and the errors compounded:

| | was | is |
|---|---|---|
| `bin` | `cursor` — the **IDE** | `cursor-agent` |
| `aliases` | `["cursor-agent"]` | `["cursor"]` |
| `resume` | `none` | `cwd` — `--resume <chatId>` |
| `modelFlag` | `false` | `true` — `--model` |
| `permissionModes` | `false` | `true` — `--mode plan`, `--force`, `--auto-review` |

`bin` and `aliases` were the wrong way round against the kiro precedent (`bin:
"kiro-cli"`, `aliases: ["kiro"]`), which made `agentForCmd("cursor-agent")` undefined —
so no node half could ever have matched, and spawning would have launched the IDE.

Chat store, verified against a real machine: `~/.cursor/chats/<md5(absolute
cwd)>/<chatId>/meta.json`. Every chat directory present matched md5 of a real workspace
path, none unmatched. `meta.json` carries `updatedAtMs` and `hasConversation`, so
"newest real chat for this cwd" is directly resolvable — a cleaner signal than codex's,
which has no equivalent of `hasConversation`.

**Cursor can be a full worker.** The bundle ships a hook system with claude's
vocabulary — `stop`, `beforeShellExecution`, `beforeSubmitPrompt`, `afterFileEdit`,
`beforeMCPExecution`, `beforeReadFile` — read from `~/.cursor/hooks.json`,
`<cwd>/.cursor/hooks.json`, an enterprise path, and (notably) claude's own
`~/.claude/settings.json`. Format is `{version: 1, hooks: {<event>: [{type: "command",
command: "…"}]}}` — kiro's exact shape, so kiro's home-overlay and hook-templating
machinery transfers. That makes `turnSignal: true` and `supervise: "broker"` reachable.

They are **not** claimed yet: nothing injects those hooks, and per this document's own
rule a capability must be earned by the runtime writing the config, never predicted.
`enabled` also stays `false` until real screens are captured into
`provider-golden.json` — the checklist's bar, and the detector is currently
hand-written guesswork with zero captured screens.

---

## Addendum 2, 2026-09-10: the manifest format, implemented

Shipped in this change: `src/detect-rules.ts` (the interpreter), `src/manifest.ts`
(schema + validation + def construction), `src/load.ts` (disk discovery), and all
**16 built-in providers re-expressed as YAML** under `packages/hive-agents/manifests/`.

### What a manifest supports

| Field | Supported | Notes |
|---|---|---|
| `id`, `label`, `bin`, `aliases`, `note` | yes | `bin` must be a bare basename — never a path |
| `enabled` | yes | spawnable, or recognised-for-status only |
| `caps` (all 7) | yes | but see the refusals below |
| `icon` | yes | declared `path`/`rect`/`circle`/`ellipse` shapes, whitelisted attributes |
| `spawn.args` | yes | the old `defaultArgs` |
| `spawn.modes` | yes | permission mode → flags, with `"*"` as the catch-all and `{mode}` interpolation |
| `spawn.model` | yes | `{model}` interpolation |
| `spawn.label` / `labelMode` | yes | `{n}`, `{label}`, `{mode}` |
| `detect` | yes | ordered rules over three scopes (see below) |
| session resume | **no** | needs the agent's session store read — code |
| hook injection / turn signal | **no** | needs to write the agent's config — code |
| config-home seeding | **no** | same |

Detect vocabulary, which is exactly what the 15 existing detectors required and
nothing more: scopes `screen` / `tail: n` / `tailNonEmpty: n`; combinators `all`,
`any`, `not`; whole-scope `contains`, `containsCS`, `numBeforeWord`; a `line: [...]`
test whose members are `contains`, `containsCS`, `startsWith`, `startsWithAny`,
`gerundAfterPrefix`, `letterAfterPrefix`, `numBeforeWord`, `anyOf`; and three named
helpers (`hasBrailleSpinner`, `hasConfirmationPrompt`, `hasInterruptPattern`).

### What it refuses, and why

- **`caps.turnSignal: true`, `caps.resume != none`, `caps.supervise: broker`** without a compiled node half. A declared-but-undelivered turn signal is worse than an absent one: `hive ctl read` times out and a blocked tile notifies "Finished".
- **raw regex** in a plugin's rules. Measured: `(a+)+$` against 41 characters costs ~1 s on the renderer poll thread, and capping the input does not help. Built-in manifests are loaded `trusted` and may use it — only claude does.
- **`bin` containing a path separator.** Otherwise a manifest labelled "Claude" could point at `/tmp/x`.
- **markup in an icon.** The manifest gives values; the loader builds the element. Attribute values are escaped, so `d: '" onload="x'` renders `&quot;`, not an event handler.

### Verification

All 16 providers, through the shipped loader, against the code catalog:

```
detect: 3000000 checks over 200000 screens · spawn: 560 combos
ALL PROVIDERS EQUIVALENT
```

The suite (`tests/manifest-equivalence.test.ts`, 8k screens for speed) compares
identity, caps, icon markup, `defaultArgs`, spawn args across every mode × model
combination, spawn labels across ordinals, and the detector — per provider, and
asserts no provider lacks a manifest and no manifest is orphaned.

Scaling the corpus up found a **second** real divergence beyond the antigravity
first-match bug, of the same family: antigravity lowercases each line and requires
both conditions on the **same** line, where the first port tested the whole scope
case-sensitively. `"tab amend\nWorking (keep (n) /TASKS 3 TASKS"` returned `idle` for
`working`. That is twice now that this class of bug survived reading the code and was
caught only by differential fuzzing — the harness is the gate, not the review.

### Not done

The loader is not yet wired into the running app. That needs the async, rescannable
registry described above (`CATALOG` is still a sync module const), the IPC mirror to
the renderer, `hive agents list|install|remove`, and a settings section for the
disabled list. `loadAgents()` already takes `disabled` and honours it for built-ins,
so the switch-anything-off behaviour exists and is tested — nothing calls it yet.

---

## Addendum 3, 2026-09-11: validation pass, and future scope

### The equivalence proof was weaker than it looked

"3,000,000 checks, all equivalent" says nothing about a rule the corpus never
reaches. Measuring per-rule coverage found **2 of 45 rules never matched a single
screen**: claude's token-counter rule (needs a `↑`/`↓`/`·`/`(` immediately before the
number) and codex's `• Working (` rule (needs a line that *starts* with the bullet).
Random token-joining produces neither at any useful rate.

Fixed by seeding one screen per rule deterministically rather than hoping fuzz lands
on it. Now 45/45 rules match, every provider produces 2–4 distinct outcomes, and no
provider returns only its default. **Coverage is a standing requirement: a new rule
kind needs a seed, or its equivalence is proved over nothing.**

### The validator did not validate

Probing `defFromManifest` with malformed input found four gaps, all silent:

| Malformed input | Old behaviour |
|---|---|
| unknown expression node | fell through to the regex branch; `new RegExp(undefined)` is the **empty regex**, which matches every screen — one typo pinned every tile of that agent to a single status, forever |
| `spawn.args: "--x"` | spread a string into `["-", "-", "x"]` — corrupted argv |
| `spawn.modes: {plan: "--dry-run"}` | `TypeError` at **spawn** time, long after the manifest loaded clean |
| `numBeforeWord.op: "BOGUS"` | fell through to `eq` — wrong comparison, no error |

Now every node is validated against a closed grammar and refused at load with the
offending field named (`detect.rules[0].when.line[0]: unknown line test ["nope"]`).
Scopes, helper names, regex validity and flag sets are checked too. All 16 built-in
manifests still pass the stricter validation, and the 3M-check equivalence still holds.

The lesson generalises: a manifest is untrusted input, so **anything that can be wrong
must be wrong at load, never at poll or spawn.**

### Future scope

**Before this is usable at all** (nothing here is done):

1. **Async, rescannable registry.** `CATALOG` is still a sync module const with five module-scope snapshots — `agents.tsx:59`, `cli/parse.ts:20`, `cli/commands/agent.ts:19`, `cli/commands/packages.ts:18`, `node.ts:40`. Each must become a live read.
2. **`defaultAgent()` must stop throwing.** It has 10 call sites, several *inside JSX* (`Workspace.tsx:1093`, `LayersPanel.tsx:310`, `WindowsView.tsx:57`). Now that disabling is user-controlled, "disable everything" would white-screen the app. Two guards, not one: the loader refuses to leave zero enabled providers, and `defaultAgent()` falls back instead of throwing.
3. **IPC mirror + renderer store**, since a def crosses `contextIsolation` only as data.
4. **`hive agents list|install|remove`**, plus `agents.rescan` over HCP — mirroring views.
5. **Settings `agents.disabled`.** `loadAgents()` already takes and honours it; nothing writes it.

**Then:**

6. `binOf` behind `platform.ts` — extension-stripping and separator-aware (the Windows bug, independent of plugins).
7. Capture real cursor screens into `provider-golden.json` → flip cursor `enabled: true`.
8. Inject cursor's `stop` hook to earn `turnSignal` — its hook format is kiro's, so that machinery transfers.

**Open design questions, flagged rather than decided:**

- **Overriding a built-in id downgrades it.** A user manifest named `claude` shadows the built-in, and because a plugin never gets a node half, the override silently loses resume, hooks and brokering. Tested and deliberate, but it may be better to refuse the override outright than to hand someone a quietly weaker claude.
- **`manifestVersion` is an exact-equality check**, so a v2 would break every v1 plugin on upgrade. A range plus a migration step is the kinder shape, and it is much cheaper to decide now than after plugins exist.
- **Both vocabularies are closed.** The icon vocabulary is 4 shapes and 17 attributes — discovered by failure, since droid needed `ellipse` and `transform`. A brand mark wanting `<g>` or a gradient cannot render. Likewise a TUI whose status cannot be expressed in the detect grammar has no escape hatch except contributing an app-owned helper. That closure is what makes plugins safe; it is also what will generate the first "why can't my agent…" report.
- **`enabled: true` in a user manifest makes an agent spawnable**, which is arbitrary code execution by design. The install trust prompt and installed-≠-enabled gate (the `tool-plugins.ts` precedent) are not built yet.

### Review findings, fixed

Reviewing the implementation adversarially rather than re-reading it turned up six
defects, five of them in code written the same day:

1. **The shape validator ran second.** `usesRegex` walks the tree with the `in`
   operator, and it was called *before* `validateExpr`. So `when: "hello"` threw a raw
   `TypeError`, not a `ManifestError` — precisely the failure mode the validator had
   just been added to prevent. Order swapped.
2. **`icon.attrs` was never validated, and the renderer spreads it onto `<svg/>` as
   React props.** A manifest could set arbitrary props on a privileged element;
   `dangerouslySetInnerHTML` was only neutralised by prop *ordering* inside
   `SvgMark`. That is a landmine, not a design. Now whitelisted.
3. **The whitelist then broke a built-in**, which exposed a distinction worth writing
   down: `icon.attrs` are **React** prop names (camelCase — codex uses `fillRule`),
   while shape attributes are serialised into markup and stay kebab-case. Both
   spellings are now accepted so an author need not know which side of the boundary
   they are on.
4. **A multi-character glyph failed silently forever.** `startsWithAny: ["-> "]` is
   matched against one character, so it could never fire and said nothing. Refused now.
5. **`numBeforeWord` existed twice** — at expression level (case-sensitive, **zero
   users**) and inside `line:` (case-insensitive, used by antigravity). A duplicate
   with different semantics is a trap; the unused one is gone, restoring the grammar's
   own rule of "exactly what the detectors needed, no more".
6. **cursor's `--resume` takes an OPTIONAL chat id**, so `restoreRetryTransform`
   blindly dropping the next token would eat an unrelated flag: `--resume --force`
   lost `--force`. Only drops the next token when it is really the value.

Two claims were also weaker than stated and are now true as written: the icon test was
named "byte-identical" while comparing whitespace-normalised strings — all 16 do match
exactly, so the comparison was tightened rather than the name softened; and `reserved`
in `ManifestLoadOptions` is currently exercised only by tests, because `loadAgents`
deliberately permits overriding a built-in id (see the open question above).

---

## Addendum 4, 2026-09-11: the live registry, and what Settings needs

### Step 1 done: the catalog is a registry, not a constant

`CATALOG` is gone. `BUILTIN_CATALOG` is now only the *floor* — the providers compiled
into the app — and `getCatalog()` / `setCatalog()` / `subscribeCatalog()` own the live
set. Every lookup (`agentById`, `agentForCmd`, `identifyProvider`, `spawnableAgents`,
`workerAgents`, `detectStatus`) re-resolves through a rebuilt index, and the daemon's
`PROVIDERS` constant became `providers()` for the same reason.

All five module-scope snapshots are gone:

| was | now |
|---|---|
| `agents.tsx:59` `export const AGENTS` | `getAgents()` + `useAgents()` via `useSyncExternalStore` (memoised, or React re-renders forever) |
| `node.ts:40` `export const PROVIDERS` | `providers()` |
| `cli/parse.ts:20` `KNOWN_AGENTS` | `knownAgents()` |
| `cli/commands/agent.ts:19` `KNOWN_AGENTS` | `knownAgents()` |
| `cli/commands/packages.ts:18` | `getCatalog()` inline |

**`defaultAgent()` no longer throws.** It has 10 call sites, several inside JSX, and
disabling providers is about to be a user action — a throw there would white-screen the
app rather than degrade one label. It now falls back: first enabled → first catalogued
→ first enabled built-in → first built-in. Tested against an all-disabled catalog and
an empty one.

One real break surfaced only here: `zz-sixth-provider.spec.ts` patches `node.ts` source
text to prove a new provider flows end to end, and its anchor
`[claudePlugin, codexPlugin, droidPlugin, kiroPlugin, piPlugin]` stopped matching when
`cursorPlugin` was added. The spec has an explicit "anchor moved" guard, which is what
caught it — but it is an e2e spec, so no unit run would ever have shown it.

### Why Settings needs restructuring, not redecorating

The page list (`App.tsx:415`) mixes two kinds of page that behave nothing alike:

- **preference** pages — Appearance, Agents, Notifications, Shortcuts: read and write `settings.json`
- **package-manager** pages — Views, Extensions: list what is installed, with install / remove / error states

Agents is about to be **both**, and there is no shape for that. Concrete defects:

1. **Pages are declared twice** — the `PAGES` array in `App.tsx` and a string switch in `settings-panels.tsx:174`. Nothing checks they agree; an id in one and not the other renders an empty body silently.
2. **Views vs Extensions overlap by their own descriptions** — "Workspace layout and toolbar" against "Manage tools and workspace views". Both claim views; a user hunting for "install a view" has to guess. Agents would make a third list.
3. **Cross-page navigation is a single bespoke prop**, `onExtensions`, which does not generalise to Agents → Extensions.
4. **The shell lives in `App.tsx`** beside `Switch`, `NotificationPrefs` and About, so Settings spans four files with no owner.

Proposed shape, to be done ONCE after the loader is wired (doing it before means
building the Agents page twice):

- a single **page registry** — `{id, label, icon, description, component}` — with the nav and the body both derived from it, so a page cannot half-exist
- **`navigate(pageId)` from context**, replacing `onExtensions`
- one **`<PackageList>`** primitive shared by Views, Extensions and Agents: source badge, error row, enable toggle, install / remove. Justified because `LoadedAgent` and `InstalledView` are already near-identical shapes
- every domain page split into **Manage** (packages) and **Defaults** (preferences) sections, which is the distinction the current page list blurs

**Hard constraint:** four e2e specs pin `[data-settings-page="<id>"]`
(`browser-plugin`, `host-chrome` ×3, `settings-appearance`). The nav contract — page
ids and that attribute — must survive the refactor. That is a feature: it lets the
internals be rebuilt without rewriting the specs.

### Remaining order

2. main loads manifests at startup → `setCatalog` → IPC mirror to the renderer (the renderer half is now ready: it subscribes).
3. the Settings restructure above.
4. `hive agents list|install|remove`; Settings writes `agents.disabled`.

---

## Addendum 5, 2026-09-11: step 2 done — agents load in the running app

Four design calls, each with its reason:

**Built-ins stay compiled; only user and repo manifests are read from disk.** The
equivalence suite proves the 16 shipped manifests are identical to the compiled defs,
so reading them at startup would buy nothing and cost a packaging requirement (YAML as
`extraResources`) plus a brand-new way for startup to fail. `loadAgents` therefore
takes either `builtinDir` (tests, `hive agents list`) or `builtins` (the app).

**Only manifests cross IPC.** A def carries a compiled `detect()` function and
structured clone refuses functions — returning one from an `ipcMain` handler throws at
*runtime*, not at compile time. So main scans, validates and reports; the renderer
rebuilds its own defs through the same schema module. This is the reason the format is
data in the first place, and `LoadedAgent` gained a `manifest` field to carry it.

**The merge lives in the browser-safe module.** It happens twice — once in main for
its own lookups, once in the renderer — so `defsFromWire` sits in `manifest.ts` beside
the schema rather than in the disk loader, which the renderer cannot import. If the two
sides ever disagreed, the UI would offer agents the daemon refuses to spawn; a test
runs real loader output through `toWire` → `structuredClone` → `defsFromWire` and
asserts the rebuilt catalog matches main's, including disabled, broken and shadowed
entries.

**Nothing here can be fatal.** The loader already returns errors instead of throwing;
main wraps the whole scan so a catastrophic failure leaves the compiled built-ins, and
the renderer refuses to install an empty catalog.

### Proven in the real app, not just in unit tests

`tests/e2e/agent-plugin.spec.ts` writes two manifests into a temp `XDG_CONFIG_HOME`
*before* launching Electron, then asserts against the running UI:

- `acme` appears in the agent picker beside the compiled-in providers — the "drop a folder in" case, end to end;
- `liar`, which declares `turnSignal: true` with no node half, is **refused** and does not take `acme` down with it;
- selecting `acme` enables the Model and Permission-mode controls while `codex` disables them — so the declared capabilities made the trip inside the manifest, not just the label.

That last one replaced a first draft that probed a `window.__hiveDetect` hook which does
not exist, and so asserted nothing.

### Step 3 next: the Settings restructure

Now that agents really are configuration, Settings can be restructured once instead of
twice — the plan is in Addendum 4: a single page registry, `navigate(id)` from context,
a shared `<PackageList>` for Views / Extensions / Agents, and each domain page split
into **Manage** and **Defaults**, keeping the `[data-settings-page]` nav contract that
four e2e specs pin.

---

## Addendum 6, 2026-09-11: step 3 — Settings restructured

### A plan correction, found by reading the code

The earlier plan said "one `<PackageList>` shared by Views, Extensions and Agents".
Reading `settings-views.tsx` showed that is wrong: **Views is not a package list.** It
is a radio-style chooser (`settings-view-choice`, `aria-pressed`, a check mark) plus
toolbar preferences — the *manager* for views has always lived in Extensions. Forcing
it into a shared list would have been the speculative abstraction the plan was supposed
to avoid.

What is shared is a `<PackageRow>`: icon, title, status line, on/off switch, optional
footer. That markup was already written **twice inside one file** (bundled tools,
community views) and the Agents manage list is a third — so this is de-duplication with
three real users, not a new abstraction invented for one.

### What changed

- **`settings-registry.ts`** — the page list, declared once. The nav, the header and the description all read from it, and the `SettingsPage` union is now that registry's type instead of a hand-kept duplicate. `chunk: "eager" | "lazy"` keeps the deliberate bundle split visible: About and Notifications stay in the entry bundle, the rest arrive with the Settings chunk.
- **`navigate(id)` through context** replaces the single-purpose `onExtensions` prop, which only ever expressed one jump.
- **The Agents page is Manage + Defaults.** It answered "which agent do I get by default" and never "which agents exist"; an agent added from disk was invisible and a built-in could not be switched off.
- **`settings.agents.disabled`** mirrors the existing `plugins.disabled`, including its 200-entry cap and string filter.

A subtlety the Manage list forced into the open: the **catalog only holds what is
active**, so a disabled agent is absent from it — and Settings must list one in order to
offer switching it back on. Hence a second store of what was *found* (`useAgentEntries`)
beside the catalog of what is *live*.

### Two bugs the e2e caught that unit tests could not

1. **A debounce race, mine.** `patchSettings` only *schedules* a save (`persist()` debounces 150 ms), so `setAgentDisabled` patched settings and immediately asked main to rescan — main re-read the file while the change was still sitting in a timer, and the toggle did nothing. Fixed with `saveSettingsNow()`, which flushes and awaits the write.
2. **A stale catalog in main.** `agents:list` rebuilt the renderer's catalog but not main's, which was only set at startup. Switching an agent off would have updated the UI while the daemon still honoured the old set for spawn transforms and HCP agent binding. The handler now calls `setCatalog` on every scan.

The second is the more interesting one: no unit test would ever have found it, because
each process was individually correct.

### Guarding the class of bug, not the instance

`tests/unit/settings-registry.test.ts` asserts every nav page has exactly one renderer,
that no renderer claims a page absent from the nav, that the `chunk` flag matches who
actually renders each page, and that the four ids pinned by e2e specs still exist. The
"declared in three places, renders blank, says nothing" failure cannot come back
silently.

**Verified:** desktop 473 unit · agents 115 · core 117 · cli 35 · four typechecks ·
build · and 18 e2e — the 5 agent-plugin specs plus all 13 that pin
`[data-settings-page]`, which passed unchanged. The nav contract held.

## Repo agents stay with their repo (closed)

A repo's `.hivemind/agents/` is scanned with a root the renderer hands to `agents:list`,
and the result replaces main's single catalog (`setCatalog`). Two consequences, neither
a takeover — a repo manifest can never claim a built-in's id:

- Open a second workspace and the first one's repo agents leave the catalog, so a tile
  still running there gets `unknown agent '<id>'` from `hive ctl spawn`.
- While that second workspace is open, its repo agents are spawnable from every frame,
  including remote ones, not only from tiles inside that repo.

Both halves are fixed without splitting the catalog. The loader stamps a repo's defs with
`sourceRoot` (set in `load.ts`, never read from a manifest), main keeps the last scan of
every root and publishes their union so nothing disappears, and `ptySpawn` refuses a def
whose `sourceRoot` is not an ancestor of the tile's cwd — the one place that knows both
the command and where it would run. A workspace's own list stays scoped: `agents:list`
still replies with just that root's agents, so other repos' agents never reach its pickers.

`agentAllowedIn` is unit-tested (inside, nested, sibling-prefix, and a manifest that tries
to declare its own root); `agent-plugin.spec.ts` covers the wiring end to end — refused
outside the repo, spawns inside it, and still spawns after another workspace is scanned.

