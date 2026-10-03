# Plugin platform — design (2026-10-03)

Status: proposal. Inputs: `docs/research/plugin-ecosystems-2026-10-03.md` (part 2 is the
architecture research), `docs/design/multiplayer-2026-09-28.md`, and the earlier plugin docs this
one builds on rather than replaces: `tile-plugins-2026-09-16.md` (tool tiles speak MCP Apps),
`plugin-runtimes-2026-09-17.md` (two runtimes, split by trust), `agents-are-plugins-2026-09-14.md`
and `plugin-marketplace-2026-09-14.md`.

Numbers relied on, and where they come from: Figma pins a widget's version per instance and runs
widget code only on the interacting client (research §1, fetched); Figma caps plugin data at
100 kB per entry and started enforcing it late, breaking live plugins (§1, fetched); Loro has
`shallow-snapshot` export and no quota API (checked in `loro-crdt@1.16.4`'s `.d.ts`), and "peers can only sync if they have versions after the shallow snapshot point" (loro.dev, fetched 2026-10-03); one
sandboxed view iframe costs ~68 MB RSS on this app (`plugin-runtimes-2026-09-17.md`, measured
here). Nothing else below depends on a number.

## 1. Goals / non-goals

Goals
- A small kernel; everything a person sees on the board can be a plugin, including what ships
  in the box.
- Plugins are multiplayer by default: shared state, presence, and a viewer who does not have the
  plugin still sees it.
- Untrusted code never runs with the owner's powers, never runs on a viewer's machine just to be
  looked at, and never updates itself silently.
- The terminal fast path stays as fast as today.

Non-goals (for this doc)
- Registry, review and payments (`plugin-marketplace-2026-09-14.md` owns those).
- A third UI runtime. Two exist on paper; this doc adds no third.
- Plugins on the pty byte path. No production system does it (research §2) and neither will we.
- Moving the terminal into a plugin.

## 2. The primitives

The kernel owns six things. Everything else is a plugin.

| Kernel piece | Exists today as |
|---|---|
| Shared document (Loro) + its edit rules | `packages/workspace-doc`, `workspace-host/src/doc-sync.ts`, `edit-rules.ts` |
| Identity, roles, audit | `workspace-host/src/access.ts` (`ROLES = view, edit, terminals, agents`), `audit-log.ts` |
| Intents: the one path for a side effect | `workspace-host/src/intents.ts:66` (`perform`) |
| Plugin loader, sandbox, budgets | `view-host/src/link.ts` (`LIMITS` :57, grants :444), `main/view-packages.ts:140` (CPU watchdog) |
| Transport | `hive-net`, `workspace-api` |
| Terminal streams (interest model) | daemon + `workspace-api/src/terminals.ts` |

### 2.1 Board object

One geometry record: `{ id, x, y, w, h, z, chrome, clickThrough, content }`.

- `chrome`: `"frame" | "card" | "none"` — a tile has a frame, a widget a card, a pet none.
- `clickThrough`: pointer events fall to whatever is below (pets, overlays).
- `content`: `{ kind: "note"|"checklist"|"text" , … }` (kernel kinds, as today) or
  `{ kind: "plugin", plugin, version, instance, render }`.

Tiles keep their own record (`TILES`) — see disagreement D3. They share the geometry and chrome
fields and the canvas renders both through one path, so "tile / widget / pet" are settings of
the same object on screen while the document keeps the distinction the permission rules need.

### 2.2 Contribution points

A plugin *asks*; the user *places*. Manifest `contributes`:

| Point | What it is | Rendered by |
|---|---|---|
| `boardObject` | a kind of board object | kernel, from the render tree (§2.3); iframe on focus if declared |
| `panel` | a side panel | iframe (MCP Apps wire, `tile-plugins` doc) |
| `status` | a status-bar item | kernel, render tree |
| `command` | palette entry + `hive ctl plugin <id> <cmd>` | logic half |
| `phoneCard` | compact card + up to 3 actions | phone app, render tree |
| `view` | whole-canvas view | existing `hivemind-view.json` protocol, unchanged |
| `service` | a typed service other plugins consume (§2.6) | logic half |

### 2.3 Logic half, render tree, UI half

A plugin has up to three parts:

1. **Logic half** — runs on the instance's **home device** (where it was placed; for a host
   widget, the host). Holds grants to host resources (net origins, fs scopes, intents). Runs in a
   worker/child process with a Deno-style scoped grant list, never in the main process. It reacts
   to events and actions, writes its state, and **renders**.
