/**
 * Solar System — a hivemind community view in three.js.
 *
 * The workspace is a solar system. Every frame is a planet: a procedurally
 * generated surface (terran / gas giant with rings / desert / ice / lava, picked
 * from the frame id), an atmosphere tinted with the frame's colour, rotation and
 * an orbit. Every tile is a moon around its planet, lit by the agent's live
 * status. Loose tiles orbit the sun. Click a planet to fly to it — there its
 * agents live; click a moon to dock its LIVE terminal on the right (the host
 * punches the hole and places the real tile). Esc steps back. Drag orbits,
 * wheel zooms, the side panel navigates.
 *
 * Motion is a capped loop: 30 fps while visible, 15 fps with a terminal docked,
 * nothing while hidden, and off entirely with the toggle (then the scene draws
 * on demand). Every frame drawn is reported to the host.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { applyThemeVars, connect, type ViewFrame, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";

const STATUS_HEX: Record<ViewStatus, number> = { unknown: 0x6b7280, idle: 0x60a5fa, working: 0x4ade80, blocked: 0xfbbf24, exited: 0xf87171 };
const STATUS_CSS: Record<ViewStatus, string> = { unknown: "#6b7280", idle: "#60a5fa", working: "#4ade80", blocked: "#fbbf24", exited: "#f87171" };
const DOCK_FRACTION = 0.5;
const SUN_R = 4.2;
type PlanetType = "terran" | "gas" | "desert" | "ice" | "lava";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("c"), labelsEl = $<HTMLDivElement>("labels"), crumb = $<HTMLDivElement>("crumb");
const backBtn = $<HTMLButtonElement>("back"), motionBtn = $<HTMLButtonElement>("motion"), listEl = $<HTMLDivElement>("list");
const subEl = $<HTMLDivElement>("sub"), hint = $<HTMLDivElement>("hint"), tip = $<HTMLDivElement>("tip");

const hm = await connect();
// Chrome (panel, buttons, labels) follows the user's theme; the scene keeps its
// own space palette. applyThemeVars re-applies on every host `theme` message.
applyThemeVars(hm);

// ── deterministic noise (3D value noise + fbm) for seamless spherical textures ──
function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]!; p[i] = p[j]!; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const g = (x: number, y: number, z: number) => perm[(perm[(perm[x & 255]! + y) & 255]! + z) & 255]! / 255;
  const sm = (t: number) => t * t * (3 - 2 * t);
  const n3 = (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi, u = sm(xf), v = sm(yf), w = sm(zf);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(g(xi, yi, zi), g(xi + 1, yi, zi), u), l(g(xi, yi + 1, zi), g(xi + 1, yi + 1, zi), u), v),
      l(l(g(xi, yi, zi + 1), g(xi + 1, yi, zi + 1), u), l(g(xi, yi + 1, zi + 1), g(xi + 1, yi + 1, zi + 1), u), v), w);
  };
  const fbm = (x: number, y: number, z: number, oct = 5) => {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += a * n3(x * f + 31 * i, y * f + 17 * i, z * f + 7 * i); norm += a; a *= 0.5; f *= 2.1; }
    return sum / norm;
  };
  return { n3, fbm, rnd };
}
function hashId(id: string): number { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function lerpRGB(a: number[], b: number[], t: number) { return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]; }

interface Surface { map: THREE.CanvasTexture; emissive?: THREE.CanvasTexture; clouds?: THREE.CanvasTexture }
const surfaceCache = new Map<string, Surface>();

/** Equirectangular procedural surface, sampled on the sphere so the seam is invisible. */
function makeSurface(type: PlanetType, seed: number): Surface {
  const W = 1024, H = 512;
  const noise = makeNoise(seed);
  const paint = (fn: (lat: number, lon: number, px: (x: number, y: number, z: number) => number) => number[] | null) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d")!, img = g.createImageData(W, H), d = img.data;
    for (let py = 0; py < H; py++) {
      const lat = (py / H - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let px = 0; px < W; px++) {
        const lon = (px / W) * Math.PI * 2;
        const x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
        const rgb = fn(lat, lon, (f, _y, _z) => noise.fbm(x * f, y * f, z * f));
        const i = (py * W + px) * 4;
        if (!rgb) { d[i + 3] = 0; continue; }
        d[i] = rgb[0]!; d[i + 1] = rgb[1]!; d[i + 2] = rgb[2]!; d[i + 3] = rgb[3] ?? 255;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    return tex;
  };
  switch (type) {
    case "terran": {
      const map = paint((lat, _lon, px) => {
        const h = px(2.3, 0, 0) + px(6, 0, 0) * 0.25 - 0.06;
        const ice = Math.max(0, (Math.abs(lat) - 1.15) / 0.3);
        let c: number[];
        if (h < 0.45) c = lerpRGB([8, 24, 70], [18, 70, 140], Math.max(0, h / 0.45));
        else if (h < 0.49) c = [40, 110, 150];
        else if (h < 0.6) c = lerpRGB([60, 110, 50], [30, 80, 40], (h - 0.49) / 0.11);
        else if (h < 0.7) c = lerpRGB([110, 95, 60], [140, 130, 110], (h - 0.6) / 0.1);
        else c = [225, 225, 230];
        return lerpRGB(c, [235, 240, 250], Math.min(1, ice));
      });
      const clouds = paint((_lat, _lon, px) => { const a = Math.max(0, (px(3.5, 0, 0) - 0.52) / 0.2); return [255, 255, 255, Math.min(255, a * 255)]; });
      return { map, clouds };
    }
    case "gas": {
      const hue = noise.rnd();
      const pal = hue < 0.33 ? [[214, 180, 140], [170, 120, 80], [235, 220, 190]] : hue < 0.66 ? [[120, 150, 200], [70, 90, 150], [200, 215, 240]] : [[200, 160, 120], [140, 90, 60], [240, 220, 200]];
      const map = paint((lat, _lon, px) => {
        const band = Math.sin(lat * 9 + px(2, 0, 0) * 3.5) * 0.5 + 0.5;
        const t = band * 0.7 + px(5, 0, 0) * 0.3;
        return t < 0.5 ? lerpRGB(pal[1]!, pal[0]!, t / 0.5) : lerpRGB(pal[0]!, pal[2]!, (t - 0.5) / 0.5);
      });
      return { map };
    }
    case "desert": {
      const map = paint((_lat, _lon, px) => { const h = px(2.6, 0, 0) * 0.7 + px(8, 0, 0) * 0.3; return h < 0.45 ? lerpRGB([120, 60, 30], [180, 100, 50], h / 0.45) : lerpRGB([180, 100, 50], [230, 190, 130], (h - 0.45) / 0.55); });
      return { map };
    }
    case "ice": {
      const map = paint((_lat, _lon, px) => { const r = Math.abs(px(4, 0, 0) - 0.5) * 2; const h = px(2, 0, 0); const c = lerpRGB([160, 200, 235], [235, 245, 255], h); return r < 0.08 ? lerpRGB(c, [90, 140, 200], 1 - r / 0.08) : c; });
      return { map };
    }
    case "lava": {
      const map = paint((_lat, _lon, px) => { const h = px(3, 0, 0); return lerpRGB([20, 14, 12], [70, 50, 40], h); });
      const emissive = paint((_lat, _lon, px) => { const r = Math.abs(px(5, 0, 0) - 0.5) * 2; const k = r < 0.06 ? 1 - r / 0.06 : 0; return [255 * k, 120 * k, 30 * k]; });
      return { map, emissive };
    }
  }
}

function radialTexture(stops: [number, string][], size = 256): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function ringTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 512; c.height = 4;
  const g = c.getContext("2d")!, noise = makeNoise(seed);
  for (let x = 0; x < 512; x++) {
    const t = x / 512, a = Math.max(0, noise.fbm(t * 30, 0.3, 0.7, 3) - 0.25) * (t < 0.08 || t > 0.95 ? 0.2 : 1) * (t > 0.55 && t < 0.6 ? 0.15 : 1);
    g.fillStyle = `rgba(220,205,180,${Math.min(1, a * 1.6)})`; g.fillRect(x, 0, 1, 4);
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

const atmosphereMaterial = (color: THREE.Color, power: number, strength: number) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: color }, uPower: { value: power }, uStrength: { value: strength } },
  vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uPower; uniform float uStrength; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(clamp(1.0 + dot(vN, vV), 0.0, 1.0), uPower); gl_FragColor = vec4(uColor * f * uStrength, clamp(f * uStrength, 0.0, 1.0)); }`,
  transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
});

// ── renderer / scene / camera / post ────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(0, 42, 78);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(800, 450), 0.55, 0.45, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 3; controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.AmbientLight(0x50587a, 0.7));
const fill = new THREE.DirectionalLight(0xbfd0ff, 0.45); scene.add(fill); scene.add(fill.target);
const sunLight = new THREE.PointLight(0xfff2dc, 2.2, 0, 0.6);
scene.add(sunLight);

// stars: three depth layers
{
  const mk = (n: number, size: number, tint: number, spread: number) => {
    const arr = new Float32Array(n * 3), noise = makeNoise(n * 7 + size * 100);
    for (let i = 0; i < n; i++) {
      const t = noise.rnd() * Math.PI * 2, u = noise.rnd() * 2 - 1, r = spread * (0.6 + noise.rnd() * 0.4);
      const k = Math.sqrt(1 - u * u); arr[i * 3] = Math.cos(t) * k * r; arr[i * 3 + 1] = u * r; arr[i * 3 + 2] = Math.sin(t) * k * r;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: tint, size, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false })));
  };
  mk(2600, 1.1, 0xc9d3ff, 900); mk(900, 1.8, 0xfff4e0, 900); mk(180, 2.8, 0xffffff, 900);
}

// sun
const sunGroup = new THREE.Group(); scene.add(sunGroup);
{
  const sunTex = (() => { const n = makeNoise(4242); const c = document.createElement("canvas"); c.width = 512; c.height = 256; const g = c.getContext("2d")!; const img = g.createImageData(512, 256); for (let y = 0; y < 256; y++) { const lat = (y / 256 - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat); for (let x = 0; x < 512; x++) { const lon = (x / 512) * Math.PI * 2; const v = n.fbm(cl * Math.cos(lon) * 3, sl * 3, cl * Math.sin(lon) * 3, 5); const c2 = lerpRGB([255, 140, 30], [255, 240, 190], Math.pow(v, 1.6)); const i = (y * 512 + x) * 4; img.data[i] = c2[0]!; img.data[i + 1] = c2[1]!; img.data[i + 2] = c2[2]!; img.data[i + 3] = 255; } } g.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 64, 32), new THREE.MeshBasicMaterial({ map: sunTex, color: 0xffe9c0 }));
  sun.userData.sun = true; sunGroup.add(sun);
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture([[0, "rgba(255,210,140,.9)"], [0.25, "rgba(255,170,80,.35)"], [0.6, "rgba(255,120,40,.08)"], [1, "rgba(255,100,30,0)"]]), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  corona.scale.setScalar(SUN_R * 6.5); sunGroup.add(corona);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(SUN_R * 1.12, 48, 24), atmosphereMaterial(new THREE.Color(0xffb060), 2.5, 1.4)); sunGroup.add(glow);
}

// ── planets and moons ───────────────────────────────────────────────────────
interface Planet { frame: ViewFrame | null; group: THREE.Group; mesh: THREE.Mesh; clouds?: THREE.Mesh; orbitR: number; angle: number; speed: number; spin: number; r: number; color: THREE.Color; moons: Moon[]; label: HTMLDivElement; type: PlanetType }
interface Moon { tile: ViewTile; mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; glow: THREE.Sprite; planet: Planet; orbitR: number; angle: number; speed: number; incl: number; label: HTMLDivElement; orbit: THREE.Line }

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsubscribe = new Map<string, () => void>();
const planets = new Map<string | null, Planet>();
const moons = new Map<string, Moon>();
const angleMemo = new Map<string, number>(); // stable positions across rebuilds
const glowTex = radialTexture([[0, "rgba(255,255,255,.85)"], [0.3, "rgba(255,255,255,.28)"], [1, "rgba(255,255,255,0)"]], 128);
let focus: string | null | undefined; // undefined = system view; null = the sun's loose moons
const trace: string[] = [];
function log(s: string) { trace.push(`${Math.round(performance.now())} ${s}`); if (trace.length > 200) trace.shift(); }
let hover: string | null = null;
let docked: string | null = null;
let motion = true;
let t = 0;
let pendingFocus: string | null | undefined; // from the layout blob, applied on the first structure
const system = new THREE.Group(); scene.add(system);

function orbitLine(r: number, color: THREE.Color, opacity: number, segments = 160): THREE.Line {
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) { const a = (i / segments) * Math.PI * 2; pts.push(Math.cos(a) * r, 0, Math.sin(a) * r); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}
function mkLabel(cls: string): HTMLDivElement { const d = document.createElement("div"); d.className = `lbl ${cls}`; labelsEl.appendChild(d); return d; }
function planetType(id: string): PlanetType { return (["terran", "gas", "desert", "ice", "lava"] as PlanetType[])[hashId(id) % 5]!; }

function rebuild() {
  for (const p of planets.values()) { system.remove(p.group); p.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; if (mat && !(mat as THREE.MeshStandardMaterial).map) mat.dispose(); }); p.label.remove(); for (const mo of p.moons) mo.label.remove(); }
  planets.clear(); moons.clear();
  const loose = tiles.filter((x) => !x.frameId || !frames.some((f) => f.id === x.frameId));
  const list: (ViewFrame | null)[] = [...frames];
  if (loose.length) list.push(null);
  let orbit = SUN_R + 9;
  list.forEach((f, i) => {
    const id = f?.id ?? "__sun__";
    const mine = f ? tiles.filter((x) => x.frameId === f.id) : loose;
    const type = f ? planetType(f.id) : "desert";
    const r = f ? 1.5 + Math.min(1.6, mine.length * 0.28) : 0; // loose tiles orbit the sun itself
    const color = new THREE.Color(f?.color ?? "#9ca3af");
    const group = new THREE.Group();
    let mesh: THREE.Mesh, clouds: THREE.Mesh | undefined;
    if (f) {
      const key = `${f.id}:${type}`;
      let surf = surfaceCache.get(key);
      if (!surf) { surf = makeSurface(type, hashId(f.id)); surfaceCache.set(key, surf); }
      const mat = new THREE.MeshStandardMaterial({ map: surf.map, bumpMap: type === "gas" ? null : surf.map, bumpScale: type === "terran" ? 0.02 : 0.035, roughness: type === "ice" ? 0.35 : 0.9, metalness: 0, emissive: surf.emissive ? 0xffffff : 0x000000, emissiveMap: surf.emissive, emissiveIntensity: surf.emissive ? 1.2 : 0 });
      mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 40), mat);
      mesh.userData.frameId = f.id; group.add(mesh);
      if (surf.clouds) { clouds = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 48, 32), new THREE.MeshStandardMaterial({ map: surf.clouds, transparent: true, depthWrite: false, roughness: 1 })); clouds.userData.frameId = f.id; group.add(clouds); }
      if (type !== "lava") group.add(new THREE.Mesh(new THREE.SphereGeometry(r * (type === "gas" ? 1.05 : 1.07), 48, 32), atmosphereMaterial(color, type === "gas" ? 3.5 : 2.6, type === "desert" ? 0.5 : 0.9)));
      else group.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.05, 48, 32), atmosphereMaterial(new THREE.Color(0xff6a2a), 3, 0.5)));
      if (type === "gas" && hashId(f.id + "ring") % 3 !== 0) {
        const inner = r * 1.5, outer = r * 2.4, geo = new THREE.RingGeometry(inner, outer, 160, 1);
        const uv = geo.attributes.uv as THREE.BufferAttribute, pos = geo.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) { const d = Math.hypot(pos.getX(k), pos.getY(k)); uv.setXY(k, (d - inner) / (outer - inner), 0.5); }
        const ring = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: ringTexture(hashId(f.id)), transparent: true, side: THREE.DoubleSide, roughness: 0.8, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2 + 0.35; group.add(ring);
      }
      mesh.rotation.z = ((hashId(f.id) % 40) - 20) / 100;
      const line = orbitLine(orbit, color, 0.22); system.add(line); group.userData.orbit = line;
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.01, 4, 2), new THREE.MeshBasicMaterial({ visible: false }));
      group.add(mesh);
    }
    const angle = angleMemo.get(id) ?? (hashId(id) % 628) / 100;
    angleMemo.set(id, angle);
    const planet: Planet = { frame: f, group, mesh, clouds, orbitR: f ? orbit : 0, angle, speed: f ? 0.22 / Math.sqrt(orbit / 12) : 0, spin: 0.12 + (hashId(id) % 10) / 60, r, color, moons: [], label: mkLabel("planet"), type };
    planet.label.innerHTML = f ? `<span class="dot" style="color:${safeColor(f.color)}"></span>${esc(f.title)}<small>${mine.length} agent${mine.length === 1 ? "" : "s"}</small>` : `<span class="dot" style="color:#9ca3af"></span>Loose<small>${mine.length} agent${mine.length === 1 ? "" : "s"}</small>`;
    // moons
    mine.forEach((tile, j) => {
      const base = f ? r + 1.1 : SUN_R + 2.2;
      const orbitR = base + j * 0.75;
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.75, emissive: 0x6b7280, emissiveIntensity: 0.35 });
      const mm = new THREE.Mesh(new THREE.SphereGeometry(f ? 0.3 : 0.42, 24, 16), mat);
      mm.userData.tileId = tile.id; group.add(mm);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x6b7280, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
      glow.scale.setScalar((f ? 0.3 : 0.42) * 5); mm.add(glow);
      const incl = ((hashId(tile.id) % 30) - 15) / 100;
      const ol = orbitLine(orbitR, color, 0.14, 96); ol.rotation.x = incl; ol.visible = false; group.add(ol);
      const ma = angleMemo.get(tile.id) ?? (hashId(tile.id) % 628) / 100; angleMemo.set(tile.id, ma);
      const moon: Moon = { tile, mesh: mm, mat, glow, planet, orbitR, angle: ma, speed: 0.9 / Math.sqrt(orbitR), incl, label: mkLabel("moon"), orbit: ol };
      planet.moons.push(moon); moons.set(tile.id, moon);
    });
    system.add(group);
    planets.set(f?.id ?? null, planet);
    if (f) orbit += 6 + r * 2.2;
  });
  for (const id of moons.keys()) paintMoon(id);
  renderPanel();
  if (pendingFocus !== undefined) { const pf = pendingFocus; pendingFocus = undefined; if (planets.has(pf)) enterFocus(pf, true); }
  else if (focus !== undefined && !planets.has(focus)) leaveFocus();
  requestFrame();
}
const safeColor = (c: string | undefined) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#9ca3af");
function esc(s: string) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)); }

function paintMoon(tileId: string) {
  const m = moons.get(tileId); if (!m) return;
  const st = status.get(tileId) ?? "unknown", hex = STATUS_HEX[st];
  m.mat.emissive.setHex(hex); m.mat.color.setHex(st === "exited" ? 0x5b5b60 : 0xb8c0cc);
  m.mat.emissiveIntensity = tileId === docked ? 1.1 : tileId === hover ? 0.9 : st === "working" ? 0.7 : 0.35;
  (m.glow.material as THREE.SpriteMaterial).color.setHex(hex); (m.glow.material as THREE.SpriteMaterial).opacity = tileId === docked || tileId === hover ? 1 : st === "exited" ? 0.35 : 0.8;
  m.mesh.scale.setScalar(tileId === docked || tileId === hover ? 1.35 : 1);
  m.label.className = `lbl moon${tileId === docked || tileId === hover ? " hot" : ""}`;
  m.label.innerHTML = `<span class="dot" style="color:${STATUS_CSS[st]}"></span>${esc(names.get(tileId) ?? tileId)}`;
  renderPanel();
  requestFrame();
}

// ── panel ───────────────────────────────────────────────────────────────────
function renderPanel() {
  const n = tiles.length;
  subEl.textContent = `${frames.length} planet${frames.length === 1 ? "" : "s"} · ${n} agent${n === 1 ? "" : "s"}`;
  const rows: string[] = [];
  for (const [fid, p] of planets) {
    const active = focus === fid;
    rows.push(`<div class="planet-row${active ? " active" : ""}" data-planet="${fid ?? "__loose__"}"><span class="swatch" style="color:${safeColor(p.frame?.color)};background:${safeColor(p.frame?.color)}"></span><span class="name">${esc(p.frame?.title ?? "Loose")}</span><span class="count">${p.moons.length}</span></div>`);
    if (active || planets.size === 1) for (const mo of p.moons) { const st = status.get(mo.tile.id) ?? "unknown"; rows.push(`<div class="moon-row${docked === mo.tile.id ? " docked" : ""}" data-moon="${mo.tile.id}"><span class="dot" style="color:${STATUS_CSS[st]};background:${STATUS_CSS[st]}"></span><span class="name">${esc(names.get(mo.tile.id) ?? mo.tile.id)}</span><span class="st">${st}</span></div>`); }
  }
  listEl.innerHTML = rows.join("");
}
listEl.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-planet],[data-moon]");
  if (!el) return;
  if (el.dataset.moon) { const mo = moons.get(el.dataset.moon); if (mo) { if (focus !== (mo.planet.frame?.id ?? null)) enterFocus(mo.planet.frame?.id ?? null); dock(mo.tile.id); } }
  else { const id = el.dataset.planet === "__loose__" ? null : el.dataset.planet!; if (focus === id) leaveFocus(); else enterFocus(id); }
});
backBtn.addEventListener("click", () => { if (docked) dock(null); leaveFocus(); });
motionBtn.addEventListener("click", () => setMotion(!motion));
function setMotion(on: boolean) { motion = on; motionBtn.classList.toggle("on", on); controls.enableDamping = on; persist(); requestFrame(); }

// ── camera: system view / planet focus, with a bounded fly-to ───────────────
let tween: { i: number; n: number; fromT: THREE.Vector3; toT: () => THREE.Vector3; fromC: THREE.Vector3; toC: () => THREE.Vector3 } | null = null;
function worldPos(p: Planet) { return p.group.position.clone(); }

function enterFocus(fid: string | null, instant = false) {
  const p = planets.get(fid); if (!p) return;
  log(`enterFocus(${fid}) instant=${instant}`);
  focus = fid;
  controls.enablePan = false;
  const dist = Math.max(4, (p.r || SUN_R) * 3.2 + p.moons.length * 0.4);
  if (instant) { const wp = worldPos(p); controls.target.copy(wp); camera.position.copy(wp).add(new THREE.Vector3(dist * 0.35, dist * 0.45, dist * 0.85)); tween = null; } else tween = { i: 0, n: 42, fromT: controls.target.clone(), toT: () => worldPos(p), fromC: camera.position.clone(), toC: () => worldPos(p).add(new THREE.Vector3(dist * 0.35, dist * 0.45, dist * 0.85)) };
  hm.commands.selectFrame(p.frame?.id ?? null);
  for (const pl of planets.values()) for (const mo of pl.moons) mo.orbit.visible = pl === p;
  crumb.innerHTML = `Solar System <span style="opacity:.5">›</span> <b>${esc(p.frame?.title ?? "Loose")}</b>`;
  backBtn.hidden = false;
  hint.textContent = "Click a moon to open its agent · Esc back · drag orbits · wheel zooms";
  renderPanel(); persist(); requestFrame();
}
function leaveFocus() {
  log("leaveFocus");
  focus = undefined;
  controls.enablePan = true;
  const far = Math.max(60, systemRadius() * 1.9);
  tween = { i: 0, n: 42, fromT: controls.target.clone(), toT: () => new THREE.Vector3(0, 0, 0), fromC: camera.position.clone(), toC: () => new THREE.Vector3(0, far * 0.55, far) };
  for (const pl of planets.values()) for (const mo of pl.moons) mo.orbit.visible = false;
  crumb.innerHTML = `<b>Solar System</b>`;
  backBtn.hidden = true;
  hint.textContent = "Click a planet to fly to it · click a moon to open its agent · drag orbits · wheel zooms";
  renderPanel(); persist(); requestFrame();
}
function systemRadius() { let m = SUN_R + 9; for (const p of planets.values()) m = Math.max(m, p.orbitR + p.r * 3); return m; }

// ── docking (the hole-punch) ────────────────────────────────────────────────
function sceneWidth() { return docked ? Math.round(hm.viewport.w * (1 - DOCK_FRACTION)) : hm.viewport.w; }
function resize() {
  const w = sceneWidth(), h = hm.viewport.h; if (w < 1 || h < 1) return;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.resolution.set(Math.round(w / 2), Math.round(h / 2));
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; labelsEl.style.width = `${w}px`;
  camera.aspect = w / h; camera.updateProjectionMatrix(); requestFrame();
}
function dock(tileId: string | null) {
  log(`dock(${tileId}) from ${docked} :: ${(new Error().stack ?? "").split("\n")[2]?.trim() ?? ""}`);
  const prev = docked; docked = tileId;
  hm.commands.selectTile(tileId);
  resize();
  const rects = tileId ? [{ tileId, x: sceneWidth(), y: 0, w: hm.viewport.w - sceneWidth(), h: hm.viewport.h }] : [];
  log(`setSurfaceRects ${JSON.stringify(rects)}`);
  hm.setSurfaceRects(rects);
  if (prev) paintMoon(prev); if (tileId) paintMoon(tileId);
  if (tileId) hint.textContent = "Esc undocks · drag orbits · wheel zooms";
  renderPanel(); requestFrame();
}
function persist() { hm.setLayout({ motion, focus: focus === undefined ? "__system__" : focus, cam: camera.position.toArray(), target: controls.target.toArray() }); }

// ── the frame loop: capped, on demand when motion is off, nothing when hidden ─
let pending = 0, needs = true, lastTick = 0;
function requestFrame() { needs = true; schedule(); }
function schedule() {
  if (pending || !hm.visible || document.hidden) return;
  const fps = motion ? (docked ? 15 : 30) : 0;
  if (!motion && !needs && !tween) return;
  const wait = fps ? Math.max(0, 1000 / fps - (performance.now() - lastTick)) : 0;
  pending = window.setTimeout(() => { pending = 0; requestAnimationFrame(frame); }, wait);
}
const _v = new THREE.Vector3();
function frame(now: number) {
  const dt = Math.min(0.05, lastTick ? (now - lastTick) / 1000 : 0.016); lastTick = now; needs = false;
  if (motion) {
    t += dt;
    for (const p of planets.values()) {
      if (p.frame) { p.angle += p.speed * dt; p.group.position.set(Math.cos(p.angle) * p.orbitR, 0, Math.sin(p.angle) * p.orbitR); p.mesh.rotation.y += p.spin * dt; if (p.clouds) p.clouds.rotation.y += p.spin * 1.3 * dt; }
      for (const mo of p.moons) { mo.angle += mo.speed * dt; mo.mesh.position.set(Math.cos(mo.angle) * mo.orbitR, Math.sin(mo.angle) * mo.orbitR * Math.sin(mo.incl), Math.sin(mo.angle) * mo.orbitR * Math.cos(mo.incl)); if ((status.get(mo.tile.id) ?? "unknown") === "working" && mo.tile.id !== docked) { const k = 0.7 + 0.3 * Math.sin(t * 4 + mo.angle); mo.mat.emissiveIntensity = k; (mo.glow.material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * k; } }
    }
    sunGroup.rotation.y += 0.02 * dt;
  } else {
    for (const p of planets.values()) { if (p.frame) p.group.position.set(Math.cos(p.angle) * p.orbitR, 0, Math.sin(p.angle) * p.orbitR); for (const mo of p.moons) mo.mesh.position.set(Math.cos(mo.angle) * mo.orbitR, Math.sin(mo.angle) * mo.orbitR * Math.sin(mo.incl), Math.sin(mo.angle) * mo.orbitR * Math.cos(mo.incl)); }
  }
  if (tween) {
    tween.i++; const e = 1 - Math.pow(1 - tween.i / tween.n, 3);
    controls.target.lerpVectors(tween.fromT, tween.toT(), e); camera.position.lerpVectors(tween.fromC, tween.toC(), e);
    if (tween.i >= tween.n) { tween = null; persist(); }
  } else if (focus !== undefined) {
    const p = planets.get(focus);
    if (p) { const wp = worldPos(p); _v.subVectors(wp, controls.target); controls.target.copy(wp); camera.position.add(_v); }
  }
  fill.position.copy(camera.position); fill.target.position.copy(controls.target);
  controls.update();
  composer.render();
  hm.reportFrame();
  placeLabels();
  if (motion || tween) schedule();
}
function placeLabels() {
  const w = sceneWidth(), h = hm.viewport.h;
  const put = (el: HTMLDivElement, pos: THREE.Vector3, dy: number, show: boolean) => {
    if (!show) { el.style.display = "none"; return; }
    _v.copy(pos).project(camera);
    if (_v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) { el.style.display = "none"; return; }
    el.style.display = "block"; el.style.left = `${((_v.x + 1) / 2) * w}px`; el.style.top = `${((1 - _v.y) / 2) * h + dy}px`;
  };
  for (const [fid, p] of planets) {
    const wp = worldPos(p);
    const dist = camera.position.distanceTo(wp);
    put(p.label, wp.clone().add(new THREE.Vector3(0, (p.r || SUN_R) + 0.4, 0)), -34, p.frame !== null && (focus === undefined || focus === fid) && dist < 260);
    for (const mo of p.moons) put(mo.label, mo.mesh.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.45, 0)), -20, focus === fid || mo.tile.id === hover || mo.tile.id === docked);
  }
}
controls.addEventListener("change", () => requestFrame());
controls.addEventListener("end", () => persist());

// ── picking ─────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function pick(x: number, y: number): { tileId?: string; frameId?: string | null; sun?: boolean } | null {
  const w = sceneWidth(), h = hm.viewport.h; if (x > w) return null;
  ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1); raycaster.setFromCamera(ndc, camera);
  for (const hit of raycaster.intersectObjects([system, sunGroup], true)) {
    let o: THREE.Object3D | null = hit.object;
    while (o) { if (typeof o.userData.tileId === "string") return { tileId: o.userData.tileId }; if (typeof o.userData.frameId === "string") return { frameId: o.userData.frameId }; if (o.userData.sun) return { sun: true }; o = o.parent; }
  }
  return null;
}
let downPt: { x: number; y: number } | null = null, lastPt = { x: 0, y: 0 };
canvas.addEventListener("pointerdown", (e) => { downPt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointermove", (e) => {
  lastPt = { x: e.clientX, y: e.clientY };
  const hit = pick(e.clientX, e.clientY);
  const id = hit?.tileId ?? null;
  if (id !== hover) { const prev = hover; hover = id; if (prev) paintMoon(prev); if (id) paintMoon(id); }
  canvas.style.cursor = hit ? "pointer" : "grab";
  if (id) { const st = status.get(id) ?? "unknown"; tip.innerHTML = `${esc(names.get(id) ?? id)}<span class="st">${st}</span>`; tip.style.display = "block"; tip.style.left = `${lastPt.x + 14}px`; tip.style.top = `${lastPt.y + 14}px`; }
  else if (hit?.frameId !== undefined && hit.frameId !== null) { const p = planets.get(hit.frameId); tip.innerHTML = `${esc(p?.frame?.title ?? "")}<span class="st">${p?.type ?? ""} · ${p?.moons.length ?? 0} agents</span>`; tip.style.display = "block"; tip.style.left = `${lastPt.x + 14}px`; tip.style.top = `${lastPt.y + 14}px`; }
  else tip.style.display = "none";
});
canvas.addEventListener("pointerleave", () => { const prev = hover; hover = null; if (prev) paintMoon(prev); tip.style.display = "none"; });
canvas.addEventListener("pointerup", (e) => {
  const moved = downPt ? Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) : 99; downPt = null;
  if (moved > 4 || e.button !== 0) return;
  const hit = pick(e.clientX, e.clientY);
  if (hit?.tileId) { const mo = moons.get(hit.tileId)!; const fid = mo.planet.frame?.id ?? null; if (focus !== fid) enterFocus(fid); dock(hit.tileId); }
  else if (hit?.frameId) { if (docked) dock(null); if (focus !== hit.frameId) enterFocus(hit.frameId); }
  else if (hit?.sun) { if (docked) dock(null); if (planets.has(null)) enterFocus(null); }
  else if (docked) dock(null);
  else if (focus !== undefined) leaveFocus();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (docked) dock(null); else if (focus !== undefined) leaveFocus(); }
  if (e.key === "m" || e.key === "M") setMotion(!motion);
});

// ── host events ─────────────────────────────────────────────────────────────
hm.on("structure", (m) => {
  log(`structure frames=${m.frames.length} tiles=${m.tiles.length}`);
  frames = m.frames; tiles = m.tiles;
  for (const x of tiles) { names.set(x.id, x.name); if (!unsubscribe.has(x.id)) unsubscribe.set(x.id, hm.subscribeStatus(x.id, (s) => { status.set(x.id, s); paintMoon(x.id); })); }
  for (const [id, off] of unsubscribe) if (!tiles.some((x) => x.id === id)) { off(); unsubscribe.delete(id); status.delete(id); }
  if (docked && !tiles.some((x) => x.id === docked)) dock(null);
  rebuild();
});
hm.on("names", (m) => { for (const [id, n] of Object.entries(m.names)) { names.set(id, n); if (moons.has(id)) paintMoon(id); } });
hm.on("selection", (m) => { log(`selection tile=${m.tileId} frame=${m.frameId} fresh=${m.fresh}`); if (m.fresh && m.tileId && m.tileId !== docked) { const mo = moons.get(m.tileId); if (mo) { const fid = mo.planet.frame?.id ?? null; if (focus !== fid) enterFocus(fid); } dock(m.tileId); } });
hm.on("undock", (m) => { if (docked === m.tileId) dock(null); }); // the host bar or Shift+Esc undocked it
hm.on("resize", () => { log(`resize ${hm.viewport.w}x${hm.viewport.h}`); if (docked) dock(docked); else resize(); });
hm.on("visibility", ({ visible }) => { if (visible) { lastTick = 0; requestFrame(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastTick = 0; requestFrame(); } });
hm.onReveal((tileId) => {
  const mo = moons.get(tileId); if (!mo) return null;
  const v = mo.mesh.getWorldPosition(new THREE.Vector3()).project(camera), w = sceneWidth(), h = hm.viewport.h;
  return { x: ((v.x + 1) / 2) * w - 16, y: ((1 - v.y) / 2) * h - 16, w: 32, h: 32 };
});

// test seam for drivers: focus / dock without pixel hunting
(window as unknown as { __solar: unknown }).__solar = {
  focus: (id: string | null) => enterFocus(id), dock: (id: string | null) => dock(id), leave: () => leaveFocus(),
  planets: () => [...planets.keys()], moons: () => [...moons.keys()], trace: () => [...trace],
  state: () => ({ focus: focus === undefined ? "__system__" : focus, docked, motion, hover, frames: frames.length, tiles: tiles.length }),
  screenPos: (id: string) => { const mo = moons.get(id); if (!mo) return null; const v = mo.mesh.getWorldPosition(new THREE.Vector3()).project(camera); return { x: ((v.x + 1) / 2) * sceneWidth(), y: ((1 - v.y) / 2) * hm.viewport.h }; },
};

// ── init ────────────────────────────────────────────────────────────────────
{
  const saved = hm.hello.layout as { motion?: boolean; focus?: string | null; cam?: number[]; target?: number[] } | null;
  if (saved && typeof saved.motion === "boolean") { motion = saved.motion; motionBtn.classList.toggle("on", motion); controls.enableDamping = motion; }
  if (saved?.cam?.length === 3 && saved.target?.length === 3) { camera.position.fromArray(saved.cam); controls.target.fromArray(saved.target); }
  if (saved && saved.focus !== undefined && saved.focus !== "__system__") pendingFocus = saved.focus;
  controls.update();
  resize();
  hint.textContent = "Click a planet to fly to it · click a moon to open its agent · drag orbits · wheel zooms";
  requestFrame();
}
