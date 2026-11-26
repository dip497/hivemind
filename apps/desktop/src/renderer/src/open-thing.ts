/**
 * The window's one way to open a link or a path, whoever asks: a terminal's click, a view, a tool,
 * `hive ctl open`. `openerFor` decides where; this checks the file is there and opens it there.
 */
import { openerFor, type Opener } from "@hivemind/core/opener";
import type { LinksSettings } from "@hivemind/core/settings-schema";
import { isRemote, withoutTrailingSlashes } from "@hivemind/core/remote-uri";
import type { OpenedThing } from "@hivemind/workspace-api/opener";

export interface OpenThingDeps {
  links(): LinksSettings;
  /** The folder of a frame (null: the workspace's), else null. */
  folderOf(frameId: string | null): string | null;
  /** Every folder a file may be opened from: the workspace's and its frames'. */
  folders(): string[];
  /** The frame whose folder this is (null: the workspace's own), else undefined. */
  frameFor(folder: string): string | null | undefined;
  /** Each opens in the frame's tile, starting one there when it has none: its id. */
  openUrl(frameId: string | null, url: string): string | null;
  openFile(frameId: string | null, path: string, at?: { line: number; col?: number }): string | null;
  openImage(frameId: string | null, path: string): string | null;
  /** Ask the person about a kind of link (`link-ask.tsx`), and keep an "always". */
  ask(scheme: string, url: string): Promise<"once" | "always" | "cancel">;
  allowAlways(scheme: string): void;
}

/** Where it is asked from: a frame, and the folder a relative path is read from (a terminal's). */
export interface OpenFrom {
  frameId: string | null;
  cwd?: string | null;
  /** The person's own click, which may ask them and may open a path on this computer outside the
   *  workspace; an agent's, a view's or a tool's is refused instead. */
  person?: boolean;
  /** What opens when `thing` does not: the part on the clicked line of a path that runs on to the next. */
  orElse?: string;
}

const coded = (code: "UNSUPPORTED" | "NOT_FOUND", message: string, quiet = false) => Object.assign(new Error(message), { code, quiet });

/** Hand a link to the system: through main in the app, a new tab on the browser page, which says when it is blocked. */
async function sendOutside(url: string): Promise<void> {
  if (window.hive.openLinkOutside) {
    const r = await window.hive.openLinkOutside(url);
    if (!r.ok) throw coded("UNSUPPORTED", `not opened: ${r.error ?? "refused"}`);
    return;
  }
  // Without `noopener`, which makes even an opened tab answer null; the opener is cut by hand.
  const tab = window.open(url, "_blank");
  if (tab) { tab.opener = null; return; }
  if (!url.startsWith("mailto:")) throw coded("UNSUPPORTED", "not opened: this browser blocked the new tab; allow pop-ups for this page");
}