2. **Render tree** — what the logic half renders: a small, kernel-defined JSON tree
   (`stack, row, text, number, meter, icon, image(asset), button(action), sprite(asset, frame)`)
   stored in the instance's state in the doc. Every viewer — guest, phone, someone without the
   plugin — draws it with kernel code. No foreign code runs to *look* at a plugin. This is the
   Figma widget model (research §1).
3. **UI half** (optional) — a sandboxed iframe from the pinned package, opened when the user
   focuses the object or opens a panel. Speaks MCP Apps JSON-RPC. Only for real UI (editors,
   charts with interaction).

Interaction from anyone: a `button(action)` in the render tree sends an **action intent** to the
instance's home device through the kernel (`intents.ts`), checked against the clicker's role.
The logic half runs it there and re-renders. A guest never runs the plugin; the host does.

### 2.4 Versions and missing plugins

- Instance pins `{plugin, version, contentHash}` in its `content`. Existing instances keep their
  version; new ones get the installed one. Upgrading an instance is an explicit action that runs
  the plugin's declared state migration (state shape is a contract: research §1, tldraw).
- Missing plugin, or pinned version not installed: draw the last render tree, greyed, with an
  **Install** affordance. Actions are disabled. Nothing breaks, nothing is dropped.
- Home device offline: last render, actions disabled, "<host> is offline".

### 2.5 State tiers

| Tier | Where | Rules |
|---|---|---|
| Shared durable | doc map `plugins/<instanceId>` (state + render) | kernel byte cap per instance and per plugin, checked at write **and** at import on the host (D4); per-user keys for concurrent writes |
| Shared ephemeral | presence channel (`workspace-host/src/presence.ts`), a per-plugin slot | never in the CRDT: positions, animation frames, cursors, "typing" |
| Local | per-plugin store on the device | kernel-capped, never synced (secrets, caches) |

Bulk or high-churn data (logs, time series) is not doc state: the logic half keeps it locally and
renders a summary. GC: deleting an instance or uninstalling clears its records; bytes leave the
document only at the host's next shallow-snapshot compaction (D4).

### 2.6 Services between plugins

`provides: [{ id: "usage/v1", schema }]`, `consumes: ["usage/v1"]`. The kernel brokers calls
between logic halves on the same device; cross-device calls go as intents. Each service declares
its minimum role; a call is allowed when the consumer's grant names the service **and** the
acting person's role meets that minimum. Versioned by id suffix; a plugin may provide `v1` and
`v2` side by side.

### 2.7 Event middleware

`on(event, ($, e, next) => …)` on kernel intents (`spawn`, `prompt`, `close`, `tool.approve`, …).

