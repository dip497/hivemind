/**
 * Home, as the person's phone follows it (spec/home.md): each workspace held here, its frames and
 * its tiles, as the Layers panel lists them, one keyed row each. A frame and a tile are what
 * `structure` says of them; a tile is also where the desktop lists it, and for an agent what the
 * agent list says. What each tile last printed is a sequence of its own, so a busy terminal never
 * moves the board's.
 */
import path from "node:path";
import { isRemote } from "@hivemind/core/remote-uri";
import { workspaceCounts, type LayerStatus } from "@hivemind/core/layers";
import type { Structure } from "@hivemind/view-host/structure";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { GENERIC_AGENT_ICON, type AgentProviderDef } from "@hivemind/agents";
import type { HomeLook, HomeMessage, HomeRow, HomeTile } from "@hivemind/workspace-api/home";
import { accentOf } from "@hivemind/core/appearance-extra";
import { cssColorToHex } from "@hivemind/core/css-color";
import { PALETTE_KEYS, type SharedAppearance } from "@hivemind/core/settings-schema";
import { wallpaperMedia } from "./appearance.js";
import { isTerminalKind, type KeptCore } from "@hivemind/workspace-doc/shapes";
import { KeyedFeed } from "./keyed-feed.js";
import { heldBoards, type HeldBoard } from "./needs.js";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";

/** What the window's Layers panel shows of a workspace: its tiles in the order listed, and the
 *  pinned ones. */
export interface LayersShown {
  order: string[];
  pinned: string[];
}

export interface HomeSource {
  held: HeldBoard[];
  /** The agents here, as the agent list has them. */
  agents: AgentItem[];
  structure(core: Pick<KeptCore, "frames" | "tiles" | "frameOf" | "tileNames">): Structure;
  /** What the window shows of the workspace in `repo`; none: the board's own order, nothing pinned. */
  shown(repo: string): LayersShown | undefined;
  /** The agent the id `id` names, as its manifest here says. */
  agent?(id: string): AgentProviderDef | undefined;
}

/** A workspace as the Layers panel's Projects list it: how many tiles it has, how many of them
 *  need the person and how many work. */
export interface WorkspaceSummary { repo: string; title: string; tiles: number; needsYou: number; working: number }

/** The Layers panel's Projects: every workspace `store` holds, and every folder set up for issues
 *  here (`registered`) but not opened yet, with what runs in each now, by name. One not opened has
 *  nothing running and is not read from the store, which would hold it from then on. */
export function workspaceSummaries(
  store: Pick<WorkspaceStore, "repos" | "ownership" | "getCore">,
  registered: readonly { repo: string }[],
  statusOf: (tile: string) => LayerStatus | null,
): WorkspaceSummary[] {
  const held = heldBoards(store);
  const known = registered
    .filter((w) => !held.some((h) => h.repo === w.repo))
    .map((w) => ({ repo: w.repo, name: path.basename(w.repo), core: null }));
  return [...held, ...known].map((h): WorkspaceSummary => ({
    repo: h.repo, title: h.name, ...workspaceCounts((h.core?.tiles ?? []).map((t) => statusOf(t.id))),
  })).sort((a, b) => a.title.localeCompare(b.title));
}

const tileKey = (workspace: string, id: string) => `t:${workspace}/${id}`;