export function makeOpenThing(d: OpenThingDeps) {
  return async function openThing(thing: string, from: OpenFrom): Promise<OpenedThing> {
    if (!from.orElse) return openOne(thing, from);
    try {
      return await openOne(thing, from);
    } catch (e) {
      if ((e as { quiet?: boolean }).quiet) throw e;
      return openOne(from.orElse, from);
    }
  };

  async function openOne(written: string, from: OpenFrom): Promise<OpenedThing> {
    const thing = from.person && written.startsWith("~/") ? await fromHome(written) : written;
    const folders = d.folders();
    const o = openerFor({ thing, cwd: from.cwd ?? d.folderOf(from.frameId), folders, person: from.person }, d.links());
    if (o.to === "ask" && o.scheme && o.url && from.person) {
      const answer = await d.ask(o.scheme, o.url);
      if (answer === "cancel") throw coded("UNSUPPORTED", "not opened", true);
      if (answer === "always") d.allowAlways(o.scheme);
      await sendOutside(o.url);
      return { to: "system-browser", url: o.url };
    }
    if (o.to === "ask") throw coded("UNSUPPORTED", `not opened: ${o.why}`);
    if (o.to === "browser-tile") return withTile(o, d.openUrl(from.frameId, o.url));
    if (o.to === "system-browser") {
      await sendOutside(o.url);
      return o;
    }
    const folder = folderHolding(o.path, folders);
    if (!folder && from.person && !isRemote(o.path)) return openOutside(o, from.frameId);
    const rel = folder ? o.path.slice(withoutTrailingSlashes(folder).length + 1) : o.path;
    const here = folder && !isRemote(folder) ? await window.hive.fileStat(folder, rel || ".").catch(() => null) : { kind: "file" as const, size: 0 };
    if (!here) throw coded("NOT_FOUND", `nothing at ${o.path}`);
    if (here.kind === "folder" || o.to === "os") {
      const r = folder ? await window.hive.openPathInApp?.(folder, o.path) : { ok: false, error: "no workspace" };
      if (!r?.ok) throw coded("UNSUPPORTED", `not opened: ${r?.error ?? "this app cannot hand files to others here"}`);
      return { to: "os", path: o.path };
    }
    // A file of another frame's folder (the main checkout, seen from a worktree) opens in that frame.
    const asked = d.folderOf(from.frameId);
    const owner = folder && withoutTrailingSlashes(folder) !== (asked && withoutTrailingSlashes(asked)) ? d.frameFor(folder) : undefined;
    const frameId = owner === undefined ? from.frameId : owner;
    if (o.to === "image") return withTile(o, d.openImage(frameId, o.path));
    // The Code tile keeps a frame's files by their path in its folder: one file, one tab. Its column counts from 0.
    const inFrame = d.folderOf(frameId);
    const path = inFrame && o.path.startsWith(`${withoutTrailingSlashes(inFrame)}/`) ? o.path.slice(withoutTrailingSlashes(inFrame).length + 1) : o.path;
    const at = o.line ? { line: o.line, ...(o.col ? { col: o.col - 1 } : {}) } : undefined;
    return withTile(o, d.openFile(frameId, path, at));
  }

  /** A path outside the workspace the person clicked, by its real path: a text file in the frame's
   *  Code tile, a picture in the Image tile, a folder or another viewable file in the system's app.
   *  Main reads, saves and hands on only a path opened here. */
  async function openOutside(o: Extract<Opener, { path: string }>, frameId: string | null): Promise<OpenedThing> {
    const opens = window.hive.personOpensOutside;
    if (!opens) throw coded("UNSUPPORTED", `not opened: outside the workspace: ${o.path}`);
    const at = await opens(o.path).catch(() => null);
    if (!at) throw coded("NOT_FOUND", `nothing at ${o.path}`);
    if (at.kind === "file" && o.to === "image") return withTile({ to: "image", path: at.path }, d.openImage(frameId, at.path));
    if (at.kind === "file" && o.to === "code") {
      const where = o.line ? { line: o.line, ...(o.col ? { col: o.col - 1 } : {}) } : undefined;
      return withTile({ ...o, path: at.path }, d.openFile(frameId, at.path, where));
    }
    const r = await window.hive.openOutsideInApp?.(at.path);
    if (!r?.ok) throw coded("UNSUPPORTED", `not opened: ${r?.error ?? `outside the workspace: ${at.path}`}`);
    return { to: "os", path: at.path };
  }
}

/** `~/a.ts:3` with home's real path for `~`, its line kept; as asked where nothing tells home. */
async function fromHome(asked: string): Promise<string> {
  const stat = window.hive.outsideFileStat;
  if (!stat) return asked;
  const line = /:\d+(?::\d+)?$/.exec(asked);
  const bare = line ? asked.slice(0, line.index) : asked;
  const at = await stat(bare).catch(() => null);
  if (!at) throw coded("NOT_FOUND", `nothing at ${bare}`);
  return `${at.path}${line?.[0] ?? ""}`;
}

const withTile = <T extends object>(o: T, tile: string | null): T & { tile?: string } => (tile ? { ...o, tile } : o);

/** The deepest folder that holds `path`. */
function folderHolding(path: string, folders: readonly string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    const base = withoutTrailingSlashes(f);
    if ((path === base || path.startsWith(`${base}/`)) && (!best || base.length > best.length)) best = base;
  }
  return best;
}
