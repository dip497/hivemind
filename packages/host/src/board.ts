/**
 * What is drawn on the board, through the workspace API (0.42, `board.*`): the host places what an
 * agent draws, so it works with no window open, and writes it as any writer of the board does; a
 * window, a phone and other devices are told of the change as of any other. An agent asks from
 * its tile on the drive socket, a person's device as they may (`roles.ts`). Electron-free.
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import { toBareId, mintId } from "@hivemind/workspace-api/tile-id";
import type { BoardAsk, BoardChange, BoardChangeAsk, BoardChanged, BoardChanges as BoardChangeFeed, BoardDrawn, BoardEraseAsk, BoardItem, BoardNoteAsked, BoardPictureAsk, BoardReading, BoardSelection, DrawAsked } from "@hivemind/workspace-api/board";
import type { PageListing, PageNewAsk } from "@hivemind/workspace-api/pages";
import { alignObjects, duplicateObjects, isLocked, lockObjects, moveObjects, restack, styleObjects, type AlignHow, type BoardChanges } from "@hivemind/workspace-doc/board-actions";
import { withObjects } from "@hivemind/workspace-doc/board-edit";
import { isWithin, pageOf } from "@hivemind/workspace-doc/pages";
import {
  MAX_SHAPES_ON_BOARD, boardPicture, boundsOf, facingSides, freeCorner, readDrawAsked, rectsTouch, sketchOf,
  type DrawnLink, type PictureAnchor, type PictureTheme, type Point, type Rect, type Sketch,
} from "@hivemind/workspace-doc/drawing";
import { drawProblems } from "@hivemind/workspace-doc/draw-problems";
import { drawFromText, isTitle, textOfDrawing } from "@hivemind/workspace-doc/draw-text";
import { drawingName, endNamer } from "@hivemind/workspace-doc/drawing-name";
import {
  SHAPE_COLORS, SHAPE_DASHES, SHAPE_WEIGHTS,
  type ArrowObject, type ArrowRoute, type BoardImage, type BoardObject, type ShapeColor, type CoreLayout, type FrameRecord, type ShapeDash, type ShapeObject, type ShapeWeight, type TileRecord, type ViewLayout, type WidgetObject,
} from "@hivemind/workspace-doc/shapes";
import { addComment, PERSON_AUTHOR, reviewRoot, REVIEW_FILE, type BoardComment } from "@hivemind/core/review";
import type { WorkspaceChange, WorkspaceStore } from "@hivemind/workspace-host/store";
import type { Participant } from "@hivemind/workspace-host/presence";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import path from "node:path";
import type { BoardImages } from "./board-images.js";

type BoardMethod = "board.draw" | "board.read" | "board.selected" | "board.changes" | "board.picture" | "board.erase" | "board.change" | "board.note" | "board.show"
  | "board.keepImage" | "board.image" | "board.undo" | "board.redo" | "page.list" | "page.new" | "page.open";

export interface BoardOptions {
  /** The store that holds a repo's board. */
  store(repo: string): WorkspaceStore;
  /** Whether a repo's board may be written here: a copy of one shared from elsewhere, as its role allows. */
  mayWrite?(repo: string): boolean;
  /** An SVG as a PNG, base64, by a window; none: no window draws one here. */
  png?(svg: string, width: number, height: number): Promise<{ png: string; width: number; height: number }>;
  /** Bring a rect of the canvas into view in a window; none: no window here. */
  show?(repo: string, box: Rect): Promise<void>;
  /** Fly a window to a page or frame and go inside it (null: out to the whole canvas); none: no window here. */
  openPage?(repo: string, page: string | null): Promise<void>;
  /** The review file of a repo changed: a window's pins read it again. */
  notesChanged?(repo: string, file: string): void;
  /** What an agent is called, by its tile. */
  agentName?(tile: string): string;
  /** Who is in a repo now, each window and device with what it has selected; none: nobody says here. */
  people?(repo: string): readonly Participant[];
  /** Hear each change the store makes; the function returned stops. */
  changes?(listener: (change: WorkspaceChange) => void): () => void;
  /** Where the board's pictures are kept; none: no picture is kept here. */
  images?: BoardImages;
}

/** The most bytes of pictures a picture of the board carries in itself; the rest are boxes with their alt text. */
const PICTURE_IMAGE_BYTES = 4 * 1024 * 1024;

/** A tile's size where the canvas has said none, as a new agent's is. */
const TILE_SIZE = { w: 1200, h: 820 };
/** How long a caller's undo history is kept unused, and how many callers' are kept at most. */
const WRITER_IDLE_MS = 60 * 60 * 1000;
const MAX_KEPT_WRITERS = 64;
/** A new page's size: an empty frame's, which grows round what goes in it. */
const NEW_PAGE = { w: 460, h: 200 };
/** How many of a workspace's board changes are kept to ask after, and how long one nobody asks after is kept. */
const FEED_KEPT = 500;
const FEED_IDLE_MS = 60 * 60 * 1000;

interface Scene {
  core: CoreLayout | null;
  frames: Map<string, Rect & { title: string; parent?: string; page?: true }>;
  tiles: Map<string, Rect & { name: string; kind: string; frame?: string }>;
  /** The board's objects in canvas coordinates, whatever frame each is in. */
  objects: BoardObject[];
  /** Everything an arrow can end on, by id. */
  rects: Map<string, Rect>;
  /** The frame each frame, tile and object is directly in, by id; an arrow is where its start is. */
  homes: Map<string, string | undefined>;
  records: readonly FrameRecord[];
}

type HeldFrame = { id: string; title?: string; parentFrameId?: string; page?: true; x?: number; y?: number; w?: number; h?: number };
const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

function sceneOf(store: WorkspaceStore, repo: string): Scene {
  const core = store.getCore(repo) as CoreLayout | null;
  const view = store.getView(repo, "canvas") as ViewLayout | null;
  const data = (view?.data ?? {}) as { positions?: Record<string, { x: number; y: number }>; sizes?: Record<string, { width: number; height: number }> };
  const frames: Scene["frames"] = new Map();
  for (const f of (core?.frames ?? []) as HeldFrame[]) {
    frames.set(f.id, { x: num(f.x), y: num(f.y), w: num(f.w), h: num(f.h), title: f.title ?? "", ...(f.parentFrameId ? { parent: f.parentFrameId } : {}), ...(f.page === true ? { page: true as const } : {}) });
  }
  const tiles: Scene["tiles"] = new Map();
  for (const t of (core?.tiles ?? []) as TileRecord[]) {
    const at = data.positions?.[t.id];
    if (!at) continue;
    const size = data.sizes?.[t.id];
    const frame = core?.frameOf?.[t.id];
    tiles.set(t.id, {
      x: at.x, y: at.y, w: size?.width ?? TILE_SIZE.w, h: size?.height ?? TILE_SIZE.h,
      name: core?.tileNames?.[t.id] || t.label || t.kind, kind: t.kind, ...(frame ? { frame } : {}),
    });
  }
  const objects = store.getObjects(repo).map((o): BoardObject => {
    const frame = (o.kind === "shape" || o.kind === "widget") && o.frame ? frames.get(o.frame) : undefined;
    return frame && (o.kind === "shape" || (o.kind === "widget" && o.placement === "board")) ? { ...o, x: num(o.x) + frame.x, y: num(o.y) + frame.y } as BoardObject : o;
  });
  const rects = new Map<string, Rect>([...frames, ...tiles]);
  for (const o of objects) if (hasBox(o)) rects.set(o.id, { x: o.x, y: o.y, w: o.w, h: o.h });
  const records = (core?.frames ?? []) as readonly FrameRecord[];
  const homes = new Map<string, string | undefined>();
  for (const [id, f] of frames) homes.set(id, f.parent);
  for (const t of core?.tiles ?? []) homes.set(t.id, core?.frameOf?.[t.id]);
  for (const b of objects) if (b.kind !== "arrow") homes.set(b.id, b.frame);
  for (const b of objects) if (b.kind === "arrow") homes.set(b.id, homes.get(b.from.id));
  return { core, frames, tiles, objects, rects, homes, records };
}