/** Every row, by key. */
export function homeRows(s: HomeSource): Map<string, HomeRow> {
  const rows = new Map<string, HomeRow>();
  const agents = new Map(s.agents.map((a) => [a.tile, a]));
  for (const h of s.held) {
    const { workspace } = h;
    rows.set(`w:${workspace}`, { of: "workspace", workspace, name: h.name });
    const structure = s.structure(h.core ?? { frames: [], tiles: [] });
    const paths = new Map((h.core?.frames ?? []).map((f) => [f.id, f.worktreePath ?? f.workspacePath]));
    structure.frames.forEach((f, order) => {
      const at = paths.get(f.id);
      const remote: boolean = isRemote(at);
      const project = !f.parentId && at && !remote && at !== h.repo ? at.split(/[\\/]/).filter(Boolean).pop() : undefined;
      rows.set(`f:${workspace}/${f.id}`, { of: "frame", workspace, ...f, order, ...(project ? { project } : {}) });
    });
    const shown = s.shown(h.repo);
    const listed = new Map(shown?.order.map((id, i) => [id, i]));
    const pinned = new Set(shown?.pinned);
    const here = new Set(structure.tiles.map((t) => t.id));
    const starter = new Map(structure.links?.spawns.filter((l) => here.has(l.parent)).map((l) => [l.child, l.parent]));
    structure.tiles.forEach((t, i) => {
      const a = agents.get(t.id);
      const parent = starter.get(t.id);
      const row: HomeTile = {
        of: "tile", workspace, id: t.id, frameId: t.frameId, kind: t.kind, name: t.name,
        ...(t.agent ? { agent: t.agent } : {}),
        ...(isTerminalKind(t.kind) ? { terminal: true as const } : {}),
        order: listed.get(t.id) ?? listed.size + i,
        ...(pinned.has(t.id) ? { pinned: true as const } : {}),
        ...(parent ? { parent } : {}),
        ...(a ? {
          state: a.state, since: a.since, ...(a.waiting ? { waiting: a.waiting } : {}),
          ...(a.program ? { program: a.program } : {}), machine: a.machine,
          ...(a.interrupt ? { interrupt: true as const } : {}), ...(a.conversation ? { conversation: true as const } : {}),
        } : {}),
      };
      rows.set(tileKey(workspace, t.id), row);
      // Its agent, once: a manifest here names it, else the generic mark under its id.
      if (t.agent && !rows.has(`a:${t.agent}`)) {
        const def = s.agent?.(t.agent);
        const { viewBox, attrs, shapes } = def?.icon ?? GENERIC_AGENT_ICON;
        rows.set(`a:${t.agent}`, { of: "agent", id: t.agent, label: def?.label ?? t.agent, icon: { viewBox, ...(attrs ? { attrs } : {}), shapes } });
      }
    });
  }
  return rows;
}

/** Each tile of `held`'s last line (`TileLines.get`), by its row's key. */
export function homeLines(held: HeldBoard[], line: (tile: string) => string | undefined): Map<string, string> {
  const lines = new Map<string, string>();
  for (const h of held) {
    for (const t of h.core?.tiles ?? []) {
      const l = line(t.id);
      if (l) lines.set(tileKey(h.workspace, t.id), l);
    }
  }
  return lines;
}

/** How the computer looks, as Home sends the person's devices (`HomeLook`): its appearance `a`,
 *  every colour `#rrggbb`, and its wallpaper as it draws it (`shown`, `wallpaperShown`), a photo or
 *  video named by a hash of its address, never the address. */
export function homeLook(a: SharedAppearance, shown: boolean): HomeLook {
  const hex = (v: string, or: string) => cssColorToHex(v, or);
  const accent = accentOf(a, a.accentCustom ? { accent: a.accentCustom } : null);
  const colors: Record<string, string> = {};
  for (const k of PALETTE_KEYS) colors[k] = hex(a.palette[k], a.mode === "dark" ? "#000000" : "#ffffff");
  colors.brand = hex(accent.brand, colors.fg!);
  colors.accent = hex(accent.accent, colors.brand);
  const t = a.terminal;
  const media = shown ? wallpaperMedia(a) : null;
  // A photo or video not yet picked draws nothing, as on the computer.
  const kind = !shown || ((a.wallpaper.kind === "image" || a.wallpaper.kind === "video") && !media) ? "none" : a.wallpaper.kind;
  return {
    mode: a.mode,
    colors,
    terminal: {
      background: hex(t.background, colors.bg!), foreground: hex(t.foreground, colors.fg!),
      cursor: hex(t.cursor, colors.fg!), selection: hex(t.selection, colors.select!),
      ansi: t.ansi.slice(0, 16).map((c) => hex(c, colors.fg!)),
    },
    wallpaper: {
      kind,
      colour: a.wallpaper.colour,
      brightness: Math.round(a.wallpaper.brightness * 100),
      motion: a.glass.animate,
      glass: a.glass.enabled ? Math.round(a.glass.opacity * 100) : null,
      ...(media ? { media: { revision: media.revision, type: media.type } } : {}),
    },
  };
}

