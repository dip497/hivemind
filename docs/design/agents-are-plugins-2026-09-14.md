# Every agent is a plugin — 2026-09-14

The catalog ships sixteen agents as TypeScript and calls six of them "plugins with a node
half". A repository or a user can add an agent, but only a lesser kind: no resume, no
worker capability, no generated assets. That split is not a property of the problem. It is
where the code happened to start.

This is the plan to remove the split: one format, one loader, one trust model, and
"built-in" demoted to "ships in the box".

## What is actually in the privileged tier

The def half is already data. Every built-in has a manifest in
`packages/hive-agents/manifests/`, and `tests/manifest-equivalence.test.ts` proves each one
reproduces its TypeScript def field by field — including the detector, which is compared
against the code detector over a corpus of real terminal screens. Nothing about a def needs
to be code.

The node half is six files. What they do, counted:

| plugin | arg edits | session lookup | asset written | spawns a process |
|---|---|---|---|---|
| claude | 6 | — | — | no |
| codex | 2 | newest session file for cwd, 1 JSON parse | — | no |
| cursor | 2 | newest session file for cwd, 1 JSON parse | — | no |
| droid | 2 | newest session file for cwd, 1 JSON parse | — | no |
| kiro | 3 | — | 1 | no |
| pi | 4 | newest session file for cwd, 1 JSON parse | 1 | no |

Three primitives, then:

1. **Argument templating** — bind a session id on spawn, add `--resume <id>` on restore.
2. **Session lookup** — the newest file under a directory whose contents name this cwd.
3. **Generated asset** — write one file (a hook script, a settings overlay) into a private
   directory at daemon start, and point an argument or env var at it.

No plugin spawns a process. No plugin computes anything at runtime. The "code" is a
templating language written in TypeScript by hand.

## Target

**One format.** A plugin is a directory: `agent.yaml`, optional asset templates, optional
`plugin.js` for the genuinely odd case. Bundled, user-installed and repo plugins differ
only in where they come from.

**One loader.** `loadAgents()` already reads user and repo directories. Bundled plugins
join it as a third source, read the same way, validated by the same code.

**Capabilities, granted by origin.** Today `trusted: true` is a boolean that unlocks
regex detectors and list commands. It becomes an explicit set:

| capability | bundled | user-installed | repo |
|---|---|---|---|
| launch a command, declarative detection | yes | yes | yes |
| regex detector, `list:` command | yes | on review | never |
| session lookup, generated assets, worker caps | yes | on review | never |
| `plugin.js` (arbitrary daemon code) | yes | explicit grant, named in the review | never |

A repo can still only add agents, never replace one, and never run code — that rule does
not move.

**Data, not disk I/O, on the first frame.** Bundled manifests are compiled to a single
JSON blob at build time and imported like today's catalog: no YAML parser in the bundle,
no startup reads, and built-in ids stay reserved because the blob is present before
anything else loads. The blob is generated from the same YAML a third party would write —
that is the point.

## Manifest v2, the parts that are new

```yaml
session:
  # fresh spawn: bind an id we choose, so the daemon can find it again
  bind: { arg: "--session-id {id}" }
  # restore: what to add when resuming a session we know
  resume:
    kind: id            # id | cwd | none
    arg: "--resume {id}"
  # cwd-resume: where this CLI keeps its sessions, and how to read one
  find:
    dir: "{home}/.factory/sessions"
    newest: "*.json"
    cwdField: "workspace"   # JSON field that must equal the tile's cwd
assets:
  - name: settings.json
    template: settings.json.tmpl   # {hookPath}, {hcpSock}, {hcpToken} substituted
    arg: "--settings {path}"       # or env: { CLAUDE_SETTINGS: "{path}" }
```

Placeholders are a closed set resolved by the daemon (`{id}`, `{cwd}`, `{home}`,
`{private}`, `{path}`, and the hook paths it already owns). No expression language, no
eval — the same closed-world rule the detector rules follow.

## Code, not only YAML — and the SDK that makes it possible

