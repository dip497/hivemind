/**
 * Protocol v1 between the hivemind host (privileged renderer) and a community
 * view (sandboxed iframe), over ONE MessagePort. Every message is a plain JSON
 * object with a `type`. Both directions are validated by the functions below:
 * the host refuses anything malformed before it touches workspace state, the
 * client drops anything it does not understand.
 *
 * Shape follows the gaps the built-in World view found in the in-process view
 * contract (docs/design/workspace-views.md, phase 3 → 4): structure and names
 * are separate messages, colours arrive pre-resolved, status is a per-tile
 * subscription, selection says whether it is new since mount, and a live tile
 * surface is a hole the plugin punches (`surfaceRects`) that the host fills
 * with a real terminal above the iframe.
 */

export const PROTOCOL_VERSION = 1;

/** What a manifest may ask for beyond the base set (projection, status,
 *  selection, reveal, surfaces, layout). The host grants exactly what the
 *  manifest lists; an unknown name is refused at install and at load. */
/** `workspace:edit` (protocol 1.2): rename a tile, bind a frame to a folder. */
export const VIEW_PERMISSIONS = ["workspace:spawn", "workspace:close", "workspace:edit"] as const;
export type ViewPermission = (typeof VIEW_PERMISSIONS)[number];

export type ViewStatus = "unknown" | "idle" | "working" | "blocked" | "exited";
const STATUSES: readonly ViewStatus[] = ["unknown", "idle", "working", "blocked", "exited"];

/** What a status means, whatever the palette. A view paints `--hm-status-<tone>` (see
 *  `applyThemeVars`) and never decides for itself which colour "blocked" is — the host decides
 *  once, for the whole app, so a tile never means one thing in a view and another on the canvas. */
export type StatusTone = "working" | "attention" | "done" | "idle" | "exited" | "failed";
export const STATUS_TONES: readonly StatusTone[] = ["working", "attention", "done", "idle", "exited", "failed"];

/** The tone for a status. `done` and `failed` are never a live status: a view that observes a
 *  turn finishing may show `done`; `failed` is for an exit the host reports as a failure. */
export function statusTone(s: ViewStatus): StatusTone {
  switch (s) {
    case "blocked": return "attention";
    case "working": return "working";
    case "exited": return "exited";
    default: return "idle";
  }
}

/** Where a frame runs, when that is a saved machine (protocol 1.1, additive). `state` is the
 *  link: `online` (with `rttMs` once measured), `connecting`, `reconnecting`, `offline`,
 *  `attention` (a person must log in), `no-hive` (terminals there die with the connection). */
export interface ViewFrameMachine {
  name: string;
  state: "online" | "connecting" | "reconnecting" | "offline" | "attention" | "no-hive" | "idle";
  rttMs?: number;
}
/** The folder a frame is bound to (protocol 1.2, additive): a git `worktree` of its parent's repo, or
 *  a plain `folder` (a repository or not). `name` is its last path segment; the path itself stays
 *  with the host. A frame bound to nothing has no `folder`. */
export interface ViewFrameFolder { name: string; kind: "worktree" | "folder" }
export interface ViewFrame {
  id: string; title: string; /** `#rrggbb` */ color: string; machine?: ViewFrameMachine;
  /** 1.2: the frame this one is nested in (a worktree under its repo). */
  parentId?: string;
  /** 1.2: the git branch of a worktree frame. */
  branch?: string;
  folder?: ViewFrameFolder;
}
export interface ViewTile {
  id: string; frameId: string | null; kind: string; name: string;
  /** 1.2: which agent an agent tile runs — its catalog id (`"codex"`, `"claude"`, …). */
  agent?: string;
}
/** Agents driving agents (protocol 1.2): `pipes` carry one agent's replies into another's input;
 *  `spawns` record which agent opened which (`hive ctl spawn`). Tile ids at both ends. */
export interface ViewLinks { pipes: { src: string; dst: string }[]; spawns: { parent: string; child: string }[] }
export interface ViewRect { x: number; y: number; w: number; h: number }
/** `chrome` (protocol 1.1, additive): "bar" (default) lets the host draw its
 *  thin slot bar — name, status, pop-out, undock — on the surface; "none"
 *  leaves the whole rect to the surface (the plugin then owns undocking). */
