/** Jellyfish: jellies beating their way up the deep, one jelly per agent, marine snow falling. */
import type { Box, CreatureSpec, LiveScene, Look } from "../scene";
import { JELLY_KINDS } from "./kinds";
import { JellyRenderer } from "./render";
import { Swarm } from "./swarm";

class JellyScene implements LiveScene {
  private swarm = new Swarm();
  private renderer: JellyRenderer;

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new JellyRenderer(canvas);
  }

  get cellWidth() {
    return this.renderer.cellWidth;
  }

  get cellHeight() {
    return this.renderer.cellHeight;
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.resize(width, height, dpr);
    this.swarm.resize(width, height);
  }

  setLook(look: Look) {
    this.renderer.setLook(look);
  }

  setFontFamily(family: string) {
    this.renderer.setFontFamily(family);
  }

  setRoster(specs: CreatureSpec[], instant: boolean) {
    this.swarm.setRoster(specs.map((s) => ({ key: s.key, kind: JELLY_KINDS[Math.floor(s.variant * JELLY_KINDS.length)]!, size: s.size, mood: s.mood })), instant);
  }

  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.swarm.setBoxes(boxes);
    this.renderer.setBoxes(boxes, seeThrough);
  }

  finished(key: string) {
    this.swarm.finished(key);
  }

  pointer(x: number, y: number, active: boolean) {
    this.swarm.pointer.x = x;
    this.swarm.pointer.y = y;
    this.swarm.pointer.active = active;
  }

  splash(x: number, y: number) {
    this.swarm.splash(x, y);
  }

  creatureAt(x: number, y: number) {
    return this.swarm.jellyAt(x, y);
  }

  step(dt: number) {
    this.swarm.step(dt);
  }

  draw(dt: number) {
    this.renderer.render(this.swarm, dt);
  }
}

export const jellyScene = (canvas: OffscreenCanvas): LiveScene => new JellyScene(canvas);