A view is *code*: it ships a page, imports `@hivemind/hive-view-sdk`, and talks to the host
over a versioned protocol. An agent has no such thing, which is the real reason a third
party cannot write one as good as ours. A manifest is the declarative floor; the SDK is
what makes the ceiling the same height for everyone.

What the audit says an agent's code actually needs to do: template arguments, choose a
session from what is on disk, and produce the contents of one file. Every one of those is a
**pure function** — input in, a description of what to do out. Not one of them needs to
open a file, spawn a process or reach the network. That is the whole security design:

```ts
import { defineAgent } from "@hivemind/agent-sdk";

export default defineAgent({
  manifest,                                   // the same facts the YAML carries
  onSpawn(ctx)      { return { args: [...] }; },        // a patch, never a command
  pickSession(found, ctx) { return found.at(-1)?.id ?? null; },  // the daemon did the listing
  assets(ctx)       { return { "settings.json": JSON.stringify(...) }; }, // content, not paths
  detect(screen)    { return "working"; },     // when rules are not enough
});
```

The daemon owns every side effect. It lists the session directory and hands the plugin what
it found; it writes the returned asset into that plugin's private directory and nowhere
else; it validates the patch (arguments are argv, never a shell string; environment keys
come from an allowlist; `cmd` and `cwd` cannot be overridden). A plugin that returns
nonsense gets refused, not obeyed.

That makes the trust question tractable. Bundled plugins are imported directly. A
third-party plugin runs in a worker with the Node permission model and no filesystem, and
since its output is validated, the worst it can do is configure badly the CLI you already
installed and pointed at your repository.

**Authoring in TypeScript, shipping as data.** `defineAgent` is a build-time helper: it
type-checks what you wrote and emits `agent.yaml` (plus `plugin.js` when you supplied
behaviour). We can author our own agents that way too — what matters is that what *ships*
is the same artifact a stranger can ship, because a format only we can produce is a
privileged path by another name.

## What is cached, and what is not

- **Bundled manifests**: compiled to a literal at build time — no YAML parser in the
  bundle, no disk read on the first frame. Validation still runs at import (sixteen small
  objects); if that ever shows up in a profile, the validated shape can be frozen too.
- **User and repo manifests**: re-read on every scan today. Keyed by `path + mtime + size`
  in the user's data dir when someone has enough plugins for it to matter — not before.
- **Presence** (`is the CLI there`): cached by resolved path + mtime; failures are
  deliberately not cached, so installing the CLI fixes the row without a restart.
- **Option discovery** (`--help`, list commands): held for the session in the settled map.
  Persisting it across restarts needs the CLI's own version as part of the key, or an
  upgrade silently keeps stale flags.

## What actually blocks an agent from being a plugin

Measured, not guessed: every manifest run through untrusted validation. Ten of sixteen pass
today. Six do not, for exactly two reasons.

| blocked | reason | what it really needs |
|---|---|---|
| claude, kiro, droid, pi | `caps.turnSignal` — "a manifest cannot inject the hooks a turn signal needs" | a config file, in the agent's own format, whose values point at hivemind's hook scripts |
| cursor, opencode | `options.list` — it runs the CLI to enumerate models | the guards `discover.ts` already applies, plus disclosure in the review |

The first one is the whole game, and it is smaller than it sounds: **the hook scripts are
ours, not the agent's.** `tracker.cjs`, `hcp-stop-hook.cjs`, `hcp-userprompt-hook.cjs` and
friends ship with Hivemind and are the same for every agent. What differs per agent is only
the *wiring file*: claude reads `settings.json` with events under a `hooks` key, droid reads
`hooks.json` with the events at the top level, kiro reads an agent config, pi loads a
JavaScript extension. So hook injection is not "code a plugin must run" — it is a file whose
shape the plugin knows and whose values we supply.

Three properties of the real implementations decide the design:

1. **Claude's file is per tile.** Its hook command lines embed `HIVEMIND_TILE=<id>` and the
   content changes with the supervision policy. Assets written once at daemon start cannot
   express it; a wiring file has to be renderable per spawn.
