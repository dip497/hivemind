# Agent providers — the pluggable architecture

> Status: shipped (milestone 3). One registration per CLI coding agent, in
> `packages/hive-agents`, read by the desktop UI, the `hive` CLI and the HCP
> control plane. Nothing outside a provider's own files names it — a unit test
> (`no-hardcoded-providers.test.ts`) fails the build if one does.

## The problem this replaces

Wiring kiro took ten touch points: a provider adapter, the registry, the UI list
with its icon, the status detector table and its alias map, the daemon's
overlay seeding, the shared spawn-context type, the initial-prompt allow-list,
two CLI name lists, and the MCP tool descriptions. Each was a registry that
could drift, and several did (the CLI lists never learned about droid). Worse,
what an agent *could not* do lived nowhere: a runtime with no turn signal
produced workers that looked alive and delivered nothing.

## Shape

```
packages/hive-agents/src
├── types.ts            the contract: AgentProviderDef (browser-safe), AgentPlugin (daemon)
├── catalog.ts          CATALOG — the ONE list of defs; agentById / agentForCmd /
│                       identifyProvider / defaultAgent / spawnableAgents /
│                       workerAgents / detectStatus / spawnArgsFor / spawnLabelFor
├── node.ts             PLUGINS — the ONE list of plugin objects; composeResume;
│                       prepareProviders (daemon start). Derived: NODE_PARTS, PROVIDERS
├── detect-helpers.ts   herdr scrape helpers (no agent names)
├── icon.ts             the generic mark
├── shq.ts, tile-session-store.ts   shared daemon-side helpers
└── providers/<id>/     ONE DIRECTORY PER PROVIDER
    ├── index.ts        the def: identity, capabilities, icon, detector, spawn-arg vocabulary
    ├── node.ts         the plugin object `{ def, prepare?, resume?, assets? }`  (tier 1+)
    └── *.ts            its assets beside it: claude/state.ts, droid/home.ts,
                        kiro/home.ts + kiro/approval-hook-source.ts, pi/ext-source.ts
```

Sixteen providers live there today: the six spawnable ones (claude, codex,
opencode, droid, pi, kiro) and ten recognised-only ones (gemini, cursor,
antigravity, cline, copilot, kimi, amp, grok, hermes, openclaw) that hivemind
identifies and status-scrapes when a user runs them, with `enabled: false`.
There is no other list anywhere.

Two halves, split by where the code can run:

- **`AgentProviderDef`** (browser-safe, `index.ts`). `id`, `label`, `bin` (spawn
  matching is exact-binary), `aliases` (identify a user-run instance for status
  only), `defaultArgs`, `enabled`, typed **`caps`**, an inline-SVG `icon`, the
  screen-scrape `detect`, optional `spawnArgs(opts)` / `spawnLabel(n, opts)` so a
  runtime's flag vocabulary (claude's permission modes and model alias) lives in
  its own def instead of the UI, and a `note` shown wherever the agent is
  offered when it cannot be a worker.
- **`AgentPlugin`** (daemon, `node.ts`): `{ def, prepare?, resume?, assets? }`.
  `prepare(paths)` runs at daemon start and returns the provider's private paths
  (an extension file, a config-home overlay, its own hook script); `resume(ctx)`
  builds the spawn/restore/retry transforms and reads those paths back from
  `ctx.providers[def.id]`; `assets` exposes the generated sources.

The shared `ProviderSpawnContext` carries only daemon-generated,
provider-agnostic fields (exec path, tracker, session dir, the common HCP hook
scripts, socket + token) plus `providers[id]`, opaque to everyone but the owner.
`node.ts` derives everything else from `PLUGINS`; it contains no provider logic.

## Capabilities are the contract

```ts
caps: {
  promptDelivery: "argv" | "typed";     // initial task: positional argv or typed on idle
  turnSignal: boolean;                  // deterministic turn events → an HCP WORKER
  resume: "none" | "cwd" | "tile";      // across a daemon restart
  supervise: "broker" | "human" | "none";
  modelFlag: boolean;                   // honours --model
  permissionModes: boolean;             // honours claude-style permission modes
  blockedDetection: boolean;            // the detector has a needs-you branch
}
```