export interface SurfaceRect extends ViewRect { tileId: string; chrome?: "bar" | "none" }
/** The host theme, resolved. `colors` are the `--color-*` tokens as `#rrggbb`;
 *  the rest (protocol 1.1, additive — a 1.0 host sends only `colors`) is the
 *  user's appearance: mode, accent, radius, fonts, the surface + terminal
 *  backgrounds, and whether glass is on. `applyThemeVars` maps all of it to
 *  CSS custom properties on the plugin document. */
export interface ViewTheme {
  colors: Record<string, string>;
  mode?: "dark" | "light";
  accent?: string;
  radius?: number;
  fonts?: { ui: string; mono: string };
  /** The panel surface colour (`#rrggbb`) and the terminal background. */
  surface?: string;
  terminalBackground?: string;
  glass?: boolean;
  /** Protocol 1.1, additive: one `#rrggbb` per status tone, resolved from the host's status
   *  tokens. A host that predates it sends none, and `applyThemeVars` derives them from `colors`. */
  status?: Partial<Record<StatusTone, string>>;
}

// ── host → plugin ───────────────────────────────────────────────────────────

export type HostMessage =
  | { type: "hello"; v: number; pluginId: string; capabilities: ViewPermission[]; theme: ViewTheme; layout: unknown; viewport: { w: number; h: number }; visible: boolean }
  /** Frames / tiles / membership (+ the current names). Structural only. */
  | { type: "structure"; frames: ViewFrame[]; tiles: ViewTile[]; /** 1.2 */ links?: ViewLinks }
  /** Display names changed (renames, agent titles) — nothing structural did. */
  | { type: "names"; names: Record<string, string> }
  /** `fresh` = changed since the plugin mounted (the selection you arrive with is not fresh). */
  | { type: "selection"; tileId: string | null; frameId: string | null; fresh: boolean }
  | { type: "status"; tileId: string; status: ViewStatus }
  /** "Show me this tile"; answer with `revealed` (its rect, or null). */
  | { type: "reveal"; requestId: number; tileId: string }
  | { type: "resize"; w: number; h: number }
  | { type: "visibility"; visible: boolean }
  | { type: "theme"; theme: ViewTheme }
  /** The user undocked a surface from the host's bar (or Shift+Esc): the
   *  host has already released the tile; drop the rect on your side. */
  | { type: "undock"; tileId: string };

// ── plugin → host ───────────────────────────────────────────────────────────

/** The WorkspaceCommands vocabulary a plugin may invoke, with the argument
 *  shapes the host accepts. `spawnTile`'s free-form options are deliberately
 *  not exposed (an agent command line is not something a plugin chooses). */
export interface ViewCommands {
  selectTile: (id: string | null) => void;
  selectFrame: (id: string | null) => void;
  focusTile: (id: string, opts?: { exact?: boolean }) => void;
  /** permission `workspace:close` */
  closeTile: (id: string) => void;
  /** permission `workspace:spawn` */
  spawnTile: (kind: string, frameId: string | null) => void;
  /** permission `workspace:spawn` */
  spawnVis: (which: "tree" | "shell" | "diff" | "issues") => void;
  /** permission `workspace:spawn` */
  spawnClaude: () => void;
  /** permission `workspace:spawn` */
  addFrame: () => void;
  /** 1.2, permission `workspace:spawn`: start an agent — a catalog id, or null for the user's
   *  default — in a frame (null: the host picks), optionally with a first prompt and a tile name. */
  spawnAgent: (agent: string | null, frameId: string | null, opts?: { prompt?: string; name?: string }) => void;
  /** 1.2, permission `workspace:edit`: rename a tile ("" goes back to its own name). */
  renameTile: (id: string, name: string) => void;
  /** 1.2, permission `workspace:edit`: ask the user for a folder to bind this frame to. */
  openFolder: (frameId: string) => void;
}
export type CommandName = keyof ViewCommands;
export const COMMAND_PERMISSION: Record<CommandName, ViewPermission | null> = {
  selectTile: null, selectFrame: null, focusTile: null,
  closeTile: "workspace:close",
  spawnTile: "workspace:spawn", spawnVis: "workspace:spawn", spawnClaude: "workspace:spawn", addFrame: "workspace:spawn",
  spawnAgent: "workspace:spawn", renameTile: "workspace:edit", openFolder: "workspace:edit",
};