2. **The values are shell command lines.** `HIVEMIND_TILE='t1' ELECTRON_RUN_AS_NODE=1
   '/path/electron' '/path/tracker.cjs' '/path/sessions'` — quoted. A plugin must never
   build that string: it names a hook, the daemon renders and quotes it.
3. **Droid and kiro need a home, not a file.** Droid symlinks every child of the real
   `~/.factory` into a private overlay and owns `hooks.json` inside it, so login, sessions
   and transcripts stay shared while the hooks are ours. That is a strategy worth naming
   once, not a file to copy.

## Detection: stop matching text, and never take a regex

The status of an agent is currently read by matching literals against the rendered screen.
Richer matching is the obvious next ask, and the obvious answer — "let a manifest ship a
regex" — is the wrong one: OWASP's ReDoS guidance names the exact shape that kills
(repetition inside repetition, overlapping alternation in a repeated group), and Node's own
security guidance is explicit that a denial of service caused by content the application
chose to process "is not a vulnerability in Node.js itself". It is ours. A plugin's regex
would be our hang.

A safer engine is not the interesting answer either. The interesting answer is that most of
what we scrape for is **already stated exactly by the terminal**, and we parse that stream
already:

- **`DECSET ?1049`** — the alternate screen buffer. Set means a full-screen program owns the
  terminal. One bit, no text.
- **`DECSET ?2004`** — bracketed paste. Line editors set it while reading a line and clear it
  while a command runs: the closest thing to "waiting for you" that exists without the
  program's cooperation.
- **OSC 133 A/B/C/D** — semantic prompt marking, implemented by iTerm2, kitty, WezTerm and
  VS Code. `B`→`C` is the input zone; `C` with no `D` is a command running; `D` carries the
  exit code. `A;k=s` marks a secondary prompt, which is literally "waiting for more input".
- **`OSC 1337 SetUserVar`** — for an agent that cooperates (ours do: the hook scripts can
  emit it), state is published rather than inferred. VS Code attaches a per-session nonce to
  its equivalent because anything running in the pty can forge these sequences; so must we.
- **`tcgetpgrp` and termios `c_lflag`** — which process group owns the terminal, and whether
  it is in raw/no-echo mode. Exact, one syscall, needs no cooperation at all.

So the architecture is tiers, text last:

1. Terminal state (modes, zones, foreground process group) — exact, cheap, agent-agnostic.
2. What the agent says about itself, authenticated with a nonce.
3. Literal rules over the screen, scoped to the current zone rather than the whole buffer.

And tier 3 changes shape: instead of every agent scanning the screen for its own literals,
one automaton built from every agent's literals is run once per screen, and each agent's
rule tree is then evaluated over the set of literals that matched. Aho–Corasick's cost is a
function of the haystack, not of how many patterns are in it — so the per-frame cost stops
growing with the catalog, and a plugin's rules can be as rich as ours without any of them
being able to make the scan slow. That is the honest way to "avoid regex": need less
matching, and make what remains linear by construction.

## Running a plugin's own code, when that day comes

The contract is already the right shape — data in, a described plan out, the host performing
every effect — so the sandbox is a small decision rather than a redesign:

- **QuickJS compiled to WebAssembly** is the choice: a minimal setup is about 1.3MB, and it
  is the only option that gives a real CPU watchdog (an interrupt handler with a cycle
  budget) alongside a memory cap, which is what a pure function needs.
- **Not `isolated-vm`.** Its own README says using it "does not automatically make your
  application safe", that leaking a single reference to untrusted code is "usually trivial
  … to use as a springboard back into the nodejs isolate which will yield complete control
  over a process", and that it should live in a different process from anything important.
  It is also a V8-ABI native module, rebuilt per Electron version.
- **Not Node's permission model as the boundary.** Its own documentation states the model
  "does not inherit to a worker thread" and does not cover every path to the filesystem. It
  is process hardening, not a plugin sandbox.
- **The security property is the validator, not the runtime.** `validatePlan` is where a
  plan becomes safe: an allowlist for environment keys, file names confined to the agent's
  own directory, caps on size and count, and unknown fields dropped rather than corrected.
  A sandbox that returns an unvalidated plan is just a slower way to be compromised.

## The plan from here

