/**
 * `hive ctl tile look`, in the window: the tile brought into view, its plugin given time to draw,
 * then where it is on the screen, its plugin's state and the last lines its code wrote. Main
 * takes the picture of that box.
 */
import { LOOK_MS, type ConsoleLine, type PluginState } from "@hivemind/workspace-api/plugins";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { consoleRings, pluginInstances } from "./plugin-instances";

export interface SeenTile {
  tile: string;
  state: PluginState | null;
  reason?: string;
  drew: boolean;
  console: ConsoleLine[];
  rect: { x: number; y: number; width: number; height: number };
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** The tile's box: its node on the canvas, else the surface its body is in. */
function boxOf(tileId: string): Element | null {
  const id = CSS.escape(tileId);
  return document.querySelector(`.react-flow__node[data-id="${id}"]`) ?? document.querySelector(`[data-surface="${id}"]`);
}

export async function lookAt(tileId: string, bringIntoView: (id: string) => void, until = Date.now() + LOOK_MS): Promise<SeenTile> {
  if (!boxOf(tileId)) throw new ApiError("NOT_FOUND", `no tile ${tileId} is open in this window`);
  bringIntoView(tileId);
  // A plugin tile is waited for until it drew or failed; a tile no plugin draws, two frames.
  const plugin = () => pluginInstances.find({ instance: tileId });
  while (Date.now() < until) {
    const p = plugin();
    if (!p || p.drew || p.state === "failed") break;
    await frame();
  }
  // The camera eases to it: wait until its box holds still for three frames.
  let last = "", still = 0;
  while (still < 3 && Date.now() < until) {
    await frame();
    const r = boxOf(tileId)?.getBoundingClientRect();
    const now = r ? `${r.x},${r.y},${r.width},${r.height}` : "";
    still = now === last ? still + 1 : 0;
    last = now;
  }
  const r = boxOf(tileId)?.getBoundingClientRect();
  if (!r) throw new ApiError("NOT_FOUND", `${tileId} closed while it was looked at`);
  const p = plugin();
  return {
    tile: tileId,
    state: p?.state ?? null,
    ...(p?.reason ? { reason: p.reason } : {}),
    drew: p ? p.drew : true,
    console: consoleRings.read(tileId),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}
