/**
 * world-scene — the Three.js scene behind the World view, kept out of React.
 *
 * PERFORMANCE CONTRACT (docs/design/workspace-views.md "Performance"): the
 * scene renders ON DEMAND only. There is no free-running requestAnimationFrame:
 * `invalidate()` schedules at most one frame, and only camera change, status
 * change, hover change, dock/undock, resize and explicit `setX` calls invalidate.
 * While `document.hidden` nothing renders (one frame is drawn on return).
 * `dispose()` releases the renderer, geometries, materials and every listener —
 * the view unmounts on every switch, so an inactive World does zero work.
 *
 * Geometry: one island per frame (a plate + a low building), one block per
 * tile on the island's grid. Colour = agent status (idle / working / blocked /
 * exited …) — set per object by the view through `setTileStatus`, never by a
 * whole-scene rebuild.
 */
import {
  AmbientLight, BoxGeometry, Color, CylinderGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ISLAND_SIZE, placeTiles, type WorldCamera } from "./world-layout";

export type WorldStatus = "idle" | "working" | "blocked" | "exited" | "unknown";

export interface WorldFrameInput { id: string; title: string; color: string; x: number; z: number }
export interface WorldTileInput { id: string; frameId: string | null; name: string }

/** Frame colours are CSS strings (oklch(...)) three.js cannot parse; resolve
 *  them through a 2D canvas fill, which Chromium understands, and cache. */
const cssColorCache = new Map<string, number>();
let cssCtx: CanvasRenderingContext2D | null | undefined;
export function cssColorToHex(css: string): number {
  const hit = cssColorCache.get(css);
  if (hit !== undefined) return hit;
  let hex = 0x8899aa;
  try {
    if (cssCtx === undefined) cssCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (cssCtx) {
      cssCtx.clearRect(0, 0, 1, 1);
      cssCtx.fillStyle = "#000";
      cssCtx.fillStyle = css; // an unparsable string leaves the previous value
      cssCtx.fillRect(0, 0, 1, 1);
      const [r, g, b] = cssCtx.getImageData(0, 0, 1, 1).data;
      hex = ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0);
    }
  } catch { /* keep the fallback */ }
  cssColorCache.set(css, hex);
  return hex;
}

/** Status → block colour. Chosen to read at a glance on a dark ground. */
const STATUS_COLOR: Record<WorldStatus, number> = {
  idle: 0x5b6b85,
  working: 0x3ddc84,
  blocked: 0xff5d5d,
  exited: 0x2a2f3a,
  unknown: 0x40485a,
};

export interface WorldSceneEvents {
  onHover: (tileId: string | null, frameId: string | null, screen: { x: number; y: number } | null) => void;
  onClickTile: (tileId: string) => void;
  onClickFrame: (frameId: string) => void;
  onCameraSettled: (camera: WorldCamera) => void;
}

