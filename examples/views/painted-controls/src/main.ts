import { applyThemeVars, connect, createInvalidator, type ViewFrame, type ViewTile } from "@hivemind/view-sdk";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const context = canvas.getContext("2d")!;
const controls = document.querySelector<HTMLElement>("#controls")!;
const status = document.querySelector<HTMLElement>("#status")!;
const hm = await connect();
applyThemeVars(hm);
let theme = hm.hello.theme.colors;
let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
let selected: string | null = null;
let docked: string | null = null;
const { invalidate } = createInvalidator(hm, draw);

function step(direction: number) {
  if (!frames.length) return;
  const index = frames.findIndex((frame) => frame.id === selected);
  const target = frames[index < 0 ? (direction > 0 ? 0 : frames.length - 1) : (index + direction + frames.length) % frames.length]!.id;
  undock();
  // The selection event confirms host state before the scene changes its label.
  hm.commands.selectFrame(target);
  invalidate();
}
function firstTool() { return tiles.find((tile) => tile.frameId === selected); }
function undock() { docked = null; hm.setSurfaceRects([]); invalidate(); }
function openTool() {
  const tile = firstTool();
  if (!tile) return;
  docked = tile.id;
  hm.commands.selectTile(tile.id);
  invalidate();
}

// Transparent native buttons share the painted hit regions. They supply keyboard
// activation, focus, labels, and disabled semantics without prescribing visuals.
const actions = [
  { label: "Previous workspace", run: () => step(-1), disabled: () => !frames.length },
  { label: "Next workspace", run: () => step(1), disabled: () => !frames.length },
  { label: "Open first tool", run: openTool, disabled: () => !firstTool() },
  { label: "Undock tool", run: undock, disabled: () => !docked },
].map((action) => {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = true;
  button.textContent = action.label;
  button.setAttribute("aria-label", action.label);
  button.addEventListener("click", action.run);
  controls.append(button);
  return { ...action, button };
});

function draw() {
  const { w, h } = hm.viewport;
  // Bound pixel cost; this example has no animation loop or polling.
  const dpr = Math.min(devicePixelRatio, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.body);
  context.fillStyle = theme.bg ?? style.backgroundColor;
  context.fillRect(0, 0, w, h);
  context.font = "14px system-ui";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const width = Math.max(1, Math.min(220, (w - 60) / 2));
  actions.forEach((action, i) => {
    const x = 24 + (i % 2) * (width + 12), y = 48 + Math.floor(i / 2) * 64;
    Object.assign(action.button.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: "48px" });
    action.button.disabled = action.disabled();
    context.globalAlpha = action.button.disabled ? 0.45 : 1;
    context.beginPath(); context.roundRect(x, y, width, 48, 16);
    context.fillStyle = theme.bg3 ?? style.backgroundColor; context.fill();
    context.fillStyle = theme.fg ?? style.color;
    context.fillText(action.label, x + width / 2, y + 24, width - 16);
  });
  context.globalAlpha = 1;
  status.textContent = frames.find((frame) => frame.id === selected)?.title ?? "Unassigned tools";
  hm.setSurfaceRects(docked && w > 64 && h > 260 ? [{ tileId: docked, x: 24, y: 184, w: w - 48, h: h - 208 }] : []);
}

hm.on("structure", (message) => {
  frames = message.frames; tiles = message.tiles;
  if (selected && !frames.some((frame) => frame.id === selected)) selected = null;
  if (docked && !tiles.some((tile) => tile.id === docked)) undock();
  invalidate();
});
hm.on("selection", (message) => { selected = message.frameId ?? tiles.find((tile) => tile.id === message.tileId)?.frameId ?? null; invalidate(); });
hm.on("names", (message) => {
  frames = frames.map((frame) => ({ ...frame, title: message.names[frame.id] ?? frame.title }));
  invalidate();
});
hm.on("theme", (next) => { theme = next.colors; invalidate(); });
hm.on("resize", invalidate);
hm.on("undock", undock);
hm.onReveal((id) => docked === id ? { x: 24, y: 184, w: hm.viewport.w - 48, h: Math.max(0, hm.viewport.h - 208) } : null);
window.addEventListener("keydown", (event) => { if (event.key === "Escape") undock(); });
invalidate();