- **Trusted only** (ships in the box, or the user's own local plugin): imperative middleware,
  host-side, explicit `order` key, per-hook timeout; on timeout the event fails **closed** for
  `deny`-able events (approvals) and **open** for observers.
- **Untrusted**: declarative rules evaluated by the kernel (`{ match, decision: allow|deny|ask }`)
  and a deny vote. No in-place rewriting (Chrome MV3 lesson, research §5).
- Hooks attach to `IntentGate.perform`, the existing single path; no second event bus.

### 2.8 Terminal

The terminal stays a kernel surface. Plugins get a **contract** (open, write a confirmed prompt,
resize, status, line-level or rate-limited output events) and never bytes inline. Bytes go
through the kernel stream with today's interest model: only shown terminals get bytes.

### 2.9 Core is headless

Key principle. Core owns the data structures, contracts, actions, validation and permissions.
How anything is *shown* — grouped by time, recency or status, laid out, sorted — is entirely a
plugin's choice. Our built-in issues list, agent sidebar and canvas are the default plugins on
the same contract, with no private API (privileged APIs only behind a flag, as in research §4).

Rules core follows:

1. **Stable ids, versioned schemas.** A record's id never changes; each record type has a schema
   version and a migration. A plugin declares the version it reads (`consumes: ["issues/v1"]`).
2. **Read via query + subscribe.** `query(type, { filter, sort, limit })` returns a snapshot plus
   a cursor; `subscribe(query)` streams incremental changes (`added | changed{fields} | removed`).
   Core keeps the indexes (state, assignee, labels, updated) so ten plugins do not each rescan
   every record on every change.
3. **Writes only through actions.** `issue.setState`, `issue.update`, … validated and
   role-checked by core and routed through `IntentGate`. A plugin never writes doc records
   directly; the edit rules refuse it on import if it tries.
4. **Per-plugin metadata namespace.** Every core record has `ext.<pluginId>` — a small,
   capped map only that plugin writes (its own tags, groups, card colours, swimlane overrides).
   Core stores and syncs it, never interprets it. Removing the plugin clears its namespace.
5. **View choice is local.** Which UI a person uses, and its settings (sort, collapsed
   columns), is local state (§2.5). It becomes shared only when the person shares it, e.g. by
   saving it as a named board view in the doc.
6. **Core never encodes presentation.** No `group`, `column`, `lane` or `order` field in core
   data — unless it is user data a person chose (a label, a state, a manual rank they set).
   Status is a fact; "the Doing column" is a UI's reading of it.

**Example: one contract, two community UIs.**

Contract `issues/v1` (core): record `{ id, title, state, labels, assignee, parent, created,
updated, ext }`; actions `create, update, setState, comment, link`; events from
`subscribe`. Same for `agents/v1`: `{ id, tile, agent, status, task, lastActivity }`, actions
`prompt, approve, stop`.

- **Timeline** (`@ana/timeline`): `subscribe(issues, { sort: "-updated", limit: 200 })` merged
  with `subscribe(agents, { sort: "-lastActivity" })`. Groups by "Today / Yesterday / This
  week" in its own code. Writes nothing to core except through actions (a "done" button calls
  `issue.setState`).
- **Kanban** (`@raj/kanban`): `subscribe(issues, { filter: { state: ["todo", "in_progress",
  "in_review"] } })`; columns are `state` values. Dragging a card between columns calls
  `issue.setState`. Manual order *within* a column is kanban's own data, stored in
  `ext["@raj/kanban"].rank` — the timeline never sees it, core never sorts by it.

Both run side by side on the same workspace. A guest using the timeline and a host using kanban
see the same move the moment `setState` lands, because both are views of one subscribed query.
Uninstalling kanban drops its ranks and nothing else.

## 3. The examples, end to end

**Usage meter** (logic + render; no iframe).
Installed by the owner; placed as a `card` board object. Logic half on the owner's device reads
agent status through the `agents/v1` service (a kernel-provided service wrapping
`agentStatus`), keeps per-minute samples locally, renders `meter + number` every 10 s or on
change (rate-limited by the kernel: max 1 render/s per instance). Shared state: just the render
tree and the cap setting, well under the cap. Guests see the meter move with zero plugin code.

**Water reminder** (logic + status contribution).
A `status` item and an optional `card`. Logic half holds a timer; at the interval it renders
"drink" and raises a kernel notification (grant: `notify`). State is local (per person: it is my
reminder) unless placed on the board, in which case per-user keys hold each person's last-drunk
time. No net, no fs. The smallest useful proof that a plugin need not be an iframe.

**Desk pet** (render + ephemeral).
Board object with `chrome: "none"`, `clickThrough: true`, sprite sheet as a package asset. Its
*mood* (fed, sleeping) is durable state; its *position and frame* are ephemeral, broadcast by the
home device on the presence channel at ≤10 Hz and interpolated by each viewer. Motion never
enters the CRDT, so a pet walking all day adds zero bytes to history.

**Community board view** (existing whole-canvas view).
Unchanged protocol (`hivemind-view.json`, `view-host/src/link.ts`). Gains: its per-view layout
already lives in the doc (`workspace-doc/src/views.ts`); it can now draw plugin board objects by
reading their render trees from the projection instead of needing each plugin's code.

**A guest viewing a host widget.**
Guest joins (M1). Doc sync brings `objects` and `plugins/<instanceId>`. The guest's canvas draws
the render tree. Guest clicks a button: action intent → host → host's logic half → new render →
doc sync → guest redraws. If the guest has `view` role and the action needs `edit`, the kernel
refuses it at the host and the button is drawn disabled for them. The guest never downloads the
package. If the guest *installs* the same plugin and pins version, nothing changes for this
instance — it is still homed on the host.

