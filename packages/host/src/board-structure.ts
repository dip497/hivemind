/**
 * What a board holds, as the view protocol's `structure` says it, worked out from the board's
 * document here: for a view on a remote screen (views.ts) and for the phone's Home (home.ts), by
 * the one builder the window's views use too.
 */
import { agentForCmd } from "@hivemind/agents";
import { isRemote, machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { ViewFrameMachine } from "@hivemind/view-sdk/protocol";
import { viewStructure, type Structure } from "@hivemind/view-host/structure";
import { AGENT_TILE_KIND, type CoreLayout, type TileRecord } from "@hivemind/workspace-doc/shapes";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import type { Links } from "@hivemind/workspace-api/agents";

export interface BoardStructureOptions {
  /** What the agent of a tile says it is doing, from its window title. */
  title(tile: string): string | undefined;
  links(): Links;
  machines: KnownMachines;
  /** How the link to a remote frame's machine is. */
  linkState?(workspacePath: string): ViewFrameMachine["state"];
}

/** The agent an agent's tile runs, by its catalog id. */
export const agentOf = (t: TileRecord): string | undefined => (t.kind === AGENT_TILE_KIND ? agentForCmd(t.cmd)?.id : undefined);

/** `core`'s structure, each tile's name, and the titles they were named from. */
export function boardStructure(core: Pick<CoreLayout, "frames" | "tiles" | "frameOf" | "tileNames">, o: BoardStructureOptions): { structure: Structure; names: Record<string, string>; titles: Record<string, string> } {
  const titles: Record<string, string> = {};
  for (const t of core.tiles) {
    const title = o.title(t.id);
    if (title) titles[t.id] = title;
  }
  const names = Object.fromEntries(core.tiles.map((t) => [t.id, tileName(core.tileNames ?? {}, titles, t)]));
  const structure = viewStructure({
    frames: core.frames, tiles: core.tiles, frameOf: core.frameOf ?? {},
    name: (t) => names[t.id], agent: agentOf, links: o.links(),
    color: (f) => frameHex((f as { color?: unknown }).color),
    machine: (f) => (f.workspacePath && isRemote(f.workspacePath)
      ? { name: machineCalled(f.workspacePath, o.machines), state: o.linkState?.(f.workspacePath) ?? "idle" }
      : undefined),
  });
  return { structure, names, titles };
}

/** A frame's colour as `#rrggbb`, from what a window saves (frame-color.ts): `oklch(L C H)`, or the
 *  hex the person picked. A device has no CSS engine: anything else is the window's own fallback. */
function frameHex(css: unknown): string {
  if (typeof css !== "string") return "#8899aa";
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toLowerCase()}`;
  const ok = css.trim().match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i);
  if (!ok) return "#8899aa";
  // OKLCH → OKLab → linear sRGB (Björn Ottosson's matrices), each channel clipped to the gamut.
  const L = Number(ok[1]) / (ok[2] ? 100 : 1);
  const C = Number(ok[3]) * (ok[4] ? 0.4 / 100 : 1);
  const h = (Number(ok[5]) * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  };
  return `#${linear.map(channel).join("")}`;
}
