/**
 * host-link — the host end of one community view's MessagePort. Pure logic:
 * validates every inbound message (protocol.ts), enforces the permission the
 * manifest was granted, counts what it refuses, and disables the plugin past a
 * threshold. No DOM, no React — CommunityView.tsx owns those; this file is what
 * the unit tests drive with a fake port.
 *
 * Disable rules (any one trips it, `onDisable(reason)` fires once):
 *   • ≥ LIMITS.malformed refused messages (malformed, unknown, before `ready`,
 *     a command without its permission, a command naming a tile that does not
 *     exist);
 *   • > LIMITS.messagesPerSecond inbound messages in one second (a flood);
 *   • > LIMITS.longTaskMsPerWindow ms of main-thread long tasks attributed to
 *     the plugin's iframe within LIMITS.windowMs (a runaway render loop). The
 *     component feeds these in from a PerformanceObserver.
 */
import {
  COMMAND_PERMISSION, PROTOCOL_VERSION, parsePluginMessage,
  type HostMessage, type PluginMessage, type SurfaceRect, type ViewPermission, type ViewRect,
} from "@hivemind/view-sdk/protocol";
import type { WorkspaceCommands } from "../../workspace-view";
import { AGENT_TILE_KIND, type TileKind } from "../../../tile-kinds";
import { bucketTileStatus } from "../../tile-status-bucket";

/** Kinds a plugin may spawn (no planReview: that is opened by the control plane). */
const SPAWNABLE: readonly string[] = [AGENT_TILE_KIND, "shell", "editor", "diff", "issues", "browser", "workbench"];

export const LIMITS = {
  malformed: 8,
  messagesPerSecond: 600,
  longTaskMsPerWindow: 1500,
  windowMs: 3000,
};

export interface LinkDeps {
  pluginId: string;
  capabilities: ViewPermission[];
  commands: WorkspaceCommands;
  /** Ids the plugin may name in commands (the current tiles). */
  hasTile: (id: string) => boolean;
  hasFrame: (id: string) => boolean;
  onReady: () => void;
  onSurfaceRects: (rects: SurfaceRect[]) => void;
  onLayout: (data: unknown) => void;
  onFramesDrawn: (count: number) => void;
  onError: (message: string) => void;
  onDisable: (reason: string) => void;
  now?: () => number;
}

export interface LinkStats {
  received: number;
  refused: number;
  ready: boolean;
  disabled: string | null;
  framesDrawn: number;
  statusSubscriptions: number;
}

interface PortLike { postMessage(msg: unknown): void; onmessage: ((e: MessageEvent) => void) | null; start?: () => void; close?: () => void }

export class CommunityLink {
  readonly stats: LinkStats = { received: 0, refused: 0, ready: false, disabled: null, framesDrawn: 0, statusSubscriptions: 0 };
  private port: PortLike | null = null;
  private statusUnsubs = new Map<string, () => void>();
  private windowStart = 0;
  private windowCount = 0;
  private longTasks: Array<{ t: number; ms: number }> = [];
  private reveals = new Map<number, (rect: ViewRect | null) => void>();
  private nextRequest = 1;
  private readonly now: () => number;

  constructor(private deps: LinkDeps) { this.now = deps.now ?? (() => performance.now()); }

  attach(port: PortLike): void {
    this.port = port;
    port.onmessage = (e) => this.handle(e.data);
    port.start?.();
  }

  send(msg: HostMessage): void {
    if (this.stats.disabled || !this.port) return;
    try { this.port.postMessage(msg); } catch { /* port gone */ }
  }

