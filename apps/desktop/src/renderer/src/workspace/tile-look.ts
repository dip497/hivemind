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

/** What a point over the tile hit, when it is not the tile: a tile, a dialog, a notification. */
function nameOf(el: Element): string {
  const tile = el.closest("[data-surface]")?.getAttribute("data-surface") ?? el.closest(".react-flow__node")?.getAttribute("data-id");
  if (tile) return `tile ${tile}`;
  if (el.closest("[data-sonner-toaster]")) return "a notification";
  const dialog = el.closest('[role="dialog"], [role="alertdialog"]');
  if (dialog) return `a dialog${dialog.getAttribute("aria-label") ? ` (${dialog.getAttribute("aria-label")})` : ""}`;
  return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;
}

/** What is drawn over `box` within `r`: an 8 by 8 grid of points and its corners, each that hits
 *  something outside the tile named once. */
function coveringOf(box: Element, r: { x: number; y: number; width: number; height: number }): string[] {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) points.push([r.x + ((i + 0.5) * r.width) / 8, r.y + ((j + 0.5) * r.height) / 8]);
  const inset = 2;
  points.push([r.x + inset, r.y + inset], [r.x + r.width - inset, r.y + inset], [r.x + inset, r.y + r.height - inset], [r.x + r.width - inset, r.y + r.height - inset]);
  const names = new Set<string>();
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (hit && !box.contains(hit)) names.add(nameOf(hit));
  }
  return [...names];
}

/** The app's notifications, hidden while a picture is taken. */
function hideNotifications(): void {
  const lists = [...document.querySelectorAll<HTMLElement>("[data-sonner-toaster]")];
  for (const l of lists) l.style.visibility = "hidden";
  setTimeout(() => { for (const l of lists) l.style.visibility = ""; }, 2_000);
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
  const box = boxOf(tileId);
  if (!box) throw new ApiError("NOT_FOUND", `${tileId} closed while it was looked at`);
  // Only the part inside the window is pictured, and only when nothing else is drawn over it.
  const b = box.getBoundingClientRect();
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  const r = { x, y, width: Math.min(innerWidth, b.right) - x, height: Math.min(innerHeight, b.bottom) - y };
  if (r.width < 1 || r.height < 1) throw new ApiError("FAILED", `${tileId} is not on the screen`);
  let covering = coveringOf(box, r);
  if (covering.includes("a notification")) {
    hideNotifications();
    await frame(); await frame();
    covering = coveringOf(box, r);
  }
  if (covering.length) throw new ApiError("OCCLUDED", `OCCLUDED: ${covering.join(", ")} is drawn over ${tileId}; move or close it, then look again`);
  const p = plugin();
  return {
    tile: tileId,
    state: p?.state ?? null,
    ...(p?.reason ? { reason: p.reason } : {}),
    drew: p ? p.drew : true,
    console: consoleRings.read(tileId),
    rect: r,
  };
}
