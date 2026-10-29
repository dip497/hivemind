/** Shoal: fish and sharks in characters, one shark per agent. The World swims them; the renderer
 *  draws them. */
import type { Box, CreatureSpec, LiveScene, Look } from "../scene";
import { AsciiRenderer } from "./render";
import { World, type SharkKind } from "./world";

/** Which shark each program's agents are: a `variant` of 0 to 1 picks one. */
const KINDS: SharkKind[] = ["classic", "hammerhead", "tiger", "mako", "thresher", "zebra", "greathammer", "nurse"];

export class ShoalScene implements LiveScene {
  private world = new World();
  private renderer: AsciiRenderer;

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new AsciiRenderer(canvas);
  }

  get cellWidth() {
    return this.renderer.cellWidth;
  }

  get cellHeight() {
    return this.renderer.cellHeight;
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.resize(width, height, dpr);
    this.world.resize(width, height, this.renderer.cellWidth, this.renderer.cellHeight);
  }

  setLook(look: Look) {
    this.renderer.setLook(look);
  }

  setFontFamily(family: string) {
    this.renderer.setFontFamily(family);
  }

  setRoster(specs: CreatureSpec[], instant: boolean) {
    this.world.setRoster(specs.map((s) => ({ key: s.key, kind: KINDS[Math.floor(s.variant * KINDS.length)]!, size: s.size, mood: s.mood })), instant);
  }

  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.world.setBoxes(boxes);
    this.renderer.setBoxes(boxes, seeThrough);
  }

  finished(key: string) {
    this.world.finished(key);
  }

  pointer(x: number, y: number, active: boolean) {
    this.world.pointer.x = x;
    this.world.pointer.y = y;
    this.world.pointer.active = active;
  }

  splash(x: number, y: number) {
    this.world.splash(x, y);
  }

  step(dt: number) {
    this.world.step(dt);
  }

  draw(dt: number) {
    this.renderer.render(this.world, dt);
  }
}