export type PluginMessage =
  | { type: "ready"; v: number }
  | { type: "command"; name: CommandName; args: unknown[] }
  | { type: "subscribeStatus"; tileId: string }
  | { type: "unsubscribeStatus"; tileId: string }
  /** The hole-punch: where live tile surfaces belong, in px relative to the
   *  plugin's viewport. The host positions a real slot per rect above the iframe. */
  | { type: "surfaceRects"; rects: SurfaceRect[] }
  | { type: "revealed"; requestId: number; rect: ViewRect | null }
  /** Frames the plugin has drawn so far (monotonic). The host reads it for its
   *  render-on-demand checks; send it when it changes, at most ~1/s. */
  | { type: "framesDrawn"; count: number }
  /** Persist an opaque blob under the plugin id (≤ LAYOUT_MAX_BYTES). */
  | { type: "layout"; data: unknown }
  | { type: "error"; message: string };

export const MAX_SURFACE_RECTS = 16;
/** 1.2 argument caps: a tile name, and an agent's first prompt. */
export const NAME_MAX = 120;
export const PROMPT_MAX = 32 * 1024;
export const LAYOUT_MAX_BYTES = 64 * 1024;
const ID_MAX = 256;

// ── validation ──────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
const isIdOrNull = (v: unknown): v is string | null => v === null || isId(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRect = (v: unknown): v is ViewRect => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h);

const COMMAND_ARGS: Record<CommandName, (args: unknown[]) => boolean> = {
  selectTile: (a) => a.length === 1 && isIdOrNull(a[0]),
  selectFrame: (a) => a.length === 1 && isIdOrNull(a[0]),
  focusTile: (a) => (a.length === 1 || a.length === 2) && isId(a[0]) && (a[1] === undefined || (isObj(a[1]) && (a[1].exact === undefined || typeof a[1].exact === "boolean"))),
  closeTile: (a) => a.length === 1 && isId(a[0]),
  spawnTile: (a) => a.length === 2 && isId(a[0]) && isIdOrNull(a[1]),
  spawnVis: (a) => a.length === 1 && ["tree", "shell", "diff", "issues"].includes(a[0] as string),
  spawnClaude: (a) => a.length === 0,
  addFrame: (a) => a.length === 0,
  spawnAgent: (a) => (a.length >= 2 && a.length <= 3) && (a[0] === null || isId(a[0])) && isIdOrNull(a[1])
    && (a[2] === undefined || (isObj(a[2])
      && (a[2].prompt === undefined || (typeof a[2].prompt === "string" && a[2].prompt.length <= PROMPT_MAX))
      && (a[2].name === undefined || (typeof a[2].name === "string" && a[2].name.length <= NAME_MAX)))),
  renameTile: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === "string" && a[1].length <= NAME_MAX,
  openFolder: (a) => a.length === 1 && isId(a[0]),
};