**Phone.**
`phoneCard` = render tree + ≤3 actions; the phone app draws it natively and sends actions as
intents (the iOS-widget lesson, research rec. 9). No web view per card. A plugin that wants a
full phone UI uses a `view` with `phone: true`, as today (`hive-view-sdk/src/manifest.ts`).

## 4. API sketch

`hivemind-plugin.json`:

```json
{
  "id": "@ana/usage-meter",
  "version": "1.2.0",
  "apiVersion": 1,
  "minAppVersion": "2026.10.0",
  "logic": "dist/logic.js",
  "ui": "dist/panel.html",
  "assets": "assets",
  "contributes": {
    "boardObject": [{ "id": "meter", "label": "Usage meter", "chrome": "card", "size": [240, 120] }],
    "status": [{ "id": "today" }],
    "phoneCard": [{ "id": "meter" }]
  },
  "consumes": ["agents/v1"],
  "grants": { "net": [], "fs": [], "intents": ["notify"] },
  "state": { "version": 2, "maxBytes": 32768 }
}
```

Logic SDK (runs in the worker):

```ts
export default definePlugin({
  migrate: { 2: (s1) => ({ ...s1, cap: s1.limit ?? 0 }) },
  async onInstance($) {                 // one per placed instance on its home device
    const agents = await $.use("agents/v1");
    const draw = () => $.render(meter($.state.get("used"), $.state.get("cap")));
    agents.onChange(() => { $.state.set("used", agents.totalTokens()); draw(); });
    $.action("reset", { role: "edit" }, () => { $.state.set("used", 0); draw(); });
    draw();
  },
});
```

`$` surface: `state.get/set/perUser`, `ephemeral.send/on`, `local.get/set`, `render(tree)`,
`action(name, {role}, fn)`, `use(service)`, `provide(service, impl)`, `notify`, `on(event, mw)`
(trusted only). UI half: MCP Apps `ui/initialize` + `tools/call` mapped to the plugin's actions.

## 5. Security model

- **Process isolation, not JS isolation.** Logic half: worker/child process per plugin with a
  scoped grant list; UI half: `hm-view://` sandboxed origin, CSP `default-src 'none'` + declared
  origins. Never `vm`/realm-based (research mistake 3).
- **Grants** are Deno-shaped (`net:<origin>`, `fs:<scope>`, `intents:<verb>`, `service:<id>`),
  shown at install, re-consented when they widen. `exec` / unscoped fs = trusted tier only.
- **Pin by content hash.** Updates are a diff the owner approves; never silent.
- **Roles × actions.** Every action and service call declares a minimum role; checked at the
  home device on arrival, using the access list already there (`access.ts`).
- **Budgets.** Messages/s and long-task windows (`link.ts:57`), CPU watchdog
  (`view-packages.ts:140`), renders/s, doc bytes per instance and per plugin, ephemeral Hz. A
  plugin over budget is disabled for the session, as views are today.
- **No remote code.** UI and logic ship inside the pinned package.
- **Viewer safety.** Render trees are data drawn by kernel code; images only from package assets
  or data URLs under a size cap; text never as HTML.
- **Kill switch.** Registry revocation the loader checks; disabled plugins fall back to last
  render.

## 6. What exists today vs gap

| Piece | Today | Gap |
|---|---|---|
| Sandboxed UI + manifest + perms | `hive-view-sdk/src/manifest.ts`, `view-host/src/link.ts` | perms are whole-canvas verbs only (`protocol.ts:24`); no net/fs grants |
| Budgets | `link.ts:57`, CPU watchdog `view-packages.ts:140` | no doc-byte or render budget |
| Disable built-ins, keep id | `community/registry.ts:84` (`plugins.disabled`), `hive-core/src/tool-plugins.ts:35` | built-ins are not on the public contract yet |
| Board objects | `workspace-doc/src/objects.ts:35`, kinds fixed at `shapes.ts:80` | no `plugin` kind, no chrome/clickThrough/z |
| Doc edit rules | `workspace-host/src/edit-rules.ts:39` | no rule for plugin records, no byte cap |
| Presence / ephemeral | `workspace-host/src/presence.ts` | no per-plugin slot |
| Intents | `workspace-host/src/intents.ts:66` | no action intents, no middleware |
| Host logic, guest UI | `community/RemoteCommunityView.tsx` (host runs the session, guest frames the files) | runs host plugin code in the guest's sandbox; the render-tree path replaces this for widgets |
| Logic half runtime | none | worker host + grants + SDK |
| Render tree | none | schema + canvas renderer + phone renderer |
| Agent manifests as data | `hive-agents/src/manifest.ts` | stays as is; agents become a contribution point later |
| Headless reads | `workspace-api/src/methods.ts:56` `issue.list` returns everything; writes are already actions (:58–68); `IssueSummary` holds no presentation fields (`hive-core/src/types.ts:102`) | query + subscribe with core indexes and change events; `ext.<plugin>` namespace; built-in issues UI moved onto the contract |
| Compaction | none | host-side shallow snapshot on a schedule |