export interface HomeFeedOptions {
  rows(): Map<string, HomeRow>;
  lines(): Map<string, string>;
  /** How the computer looks now; null while not known, and left out, Home says nothing of it. */
  look?(): HomeLook | null;
  /** The least time between two workings-out (ms). */
  every?: number;
  keep?: number;
  bytes?: number;
  now?(): number;
}

/** Home's two sequences, worked out at most every `every` ms however often things change, each
 *  change told to every follower. A line that changes works out the lines alone: never every
 *  row of the layout. */
export class HomeFeed {
  private readonly layout: KeyedFeed<HomeRow>;
  private readonly lines: KeyedFeed<string>;
  private readonly followers = new Set<(m: HomeMessage) => void>();
  private due: ReturnType<typeof setTimeout> | null = null;
  private lastAt = -Infinity;
  /** Changed while no one followed: worked out when someone next asks. */
  private stale = false;
  /** What changed since Home was last worked out may change its layout, not only its lines. */
  private layoutStale = false;
  /** The look as last sent, and whether it may have changed since. */
  private lookSent: string | null = null;
  private lookStale = true;

  constructor(private readonly o: HomeFeedOptions) {
    const caps = { ...(o.keep ? { keep: o.keep } : {}), ...(o.bytes ? { bytes: o.bytes } : {}) };
    this.layout = new KeyedFeed(caps);
    this.lines = new KeyedFeed(caps);
    this.layout.set(o.rows());
    this.lines.set(o.lines());
  }

  /** Something Home shows changed: work it out again, soon. */
  changed(): void {
    this.layoutStale = true;
    this.linesChanged();
  }

  /** How the computer looks may have changed: told, soon, when it did. */
  lookChanged(): void {
    this.lookStale = true;
    this.linesChanged();
  }

  /** The look, when it changed since it was last sent. */
  private newLook(): HomeLook | null {
    const look = this.lookStale ? this.o.look?.() : null;
    if (!look) return null;
    this.lookStale = false;
    const json = JSON.stringify(look);
    if (json === this.lookSent) return null;
    this.lookSent = json;
    return look;
  }

  /** Only a tile's last line changed: its lines are worked out again, soon, and its layout not. */
  linesChanged(): void {
    if (this.followers.size === 0) {
      this.stale = true;
      return;
    }
    if (this.due) return;
    const now = this.o.now?.() ?? Date.now();
    const wait = (this.o.every ?? 250) - (now - this.lastAt);
    if (wait <= 0) return this.refresh();
    this.due = setTimeout(() => this.refresh(), wait);
    (this.due as { unref?: () => void }).unref?.();
  }

  refresh(): void {
    if (this.due) clearTimeout(this.due);
    this.due = null;
    this.stale = false;
    this.lastAt = this.o.now?.() ?? Date.now();
    const layout = this.layoutStale ? this.layout.set(this.o.rows()) : [];
    this.layoutStale = false;
    const lines = this.lines.set(this.o.lines());
    const look = this.newLook();
    if (!layout.length && !lines.length && !look) return;
    const m: HomeMessage = {
      t: "changes",
      ...(layout.length ? { layout: { seq: layout.at(-1)!.seq, changes: layout } } : {}),
      ...(lines.length ? { lines: { seq: lines.at(-1)!.seq, changes: lines } } : {}),
      ...(look ? { look } : {}),
    };
    for (const f of this.followers) f(m);
  }

  /** What a follower that has the sequences up to `at` is answered: what came after, or, when it
   *  has none or is too far behind, both whole. */
  answer(at: { layout?: number; lines?: number }): HomeMessage {
    if (this.due || this.stale) this.refresh();
    const layout = at.layout === undefined ? null : this.layout.since(at.layout);
    const lines = at.lines === undefined ? null : this.lines.since(at.lines);
    this.newLook();
    const look = this.lookSent ? { look: JSON.parse(this.lookSent) as HomeLook } : {};
    if (!layout || !lines) return { t: "home", layout: this.layout.snapshot(), lines: this.lines.snapshot(), ...look };
    return { t: "changes", layout, lines, ...look };
  }

  /** Tell `f` each change from now on, until what this returns is called. */
  follow(f: (m: HomeMessage) => void): () => void {
    this.followers.add(f);
    return () => this.followers.delete(f);
  }

  close(): void {
    if (this.due) clearTimeout(this.due);
    this.due = null;
    this.followers.clear();
  }
}
