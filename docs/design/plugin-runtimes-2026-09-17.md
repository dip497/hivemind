# Two runtimes for a plugin tile, and where the line sits

Status: decided. 2026-09-17. Branch `feat/tile-plugins`.
Companion to `tile-plugins-2026-09-16.md`, which covers the registry and capabilities.

## The question

A sandboxed iframe is the right home for a big tile. It is absurd for a water-break
reminder. Measured on this app: mounting one sandboxed view (the `orbit` example, idle
canvas) grew total RSS by **~68 MB**. Nobody should pay that, plus a build step, to draw a
checkbox — and nobody should be told to write a code editor as a component tree.

So: two runtimes, split by **trust, not size**.

| | In-process React SDK | Sandboxed iframe (MCP Apps) |
| --- | --- | --- |
| For | first-party tiles, and the user's own tools in their workspace | anything installed from a catalog or an MCP server; anything big |
| Loaded from | `.hivemind/tiles/*.tsx` — never a catalog | a package, over `hm-view://` |
| Isolation | none; trust-based | own origin, own process, CSP `default-src 'none'` |
| Cost | a component | ~68 MB measured, own bundle, own React |
| Theming | host CSS and context, free | CSS variables we inject |
| Can host a code editor | no | yes |

A "declarative widget" is **not** a third runtime. It is the SDK's preset components plus a
manifest entry the host renders with no plugin code — which covers the reminder, the
countdown, the pomodoro. VS Code does exactly this split (`TreeView` / `viewsWelcome` for
data-only, webview for real UI), and so does Figma (widget vs `showUI` iframe). Nobody
ships three runtimes.

## Why a big tile stays in the iframe

A host-rendered component SDK cannot host a real editor, and this is not a limitation we
could engineer away. Monaco and CodeMirror need raw DOM: a virtualized scroller measuring
line boxes synchronously, `contenteditable` and IME composition, key handling with
`preventDefault`, canvas/WebGL. Anything that mirrors a mutation stream across
`postMessage` is asynchronous by construction.

The precedents agree: Monaco in a VS Code webview, big Figma plugins in a `showUI` iframe.
Only Obsidian lets large third-party code run in-process — the trust bargain that produced
a real malware incident (PHANTOMPULSE, delivered through community plugins, April 2026).

So "someone wants to ship their own editor" is an argument **for** the iframe, not against
it. They get their own bundle, their own React version, their own workers, and our runaway
watchdog already catches a spinning frame because each sandboxed view is its own process.

## Why not remote-dom

Shopify's remote-dom (`@remote-dom/core` 1.11.1) is the obvious middle path: the plugin
runs in a worker and the *host* renders real components. It is production-proven — every
Shopify checkout UI extension runs on it, with a hard 64 KB per-extension budget.

We are not adopting it:

- **MCP is not going there.** MCP Apps (SEP-1865, stable 2026-01-26) deferred remote-dom out
  of the MVP and specifies `text/html;profile=mcp-app` only; mcp-ui has demoted its
  remote-dom resource type to legacy and no longer generates it. Adopting it means a second
  protocol beside MCP Apps, forever.
- **It costs a component allowlist we maintain forever**, and still cannot carry a big tile:
  its only escape hatch is async remote methods on host-implemented elements — fine for
  `focus()`, useless for a 60 fps scroller.
- **Its marginal win over iframe + MCP Apps is aesthetic consistency**, which our CSS-variable
  theming already mostly delivers.

## The SDK, concretely

Ship a small vocabulary and nothing else — `Stack`, `Row`, `Text`, `Button`, `TextField`.
State is host-persisted JSON, the way Obsidian's `loadData/saveData` and Raycast's
`LocalStorage` work:

```tsx
export default function Todo({ state, setState }: TileProps<string[]>) {
  const items = state ?? [];
  return <Stack>
    <TextField placeholder="add…" onSubmit={(t) => setState([...items, t])} />
    {items.map((t, i) => <Row key={i} onRemove={() => setState(items.filter((_, j) => j !== i))}>{t}</Row>)}
  </Stack>;
}
```

Theme arrives by context, not props. Capabilities arrive as **arguments** (`{state, setState,
fs, agent}`), scoped to that tile.

## The three risks, and what we do about each

1. **React version coupling.** A tile compiled against a different React breaks hooks. The
   host externalises `react`/`react-dom` (the plugin bundles neither, like Obsidian's
   `obsidian` external), the manifest declares `sdkVersion`, and a mismatched major is
   refused at load. Raycast pins one React and treats it as public API; so do we.
2. **Ambient authority.** In-process means the tile can reach the preload bridge. Mitigation
   is the loading rule, not a sandbox: in-process tiles load **only from the user's own
   workspace**, capabilities are passed as arguments, and the IPC bridge is never a global in
   the tile's realm. Freezing intrinsics at boot is hardening, not a boundary — an
   in-process tile is code the user chose to run, and we say so at install.
3. **A crash takes the canvas down.** Every tile gets an error boundary that renders its own
   "reload tile" chrome, and a watchdog unmounts a tile whose render blows its budget.
   Anything needing real crash isolation is an iframe.

## Many tiles at once

Three editors plus ten widgets must not be thirteen processes. Ten widgets are in-process
components (zero processes); three editors are iframes. Off-screen or collapsed iframes get
torn down against a `saveState()` snapshot rather than kept alive, as VS Code does with
hidden webviews — and only for plugins that implement it, since tearing down anything with
a live connection or in-memory undo history loses work.

`apps/desktop/scripts/plugin-tile-cost.mjs` measures the per-iframe cost on a real canvas.
Re-run it before changing the suspension policy; the published per-process numbers for
Electron are not current enough to plan against.

## Order

1. `TileProps` + the component vocabulary + host-persisted state, with our own tiles as the
   first consumers.
2. Load in-process tiles from `.hivemind/tiles/`, with the error boundary and watchdog.
3. MCP Apps host for catalog-installed and big tiles (see the companion doc).
4. Suspension policy for off-screen iframes, once step 3 has a real tile to suspend.