  /** Ask the plugin where a tile is (its rect in the plugin viewport, or null). */
  reveal(tileId: string, timeoutMs = 2000): Promise<ViewRect | null> {
    if (this.stats.disabled || !this.stats.ready) return Promise.resolve(null);
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.reveals.delete(requestId); resolve(null); }, timeoutMs);
      this.reveals.set(requestId, (rect) => { clearTimeout(timer); resolve(rect); });
      this.send({ type: "reveal", requestId, tileId });
    });
  }

  /** Feed a main-thread long task attributed to the plugin's iframe. */
  noteLongTask(ms: number): void {
    if (this.stats.disabled) return;
    const t = this.now();
    this.longTasks.push({ t, ms });
    const cutoff = t - LIMITS.windowMs;
    while (this.longTasks.length && this.longTasks[0]!.t < cutoff) this.longTasks.shift();
    const total = this.longTasks.reduce((a, b) => a + b.ms, 0);
    if (total > LIMITS.longTaskMsPerWindow) this.disable(`runaway: ${Math.round(total)} ms of long tasks in ${LIMITS.windowMs / 1000} s`);
  }

  dispose(): void {
    for (const u of this.statusUnsubs.values()) u();
    this.statusUnsubs.clear();
    this.stats.statusSubscriptions = 0;
    if (this.port) { this.port.onmessage = null; this.port.close?.(); this.port = null; }
  }

  private disable(reason: string) {
    if (this.stats.disabled) return;
    this.stats.disabled = reason;
    this.dispose();
    this.deps.onDisable(reason);
  }

  private refuse(why: string) {
    this.stats.refused++;
    console.warn(`[hivemind] view "${this.deps.pluginId}" refused: ${why}`);
    if (this.stats.refused >= LIMITS.malformed) this.disable(`${this.stats.refused} malformed or unauthorised messages (last: ${why})`);
  }

  /** Public for tests; the port handler routes here. */
  handle(raw: unknown): void {
    if (this.stats.disabled) return;
    this.stats.received++;
    const t = this.now();
    if (t - this.windowStart >= 1000) { this.windowStart = t; this.windowCount = 0; }
    if (++this.windowCount > LIMITS.messagesPerSecond) { this.disable(`message flood: >${LIMITS.messagesPerSecond} messages in one second`); return; }
    const r = parsePluginMessage(raw);
    if (!r.ok) { this.refuse(r.reason); return; }
    const m: PluginMessage = r.msg;
    if (!this.stats.ready) {
      if (m.type !== "ready") { this.refuse(`${m.type} before ready`); return; }
      if (m.v !== PROTOCOL_VERSION) { this.disable(`protocol version ${m.v} is not supported (host speaks ${PROTOCOL_VERSION})`); return; }
      this.stats.ready = true;
      this.deps.onReady();
      return;
    }
    switch (m.type) {
      case "ready": this.refuse("duplicate ready"); return;
      case "command": this.command(m.name, m.args); return;
      case "subscribeStatus": {
        if (!this.deps.hasTile(m.tileId)) { this.refuse(`subscribeStatus: unknown tile ${m.tileId}`); return; }
        if (this.statusUnsubs.has(m.tileId)) return;
        const unsub = this.deps.commands.subscribeTileStatus(m.tileId, (status) => this.send({ type: "status", tileId: m.tileId, status: bucketTileStatus(status) }));
        this.statusUnsubs.set(m.tileId, unsub);
        this.stats.statusSubscriptions = this.statusUnsubs.size;
        return;
      }
      case "unsubscribeStatus": {
        this.statusUnsubs.get(m.tileId)?.();
        this.statusUnsubs.delete(m.tileId);
        this.stats.statusSubscriptions = this.statusUnsubs.size;
        return;
      }
      case "surfaceRects": {
        const rects = m.rects.filter((r) => this.deps.hasTile(r.tileId));
        if (rects.length !== m.rects.length) this.refuse("surfaceRects: unknown tile");
        this.deps.onSurfaceRects(rects);
        return;
      }
      case "revealed": {
        const cb = this.reveals.get(m.requestId);
        if (!cb) { this.refuse(`revealed: unknown requestId ${m.requestId}`); return; }
        this.reveals.delete(m.requestId);
        cb(m.rect);
        return;
      }
      case "framesDrawn": this.stats.framesDrawn = m.count; this.deps.onFramesDrawn(m.count); return;
      case "layout": this.deps.onLayout(m.data); return;
      case "error": this.deps.onError(m.message); return;
    }
  }

  /** A tile closed: drop its subscription silently (the plugin will hear it in `structure`). */
  dropTile(tileId: string): void {
    this.statusUnsubs.get(tileId)?.();
    if (this.statusUnsubs.delete(tileId)) this.stats.statusSubscriptions = this.statusUnsubs.size;
  }

  private command(name: keyof typeof COMMAND_PERMISSION, args: unknown[]) {
    const need = COMMAND_PERMISSION[name];
    if (need && !this.deps.capabilities.includes(need)) { this.refuse(`${name} needs permission "${need}"`); return; }
    const c = this.deps.commands;
    const tile = (id: unknown) => (id === null || this.deps.hasTile(id as string) ? true : (this.refuse(`${name}: unknown tile ${String(id)}`), false));
    const frame = (id: unknown) => (id === null || this.deps.hasFrame(id as string) ? true : (this.refuse(`${name}: unknown frame ${String(id)}`), false));
    switch (name) {
      case "selectTile": if (tile(args[0])) c.selectTile(args[0] as string | null); return;
      case "selectFrame": if (frame(args[0])) c.selectFrame(args[0] as string | null); return;
      case "focusTile": if (tile(args[0])) c.focusTile(args[0] as string, args[1] as { exact?: boolean } | undefined); return;
      case "closeTile": if (tile(args[0])) c.closeTile(args[0] as string); return;
      case "spawnTile":
        if (!SPAWNABLE.includes(args[0] as string)) { this.refuse(`spawnTile: unknown kind ${String(args[0])}`); return; }
        if (frame(args[1])) c.spawnTile(args[0] as TileKind, args[1] as string | null);
        return;
      case "spawnVis": c.spawnVis(args[0] as "tree" | "shell" | "diff" | "issues"); return;
      case "spawnClaude": c.spawnClaude(); return;
      case "addFrame": c.addFrame(); return;
    }
  }
}