/** Whether `id` is inside the page or frame `page`, at any depth; null: the whole canvas, which holds everything. */
const inside = (scene: Scene, id: string, page: string | null): boolean => page === null || isWithin(scene.records, scene.homes.get(id), page);

/** The page or frame asked for; null or left out: the whole canvas. */
function pageAsked(scene: Scene, value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !scene.frames.has(value)) throw new ApiError("NOT_FOUND", `no page or frame ${String(value)} on this board: \`hive ctl page list\` and \`hive ctl frames\` list them`);
  return value;
}

/** A box as the store keeps it: placed from its frame's corner when it has one. */
function stored(scene: Scene, b: BoardObject | null): BoardObject | null {
  if (!b || !hasBox(b) || !b.frame) return b;
  const f = scene.frames.get(b.frame);
  return f ? { ...b, x: b.x - f.x, y: b.y - f.y } as BoardObject : b;
}

function hasBox(o: BoardObject): o is ShapeObject | (WidgetObject & Rect) {
  return o.kind === "shape" || (o.kind === "widget" && o.placement === "board");
}

const firstLine = (s: string | undefined): string => (s ?? "").split("\n")[0]!.trim();


function itemOf(o: BoardObject): BoardItem {
  if (o.kind === "arrow") {
    return { id: o.id, kind: o.kind, from: o.from.id, to: o.to.id, ...(o.label ? { text: o.label } : {}), ...(o.by ? { by: o.by } : {}), ...(o.drawing ? { drawing: o.drawing } : {}) };
  }
  const box = hasBox(o) ? { x: o.x, y: o.y, w: o.w, h: o.h } : undefined;
  if (o.kind === "widget") return { id: o.id, kind: o.kind, widget: o.widget, ...(box ? { box } : {}), ...(firstLine(o.text) ? { text: firstLine(o.text) } : {}), ...(o.frame ? { frame: o.frame } : {}) };
  return {
    id: o.id, kind: o.kind, form: o.form, box: box!,
    ...(firstLine(o.text ?? o.alt) ? { text: firstLine(o.text ?? o.alt) } : {}), ...(o.image ? { image: o.image.hash } : {}), ...(o.by ? { by: o.by } : {}), ...(o.drawing ? { drawing: o.drawing } : {}), ...(o.frame ? { frame: o.frame } : {}),
  };
}

type AsWriter = Connection & { writesAs?: string };
const VIEW_WRITER = /^view:\S{1,200}$/;

/** The caller, writing as the view it names (`as.writer`): only this computer's own window may, and only as a view. */
function writingAs(from: Connection, as: unknown): Connection {
  if (as === undefined || as === null) return from;
  const writer = (as as { writer?: unknown }).writer;
  if (from.may || typeof writer !== "string" || !VIEW_WRITER.test(writer)) throw new ApiError("FORBIDDEN", "only this computer's window writes as a view, and only as view:<id>");
  return Object.assign(Object.create(from) as AsWriter, { writesAs: writer });
}

const callerOf = (from: Connection): string | undefined => (from.actor.kind === "peer" && from.actor.tile ? toBareId(from.actor.tile) : undefined);

/** Who a connection writes as: an agent by its tile, a program by its grant, a device by its person and device, else the person here. */
function whoOf(from: Connection): string {
  const a = from.actor;
  if (a.kind === "tile") return toBareId(a.tile);
  if (a.kind === "person") return "person";
  if (a.tile) return toBareId(a.tile);
  return a.person === a.device ? a.person : `${a.person}/${a.device}`;
}

/** Where to start looking for room: past what is there, else inside an empty page or frame from its corner. */
function emptyStart(everything: Rect | null, page: Rect | null): Point {
  if (everything) return { x: everything.x + everything.w + 96, y: everything.y };
  return page ? { x: page.x + 48, y: page.y + 48 } : { x: 96, y: 0 };
}

const ALIGNS: readonly AlignHow[] = ["left", "centre", "right", "top", "middle", "bottom", "spread-across", "spread-down"];

/** The boxes with `ids` not inside `page` yet moved into it; null: those inside a page moved out of
 *  every frame. Gathered, they go together near its corner; else they stay where they are on the canvas. */
function intoPage(scene: Scene, board: readonly BoardObject[], ids: readonly string[], page: string | null, gather: boolean): BoardChanges {
  const wanted = new Set(ids);
  const moves = (b: ShapeObject | (WidgetObject & Rect)) => (page === null ? pageOf(scene.records, b.frame) !== null : !isWithin(scene.records, b.frame, page));
  const boxes = board.filter((b): b is ShapeObject | (WidgetObject & Rect) => wanted.has(b.id) && hasBox(b) && !isLocked(b) && moves(b));
  const corner = page ? scene.frames.get(page)! : null;
  const from = boundsOf(boxes);
  const by = corner && from && gather ? { x: corner.x + 48 - from.x, y: corner.y + 48 - from.y } : { x: 0, y: 0 };
  const out: BoardChanges = {};
  for (const b of boxes) {
    const { frame: _was, ...rest } = b;
    out[b.id] = { ...rest, x: b.x + by.x, y: b.y + by.y, ...(page ? { frame: page } : {}) } as BoardObject;
  }
  return out;
}

/** Who changed the board, as the changes feed says it. */
type Author = Pick<BoardChange, "by" | "who">;

/** A caller of this domain: an agent by its tile, a view by its id, else the person. */
function authorOfCaller(from: Connection, writesAs: string | undefined): Author {
  if (writesAs) return { by: "view", who: writesAs.slice("view:".length) };
  const a = from.actor;
  if (a.kind === "tile") return { by: "agent", who: toBareId(a.tile) };
  if (a.kind === "peer" && a.tile) return { by: "agent", who: toBareId(a.tile) };
  return a.kind === "peer" && a.person !== a.device ? { by: "person", who: a.device } : { by: "person" };
}

/** A writer this domain did not make: a window's, a view's, another device's, or the app's own. */
function authorOfWriter(writer: string): Author {
  if (writer === "view") return { by: "view" };
  if (writer.startsWith("view:")) return { by: "view", who: writer.slice("view:".length) };
  if (writer.startsWith("client:")) return { by: "person" };
  if (writer.startsWith("peer:") || writer === "host" || writer.startsWith("host:")) return { by: "person", who: writer };
  return { by: "app", ...(writer ? { who: writer } : {}) };
}

/** Whether a line style said is what is there: dashed said of a dotted line is not a change. */
const sameDash = (said: ShapeDash | undefined, was: ShapeDash | undefined): boolean =>
  said === undefined || said === (was ?? "solid") || (said === "dashed" && was === "dotted");

/** An arrow from `a` to `b` as a drawing's link says it. */
function newArrow(id: string, l: DrawnLink, a: string, b: string, from: Rect, to: Rect, z: number, drawing: string, me: string | undefined): ArrowObject {
  const [fromSide, toSide] = facingSides(from, to);
  const look = l as typeof l & { route?: ArrowRoute; dash?: ShapeDash; weight?: ShapeWeight; tail?: boolean };
  return {
    id, kind: "arrow", label: l.label ?? "", z, from: { id: a, side: fromSide }, to: { id: b, side: toSide }, drawing,
    ...(look.route ? { route: look.route } : {}), ...(look.dash ? { dash: look.dash } : {}), ...(look.weight ? { weight: look.weight } : {}), ...(look.tail ? { tail: true } : {}),
    ...(me ? { by: me } : {}),
  };
}