## 7. Phased plan

**Phase 1 — prove the split** (usage meter, water reminder, desk pet).
0. Query + subscribe for `agents/v1` (the meter consumes it) — the first headless contract.
1. `plugin` board-object kind + `plugins/<instance>` records in `workspace-doc`, with a byte cap
   in `writeObjects` *and* in `edit-rules` for imported changes. Tests: oversize write refused
   locally and from a peer.
2. Render-tree schema (`packages/hive-plugin-sdk`) + canvas renderer + missing-plugin placeholder.
3. Logic-half worker host in main: load, grants (`notify`, `service:agents/v1` only), budgets,
   one instance per placed object.
4. Action intents through `IntentGate`, role-checked at the home device.
5. Per-plugin ephemeral slot on presence (pet).
6. The three plugins as packages in `.hivemind/plugins/`. Done when: a guest sees all three
   move and can click the meter's reset (with `edit`), without the package on their machine, and
   uninstalling on the host leaves greyed last renders.

**Phase 2** — services between plugins, phone cards, UI half (MCP Apps iframe on focus),
per-instance upgrade + migrations, shallow-snapshot compaction.
**Phase 3** — trusted middleware + untrusted declarative rules; first built-in migration
(issues), then browser, editor, agents. Each keeps its id and settings keys and is
disable-able, not uninstallable.

## 8. Where this departs from the agreed direction

- **D1. A sandboxed UI half per widget is too expensive.** One view iframe is ~68 MB here; ten
  widgets would be ~700 MB. Widgets, status items and phone cards render as kernel-drawn
  render trees; the iframe is opt-in, on focus. This *is* the Figma model the direction cites —
  it just makes the render tree the primary UI, not a fallback.
- **D2. "Logic runs where installed" must not mean "with host powers".** Obsidian-level access
  is the class behind the supply-chain incidents in the research. The logic half runs isolated
  with scoped grants, and the instance's home device — not the clicker's — executes actions.
- **D3. Tiles stay a separate record.** `edit-rules.ts` decides who may start things by whether a
  tile *runs* something (`INERT`, `RUNS`); folding tiles into board-object `content` would put a
  process launch behind a field any `edit` role can change. Share geometry and rendering, not
  storage. (Arrows are also not boxes.)
- **D4. A write-time cap alone is not enforcement, and uninstall does not free bytes.** A
  modified client skips its own check, so the host re-checks imported changes in `edit-rules`.
  Loro keeps history, so clearing a container frees nothing until a shallow snapshot; and
  shallow snapshots refuse imports from peers behind the frontier, so compaction must wait for
  every device to have synced past it.
- **D5. Middleware: fixed order, but not the reference it cites.** The research notes Claude Code
  docs say "All matching hooks run in parallel" (code.claude.com/docs/en/hooks, fetched 2026-10-03), so "like Claude Code mods" is not an
  ordering precedent; the ordering is Koa/Tapable-style with an explicit `order` key, and the
  hook point is the existing intent gate, not a new bus.

## 9. Open questions

- Home device handoff: when the host leaves for good, can an instance be re-homed to another
  device that has the plugin, and who approves the grants there?
- Render-tree vocabulary: how small can it stay before every plugin wants "just one more" node?
  Charts are the first pressure.
- Per-plugin doc vs one doc: separate Loro docs would make GC real (drop the file) at the cost
  of a second sync channel. Measure doc growth with the three Phase-1 plugins first.
- Does the in-process React runtime (`plugin-runtimes` doc) survive, or does the render tree
  replace it for the user's own tiles too?
- Agent-built plugins: same pinning and review as any other, but who is the "owner" approving the
  grant diff when an agent tile wrote it?