Every field is required, so an absence is a decision, never an omission. And
every field has a reader:

| capability | who reads it |
|---|---|
| `promptDelivery` | `shared/agent-io.ts` — argv auto-submit vs typed-on-idle |
| `turnSignal` | HCP `agent.read` / `workflow.run` refuse with `UNSUPPORTED`; `hive ctl workflow --agent` refuses before spawning (exit 7); `workerAgents()` for the skill and help text |
| `resume` | drift test: needs a node half unless `noNodeHalf` |
| `supervise` | HCP spawn: `"none"` refuses `--supervise`; `"human"` accepts it (its own prompts stay with the human); `"broker"` brokers |
| `modelFlag`, `permissionModes` | `useSpawn` / HCP spawn build args only for providers that honour them |
| `blockedDetection` | the checklist row; the UI never shows "Finished" for a stuck approval when true |

## Who reads the catalog

| reader | before | now |
|---|---|---|
| tool island, frame launcher, Layers rail, pickers | `agents.tsx` hand-list + per-provider React icons | `AGENTS = CATALOG.map(…)`; icons rendered generically from `def.icon` |
| status detection | `agent-state.ts` union type, alias map, detector table | catalog aliases + `def.detect` for every recognised agent; `agent-state.ts` only routes by id |
| initial prompt delivery | `ARGV_PROMPT_AGENTS` set | `caps.promptDelivery` |
| PTY daemon | per-provider blocks (pi ext, droid home, kiro home + hook) | `prepareProviders(paths)` → `ctx.providers` |
| HCP spawn / read / workflow | `"claude"` default, `SUPERVISE_UNSUPPORTED = {pi}` | `defaultAgent()`, `caps.supervise`, `caps.turnSignal` |
| `hive ctl --agent`, `hive agent detect`, `--assignee` | three hand-kept lists | `spawnableAgents()`, `CATALOG.map(bin)`, `CATALOG.map(id)` — no extras list |
| spawn args / labels | claude's modes + model flag in `useSpawn` | `def.spawnArgs` / `def.spawnLabel` via `spawnArgsFor` / `spawnLabelFor` |

The agent tile kind is still persisted as the historical value `"claude"`
(`AGENT_TILE_KIND` in `tile-kinds.ts`, the one allowed literal); the provider of
a tile is derived from its command.

## Adding a provider

1. `providers/<id>/index.ts` — the def. Probe the binary first (the skill's
   capability table); the caps you write here are what the control plane will
   believe. `spawnArgs` if the runtime has its own flag vocabulary.
2. `providers/<id>/node.ts` — only if it resumes or injects signals: export
   `plugin: AgentPlugin`. Keep its assets as sibling files.
3. One line in `catalog.ts` (`CATALOG`); one in `node.ts` (`PLUGINS`) if there
   is a plugin object.

That is the whole procedure — `zz-sixth-provider.spec.ts` performs it against a
throwaway provider on every e2e run and checks the UI list, the CLI choices, HCP
spawn and the full lifecycle (spawn → working/idle → send → read → report →
workflow → close) through the scripted stand-in agent.

## Guarantees and their tests

- **Behaviour is pinned.** `provider-golden.test.ts` snapshots spawn/restore/retry
  transforms, injected files, asset hashes, prompt delivery, identification,
  supervise policy and detector outputs per provider.
- **Composition is order-independent.** The same golden is asserted with the
  providers composed in reversed order.
- **The lists cannot drift.** Every plugin's `def` is the catalogued object
  itself; every def whose caps need one has a plugin (or says `noNodeHalf`).
- **Nothing names a provider elsewhere.** `no-hardcoded-providers.test.ts`
  greps `apps/desktop/src` and `apps/cli/src` for every id, binary and alias.