Ordered so the architecture lands before the ports, and the worst case is proved before the
easy ones — a design that fits pi but not claude is not a design.

**A. One runtime seam.** Today a daemon half is an object in `node.ts` and a manifest is
data read in three different places. Both become an `AgentRuntime` built from a def:
`prepare(paths)` for files that exist once per install, `renderForSpawn(spec, tile)` for
files that exist per tile, and `transforms(ctx)` for argv and environment. The declarative
implementation reads the manifest; the four hand-written halves implement the same interface
until their ports land. No behaviour changes in this step — the goldens prove it.

**B — the mechanism works; the ports remain.** An asset is a template; `{hookCmd:name}`
expands to a complete, quoted command line for one of the daemon's own hook scripts, and
substitutions are escaped for the file they land in (a command dropped into JSON is JSON).
Scope is inferred rather than declared: an asset whose contents name a tile, a session or a
hook is rendered per launch; one that is the same for everyone is written once at install.

Proved end to end on the throwaway sixth agent, which now has **no code at all** — a
manifest and a template — and still passes the full lifecycle: spawn, working/idle, send,
read, report, workflow, close. A worker-capable agent with hooks and nothing written by us.

That port found a real defect in the first design. Per-tile contents were being written to a
per-agent path, so two tiles of one agent overwrite each other's file and the hook commands
carry whichever tile wrote last. **A file whose contents name one tile belongs to that
tile** — the name now carries the tile id, which is what claude's hand-written code always
did and the reason it never hit this.

**Claude is ported — the hardest one, and it fits.** Its 288-line module is gone. What
replaced it, all declared:

