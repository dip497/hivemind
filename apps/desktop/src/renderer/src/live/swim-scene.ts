/** A live scene whose creatures swim (Shoal, Koi Pond): the World swims them, the scene's
 *  renderer draws them. */
import type { Box, CreatureSpec, LiveScene, Look } from "./scene";
import type { SwimRenderer } from "./swim";
import type { World } from "./world";

export class SwimScene implements LiveScene {
  /** `kinds` are the creatures an agent's variant picks from. */
  constructor(private world: World, private renderer: SwimRenderer, private kinds: readonly string[]) {}

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
    this.world.setRoster(specs.map((s) => ({ key: s.key, kind: this.kinds[Math.floor(s.variant * this.kinds.length)]!, size: s.size, mood: s.mood })), instant);
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