export class WorldScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private islands = new Map<string, { group: Group; plate: Mesh; building: Mesh }>();
  private tiles = new Map<string, { mesh: Mesh; frameId: string | null; status: WorldStatus; hovered: boolean; docked: boolean }>();
  private frameOfTile = new Map<string, string | null>();
  private pending = false;
  private disposed = false;
  private hovered: string | null = null;
  private ro: ResizeObserver;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames drawn so far (test/diagnostic: proves render-on-demand). */
  public frameCount = 0;

  constructor(private host: HTMLElement, private events: WorldSceneEvents, initialCamera: WorldCamera | null) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(new Color(0x0b0e14), 1);
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    canvas.setAttribute("data-world-canvas", "");
    host.appendChild(canvas);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 500);
    if (initialCamera) {
      this.camera.position.set(...initialCamera.position);
    } else {
      this.camera.position.set(18, 22, 26);
    }
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false; // damping needs a loop; we render on demand
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 200;
    if (initialCamera) this.controls.target.set(...initialCamera.target);
    this.controls.update();
    this.controls.addEventListener("change", this.onCameraChange);

    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const sun = new DirectionalLight(0xffffff, 1.1);
    sun.position.set(30, 50, 20);
    this.scene.add(sun);
    const ground = new Mesh(new PlaneGeometry(600, 600), new MeshStandardMaterial({ color: 0x10141c, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.name = "ground";
    this.scene.add(ground);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("click", this.onClick);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  // ── on-demand rendering ────────────────────────────────────────────────────

  /** Ask for ONE frame. Coalesces; no-op while hidden or after dispose. */
  invalidate = (): void => {
    if (this.disposed || this.pending || document.hidden) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.disposed || document.hidden) return;
      this.renderer.render(this.scene, this.camera);
      this.frameCount++;
    });
  };

  private onVisibility = (): void => {
    if (!document.hidden) this.invalidate(); // one catch-up frame on return
  };

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private onCameraChange = (): void => {
    this.invalidate();
    // Persist the pose once the user stops moving (debounced; the view's
    // useDebouncedSave debounces again before touching storage).
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => {
      this.cameraTimer = null;
      this.events.onCameraSettled(this.cameraPose());
    }, 300);
  };

  cameraPose(): WorldCamera {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  // ── content ────────────────────────────────────────────────────────────────

  /** Reconcile islands + tile blocks with the workspace. Creates/moves/removes
   *  objects; keeps every surviving object (and its status colour) as is. */
  setContent(frames: readonly WorldFrameInput[], tiles: readonly WorldTileInput[]): void {
    const seenFrames = new Set<string>();
    for (const f of frames) {
      seenFrames.add(f.id);
      let isl = this.islands.get(f.id);
      if (!isl) {
        const group = new Group();
        group.name = `island:${f.id}`;
        const plate = new Mesh(
          new CylinderGeometry(ISLAND_SIZE / 2, ISLAND_SIZE / 2 + 0.6, 0.8, 32),
          new MeshStandardMaterial({ color: 0x1b2230, roughness: 0.9 }),
        );
        plate.position.y = -0.4;
        plate.userData = { frameId: f.id };
        const building = new Mesh(
          new BoxGeometry(1.6, 2.6, 1.6),
          new MeshStandardMaterial({ color: cssColorToHex(f.color), roughness: 0.6, metalness: 0.1 }),
        );
        building.position.set(-ISLAND_SIZE / 2 + 1.4, 1.3, -ISLAND_SIZE / 2 + 1.4);
        building.userData = { frameId: f.id };
        group.add(plate, building);
        this.scene.add(group);
        isl = { group, plate, building };
        this.islands.set(f.id, isl);
      }
      isl.group.position.set(f.x, 0, f.z);
      (isl.building.material as MeshStandardMaterial).color.set(cssColorToHex(f.color));
    }
    for (const [id, isl] of this.islands) {
      if (seenFrames.has(id)) continue;
      this.scene.remove(isl.group);
      disposeObject(isl.group);
      this.islands.delete(id);
    }

    // Tiles: grouped per island, laid out on its grid.
    const byFrame = new Map<string | null, WorldTileInput[]>();
    for (const t of tiles) {
      const list = byFrame.get(t.frameId) ?? [];
      list.push(t);
      byFrame.set(t.frameId, list);
    }
    const seenTiles = new Set<string>();
    for (const [frameId, list] of byFrame) {
      const spots = placeTiles(list.length);
      const island = frameId ? this.islands.get(frameId) : undefined;
      list.forEach((t, i) => {
        seenTiles.add(t.id);
        let entry = this.tiles.get(t.id);
        if (!entry) {
          const mesh = new Mesh(
            new BoxGeometry(1.4, 1.0, 1.4),
            new MeshStandardMaterial({ color: STATUS_COLOR.unknown, roughness: 0.5, emissive: 0x000000 }),
          );
          mesh.userData = { tileId: t.id };
          entry = { mesh, frameId: t.frameId, status: "unknown", hovered: false, docked: false };
          this.tiles.set(t.id, entry);
        }
        entry.mesh.name = t.name;
        // Re-parent if the tile moved between frames (or became loose).
        const parent: Object3D = island ? island.group : this.scene;
        if (entry.mesh.parent !== parent) parent.add(entry.mesh);
        entry.frameId = t.frameId;
        this.frameOfTile.set(t.id, t.frameId);
        const spot = spots[i]!;
        // Loose tiles (no frame) sit in a row south of the origin.
        entry.mesh.position.set(island ? spot.x + 1.2 : spot.x, 0.5, island ? spot.z + 1.2 : spot.z + 20);
      });
    }
    for (const [id, entry] of this.tiles) {
      if (seenTiles.has(id)) continue;
      entry.mesh.parent?.remove(entry.mesh);
      disposeObject(entry.mesh);
      this.tiles.delete(id);
      this.frameOfTile.delete(id);
      if (this.hovered === id) this.hovered = null;
    }
    this.invalidate();
  }

  /** Colour ONE tile by status. Called from the per-tile status subscription. */
  setTileStatus(tileId: string, status: WorldStatus): void {
    const e = this.tiles.get(tileId);
    if (!e || e.status === status) return;
    e.status = status;
    this.paint(e);
    this.invalidate();
  }

  setDocked(tileId: string | null): void {
    for (const [id, e] of this.tiles) {
      const d = id === tileId;
      if (e.docked !== d) { e.docked = d; this.paint(e); }
    }
    this.invalidate();
  }

  private paint(e: { mesh: Mesh; status: WorldStatus; hovered: boolean; docked: boolean }): void {
    const m = e.mesh.material as MeshStandardMaterial;
    m.color.set(STATUS_COLOR[e.status]);
    m.emissive.set(e.docked ? 0x3355ff : e.hovered ? 0x222222 : 0x000000);
    e.mesh.scale.setScalar(e.hovered ? 1.12 : 1);
  }

  /** Fly the camera to look at an island (one step — no animation loop). */
  flyToFrame(frameId: string): void {
    const isl = this.islands.get(frameId);
    if (!isl) return;
    const p = isl.group.position;
    this.controls.target.set(p.x, 0.5, p.z);
    this.camera.position.set(p.x + 9, 11, p.z + 13);
    this.controls.update();
    this.events.onCameraSettled(this.cameraPose());
    this.invalidate();
  }

  /** Screen-space rect (host-relative px) of a tile block — where a docked slot
   *  overlay is anchored. Null when the tile is unknown or behind the camera. */
  projectTile(tileId: string): { x: number; y: number } | null {
    const e = this.tiles.get(tileId);
    if (!e) return null;
    const v = new Vector3();
    e.mesh.getWorldPosition(v);
    v.y += 0.9;
    v.project(this.camera);
    if (v.z > 1) return null;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
  }

  // ── pointer ────────────────────────────────────────────────────────────────

  private pick(ev: PointerEvent | MouseEvent): { tileId?: string; frameId?: string } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    for (const h of hits) {
      const u = h.object.userData as { tileId?: string; frameId?: string };
      if (u.tileId || u.frameId) return u;
      if (h.object.name === "ground") return null;
    }
    return null;
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const hit = this.pick(ev);
    const tileId = hit?.tileId ?? null;
    if (tileId !== this.hovered) {
      const prev = this.hovered ? this.tiles.get(this.hovered) : undefined;
      if (prev) { prev.hovered = false; this.paint(prev); }
      const next = tileId ? this.tiles.get(tileId) : undefined;
      if (next) { next.hovered = true; this.paint(next); }
      this.hovered = tileId;
      this.invalidate();
    }
    const r = this.renderer.domElement.getBoundingClientRect();
    this.events.onHover(tileId, hit?.frameId ?? null, tileId || hit?.frameId ? { x: ev.clientX - r.left, y: ev.clientY - r.top } : null);
  };

  private onPointerLeave = (): void => {
    if (this.hovered) {
      const prev = this.tiles.get(this.hovered);
      if (prev) { prev.hovered = false; this.paint(prev); }
      this.hovered = null;
      this.invalidate();
    }
    this.events.onHover(null, null, null);
  };

  private onClick = (ev: MouseEvent): void => {
    const hit = this.pick(ev);
    if (hit?.tileId) this.events.onClickTile(hit.tileId);
    else if (hit?.frameId) this.events.onClickFrame(hit.frameId);
  };

  dispose(): void {
    this.disposed = true;
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.ro.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("click", this.onClick);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.removeEventListener("change", this.onCameraChange);
    this.controls.dispose();
    this.scene.traverse((o) => disposeObject(o));
    this.renderer.dispose();
    canvas.remove();
  }
}

function disposeObject(o: Object3D): void {
  const m = o as Mesh;
  if (m.geometry) m.geometry.dispose();
  const mat = m.material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat?.dispose();
}
