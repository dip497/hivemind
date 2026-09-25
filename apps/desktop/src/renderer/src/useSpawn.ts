/**
 * useSpawn — tile spawning + in-frame placement, lifted from Canvas.tsx. Owns:
 * placeInFrame (slot packing + auto-grow), ensureFrame (resolve/lazily-create
 * the target frame), spawnTile (the single-source create path), and the
 * spawnInto/spawnClaude/spawnVis/frameOpen wrappers. Canvas passes its state
 * refs + setters as context; the handlers read/update them exactly as before.
 */
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { frameColorFor } from "./frame-color";
import { nextSlotInFrame, FRAME_ROW_MAX, FRAME_GAP } from "./frame-layout";
import { defaultSizeForKind, defaultTileSize, FRAME_PAD, FRAME_HEADER } from "./canvas-sizing";
import { agentById } from "./agents";
import { agentById as catalogAgentById, defaultAgent, spawnArgsFor, spawnLabelFor, type AgentProviderDef, type SpawnOptions } from "@hivemind/agents";
import { AGENT_TILE_KIND } from "./tile-kinds";
import { defaultShell, type FrameState, type TileInstance } from "./canvas-persistence";
import { queueWork } from "./claude-bus";
import { markBackgroundTile } from "./worker-tiles";
import type { TileKind } from "./tile-kinds";
import { checkToolCreation } from "./tool-availability";
import { checkAgentInstalled, noAgentInstalled } from "./agent-plugins";
import { isRemote } from "../../shared/remote-uri";
import { mintId } from "../../shared/tile-id";
import { getSettings } from "./settings-store";

/** Kinds that are one-per-frame (spawn → focus existing). claude/shell are not. */
const SINGLETON_KINDS: ReadonlySet<TileKind> = new Set(["editor", "diff", "issues"]);

type FocusReq = { id: string; cx: number; cy: number; w: number; h: number; n: number; exact?: boolean } | null;
type SpawnOpts = {
  mode?: string; work?: string; url?: string; file?: string;
  /** Per-spawn launch options beyond `mode` (agent-option id → value). */
  launch?: Partial<Record<string, string>>;
  agent?: { id: string; cmd: string; args?: string[]; label: string };
  /** A terminal that shows this existing daemon session instead of starting its own. */
  session?: { id: string; cmd: string; args?: string[]; label: string };
};
type SpawnPick = ({ kind: TileKind } & SpawnOpts) | null;

export interface SpawnCtx {
  repoPath: string | null;
  /** settings.agents.options: agent id → option id → value. */
  positionsRef: MutableRefObject<Record<string, { x: number; y: number }>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  tilesRef: MutableRefObject<TileInstance[]>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  framesRef: MutableRefObject<FrameState[]>;
  selectedFrameIdRef: MutableRefObject<string | null>;
  selectedTileIdRef: MutableRefObject<string | null>;
  repoPathRef: MutableRefObject<string | null>;
  rootRef: MutableRefObject<string | null>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  setFrameOf: Dispatch<SetStateAction<Record<string, string>>>;
  setPositions: Dispatch<SetStateAction<Record<string, { x: number; y: number }>>>;
  setSelectedTileId: Dispatch<SetStateAction<string | null>>;
  setFocusReq: Dispatch<SetStateAction<FocusReq>>;
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setSelectedFrameId: Dispatch<SetStateAction<string | null>>;
  setTiles: Dispatch<SetStateAction<TileInstance[]>>;
  setSpawnPick: Dispatch<SetStateAction<SpawnPick>>;
  focusTile: (id: string) => void;
  /** Open a file as a tab in an editor tile — spawnTile mints the new tile's
   *  id, so a caller that wants the fresh editor to show a file passes
   *  `opts.file` and this delivers it (the same shape as `queueWork` for a
   *  fresh agent tile). */
  openFileInTile: (tileId: string, file: string) => void;
  /** Give a tile an explicit name, which outranks the title its program sets. */
  renameTile: (tileId: string, name: string) => void;
}

