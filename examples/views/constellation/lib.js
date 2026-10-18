// What the constellation draws, worked out from the workspace and nothing else, so it can be
// checked without a screen: where each frame and tile sits, and what each agent's light means.

/** What an agent's light says, from its status and what it reports doing. */
export function lightOf(status, agent) {
  const s = agent && agent.state;
  if (status === "blocked" || s === "waiting") return "waiting";
  if (s === "failed" || s === "limited") return "failed";
  if (status === "working" || s === "working") return "working";
  if (status === "exited" || s === "exited") return "exited";
  return "idle";
}

/** The tone the app paints each light in (`--hm-status-<tone>`). */
export const TONE = { working: "working", waiting: "attention", idle: "idle", exited: "exited", failed: "failed" };

/**
 * Where everything sits: each top frame on a ring around the middle, a worktree frame close to the
 * frame it was made from, and each frame's tiles on orbits around it, agents outside the rest.
 */
export function layout(frames, tiles) {
  const top = frames.filter((f) => !f.parentId || !frames.some((p) => p.id === f.parentId));
  const ring = Math.max(7, top.length * 3.2);
  const place = new Map();
  top.forEach((f, i) => {
    const a = (i / Math.max(top.length, 1)) * Math.PI * 2;
    place.set(f.id, { x: Math.cos(a) * ring, y: (i % 2 ? 1 : -1) * 0.8, z: Math.sin(a) * ring, size: 1 });
  });
  const children = frames.filter((f) => !top.includes(f));
  const perParent = new Map();
  for (const f of children) {
    const p = place.get(f.parentId) ?? { x: 0, y: 0, z: 0 };
    const k = perParent.get(f.parentId) ?? 0;
    perParent.set(f.parentId, k + 1);
    const out = Math.atan2(p.z, p.x) + (k % 2 ? 1 : -1) * (0.5 + Math.floor(k / 2) * 0.4);
    const r = Math.hypot(p.x, p.z) + 5.5;
    place.set(f.id, { x: Math.cos(out) * r, y: p.y + 2.2 + k * 0.6, z: Math.sin(out) * r, size: 0.7 });
  }
  const orbits = new Map();
  const byFrame = new Map();
  for (const t of tiles) byFrame.set(t.frameId, [...(byFrame.get(t.frameId) ?? []), t]);
  for (const [frameId, list] of byFrame) {
    const agents = list.filter((t) => t.agent);
    const rest = list.filter((t) => !t.agent);
    agents.forEach((t, i) => orbits.set(t.id, { frameId, radius: 2.2 + (i % 3) * 0.75, tilt: ((i * 47) % 60 - 30) * (Math.PI / 180), phase: (i / Math.max(agents.length, 1)) * Math.PI * 2, speed: 0.12 + (i % 4) * 0.03, agent: true }));
    rest.forEach((t, i) => orbits.set(t.id, { frameId, radius: 1.3, tilt: 0, phase: (i / Math.max(rest.length, 1)) * Math.PI * 2, speed: 0.05, agent: false }));
  }
  return { frames: place, orbits };
}

/** Where a tile on its orbit is at time `t` (seconds), around its frame at `c`. */
export function orbitPoint(o, c, t) {
  const a = o.phase + t * o.speed;
  const x = Math.cos(a) * o.radius, z = Math.sin(a) * o.radius;
  return { x: c.x + x, y: c.y + z * Math.sin(o.tilt), z: c.z + z * Math.cos(o.tilt) };
}

/** How many agents show each light. */
export function census(lights) {
  const out = { working: 0, waiting: 0, idle: 0, failed: 0, exited: 0 };
  for (const l of lights) if (l in out) out[l]++;
  return out;
}