/** Host side: validate a message received from a plugin. */
export function parsePluginMessage(raw: unknown): ParseResult<PluginMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): ParseResult<PluginMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  switch (raw.type) {
    case "ready":
      return isNum(raw.v) ? { ok: true, msg: { type: "ready", v: raw.v } } : bad("v must be a number");
    case "command": {
      const name = raw.name as CommandName;
      const check = Object.prototype.hasOwnProperty.call(COMMAND_ARGS, name) ? COMMAND_ARGS[name] : null;
      if (!check) return bad(`unknown command ${JSON.stringify(raw.name)}`);
      const args = raw.args === undefined ? [] : raw.args;
      if (!Array.isArray(args) || !check(args)) return bad(`bad arguments for ${name}`);
      return { ok: true, msg: { type: "command", name, args } };
    }
    case "subscribeStatus":
    case "unsubscribeStatus":
      return isId(raw.tileId) ? { ok: true, msg: { type: raw.type, tileId: raw.tileId } } : bad("tileId must be a string");
    case "surfaceRects": {
      if (!Array.isArray(raw.rects)) return bad("rects must be an array");
      if (raw.rects.length > MAX_SURFACE_RECTS) return bad(`more than ${MAX_SURFACE_RECTS} rects`);
      const seen = new Set<string>();
      for (const r of raw.rects) {
        if (!isRect(r) || !isId((r as SurfaceRect).tileId)) return bad("each rect needs tileId,x,y,w,h numbers");
        if (seen.has((r as SurfaceRect).tileId)) return bad("duplicate tileId");
        seen.add((r as SurfaceRect).tileId);
        const c = (r as SurfaceRect).chrome;
        if (c !== undefined && c !== "bar" && c !== "none") return bad("chrome must be \"bar\" or \"none\"");
      }
      return { ok: true, msg: { type: "surfaceRects", rects: (raw.rects as SurfaceRect[]).map((r) => ({ tileId: r.tileId, x: r.x, y: r.y, w: r.w, h: r.h, ...(r.chrome ? { chrome: r.chrome } : {}) })) } };
    }
    case "revealed":
      if (!isNum(raw.requestId)) return bad("requestId must be a number");
      if (raw.rect !== null && !isRect(raw.rect)) return bad("rect must be a rect or null");
      return { ok: true, msg: { type: "revealed", requestId: raw.requestId, rect: raw.rect === null ? null : { x: raw.rect.x, y: raw.rect.y, w: raw.rect.w, h: raw.rect.h } } };
    case "framesDrawn":
      return isNum(raw.count) && raw.count >= 0 ? { ok: true, msg: { type: "framesDrawn", count: raw.count } } : bad("count must be a non-negative number");
    case "layout": {
      let size = 0;
      try { size = JSON.stringify(raw.data ?? null).length; } catch { return bad("data is not JSON"); }
      if (size > LAYOUT_MAX_BYTES) return bad(`data exceeds ${LAYOUT_MAX_BYTES} bytes`);
      return { ok: true, msg: { type: "layout", data: raw.data ?? null } };
    }
    case "error":
      return typeof raw.message === "string" ? { ok: true, msg: { type: "error", message: raw.message.slice(0, 2000) } } : bad("message must be a string");
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(raw.type)}` };
  }
}

/** Plugin side: validate a message received from the host (lenient on extras). */
export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): ParseResult<HostMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  switch (raw.type) {
    case "hello":
      if (!isNum(raw.v) || !isId(raw.pluginId) || !Array.isArray(raw.capabilities) || !isObj(raw.theme) || !isObj(raw.viewport)) return bad("missing fields");
      return { ok: true, msg: raw as unknown as HostMessage };
    case "structure":
      if (!Array.isArray(raw.frames) || !Array.isArray(raw.tiles)) return bad("frames and tiles must be arrays");
      return { ok: true, msg: raw as unknown as HostMessage };
    case "names":
      return isObj(raw.names) ? { ok: true, msg: raw as unknown as HostMessage } : bad("names must be an object");
    case "selection":
      return isIdOrNull(raw.tileId) && isIdOrNull(raw.frameId) && typeof raw.fresh === "boolean" ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "status":
      return isId(raw.tileId) && STATUSES.includes(raw.status as ViewStatus) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "reveal":
      return isNum(raw.requestId) && isId(raw.tileId) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "resize":
      return isNum(raw.w) && isNum(raw.h) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "visibility":
      return typeof raw.visible === "boolean" ? { ok: true, msg: raw as unknown as HostMessage } : bad("visible must be a boolean");
    case "theme":
      return isObj(raw.theme) ? { ok: true, msg: raw as unknown as HostMessage } : bad("theme must be an object");
    case "undock":
      return isId(raw.tileId) ? { ok: true, msg: raw as unknown as HostMessage } : bad("tileId must be a string");
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(raw.type)}` };
  }
}

/** The message the host posts to the iframe window to hand over the port. */
export const PORT_HANDSHAKE = "hivemind-view:port";
