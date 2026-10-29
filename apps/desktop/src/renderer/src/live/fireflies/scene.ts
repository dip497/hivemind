/** Fireflies: a meadow at night, one firefly per agent among the small ones, flashing. */
import type { Box, CreatureSpec, LiveScene, Look } from "../scene";
import { FIREFLY_KINDS } from "./kinds";
import { Meadow } from "./meadow";
import { FireflyRenderer } from "./render";

class FireflyScene implements LiveScene {
  private meadow = new Meadow();
  private renderer: FireflyRenderer;

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new FireflyRenderer(canvas);
  }

  get cellWidth() {
    return this.renderer.cellWidth;
  }

  get cellHeight() {
    return this.renderer.cellHeight;
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.resize(width, height, dpr);
    this.meadow.resize(width, height);
  }

  setLook(look: Look) {
    this.renderer.setLook(look);
  }

  setFontFamily(family: string) {
    this.renderer.setFontFamily(family);
  }

  setRoster(specs: CreatureSpec[], instant: boolean) {
    this.meadow.setRoster(specs.map((s) => ({ key: s.key, kind: FIREFLY_KINDS[Math.floor(s.variant * FIREFLY_KINDS.length)]!, size: s.size, mood: s.mood })), instant);
  }

  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.meadow.setBoxes(boxes);
    this.renderer.setBoxes(boxes, seeThrough);
  }

  finished(key: string) {
    this.meadow.finished(key);
  }

  pointer(x: number, y: number, active: boolean) {
    this.meadow.pointer.x = x;
    this.meadow.pointer.y = y;
    this.meadow.pointer.active = active;
  }

  splash(x: number, y: number) {
    this.meadow.splash(x, y);
  }

  creatureAt(x: number, y: number) {
    return this.meadow.fireflyAt(x, y);
  }

  step(dt: number) {
    this.meadow.step(dt);
  }

  draw(dt: number) {
    this.renderer.render(this.meadow, dt);
  }
}

export const firefliesScene = (canvas: OffscreenCanvas): LiveScene => new FireflyScene(canvas);