/** One past the highest ordinal already on the canvas for this label, so numbers neither repeat nor restart after a relaunch. */
export function nextOrdinal(labels: readonly string[], labelFor: (n: number) => string): number {
  const probe = 987654321;
  const prefix = labelFor(probe).split(String(probe))[0]!;
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const n = parseInt(label.slice(prefix.length), 10);
    if (n > max) max = n;
  }
  return max + 1;
}

/** The user's saved options for this agent, with this launch's own choices on top.
 *  Read at spawn time: settings are rebuilt on every write, and as a hook dependency
 *  they rebuilt every spawn callback and every tile surface with it. */
function launchOptions(id: string, over: SpawnOptions): SpawnOptions {
  const saved = getSettings().agents.options;
  const picked = Object.fromEntries(Object.entries(over).filter(([, v]) => v));
  return { ...saved[id], ...picked };
}

export function useSpawn(ctx: SpawnCtx) {
  const {
    repoPath,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile, openFileInTile, renameTile,
  } = ctx;

  // Labels handed out whose tiles have not rendered yet: two spawns in one tick must not share a number.
  const issued = useRef<string[]>([]);
  const ordinalLabel = useCallback((countAs: (n: number) => string, labelFor = countAs): string => {
    const shown = new Set(tilesRef.current.map((t) => t.label));
    issued.current = issued.current.filter((l) => !shown.has(l));
    const label = labelFor(nextOrdinal([...shown, ...issued.current], countAs));
    issued.current.push(label);
    return label;
  }, [tilesRef]);

  const placeInFrame = useCallback((id: string, frame: FrameState, opts?: { background?: boolean }) => {
    // CRITICAL: these MUST match the auto-fit derivation in `tileBox`
    // (frame.x = minTileX − FRAME_PAD, frame.y = minTileY − FRAME_HEADER). If
    // they diverge, the auto-fit effect recomputes the frame's box a few px off
    // from where the tile was placed — exceeding the 2px dead-band — so the
    // frame visibly jumps the instant its first tile lands (and can nudge into a
    // neighbour, triggering a needless separation cascade).
    //   padX   = FRAME_PAD    → placed tile at frame.x+PAD ⇒ derived frame.x = tile.x−PAD = frame.x ✓
    //   padTop = FRAME_HEADER → placed tile at frame.y+HEADER ⇒ derived frame.y = tile.y−HEADER = frame.y ✓
    const padX = FRAME_PAD;
    const padTop = FRAME_HEADER;
    const gap = FRAME_GAP;
    const pos = positionsRef.current;
    const sizeOf = (tid: string) => {
      if (sizesRef.current[tid]) return sizesRef.current[tid]!;
      const k = tilesRef.current.find((t) => t.id === tid)?.kind;
      return k ? defaultSizeForKind(k) : defaultTileSize(tid);
    };

    // Existing occupants of THIS frame to pack beside: its member tiles (explicit
    // frameOf) PLUS its worktree CHILD frames — so a new tile never lands on top
    // of a nested worktree frame (and vice-versa; spawnWorktreeFrame packs around
    // these same tiles). One occupancy model = the parent divides space properly.
    const members: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (const t of tilesRef.current) {
      if (t.id === id) continue;
      if (frameOfRef.current[t.id] !== frame.id) continue;
      const p = pos[t.id];
      if (!p) continue;
      const s = sizeOf(t.id);
      members.push({ id: t.id, x: p.x, y: p.y, w: s.width, h: s.height });
    }
    for (const cf of framesRef.current) {
      if (cf.parentFrameId === frame.id) members.push({ id: cf.id, x: cf.x, y: cf.y, w: cf.w, h: cf.h });
    }
    const me = sizeOf(id);
    const slot = nextSlotInFrame(
      { x: frame.x, y: frame.y },
      members,
      { w: me.width, h: me.height },
      { padX, padTop, gap, maxRowWidth: FRAME_ROW_MAX },
    );
    const placeX = slot.x;
    const placeY = slot.y;
    // This frame is now the user's focus — keep it anchored during separation.
    lastActiveFrameRef.current = frame.id;

    // Record membership EXPLICITLY + set position. The auto-fit effect grows
    // the frame to contain it (membership is no longer geometry-derived, so
    // there's no deadlock if the new tile's center lands outside the frame).
    setFrameOf((m) => ({ ...m, [id]: frame.id }));
    setPositions((p) => ({ ...p, [id]: { x: placeX, y: placeY } }));
    // SINGLE focus+select authority for placed tiles. Every spawn path routes
    // through placeInFrame, so callers must NOT also focus/select (that fired
    // the animation twice). Center on the KNOWN coords directly (don't wait
    // for the positions ref to settle). EXCEPT background workers (workflow /
    // report:false): they're placed but must NOT grab selection (→ keyboard
    // focus) or pan the viewport — you stay where you are while they run.
    if (!opts?.background) {
      setSelectedTileId(id);
      setFocusReq((prev) => ({ id, cx: placeX + me.width / 2, cy: placeY + me.height / 2, w: me.width, h: me.height, n: (prev?.n ?? 0) + 1, exact: true }));
    }
  }, [repoPath]);

  // frame = workspace: EVERY tile lives in a frame, never loose on the canvas.
  // Returns the frame to open into — the active one, else the first existing,
  // else lazily creates a "base" workspace frame bound to the launch repo (so
  // the empty playground gets a real workspace the moment you open anything).
  /** The frame a spawn lands in, without creating one. */
  const pickFrame = useCallback((): FrameState | undefined => {
    const sel = selectedFrameIdRef.current;
    const selF = sel ? framesRef.current.find((f) => f.id === sel) : undefined;
    if (selF) return selF;
    // Prefer a workspace-bound TOP-LEVEL frame over an empty base — without
    // this, a user-bound zone (e.g. "manageark") that wasn't created first
    // would lose spawns to a stale base frame, and tiles would land off-screen
    // relative to the visible workspace. Never auto-route into a worktree
    // sub-frame (parentFrameId set) — those are spawned-into only on explicit
    // selection, else an unselected spawn would land in a random worktree.
    const bound = framesRef.current.find((f) => !f.parentFrameId && f.workspacePath);
    if (bound) return bound;
    return framesRef.current.find((f) => !f.parentFrameId);
  }, []);

  const ensureFrame = useCallback((): FrameState => {
    const existing = pickFrame();
    if (existing) return existing;
    const id = mintId("frame");
    const rp = repoPathRef.current;
    // If old tiles already exist on the canvas (persisted from before
    // frame=workspace landed), size the base frame to WRAP them so they
    // visually live inside the workspace (instead of looking loose + new
    // spawns landing on the wrong empty slot).
    let x = 80, y = 80, w = 1860, h = 1380;
    const pos = positionsRef.current;
    const sz = sizesRef.current;
    const tileEntries = Object.entries(pos);
    if (tileEntries.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [tid, p] of tileEntries) {
        const s = sz[tid] ?? { width: 700, height: 480 };
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x + s.width > maxX) maxX = p.x + s.width;
        if (p.y + s.height > maxY) maxY = p.y + s.height;
      }
      x = Math.max(0, minX - 24);
      y = Math.max(0, minY - 48);
      w = Math.max(1860, maxX - x + 24);
      h = Math.max(1380, maxY - y + 24);
    }
    const frame: FrameState = {
      id,
      x, y,
      w: Math.max(w, 2520),
      h: Math.max(h, 1780),
      title: rp?.split("/").filter(Boolean).pop() ?? "workspace",
      color: frameColorFor(id), z: 0,
      workspacePath: rp ?? undefined, workspaceRoot: rootRef.current ?? null,
    };
    setFrames((fs) => (fs.length ? fs : [frame]));
    setSelectedFrameId(id);
    // Adopt any pre-existing loose tiles into this base frame (explicit
    // membership) so they're treated as members by auto-fit + parenting.
    if (tileEntries.length > 0) {
      setFrameOf((m) => {
        const copy = { ...m };
        for (const [tid] of tileEntries) if (!copy[tid]) copy[tid] = id;
        return copy;
      });
    }
    // Sync the ref NOW so an immediately-following placeInFrame / doSpawnClaude
    // (both read framesRef) see the new frame before the next render commits.
    if (!framesRef.current.length) framesRef.current = [frame];
    return frame;
  }, []);

  // Wrap legacy loose tiles on mount: layouts persisted before frame=workspace
  // landed have positions but no frames → create the base frame sized to their
  // bounding box so they visually live INSIDE the workspace (and the slot
  // scanner sees them as occupied, so new spawns land in free slots).
  const wrapOnceRef = useRef(false);
  useEffect(() => {
    if (wrapOnceRef.current) return;
    if (!repoPath) return;
    if (framesRef.current.length > 0) { wrapOnceRef.current = true; return; }
    if (Object.keys(positionsRef.current).length === 0) return;
    wrapOnceRef.current = true;
    ensureFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  // Create a tile of `kind` inside `targetFrameId` (or the resolved active
  // frame). claude/shell are unlimited per frame; editor/diff/issues are
  // one-per-frame — if the frame already has one, focus it instead of making a
  // duplicate. placeInFrame lays it out + auto-grows the frame + selects/foci.
  const spawnTile = useCallback(
    (kind: TileKind, targetFrameId: string | null, opts?: SpawnOpts): string | undefined => {
      if (!checkToolCreation(kind)) return;
      const target = (targetFrameId ? framesRef.current.find((f) => f.id === targetFrameId) : undefined) ?? pickFrame();
      // A remote frame runs the agent on its host, whose PATH this machine cannot see.
      const remote = !!target?.workspacePath && isRemote(target.workspacePath);
      const def = kind === AGENT_TILE_KIND ? ((opts?.agent ? catalogAgentById(opts.agent.id) : undefined) ?? defaultAgent()) : undefined;
      if (kind === AGENT_TILE_KIND) {
        // Nothing compiled in to fall back to: with no agent installed there is nothing to spawn.
        if (!def) { noAgentInstalled(); return; }
        if (!remote && !checkAgentInstalled(def)) return;
      }
      const frame = target ?? ensureFrame();
      const fid = frame.id;
      if (SINGLETON_KINDS.has(kind)) {
        const existing = tilesRef.current.find((t) => t.kind === kind && frameOfRef.current[t.id] === fid);
        if (existing) {
          if (opts?.file) openFileInTile(existing.id, opts.file);
          setSelectedTileId(existing.id); focusTile(existing.id); return;
        }
      }
      const newId = mintId(`tile-${def?.id ?? kind}`);
      let cmd: string | undefined;
      let args: string[] | undefined;
      let label: string;
      if (def) {
        const so = launchOptions(def.id, { mode: opts?.mode, ...(opts?.launch ?? {}) });
        args = spawnArgsFor(def, so);
        cmd = def.bin;
        label = ordinalLabel((n) => spawnLabelFor(def, n, {}), (n) => spawnLabelFor(def, n, so));
      } else if (kind === "shell" && opts?.session) {
        cmd = opts.session.cmd; args = opts.session.args;
        label = opts.session.label;
      } else if (kind === "shell") {
        const sh = defaultShell();
        cmd = sh.cmd; args = sh.args;
        label = ordinalLabel((n) => `shell #${n}`);
      } else if (kind === "browser") {
        label = ordinalLabel((n) => `Browser #${n}`);
      } else {
        label = kind === "editor" ? "Editor" : kind === "diff" ? "Diff" : "Issues";
      }
      placeInFrame(newId, frame);
      setTiles((cur) => [...cur, { id: newId, kind, label, cmd, args, ...(kind === "browser" && opts?.url ? { url: opts.url } : {}), ...(kind === "shell" && opts?.session ? { session: opts.session.id } : {}) }]);
      // "Work on this": hand the fresh claude tile its prompt. It delivers it to
      // itself the first time it's ready (see claude-bus queueWork/claimWork).
      if (kind === AGENT_TILE_KIND && opts?.work) queueWork(newId, opts.work);
      // An editor spawned to show a specific file (a path clicked in a terminal,
      // a "reveal in editor") carries it in `opts.file`: the id was minted here,
      // so the caller could not open the tab itself.
      if (opts?.file) openFileInTile(newId, opts.file);
      return newId;
    },
    [placeInFrame, ensureFrame, focusTile, openFileInTile, tilesRef],
  );

  // Spawn from a global surface (ToolIsland / palette / hotkey). A current
  // selection IS the target: a selected frame — or the frame holding the
  // selected tile — spawns straight in, no picker. Only ask when nothing is
  // selected to disambiguate AND 2+ frames exist.
  const spawnInto = useCallback((kind: TileKind, opts?: SpawnOpts) => {
    if (!checkToolCreation(kind)) return;
    // Refuse before creating a frame or asking which one: only a remote frame could still run it.
    const def = (opts?.agent ? catalogAgentById(opts.agent.id) : undefined) ?? defaultAgent();
    if (kind === AGENT_TILE_KIND) {
      if (!def) { noAgentInstalled(); return; }
      const anyRemote = framesRef.current.some((f) => !!f.workspacePath && isRemote(f.workspacePath));
      if (!anyRemote && !checkAgentInstalled(def)) return;
    }
    const selTile = selectedTileIdRef.current;
    const selFrame =
      selectedFrameIdRef.current ?? (selTile ? frameOfRef.current[selTile] ?? null : null);
    if (selFrame && framesRef.current.some((f) => f.id === selFrame)) {
      spawnTile(kind, selFrame, opts);
      return;
    }
    if (framesRef.current.length >= 2) {
      setSpawnPick({ kind, mode: opts?.mode, work: opts?.work, agent: opts?.agent });
      return;
    }
    spawnTile(kind, ensureFrame().id, opts);
  }, [spawnTile, ensureFrame]);

  // Spawn a registry agent from a global surface (the tool island). claude keeps
  // its permission-mode path; other agents carry their registry cmd/flags.
  const spawnAgent = useCallback((agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }, mode?: string) => {
    spawnInto(AGENT_TILE_KIND, { mode, agent: { id: agent.id, cmd: agent.cmd, args: agent.defaultArgs, label: agent.label } });
  }, [spawnInto]);

  // Back-compat thin wrappers for the many existing call sites.
  const spawnClaude = useCallback(
    (mode?: string, work?: string) => spawnInto(AGENT_TILE_KIND, { mode, work }),
    [spawnInto],
  );
  const spawnVis = useCallback(
    (which: "tree" | "shell" | "diff" | "issues") => spawnInto(which === "tree" ? "editor" : which),
    [spawnInto],
  );

  // Open a tile INSIDE a specific frame (the frame's launcher toolbar) — always
  // targets that frame, no picker. Same one-per-frame rule via spawnTile.
  const frameOpen = useCallback((frameId: string, kind: string, launch?: SpawnOpts["launch"]) => {
    // A registry agent (codex / opencode / …) opens as an agent-terminal tile
    // carrying its binary + default flags.
    const agent = agentById(kind);
    if (agent) {
      spawnTile(AGENT_TILE_KIND, frameId, { agent: { id: agent.id, cmd: agent.cmd, args: agent.defaultArgs, label: agent.label }, launch });
      return;
    }
    const k: TileKind =
      kind === "tree" ? "editor"
      : kind === AGENT_TILE_KIND || kind === "shell" || kind === "diff" || kind === "issues" || kind === "browser" ? kind
      : "shell";
    spawnTile(k, frameId);
  }, [spawnTile]);

  // Open a plan-review tile for an agent's plan handoff. Places it in the SAME
  // frame as the agent tile that produced the plan (so the review sits beside
  // its terminal), falling back to the active frame. Returns the new tile id so
  // the caller can close it on abort. Not a SINGLETON_KIND — several agents can
  // be mid-review at once.
  const openPlanReview = useCallback(
    (payload: { requestId?: string; hcpCmdId?: string; plan: string; cwd: string; agentTileId?: string }): string => {
      // agentTileId arrives as the agent's HIVEMIND_TILE, which is the PTY id
      // (`hm:<tileId>`). frameOf is keyed by the bare tile id, so strip the
      // `hm:` scope prefix before the lookup — otherwise it always misses and
      // the review tile lands in the active/first frame (the wrong project).
      const callerTile = payload.agentTileId?.startsWith("hm:")
        ? payload.agentTileId.slice(3)
        : payload.agentTileId;
      const agentFrameId = callerTile ? frameOfRef.current[callerTile] : undefined;
      const frame =
        (agentFrameId ? framesRef.current.find((f) => f.id === agentFrameId) : undefined) ?? ensureFrame();
      const newId = mintId("tile-planReview");
      placeInFrame(newId, frame);
      setTiles((cur) => [
        ...cur,
        {
          id: newId,
          kind: "planReview",
          label: "Plan review",
          review: { requestId: payload.requestId, hcpCmdId: payload.hcpCmdId, plan: payload.plan, cwd: payload.cwd, agentTileId: callerTile },
        },
      ]);
      return newId;
    },
    [ensureFrame, placeInFrame],
  );

  // HCP control-plane spawn: create an agent tile and return its id so the
  // caller (main, via the renderer command channel) can drive it. Mirrors the
  // claude/registry-agent branch of spawnTile, plus prompt delivery via the
  // claude-bus work queue. `agent` is a catalog id.
  const hcpSpawnAgent = useCallback(
    (opts: { agent?: string; prompt?: string; frame?: string; mode?: string; model?: string; callerTile?: string; background?: boolean; name?: string }): string => {
      // Frame preference: explicit > the CALLER agent's frame (so a worker lands
      // beside the agent that spawned it) > the active/first frame.
      // The caller passes its HIVEMIND_TILE, which is the PTY id (`hm:<tileId>`
      // for a persistent pty); frameOf is keyed by the bare tile id, so strip the
      // `hm:` scope prefix before the lookup.
      const callerTile = opts.callerTile?.startsWith("hm:") ? opts.callerTile.slice(3) : opts.callerTile;
      const callerFrameId = callerTile ? frameOfRef.current[callerTile] : undefined;
      // Resolve opts.frame (a frame id, repo/worktree name, or title) most-
      // specific → loosest: exact id → case-insensitive title → worktree/
      // workspace path basename → case-insensitive title substring. Falls
      // through to the caller's frame, then ensureFrame().
      const resolveFrame = (q: string): FrameState | undefined => {
        const fs = framesRef.current;
        const byId = fs.find((f) => f.id === q);
        if (byId) return byId;
        const lq = q.toLowerCase();
        const byTitle = fs.find((f) => f.title.toLowerCase() === lq);
        if (byTitle) return byTitle;
        const base = (p?: string) => p?.split("/").filter(Boolean).pop()?.toLowerCase();
        const byPath = fs.find((f) => base(f.worktreePath) === lq || base(f.workspacePath) === lq);
        if (byPath) return byPath;
        return fs.find((f) => f.title.toLowerCase().includes(lq));
      };
      const resolved = opts.frame ? resolveFrame(opts.frame) : undefined;
      const callerFrame = callerFrameId ? framesRef.current.find((f) => f.id === callerFrameId) : undefined;
      const frame = resolved ?? callerFrame ?? ensureFrame();
      const def = catalogAgentById(opts.agent) ?? defaultAgent();
      // The control plane only sends a bare agent when the catalog has one — but the
      // default can still be missing (nothing installed), and there is nothing to spawn into.
      if (!def) { noAgentInstalled(); return ""; }
      const newId = mintId(`tile-${def.id}`);
      const so = launchOptions(def.id, { mode: opts.mode, model: opts.model });
      const args = spawnArgsFor(def, so);
      const cmd = def.bin;
      const label = ordinalLabel((n) => spawnLabelFor(def, n, {}), (n) => spawnLabelFor(def, n, so));
      // A spawner-chosen name ("reviewer") is what tells a dozen workers apart, so it
      // ranks like a rename, above the title the agent sets itself. Main sanitizes it.
      if (opts.name) renameTile(newId, opts.name);
      // Background (workflow / report:false) workers: place WITHOUT stealing
      // focus or centering the viewport, and mark them so useAgentAwareness skips
      // their "finished" notification — they're gathered in bulk, not driven.
      if (opts.background) markBackgroundTile(newId);
      placeInFrame(newId, frame, { background: opts.background });
      setTiles((cur) => [...cur, { id: newId, kind: AGENT_TILE_KIND, label, cmd, args }]);
      if (opts.prompt) queueWork(newId, opts.prompt);
      return newId;
    },
    [ensureFrame, placeInFrame, renameTile, tilesRef],
  );

  return { placeInFrame, ensureFrame, spawnTile, spawnInto, spawnClaude, spawnAgent, spawnVis, frameOpen, openPlanReview, hcpSpawnAgent };
}