- `hooks:` — an events map naming which of our scripts fires on which event, with the two
  conditions real agents need: an entry is dropped when the daemon has no such script, and
  `when: supervised` appears only for a supervised tile. `matcher: supervise` becomes the
  tools that tile's policy covers. The document shape is a one-line template (`{"hooks":
  {events}}`), delivered as an inline argument or written to a file.
- `session.bind` — a generated id passed with a flag, skipped when the user is steering the
  session themselves.
- `session.resume.from` — the live id our tracker hook recorded for the tile, else the id
  bound at spawn (whose flag the resume replaces), else its own store. `position: before`
  for a CLI that wants it early; `fallback` for one that can pick up its last conversation.
- On retry, the tile keeps its identity: the resume is abandoned but the same id is bound
  again, so a vanished session does not turn the tile into a stranger.

The provider golden — which pins argv, environment, the whole settings document, the
supervised variant, restore and retry — passes byte for byte.

**C — done. Droid and kiro too, and with them the last daemon half.** `PLUGINS` is now an
empty list: no agent has code. What the two of them added:

- `home:` — mirror the directory the CLI would normally read into a private one, own named
  files inside it, point an environment variable at the result. Kiro's is nested: a
  directory containing something of ours is mirrored one level deeper instead of linked
  whole, so the user's own custom agents stay beside the one we generate.
- `launch.subcommand` — a subcommand the agent is always launched through, added when the
  command line does not already have it. My first attempt at this was "insert after a
  token", which is not what kiro's code did; the golden said so.
- `launch.requiresHome` — arguments that select something inside the private home are
  skipped when the overlay is not there, so a failed seed degrades the agent instead of
  breaking it. That behaviour existed in kiro's module and would have been lost silently.
- `hooks.entry` / `hooks.group` — the shape of one command and of the wrapper around an
  event's commands. Kiro wants a plain list of `{command}`; claude and droid want each
  wrapped with a type, a timeout and a matcher. That is a property of the CLI, so the
  manifest says it rather than the renderer assuming.
- `session.resume.position: beforeLaunch` — pi wants its bridge extension before the
  resume, kiro wants the resume first. Also per-CLI, also declared.

Four design errors surfaced during the ports, each caught by the golden rather than by
review: validation silently dropping newly added fields (twice — the session block, then
the hook shapes), the wrong abstraction for subcommands, and a retry that forgot to re-bind
the tile's session id. The one the golden could not catch was found by the end-to-end
suite: `prepareProviders` still iterated the hand-written list, so with that list empty
nothing seeded a home or wrote an asset, and droid's workers timed out with no signal.
Unit tests passed throughout — they hand the runtime a context the daemon was no longer
building.

**C. The home overlay, proved on droid then kiro.** A `home:` block: mirror a real config
directory into a private one, own named files inside it, point an environment variable at
it. Kiro's generated approval hook becomes one of the daemon's shared hook scripts, since
nothing about it is kiro-shaped.

**D — done.** pi has no daemon half at all: its extension is a plugin asset, its launch
block adds `-e <asset>` and the control-plane environment, its manifest says where its
sessions live. Its files moved into an agent-private directory (`agents/pi/`), which is the
isolation two plugins need to not collide; the extension itself is byte-identical. The
capability gate moved with it: a turn signal may be delivered by a manifest that wires the
agent to the control plane, not only by a module of ours.

**E — done. `list:` is anyone's.** The guard trust was standing in for turned out not to be
"who wrote it" but "who read it". Three parts, in order of what each actually stops:

- *Validation:* 1-8 plain tokens. No shell runs a listing command — except a Windows `.cmd`
  shim, which does, and where a token carrying `&` would be a second command.
- *Disclosure:* the review names the exact command line, because the interesting question is
  never the shape of the arguments, it is `cursor models` versus something else entirely.
- *Auto-install refuses it.* This is the part that mattered and was nearly missed: an agent
  added because its CLI is on PATH has had no reader, and discovery runs the listing command
  on its own. Anything a person has not agreed to now waits in the catalog instead.

`agentDisclosures()` is the one place that decides what counts, and both the review and
auto-install ask it, so the two can never drift apart.

**F — done.** Seven agents ship inside the app: claude, codex, cursor, droid, pi, kiro — each
needs the daemon before it works at all — plus openclaw, which is a placeholder with nothing
to spawn and no install page, so there is nothing to publish. The other ten moved to
`examples/agents/` and the catalog.

The move was made provably behaviour-neutral by fixing the test suite *first*. The detector
corpus and its golden were taken over the bundled manifests, so unbundling ten agents would
have dropped ten detectors out of the suite on the day they left — silently, with every test
still green. They are now taken over **every agent this repository writes**, bundled or not
(`tests/authored.ts`). Because none of the catalog agents had detectors, widening the basis
changed no screen and no hash; the move then changed none either, because the same manifests
are still read, from a different place. Seven agents gained argv coverage they never had.

Two behaviour changes are real and worth naming rather than regenerating a golden over:
`parseAssignee("gemini")` is a person's name until gemini is installed, which is what it is;
and the counts in the load tests became `BUNDLED_AGENTS.length`, because the number is a
product decision and should never again be a literal in a test.

**The original F plan said the move waits on a push.** `RESERVED_AGENTS` (id → the CLI it
launches) ships in the binary, covering every agent we have shipped, bundled or catalog. A
manifest may take a reserved name only by launching the command that name has always meant —
so unbundling gemini does not open "gemini" to a cloned repository or another index. An
explicit `hive agents install --replace` still lifts it: that is a person deciding, which is
the only thing the rule was ever protecting.

Two checks keep it honest as the bundled set changes: the manifest suite asserts every
bundled agent is on the list, and `build-plugin-index.mjs` refuses a catalog agent that is
not. What is left is the flip itself — ten thin agents moving to `examples/agents/`, three
mechanical edits each — and it cannot land yet: `plugins/index.json` is not on `main`, so the
default index 404s and an unbundled agent would simply vanish for everyone.

**G — the premise changed, and the honest answer is smaller than the plan.**

G was written as "the SDK and its sandbox", on the assumption that `hooks` and `home` needed
a place to run plugin code. Reading what they actually are says otherwise: a manifest *names*
a hook, it never writes the command line, and a name that is not one of ours is dropped when
the document is rendered. The home overlay only ever writes into the plugin's own private
directory; nothing is written back into the user's. Neither is code. Both are now open to
anyone, with the directory and the control-plane wiring named in the review.

That left one agent — claude — outside, on one thing: fifteen regexes. So the last piece was
not a sandbox but **`seq`**, a matcher with no engine behind it: a sequence of terms (a
literal, an alternation, a run of characters from a named or given set, a scan to a literal,
a zero-width "not this next"). Greedy, and it never backtracks — *because it cannot*. An
unbounded run followed by something that must consume a character the run would have eaten
is refused when the manifest loads, which is the only shape that could make matching
super-linear. "Never take a regex" stopped being a rule about plugins and became true of the
format: `re` is gone, ours included.

Each replacement was proved against the regex it replaced over 16,070 texts before anything
was swapped, and every detector — all fifteen — was then proved to answer identically over
both the old corpus and the new one. That mattered: the corpus is generated from the
manifests' own literals, so editing claude's rules moved it, and fifteen hashes went red at
once for a reason that had nothing to do with detection. The golden now pins the corpus by
content and says so, instead of letting a moved corpus read as fifteen broken detectors.

One replacement was still wrong, and only the end-to-end suite said so. A regex `\s` matches
the newline at the end of a line; a matcher that works line by line has no newline to match.
So `^[❯>][\s\xa0]` read a bare prompt at the end of a line as idle and its replacement did
not — a tile that had finished stayed "working" forever. The corpus could not produce the
shape: every token in its pool carries its own trailing space. The fix is a term that says
what was meant (`end`, the line stops here) rather than leaning on an accident of `\s`, and
the shape is now a corpus seed. It changed no verdict on any of the 8035 screens, which is
exactly why it had to be found somewhere else.

**The hole under all of it.** With the gates gone, a `providers()` check on an installed
agent came back empty: `NODE_PARTS` was built from the bundled catalog alone, so an agent
anyone installed got spawn and detection and *nothing else* — its assets unwritten, its home
unbuilt, its hooks never wired, silently. Validation had been saying yes to capabilities the
daemon would never act on. A daemon half is now derived for any def in the live catalog
(`nodePartsFor`, memoised per def so a rescan cannot leave a stale runtime writing the
previous manifest's files), and an installed agent's assets are read from the folder it was
installed into rather than only from the compiled bundle. This is the same shape as the
earlier `prepareProviders` bug and the same lesson: unit tests hand the runtime a context;
only wiring proves the daemon builds one.

And there was a last mile under *that*: the pty daemon is its own process, and it never
loaded the agents on the machine at all — so even with the parts derived correctly, the
process that actually writes an agent's files and injects its hooks only knew the compiled-in
list. An installed worker spawned, ran, and never reported a finished turn. It now scans at
start, best-effort; an agent installed while it is running is wired at the next start.

The throwaway sixth agent went from a bundled one (which meant editing our own source and
rebuilding the app twice, about five minutes) to one installed the way anyone's is — a
manifest and a file in the user's agents folder, no rebuild, 29 seconds. That is what found
both of these, and it is the spec worth trusting: it is now the only test that exercises an
agent nobody compiled in.

**So: 16 of 16 agents now validate as untrusted plugins, up from 10.** The privileged tier is
empty — not "small", empty. What a sandbox would add is a plugin that *computes* something,
and after A–F nothing in sixteen agents does. It stays unbuilt until something needs it,
which is what the phase always said to do.

## What this is worth

- A third party can write an agent as good as ours. Today they provably cannot.
- The sixteen `providers/*/index.ts` files (131KB of source) become sixteen YAML files that
  are already written and already tested.
- "Why do we ship sixteen agents?" stops being an architecture question. P6 answers it as a
  product question, which is what it always was.

## What to watch

- **The detector corpus is the gate.** It caught the difference between a code detector and
  a rule set once; it must run in every phase.
- **Resume is the risky half.** A wrong `--resume` silently starts a fresh session and the
  user loses context. Each port lands with its existing resume test passing untouched.
- **The trust table is load-bearing.** A capability that a manifest can silently claim is a
  hole; every new capability is refused for untrusted sources by default, with a test that
  says so (the pattern `manifest.test.ts` already uses for `re` and `list`).
- **First-frame cost.** The compiled blob keeps the current shape; if it ever becomes a
  runtime read, the toolbar's first paint regresses.
