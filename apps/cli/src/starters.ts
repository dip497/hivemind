/** What `hive plugins new` writes for a tool and for a widget: a plugin that works as written. */
import { TOOL_API_VERSION } from "@hivemind/core/tool-format";
import { TOOL_MANIFEST } from "@hivemind/core/tool-packages";
import { WIDGET_TYPES } from "@hivemind/core/widget-api";
import { pluginBrief } from "./plugin-brief.js";
import { typeFiles } from "./type-files.js";

/** The files of a starter tool plugin `name`, owned by `owner`. */
export function toolStarter(owner: string, name: string): Record<string, string> {
  const id = `@${owner}/${name}`;
  const tileKind = `${owner}-${name}`.slice(0, 41);
  const manifest = {
    id, name: name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), version: "0.1.0", apiVersion: TOOL_API_VERSION,
    description: "What it shows, in one line.", entry: "index.js", permissions: [], settings: [],
    tools: [{ key: name, label: name, description: "What its tile shows.", tileKind, size: { width: 720, height: 480 }, needsRepo: true, singleton: true }],
  };
  return {
    [TOOL_MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
    "index.js": STARTER_JS.replace("__KIND__", JSON.stringify(tileKind)),
    "README.md": `# ${manifest.name}\n\n${manifest.description}\n\nAdd it to the app, switch it on and open it:\n\n\`\`\`bash\nhive plugins install .\nhive plugins enable tool:${id}\nhive ctl plugin open tool:${id}\n\`\`\`\n`,
    "PROMPT.md": pluginBrief("tool", id),
    "jsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true, checkJs: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
        lib: ["ES2023", "DOM", "DOM.Iterable"], skipLibCheck: true, types: [],
        paths: { "@hivemind/view-sdk": ["./types/view-sdk/index.ts"], "@hivemind/tile-sdk": ["./types/tile-sdk/index.ts"] },
      },
      include: ["*.js", "types"],
    }, null, 2) + "\n",
    "types/host.d.ts": HOST_TYPES,
    ...typeFiles(["view-sdk", "tile-sdk"]),
  };
}

/** The app's modules a tool imports, typed as far as a starter needs: React's hooks, and the SDK. */
const HOST_TYPES = `// The app's modules a tool imports, by the URL it imports them from. Here for their types.
declare module "hm-plugin://host/react.js" {
  type SetState<T> = (value: T | ((was: T) => T)) => void;
  export function useState<T>(initial: T | (() => T)): [T, SetState<T>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(make: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  export const Fragment: unknown;
  const React: { createElement: typeof createElement; Fragment: unknown };
  export default React;
}
declare module "hm-plugin://host/sdk.js" {
  import type { HostSdk } from "@hivemind/tile-sdk";
  export const TILE_API_VERSION: HostSdk["TILE_API_VERSION"];
  export const Button: HostSdk["Button"];
  export const PatchView: HostSdk["PatchView"];
  export const Markdown: HostSdk["Markdown"];
  export const Loading: HostSdk["Loading"];
  export const Frame: HostSdk["Frame"];
  export const useTileState: HostSdk["useTileState"];
}
declare module "hm-plugin://host/react-jsx-runtime.js";
declare module "hm-plugin://host/ui.js";
`;

const STARTER_JS = `// A tool plugin's tile, drawn by the app's own React, inside the app.
//   tile: this tile (id, kind, name, frameId)
//   hm:   the client a view has: frames, tiles, agents, commands, its settings and saved state
//   host: what only a tile has: its folder, programs run there, opening things beside it
import React, { useEffect, useState } from "hm-plugin://host/react.js";
import { Button } from "hm-plugin://host/sdk.js";

const h = React.createElement;

/** @param {import("@hivemind/tile-sdk").TileProps} props */
function Tile({ tile, host }) {
  const [branch, setBranch] = useState("…");
  const refresh = () => host.run("git", ["branch", "--show-current"]).then((r) => setBranch(r.stdout.trim() || "(no branch)"));
  useEffect(() => { void refresh(); }, []);
  return h("div", { style: { padding: 16, display: "grid", gap: 8 } },
    h("h3", { style: { margin: 0 } }, tile.name),
    h("p", null, "Branch: ", h("code", null, branch)),
    h(Button, { size: "sm", variant: "outline", onClick: refresh }, "Refresh"));
}

/** @type {import("@hivemind/tile-sdk").ToolModule} */
export default { tiles: { __KIND__: Tile } };
`;

/** A widget that works as written: a counter with a button, kept with the workspace. */
export function widgetStarter(owner: string, name: string): Record<string, string> {
  const title = name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return {
    "widget.json": JSON.stringify({
      id: `@${owner}/${name}`, name: title, version: "0.1.0", description: "Counts presses.", icon: "icon.svg",
      options: [{ id: "step", label: "Step", type: "number", min: 1, max: 100, default: 1 }],
    }, null, 2) + "\n",
    "widget.js": `/// <reference path="./hive.d.ts" />
// Runs in a worker the app starts for each one placed. \`hive\` is its whole API (hive.d.ts).
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: hive.state?.n ?? 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });

hive.on("start", draw);
hive.on("action", (a) => {
  if (a === "inc") { hive.setState({ n: (hive.state?.n ?? 0) + Number(hive.options.step ?? 1) }); draw(); }
});
`,
    "hive.d.ts": WIDGET_TYPES,
    "jsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "es2022", lib: ["es2022", "webworker"] }, include: ["*.js", "*.d.ts"] }, null, 2) + "\n",
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>\n',
    "README.md": `# ${title}\n\nCounts presses. Shown on its HiveHub page and in the app before anyone installs it: say what it does and what it asks for.\n`,
    "PROMPT.md": pluginBrief("widget", `@${owner}/${name}`),
  };
}