export function board(o: BoardOptions): Domain<BoardMethod> {
  const repoOf = (v: unknown) => text(v, "repo");
  const writable = (repo: string): WorkspaceStore => {
    if (o.mayWrite && !o.mayWrite(repo)) throw new ApiError("FORBIDDEN", "this workspace's board may not be written here: it was shared with you to view");
    return o.store(repo);
  };
  // Each caller writes as itself (`api:<who>`): a history of its own, which no window's undo takes
  // back, kept across its connections (a `hive ctl` call is one) until idle or crowded out.
  const kept = new Map<string, { used: number; stores: Set<WorkspaceStore>; author: Author }>();
  const forget = (writer: string): void => {
    for (const store of kept.get(writer)!.stores) store.forgetWriter(writer);
    kept.delete(writer);
  };
  const writerOf = (from: Connection, store: WorkspaceStore): string => {
    const writesAs = (from as AsWriter).writesAs;
    const writer = writesAs ?? `api:${whoOf(from)}`;
    const now = Date.now();
    for (const [other, held] of kept) if (other !== writer && now - held.used > WRITER_IDLE_MS) forget(other);
    const held = kept.get(writer) ?? { used: now, stores: new Set<WorkspaceStore>(), author: authorOfCaller(from, writesAs) };
    // Map order is least recently used first.
    kept.delete(writer);
    kept.set(writer, { used: now, stores: held.stores.add(store), author: held.author });
    while (kept.size > MAX_KEPT_WRITERS) forget(kept.keys().next().value!);
    return writer;
  };
  /** Who wrote a change: a caller of this domain as it was known, else by the kind of writer it is. */
  const authorOf = (writer: string): Author => kept.get(writer)?.author ?? authorOfWriter(writer);
  const write = (from: Connection, store: WorkspaceStore, repo: string, objects: Record<string, BoardObject | null>): void => {
    try {
      store.editObjects(repo, { objects }, { writer: writerOf(from, store) });
    } catch (e) {
      throw e instanceof TypeError ? new ApiError("BAD_REQUEST", e.message) : e;
    }
  };
  const meant = (id: string, me: string | undefined): string => (id === "me" && me ? me : toBareId(id));

  const draw = (from: Connection, repoParam: unknown, askedParam: unknown): BoardDrawn => {
    const repo = repoOf(repoParam);
    const store = writable(repo);
    const me = callerOf(from);
    const scene = sceneOf(store, repo);
    const { text: flowchart, page: _page, ...rest } = (askedParam ?? {}) as Record<string, unknown>;
    const updating = typeof rest.update === "string" ? rest.update : null;
    const inUpdated = new Set(updating ? scene.objects.filter((b) => b.kind !== "widget" && b.drawing === updating).map((b) => b.id) : []);
    // A bare node of flowchart text names what is on the board already, unless it is of the drawing updated.
    const onBoard = (id: string): boolean => { const real = meant(id, me); return scene.rects.has(real) && !inUpdated.has(real); };
    let asked: DrawAsked;
    try {
      // Flowchart text stands in for boxes and links; what is said beside it (direction, near, at) wins.
      const imageOf = (hash: string) => o.images?.find(repo, hash) ?? null;
      asked = readDrawAsked(typeof flowchart === "string" ? { ...drawFromText(flowchart, onBoard), ...rest } : askedParam, imageOf);
    } catch (e) {
      throw e instanceof TypeError ? new ApiError("BAD_REQUEST", e.message) : e;
    }
    const pageParam = (askedParam as { page?: unknown } | null)?.page;
    if (asked.update) {
      if (asked.at || asked.near || asked.frame || pageParam !== undefined) throw new ApiError("BAD_REQUEST", "an update keeps the drawing where it is: leave out at, near, frame and page, and move it with `hive ctl board move`");
      return update(from, store, repo, scene, asked, me, asked.update);
    }
    if (asked.keep) throw new ApiError("BAD_REQUEST", "keep goes with an update: `hive ctl draw --update <drawing>`");
    const sketch = sketchOf(asked);

    const onBoardNow = scene.objects.filter((b) => b.kind === "shape").length;
    if (onBoardNow + sketch.shapes.length > MAX_SHAPES_ON_BOARD) {
      throw new ApiError("BAD_REQUEST", `this board holds ${onBoardNow} shapes and takes at most ${MAX_SHAPES_ON_BOARD}: erase some first with \`hive ctl erase\``);
    }

    // Beside what it is drawn near, in that one's frame, on free canvas; the frame it joins grows round it.
    const near = asked.near ? meant(asked.near, me) : me;
    const nearRect = near ? scene.rects.get(near) : undefined;
    if (asked.near && !nearRect) throw new ApiError("NOT_FOUND", `nothing called ${asked.near} is on this board: \`hive ctl board\` lists what is`);
    const nearFrame = near ? (scene.tiles.get(near)?.frame ?? (scene.frames.has(near) ? near : scene.objects.find((b) => b.id === near && b.kind !== "arrow" && b.frame)?.frame)) : undefined;
    const askedPage = pageParam == null ? null : pageAsked(scene, pageParam);
    const found = asked.frame === "none" ? undefined : asked.frame ?? (asked.at ? undefined : (nearFrame as string | undefined));
    // Asked for a page or frame, it goes in the frame found when that is inside it, else in it; asked
    // for none (null), it stays out of every page.
    const frame = pageParam === null ? (found !== undefined && pageOf(scene.records, found) === null ? found : undefined)
      : askedPage === null || asked.frame !== undefined || (found !== undefined && isWithin(scene.records, found, askedPage)) ? found : askedPage;
    if (frame && !scene.frames.has(frame)) throw new ApiError("NOT_FOUND", `no frame ${frame} on this board: \`hive ctl frames\` lists them`);
    if (askedPage !== null && !isWithin(scene.records, frame, askedPage)) throw new ApiError("BAD_REQUEST", `what is drawn inside ${askedPage} is in a frame inside it: leave out frame, or name one inside it`);
    const held = new Set<string>();
    for (let f = frame; f && !held.has(f); f = scene.frames.get(f)?.parent) held.add(f);
    // Clear of what is there: inside the page or frame asked for, else anywhere on the canvas.
    const taken: Rect[] = [...scene.rects].filter(([id]) => !held.has(id) && inside(scene, id, askedPage)).map(([, r]) => r);
    const everything = boundsOf(taken);
    const start = asked.at ?? (nearRect ? { x: nearRect.x + nearRect.w + 48, y: nearRect.y } : emptyStart(everything, askedPage !== null ? scene.frames.get(askedPage)! : null));
    const corner = asked.at ? start : freeCorner(start, sketch.size, taken);
    const origin = frame ? scene.frames.get(frame)! : { x: 0, y: 0 };

    const drawing = mintId("drawing");
    let z = scene.objects.reduce((top, b) => Math.max(top, b.z ?? 0), 0);
    const ids = new Map<string, string>();
    const made: Record<string, BoardObject | null> = {};
    const placed: Array<{ id: string; rect: Rect; text?: string }> = [];
    for (const { box, ...s } of sketch.shapes) {
      const id = mintId("shape");
      if (box) ids.set(box, id);
      const at = { x: corner.x + s.x, y: corner.y + s.y };
      made[id] = {
        ...s, id, kind: "shape", z: ++z, x: at.x - origin.x, y: at.y - origin.y, drawing,
        ...(box ? { key: box } : {}), ...(me ? { by: me } : {}), ...(frame ? { frame } : {}),
      };
      placed.push({ id, rect: { x: at.x, y: at.y, w: s.w, h: s.h } });
    }
    const rectOf = (id: string): Rect | undefined => placed.find((p) => p.id === id)?.rect ?? scene.rects.get(id);
    const endOf = (end: string, link: number): string => {
      const id = ids.get(end) ?? meant(end, me);
      if (!rectOf(id)) throw new ApiError("BAD_REQUEST", `links[${link}] ends on ${end}: no box here and nothing on the board has that id (\`hive ctl board\` lists what does)`);
      return id;
    };
    sketch.links.forEach((l, i) => {
      const [a, b] = [endOf(l.from, i), endOf(l.to, i)];
      if (a === b) return;
      const id = mintId("arrow");
      made[id] = newArrow(id, l, a, b, rectOf(a)!, rectOf(b)!, ++z, drawing, me);
    });
    write(from, store, repo, made);

    const overlaps: BoardDrawn["overlaps"] = [];
    placed.forEach((p, i) => {
      for (const other of placed.slice(i + 1)) if (rectsTouch(p.rect, other.rect)) overlaps.push({ shape: p.id, with: other.id });
      for (const [id, r] of scene.rects) {
        if (!held.has(id) && inside(scene, id, askedPage) && rectsTouch(p.rect, r)) overlaps.push({ shape: p.id, with: id });
      }
    });
    const box = boundsOf(placed.map((p) => p.rect)) ?? { ...corner, w: 0, h: 0 };
    // Checked where it landed on the canvas; its frame grows round it, so being outside that is not looked for.
    const landed = new Map(placed.map((p) => [p.id, p.rect]));
    const drawn = Object.values(made).filter((b): b is BoardObject => b !== null).map((b) => (b.kind === "shape" ? { ...b, ...landed.get(b.id) } : b));
    const problems = drawProblems(drawn, { ends: new Set(scene.rects.keys()) });
    return {
      drawing, objects: Object.keys(made), boxes: Object.fromEntries(ids),
      box, ...(frame ? { frame } : {}), overlaps: overlaps.slice(0, 50), problems,
    };
  };

  /**
   * `asked` as the drawing `drawing` now, in one write: a box found by its key (or its id) keeps its
   * place, its size and what was not said of it; a new box is placed beside what it links to; what
   * is not named is erased, but what the person locked; an arrow is drawn again only where an end
   * is new or grew. Nothing to change writes nothing.
   */
  const update = (from: Connection, store: WorkspaceStore, repo: string, scene: Scene, asked: DrawAsked, me: string | undefined, drawing: string): BoardDrawn => {
    const members = scene.objects.filter((b): b is ShapeObject | ArrowObject => (b.kind === "shape" || b.kind === "arrow") && b.drawing === drawing);
    if (members.length === 0) throw new ApiError("NOT_FOUND", `no drawing ${drawing} on this board: \`hive ctl board\` lists them`);
    const shapes = members.filter((m): m is ShapeObject => m.kind === "shape").sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    const arrows = members.filter((m): m is ArrowObject => m.kind === "arrow");
    const stored = new Map(store.getObjects(repo).map((b) => [b.id, b]));
    const sketch = sketchOf(asked);
    const said = new Map((asked.boxes ?? []).map((b) => [b.id, b]));
    const byKey = new Map<string, ShapeObject>();
    for (const s of shapes) if (s.key && !byKey.has(s.key)) byKey.set(s.key, s);
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const used = new Set<string>();
    const free = (s: ShapeObject | undefined): ShapeObject | undefined => (s && !used.has(s.id) ? s : undefined);
    const keyed = new Map<string, string>();
    /** Where each of the drawing's shapes is after, on the canvas. */
    const final = new Map<string, Rect>();
    const changes: Record<string, BoardObject | null> = {};
    const looks = new Map<string, Record<string, unknown>>();
    const grown = new Set<string>();
    const locked: string[] = [];
    const change = (id: string, patch: Partial<ShapeObject> | Partial<ArrowObject>, drop: readonly string[] = []): void => {
      const base = { ...(changes[id] ?? stored.get(id)), ...patch } as Record<string, unknown>;
      for (const k of drop) delete base[k];
      changes[id] = base as unknown as BoardObject;
      looks.set(id, { ...looks.get(id), ...patch });
    };
    const title = shapes.find(isTitle);
    const fresh: Sketch["shapes"] = [];

    for (const s of sketch.shapes) {
      const was = s.box !== undefined ? free(byKey.get(s.box)) ?? free(byId.get(s.box))
        : asked.title !== undefined && s.form === "text" && s.size === "large" && s.text === asked.title ? free(title) : undefined;
      if (!was) { fresh.push(s); continue; }
      used.add(was.id);
      if (s.box !== undefined) keyed.set(s.box, was.id);
      final.set(was.id, { x: was.x, y: was.y, w: was.w, h: was.h });
      if (was.locked) { locked.push(was.id); continue; }
      const patch: Partial<ShapeObject> = {};
      // Written bare (`web --> new[Box]`), or with no text, a box keeps its words.
      const bare = s.text === s.box || (s.box !== undefined && s.text === "");
      if (s.text !== undefined && !bare && s.text !== (was.text ?? "")) {
        patch.text = s.text;
        if (s.w > was.w || s.h > was.h) {
          Object.assign(patch, { w: Math.max(was.w, s.w), h: Math.max(was.h, s.h) });
          final.set(was.id, { x: was.x, y: was.y, w: patch.w!, h: patch.h! });
          grown.add(was.id);
        }
      }
      const look = s.box !== undefined ? said.get(s.box) : undefined;
      if (look?.form && look.form !== was.form) patch.form = look.form;
      if (look?.color && look.color !== ((was.color as ShapeColor | undefined) ?? "ink")) patch.color = look.color;
      if (look?.filled !== undefined && look.filled !== !!was.filled) patch.filled = look.filled;
      if (!sameDash(look?.dash, was.dash)) patch.dash = look!.dash;
      if (look?.weight && look.weight !== was.weight) patch.weight = look.weight;
      if (look?.rough && !was.rough) patch.rough = true;
      if (look?.image && look.image.hash !== was.image?.hash) Object.assign(patch, { form: "image", image: look.image });
      if (look?.image && look.alt && look.alt !== was.alt) patch.alt = look.alt;
      if (Object.keys(patch).length > 0) change(was.id, patch);
    }
    for (const id of asked.keep ?? []) {
      const s = byId.get(toBareId(id));
      if (!s) {
        if (!arrows.some((a) => a.id === toBareId(id))) throw new ApiError("BAD_REQUEST", `keep names ${id}, which is not in drawing ${drawing}`);
        continue;
      }
      used.add(s.id);
      final.set(s.id, { x: s.x, y: s.y, w: s.w, h: s.h });
    }
    const erased = new Set<string>();
    for (const s of shapes) {
      if (used.has(s.id)) continue;
      if (s.locked) { locked.push(s.id); final.set(s.id, { x: s.x, y: s.y, w: s.w, h: s.h }); continue; }
      changes[s.id] = null;
      erased.add(s.id);
    }
    const onBoardNow = scene.objects.filter((b) => b.kind === "shape").length - erased.size;
    if (onBoardNow + fresh.length > MAX_SHAPES_ON_BOARD) {
      throw new ApiError("BAD_REQUEST", `this board holds ${onBoardNow} shapes and takes at most ${MAX_SHAPES_ON_BOARD}: erase some first with \`hive ctl erase\``);
    }

    // New shapes go in the drawing's frame, clear of what is there.
    const frame = shapes.find((s) => s.frame)?.frame;
    const origin = (frame ? scene.frames.get(frame) : undefined) ?? { x: 0, y: 0 };
    // The frames it is in grow round what is added: they are not in its way.
    const holding = new Set<string>();
    for (let f = frame; f && !holding.has(f); f = scene.frames.get(f)?.parent) holding.add(f);
    const taken: Rect[] = [...scene.rects].filter(([id]) => !erased.has(id) && !final.has(id) && !holding.has(id)).map(([, r]) => r);
    taken.push(...final.values());
    let z = scene.objects.reduce((top, b) => Math.max(top, b.z ?? 0), 0);
    const added: string[] = [];
    const placed = new Map<string, Rect>();
    const place = ({ box: key, ...s }: Sketch["shapes"][number], at: Point): void => {
      const id = mintId("shape");
      changes[id] = {
        ...s, id, kind: "shape", z: ++z, x: at.x - origin.x, y: at.y - origin.y, drawing,
        ...(key !== undefined ? { key } : {}), ...(me ? { by: me } : {}), ...(frame ? { frame } : {}),
      };
      const rect = { x: at.x, y: at.y, w: s.w, h: s.h };
      if (key !== undefined) keyed.set(key, id);
      final.set(id, rect);
      placed.set(id, rect);
      taken.push(rect);
      added.push(id);
    };
    const old = boundsOf(shapes) ?? { x: 0, y: 0, w: 0, h: 0 };
    if (!shapes.some((s) => used.has(s.id) && s !== title)) {
      // Nothing kept: drawn afresh where the drawing was.
      for (const s of fresh) place(s, { x: old.x + s.x, y: old.y + s.y });
    } else {
      const rectOfEnd = (end: string): Rect | undefined => {
        const id = keyed.get(end) ?? meant(end, me);
        return erased.has(id) ? undefined : final.get(id) ?? scene.rects.get(id);
      };
      const down = asked.direction === "down";
      const pending = fresh.filter((s) => s.box !== undefined);
      // Beside what it links to, after what leads to it, before what it leads to; repeated so a chain of new boxes follows on.
      for (let moved = true; moved && pending.length > 0;) {
        moved = false;
        for (const s of [...pending]) {
          let start: Point | undefined;
          // Beside a box of the drawing before anything else it links to.
          const links = [...asked.links ?? []].sort((x, y) => Number(!keyed.has(x.from === s.box ? x.to : x.from)) - Number(!keyed.has(y.from === s.box ? y.to : y.from)));
          for (const l of links) {
            const after = l.to === s.box;
            const other = after ? l.from : l.from === s.box ? l.to : undefined;
            const r = other !== undefined && other !== s.box ? rectOfEnd(other) : undefined;
            if (!r) continue;
            start = down ? { x: r.x, y: after ? r.y + r.h + 72 : r.y - s.h - 72 } : { x: after ? r.x + r.w + 112 : r.x - s.w - 112, y: r.y };
            break;
          }
          if (!start) continue;
          place(s, freeCorner(start, s, taken));
          pending.splice(pending.indexOf(s), 1);
          moved = true;
        }
      }
      for (const s of fresh) {
        if (s.box !== undefined && !pending.includes(s)) continue;
        const all = boundsOf([...final.values()]) ?? old;
        if (s.form === "text" && s.size === "large" && s.text === asked.title) place(s, { x: all.x, y: all.y - 44 });
        else place(s, s.box !== undefined ? freeCorner({ x: all.x + all.w + 112, y: all.y }, s, taken) : { x: old.x + s.x, y: old.y + s.y });
      }
    }

    const rectOf = (id: string): Rect | undefined => final.get(id) ?? scene.rects.get(id);
    const endOf = (end: string, link: number): string => {
      const id = keyed.get(end) ?? meant(end, me);
      if (erased.has(id) || !rectOf(id)) throw new ApiError("BAD_REQUEST", `links[${link}] ends on ${end}: no box here and nothing on the board has that id (\`hive ctl board\` lists what does)`);
      return id;
    };
    const arrowsUsed = new Set<string>();
    sketch.links.forEach((l, i) => {
      const [a, b] = [endOf(l.from, i), endOf(l.to, i)];
      if (a === b) return;
      const was = arrows.find((x) => !arrowsUsed.has(x.id) && x.from.id === a && x.to.id === b);
      if (!was) {
        const id = mintId("arrow");
        changes[id] = newArrow(id, l, a, b, rectOf(a)!, rectOf(b)!, ++z, drawing, me);
        added.push(id);
        return;
      }
      arrowsUsed.add(was.id);
      const look = l as typeof l & { route?: ArrowRoute; dash?: ShapeDash; weight?: ShapeWeight; tail?: boolean };
      const patch: Partial<ArrowObject> = {};
      if ((l.label ?? "") !== was.label) patch.label = l.label ?? "";
      if (!sameDash(look.dash, was.dash)) patch.dash = look.dash;
      if (look.weight && look.weight !== was.weight) patch.weight = look.weight;
      if (look.route && look.route !== (was.route ?? "curve")) patch.route = look.route;
      if (look.tail && !was.tail) patch.tail = true;
      let drop: string[] = [];
      if (placed.has(a) || placed.has(b) || grown.has(a) || grown.has(b)) {
        const [fromSide, toSide] = facingSides(rectOf(a)!, rectOf(b)!);
        if (fromSide !== was.from.side || toSide !== was.to.side || was.fromAt || was.toAt) {
          Object.assign(patch, { from: { ...was.from, side: fromSide }, to: { ...was.to, side: toSide } });
          drop = ["fromAt", "toAt"];
        }
      }
      if (Object.keys(patch).length > 0) change(was.id, patch, drop);
    });
    for (const x of arrows) if (!arrowsUsed.has(x.id) && !(asked.keep ?? []).some((id) => toBareId(id) === x.id)) { changes[x.id] = null; erased.add(x.id); }
    // An arrow goes with what it ended on, whoever drew it.
    for (const b of stored.values()) if (b.kind === "arrow" && !erased.has(b.id) && (erased.has(b.from.id) || erased.has(b.to.id))) { changes[b.id] = null; erased.add(b.id); }

    if (Object.keys(changes).length > 0) write(from, store, repo, changes);

    const after = [...members.filter((m) => !erased.has(m.id)), ...added.map((id) => changes[id]!)]
      .map((b): BoardObject => (placed.has(b.id) ? { ...b, ...placed.get(b.id) } as BoardObject : { ...b, ...looks.get(b.id), ...(final.has(b.id) ? final.get(b.id) : {}) } as BoardObject));
    const overlaps: BoardDrawn["overlaps"] = [];
    for (const [id, r] of placed) {
      for (const [other, o2] of [...placed, ...[...scene.rects].filter(([k]) => !erased.has(k) && !final.has(k) && !holding.has(k))]) {
        if (other !== id && rectsTouch(r, o2) && !overlaps.some((p) => p.shape === other && p.with === id)) overlaps.push({ shape: id, with: other });
      }
    }
    return {
      drawing, objects: after.map((b) => b.id), boxes: Object.fromEntries(keyed),
      box: boundsOf(after.filter(hasBox)) ?? { x: old.x, y: old.y, w: 0, h: 0 }, ...(frame ? { frame } : {}),
      overlaps: overlaps.slice(0, 50), problems: drawProblems(after, { ends: new Set(scene.rects.keys()) }),
      added, changed: [...looks.keys()], erased: [...erased], ...(locked.length ? { locked } : {}),
    };
  };

  const read = (repoParam: unknown, askParam: unknown): BoardReading => {
    const repo = repoOf(repoParam);
    const ask = (askParam ?? {}) as BoardAsk;
    const scene = sceneOf(o.store(repo), repo);
    const page = pageAsked(scene, ask.page);
    const here = (id: string): boolean => inside(scene, id, page);
    const drawn = scene.objects.filter((b) => (b.kind === "shape" || b.kind === "arrow" || hasBox(b)) && here(b.id));
    const groups = new Map<string, Array<ShapeObject | ArrowObject>>();
    for (const b of drawn) if ((b.kind === "shape" || b.kind === "arrow") && b.drawing) groups.set(b.drawing, [...(groups.get(b.drawing) ?? []), b]);
    const limit = typeof ask.limit === "number" && ask.limit >= 0 ? Math.min(ask.limit, MAX_SHAPES_ON_BOARD) : 200;
    const nameOf = endNamer(scene.objects, [...scene.tiles].map(([id, t]) => ({ id, name: t.name })));
    const reading: BoardReading = {
      frames: [...scene.frames].filter(([id]) => here(id)).map(([id, f]) => ({ id, title: f.title, box: { x: f.x, y: f.y, w: f.w, h: f.h }, ...(f.page ? { page: true as const } : {}) })),
      tiles: [...scene.tiles].filter(([id]) => here(id)).map(([id, t]) => ({ id, name: t.name, kind: t.kind, box: { x: t.x, y: t.y, w: t.w, h: t.h }, ...(t.frame ? { frame: t.frame } : {}) })),
      drawings: [...groups].map(([id, members]) => {
        const shapes = members.filter((m): m is ShapeObject => m.kind === "shape");
        return { id, title: drawingName(members, nameOf), ...(members[0]!.by ? { by: members[0]!.by } : {}), box: boundsOf(shapes) ?? { x: 0, y: 0, w: 0, h: 0 }, objects: members.length };
      }),
      objects: drawn.slice(0, limit).map(itemOf),
      ...(drawn.length > limit ? { more: drawn.length - limit } : {}),
    };
    if (ask.check) {
      const frames = new Map<string, Rect>([...scene.frames].filter(([id]) => here(id)));
      reading.problems = drawProblems(scene.objects.filter((b) => here(b.id)), { frames, ends: new Set(scene.rects.keys()) });
    }
    const ids = Array.isArray(ask.ids) ? new Set(ask.ids.map((id) => toBareId(String(id)))) : null;
    const wanted = ask.drawing ?? null;
    if (ids || wanted) {
      // Asked for by id or drawing, they are found on any page.
      reading.full = scene.objects.filter((b): b is ShapeObject | ArrowObject => (b.kind === "shape" || b.kind === "arrow") && (!!ids?.has(b.id) || (wanted !== null && b.drawing === wanted)));
    }
    if (ask.as === "text") {
      const members = wanted === null ? [] : reading.full!.filter((b) => b.drawing === wanted);
      if (members.length === 0) throw new ApiError("NOT_FOUND", `say which drawing to write as text, by its id: no drawing ${String(wanted)} on this board`);
      reading.text = textOfDrawing(members);
    }
    return reading;
  };

  const selected = (repoParam: unknown): BoardSelection => {
    const repo = repoOf(repoParam);
    if (!o.people) throw new ApiError("UNSUPPORTED", "no window here says what is selected");
    const people = o.people(repo);
    if (people.length === 0) return { windows: [] };
    const scene = sceneOf(o.store(repo), repo);
    const objects = new Map(scene.objects.map((b) => [b.id, b]));
    const itemFor = (id: string): BoardItem | null => {
      const b = objects.get(id);
      if (b) return itemOf(b);
      const t = scene.tiles.get(id);
      if (t) return { id, kind: "tile", text: t.name, box: { x: t.x, y: t.y, w: t.w, h: t.h }, ...(t.frame ? { frame: t.frame } : {}) };
      const f = scene.frames.get(id);
      return f ? { id, kind: f.page ? "page" : "frame", text: f.title, box: { x: f.x, y: f.y, w: f.w, h: f.h } } : null;
    };
    return { windows: people.map((p) => ({ window: p.id, person: p.person, name: p.name, selected: p.selection.map(itemFor).filter((i): i is BoardItem => i !== null) })) };
  };

  // The board's changes, kept per workspace from when someone first asks, for whoever asks again
  // after a seq; a follower is told each as it comes. Each change costs one small record.
  const feeds = new Map<string, { seq: number; kept: BoardChange[]; asked: number; followers: Set<Connection> }>();
  let stopHearing: (() => void) | null = null;
  const heard = (change: WorkspaceChange): void => {
    if (change.part !== "board") return;
    const feed = feeds.get(change.repo);
    if (!feed) return;
    const entry: BoardChange = { seq: ++feed.seq, at: Date.now(), ...authorOf(change.writer), objects: change.objects ?? null };
    feed.kept.push(entry);
    if (feed.kept.length > FEED_KEPT) feed.kept.splice(0, feed.kept.length - FEED_KEPT);
    const told: EventMessage = { event: "board.changed", params: [change.repo, entry] };
    for (const c of feed.followers) c.send(told);
    if (feed.followers.size === 0 && entry.at - feed.asked > FEED_IDLE_MS) {
      feeds.delete(change.repo);
      if (feeds.size === 0) { stopHearing?.(); stopHearing = null; }
    }
  };
  const changesSince = (from: Connection, repoParam: unknown, sinceParam: unknown, follow: unknown): BoardChangeFeed => {
    const repo = repoOf(repoParam);
    if (!o.changes) throw new ApiError("UNSUPPORTED", "this host does not keep the board's changes");
    if (sinceParam != null && !(typeof sinceParam === "number" && Number.isInteger(sinceParam) && sinceParam >= 0)) throw new ApiError("BAD_REQUEST", "since is a change's seq, from an earlier answer");
    stopHearing ??= o.changes(heard);
    let feed = feeds.get(repo);
    if (!feed) feeds.set(repo, (feed = { seq: 0, kept: [], asked: 0, followers: new Set() }));
    feed.asked = Date.now();
    if (follow === true) feed.followers.add(from);
    if (sinceParam == null) return { seq: feed.seq, changes: [], erased: [] };
    const since = sinceParam as number;
    const oldest = feed.kept[0]?.seq ?? feed.seq + 1;
    const lost = since > feed.seq || since < oldest - 1;
    const changes = lost ? feed.kept : feed.kept.filter((c) => c.seq > since);
    const named = new Set(changes.flatMap((c) => c.objects ?? []));
    if (named.size > 0) for (const b of o.store(repo).getObjects(repo)) named.delete(b.id);
    return { seq: feed.seq, changes, erased: [...named], ...(lost ? { lost: true as const } : {}) };
  };

  const picture = async (from: Connection, repoParam: unknown, askParam: unknown) => {
    const repo = repoOf(repoParam);
    const ask = (askParam ?? {}) as BoardPictureAsk;
    const scene = sceneOf(o.store(repo), repo);
    const theme: PictureTheme = ask.theme === "light" ? "light" : "dark";
    // One drawing is found wherever it is; else what is drawn inside the page or frame, or everywhere.
    const page = ask.drawing == null ? pageAsked(scene, ask.page) : null;
    const drawn = scene.objects.filter((b): b is ShapeObject | ArrowObject => (b.kind === "shape" || b.kind === "arrow") && (ask.drawing == null ? inside(scene, b.id, page) : b.drawing === ask.drawing));
    if (ask.drawing != null && drawn.length === 0) throw new ApiError("NOT_FOUND", `no drawing ${String(ask.drawing)} on this board: \`hive ctl board\` lists them`);
    // What an arrow ends on, faintly, so a drawing that points at a tile says which.
    const here = new Set(drawn.map((b) => b.id));
    const anchors = new Map<string, PictureAnchor>();
    for (const b of drawn) {
      if (b.kind !== "arrow") continue;
      for (const end of [b.from.id, b.to.id]) {
        const r = scene.rects.get(end);
        if (here.has(end) || !r) continue;
        anchors.set(end, { id: end, ...r, name: scene.tiles.get(end)?.name ?? scene.frames.get(end)?.title ?? "" });
      }
    }
    const pic = boardPicture(drawn, [...anchors.values()], theme, await imagesIn(repo, drawn));
    if (!ask.png) return pic;
    // A window here is asked to draw it: another device's own window can do that with the SVG.
    if (from.actor.kind === "peer" && !from.actor.tile) throw new ApiError("FORBIDDEN", "a PNG is drawn by a window on this machine: ask for the SVG");
    if (!o.png) throw new ApiError("UNSUPPORTED", "no window draws pictures here: ask for the SVG");
    return o.png(pic.svg, pic.width, pic.height);
  };

  /** The pictures among `drawn` as `data:` URLs, front-most first, while they fit the picture's budget. */
  const imagesIn = async (repo: string, drawn: readonly BoardObject[]): Promise<(image: BoardImage) => string | undefined> => {
    const urls = new Map<string, string>();
    let left = PICTURE_IMAGE_BYTES;
    const shown = drawn.filter((b): b is ShapeObject => b.kind === "shape" && b.form === "image" && !!b.image).sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
    for (const s of shown) {
      if (!o.images || urls.has(s.image!.hash)) continue;
      const kept = await o.images.read(repo, s.image!.hash);
      if (!kept || kept.data.length > left) continue;
      left -= kept.data.length;
      urls.set(s.image!.hash, `data:${kept.type};base64,${kept.data}`);
    }
    return (image) => urls.get(image.hash);
  };

  const keepImage = async (from: Connection, repoParam: unknown, given: unknown) => {
    const repo = repoOf(repoParam);
    writable(repo);
    if (!o.images || repo.startsWith("hive://")) throw new ApiError("UNSUPPORTED", "pictures are kept by the workspace's own host: add it from a window showing the workspace");
    return o.images.keep(repo, given);
  };

  const image = async (repoParam: unknown, hashParam: unknown) => {
    const repo = repoOf(repoParam);
    const hash = text(hashParam, "hash");
    const kept = await o.images?.read(repo, hash);
    if (!kept) throw new ApiError("NOT_FOUND", `no picture ${hash} is kept for this board`);
    return kept;
  };

  const erase = (from: Connection, repoParam: unknown, askParam: unknown): { erased: string[]; locked?: string[] } => {
    const me = callerOf(from);
    const repo = repoOf(repoParam);
    const store = writable(repo);
    const ask = (askParam ?? {}) as BoardEraseAsk;
    const ids = Array.isArray(ask.ids) ? new Set(ask.ids.map((id) => toBareId(String(id)))) : new Set<string>();
    const by = typeof ask.by === "string" ? meant(ask.by, me) : null;
    const drawing = typeof ask.drawing === "string" ? ask.drawing : null;
    if (ids.size === 0 && by === null && drawing === null) throw new ApiError("BAD_REQUEST", "say what to erase: ids, a drawing, or by");
    const objects = store.getObjects(repo);
    const scene = ask.page !== undefined ? sceneOf(store, repo) : null;
    const page = scene ? pageAsked(scene, ask.page) : null;
    const matching = objects.filter((b) => (b.kind === "shape" || b.kind === "arrow")
      && (ids.has(b.id) || (drawing !== null && b.drawing === drawing) || (by !== null && b.by === by))
      && (!scene || inside(scene, b.id, page)));
    const locked = matching.filter((b) => b.kind === "shape" && b.locked).map((b) => b.id);
    if (locked.length > 0 && locked.length === matching.length) throw new ApiError("FORBIDDEN", "the person locked that: it stays until they unlock it");
    const chosen = new Set(matching.filter((b) => !locked.includes(b.id)).map((b) => b.id));
    // An arrow goes with what it ended on, on the board as in a window.
    for (const b of objects) if (b.kind === "arrow" && (chosen.has(b.from.id) || chosen.has(b.to.id))) chosen.add(b.id);
    if (chosen.size === 0) throw new ApiError("NOT_FOUND", "nothing drawn matches that: `hive ctl board` lists what is");
    write(from, store, repo, Object.fromEntries([...chosen].map((id) => [id, null])));
    return { erased: [...chosen], ...(locked.length ? { locked } : {}) };
  };

  const change = (from: Connection, repoParam: unknown, askParam: unknown): BoardChanged => {
    const repo = repoOf(repoParam);
    const store = writable(repo);
    const ask = (askParam ?? {}) as Partial<BoardChangeAsk>;
    const ids = new Set(Array.isArray(ask.ids) ? ask.ids.map((id) => toBareId(String(id))) : []);
    if (ids.size === 0) throw new ApiError("BAD_REQUEST", "say what to change: ids of shapes or arrows, or a drawing's id");
    const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T | undefined => {
      if (value === undefined) return undefined;
      if (!(allowed as readonly unknown[]).includes(value)) throw new ApiError("BAD_REQUEST", `${what} must be one of ${allowed.join(", ")}`);
      return value as T;
    };
    const color = oneOf(ask.color, SHAPE_COLORS, "color");
    const dash = oneOf(ask.dash, SHAPE_DASHES, "dash");
    const weight = oneOf(ask.weight, SHAPE_WEIGHTS, "weight");
    const stack = oneOf(ask.stack, ["front", "back"] as const, "stack");
    const align = oneOf(ask.align, ALIGNS, "align");
    const yesOrNo = (value: unknown, what: string): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "boolean") throw new ApiError("BAD_REQUEST", `${what} is true or false`);
      return value;
    };
    const rough = yesOrNo(ask.rough, "rough");
    const locked = yesOrNo(ask.locked, "locked");
    const to = ask.to;
    if (to !== undefined && !(Number.isFinite(to?.x) && Number.isFinite(to?.y))) throw new ApiError("BAD_REQUEST", "to must be {x, y} on the canvas");
    const duplicate = ask.duplicate;
    if (duplicate !== undefined && !(Number.isFinite(duplicate?.dx) && Number.isFinite(duplicate?.dy))) throw new ApiError("BAD_REQUEST", "duplicate must be {dx, dy}: how far from the originals the copies go");
    const movesPage = ask.page !== undefined;
    const restyles = color !== undefined || dash !== undefined || weight !== undefined || rough !== undefined;
    if (!to && !restyles && locked === undefined && !stack && !align && !duplicate && !movesPage) {
      throw new ApiError("BAD_REQUEST", "say what changes: to, color, dash, weight, rough, locked, stack, align, duplicate or page");
    }

    const scene = sceneOf(store, repo);
    const page = movesPage ? pageAsked(scene, ask.page) : null;
    const chosen = scene.objects.filter((b): b is ShapeObject | ArrowObject => (b.kind === "shape" || b.kind === "arrow") && (ids.has(b.id) || (!!b.drawing && ids.has(b.drawing))));
    if (chosen.length === 0) throw new ApiError("NOT_FOUND", "nothing drawn has that id: `hive ctl board` lists what is");
    const chosenIds = chosen.map((b) => b.id);

    // Each action sees the board as the one before left it; what they changed is written as one edit.
    let now: readonly BoardObject[] = scene.objects;
    const changes: BoardChanges = {};
    const apply = (next: BoardChanges): void => {
      if (Object.keys(next).length === 0) return;
      Object.assign(changes, next);
      now = withObjects(now, next);
    };
    if (locked !== undefined) apply(lockObjects(now, chosenIds, locked));
    const byId = new Map(now.map((b) => [b.id, b]));
    const held = chosenIds.filter((id) => isLocked(byId.get(id)!));
    const free = chosenIds.filter((id) => !held.includes(id));
    if (free.length === 0 && locked === undefined && !stack && !duplicate) throw new ApiError("FORBIDDEN", "the person locked that: it stays until they unlock it");
    if (restyles) apply(styleObjects(now, free, { ...(color ? { color } : {}), ...(dash ? { dash } : {}), ...(weight ? { weight } : {}), ...(rough !== undefined ? { rough } : {}) }));
    if (stack) apply(restack(now, chosenIds, stack));
    if (align) apply(alignObjects(now, free, align));
    if (to) {
      if (!free.some((id) => byId.get(id)!.kind === "shape")) throw new ApiError("BAD_REQUEST", "an arrow follows what it ends on: move a shape, or a drawing");
      apply(moveObjects(now, free, to));
    }
    if (movesPage) apply(intoPage(scene, now, free, page, !to));
    let copies: string[] | undefined;
    if (duplicate) {
      let made: BoardChanges;
      try {
        made = duplicateObjects(now, chosenIds, mintId, duplicate.dx, duplicate.dy);
      } catch (e) {
        throw e instanceof TypeError ? new ApiError("BAD_REQUEST", e.message) : e;
      }
      copies = Object.keys(made);
      Object.assign(changes, made);
    }
    const changed = Object.keys(changes).filter((id) => !copies?.includes(id));
    if (Object.keys(changes).length > 0) write(from, store, repo, Object.fromEntries(Object.entries(changes).map(([id, b]) => [id, stored(scene, b)])));
    return { changed, locked: held, ...(copies ? { copies } : {}) };
  };

  const note = async (from: Connection, repoParam: unknown, noteParam: unknown): Promise<BoardComment> => {
    const repo = repoOf(repoParam);
    const asked = (noteParam ?? {}) as BoardNoteAsked;
    const body = text(asked.body, "body").trim();
    if (!body || body.length > 10_000) throw new ApiError("BAD_REQUEST", "body must say something, in at most 10000 characters");
    const me = callerOf(from);
    const on = asked.on == null ? null : meant(text(asked.on, "on"), me);
    const scene = sceneOf(writable(repo), repo);
    if (on && !scene.rects.has(on)) throw new ApiError("NOT_FOUND", `nothing called ${on} is on this board: \`hive ctl board\` lists what is`);
    const at = asked.at;
    if (at != null && !(Number.isFinite(at.x) && Number.isFinite(at.y))) throw new ApiError("BAD_REQUEST", "at must be {x, y}");
    if (!on && at == null) throw new ApiError("BAD_REQUEST", "say where: on something, or at a place on the canvas");
    const what = on ? (scene.tiles.get(on)?.name ?? scene.frames.get(on)?.title ?? firstLine((scene.objects.find((b) => b.id === on) as ShapeObject | undefined)?.text)) : "";
    const root = await reviewRoot(repo);
    const author = me ? (o.agentName?.(me) ?? "agent") : PERSON_AUTHOR;
    const comment = await addComment(root, {
      body, author, board: { ...(on ? { on } : {}), x: at?.x ?? 0, y: at?.y ?? 0, ...(what ? { what } : {}) },
    });
    o.notesChanged?.(repo, path.join(repo, ".hivemind", REVIEW_FILE));
    return comment as BoardComment;
  };

  const pageList = (repoParam: unknown): { pages: PageListing[] } => {
    const repo = repoOf(repoParam);
    const scene = sceneOf(o.store(repo), repo);
    const pages = [...scene.frames].filter(([, f]) => f.page).map(([id, f]) => ({
      id, title: f.title, parent: pageOf(scene.records, f.parent),
      objects: scene.objects.filter((b) => inside(scene, b.id, id)).length,
      tiles: (scene.core?.tiles ?? []).filter((t) => inside(scene, t.id, id)).length,
    }));
    return { pages };
  };

  const pageNew = (from: Connection, repoParam: unknown, askParam: unknown): { id: string } => {
    const repo = repoOf(repoParam);
    const store = writable(repo);
    const ask = (askParam ?? {}) as Partial<PageNewAsk>;
    const title = text(ask.title, "title").trim();
    if (!title || title.length > 200) throw new ApiError("BAD_REQUEST", "a page's title says something, in at most 200 characters");
    const at = ask.at;
    if (at != null && !(Number.isFinite(at.x) && Number.isFinite(at.y))) throw new ApiError("BAD_REQUEST", "at must be {x, y} on the canvas");
    const scene = sceneOf(store, repo);
    const parent = pageAsked(scene, ask.in);
    const taken = [...scene.rects].filter(([id]) => inside(scene, id, parent)).map(([, r]) => r);
    const holder = parent ? scene.frames.get(parent)! : null;
    const everything = boundsOf(taken);
    const start = emptyStart(everything, holder);
    const corner = at ?? freeCorner(start, NEW_PAGE, taken);
    const id = mintId("frame");
    const frame = { id, title, page: true, ...(parent ? { parentFrameId: parent } : {}), x: corner.x, y: corner.y, ...NEW_PAGE } as FrameRecord;
    store.addFrame(repo, frame, { writer: writerOf(from, store) });
    return { id };
  };

  const step = (from: Connection, repoParam: unknown, back: boolean): boolean => {
    const repo = repoOf(repoParam);
    const store = writable(repo);
    const writer = writerOf(from, store);
    return back ? store.undo(repo, { writer }) : store.redo(repo, { writer });
  };

  return {
    answers: {
      "board.undo": (from, repo, as) => ({ undone: step(writingAs(from, as), repo, true) }),
      "board.redo": (from, repo, as) => ({ redone: step(writingAs(from, as), repo, false) }),
      "page.list": (_from, repo) => pageList(repo),
      "page.new": (from, repo, ask) => pageNew(from, repo, ask),
      "page.open": async (_from, repoParam, target) => {
        const repo = repoOf(repoParam);
        if (!o.openPage) throw new ApiError("UNSUPPORTED", "no window here to go inside a page");
        const page = pageAsked(sceneOf(o.store(repo), repo), target);
        await o.openPage(repo, page);
        return null;
      },
      "board.draw": (from, repo, asked, as) => draw(writingAs(from, as), repo, asked),
      "board.read": (_from, repo, ask) => read(repo, ask),
      "board.selected": (_from, repo) => selected(repo),
      "board.changes": (from, repo, since, follow) => changesSince(from, repo, since, follow),
      "board.picture": (from, repo, ask) => picture(from, repo, ask),
      "board.keepImage": (from, repo, given) => keepImage(from, repo, given),
      "board.image": (_from, repo, hash) => image(repo, hash),
      "board.erase": (from, repo, ask, as) => erase(writingAs(from, as), repo, ask),
      "board.change": (from, repo, ask, as) => change(writingAs(from, as), repo, ask),
      "board.note": (from, repo, asked) => note(from, repo, asked),
      "board.show": async (_from, repoParam, target) => {
        const repo = repoOf(repoParam);
        if (!o.show) throw new ApiError("UNSUPPORTED", "no window shows the board here");
        const id = text(target, "target");
        const scene = sceneOf(o.store(repo), repo);
        const members = scene.objects.filter((b): b is ShapeObject => b.kind === "shape" && b.drawing === id);
        const box = boundsOf(members) ?? scene.rects.get(toBareId(id));
        if (!box) throw new ApiError("NOT_FOUND", `no drawing or object ${id} on this board: \`hive ctl board\` lists them`);
        await o.show(repo, box);
        return null;
      },
    },
    effects: {
      "board.draw": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.erase": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.change": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.note": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.keepImage": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.undo": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "board.redo": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
      "page.new": (repo) => ({ target: typeof repo === "string" ? repo : undefined }),
    },
    gone: (connection) => {
      for (const feed of feeds.values()) feed.followers.delete(connection);
    },
  };
}
