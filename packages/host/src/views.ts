/**
 * Community views on a remote screen, the person's phone among them (P8,
 * docs/design/phone-app-2026-10-02.md §6.1; spec/workspace-api.md, "Views on a remote screen"): the
 * views installed here that say they work on a phone, their files as the app serves them (the SDK
 * and the page for a `.js` entry among them, each under its policy), and a view opened on a
 * workspace here for one caller, on its screen. Its host (`@hivemind/view-host/link`) runs here, as
 * the window's runs there, fed from what this device holds: the board from the store, statuses and
 * links from the control plane, a selection of its own; the screen's size and look from the caller
 * (`view.open`, `view.screen`). What the view posts comes in as `view.post`; what its host says
 * goes to that caller alone as `view.said`, until `view.close`, until the caller goes, or until the
 * host disables the view (`view.ended`, and why). The view may do what its manifest asks and its
 * caller may call (`Connection.may`): on a phone, what a phone may. A remote screen places no live
 * surfaces, has no folder picker nor share sheet, and starts no tile but an agent's.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { cleanName, spawnableAgents, agentForCmd } from "@hivemind/agents";
import type { SessionStatus } from "@hivemind/agent-host/status-store";
import { tileStatusOf } from "@hivemind/agent-host/tile-status";
import { isRemote, machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import { pageOf, serveViewFile } from "@hivemind/core/view-files";
import type { InstalledView } from "@hivemind/core/views";
import type { ViewManifest } from "@hivemind/view-sdk/manifest";
import { PROTOCOL_VERSION, STATUS_TONES, type ViewFrameMachine, type ViewPermission, type ViewTheme } from "@hivemind/view-sdk/protocol";
import { CommunityLink, type LinkCommands } from "@hivemind/view-host/link";
import { viewAgentStatus } from "@hivemind/view-host/status";
import { viewStructure } from "@hivemind/view-host/structure";
import { AGENT_TILE_KIND, type TileRecord } from "@hivemind/workspace-doc/shapes";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import type { Links, StatusChange } from "@hivemind/workspace-api/agents";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { ViewFile, ViewListing, ViewScreen } from "@hivemind/workspace-api/views";
import type { Intent, Intents } from "@hivemind/workspace-host/intents";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";

/** The largest file of a view's a remote screen is sent. */
const FILE_MAX = 4 * 1024 * 1024;
/** What a remote screen is (`hello.device`, protocol 1.5): a finger on a phone's screen. */
const DEVICE = { touch: true, compact: true };
/** A screen its caller says nothing of (0.12): no size, and no look of its own to give the view. */
const UNSAID: ViewScreen = { w: 0, h: 0, theme: { colors: {} } };
/** The widest and tallest screen, in CSS pixels. */
const SCREEN_MAX = 100_000;
/** Who a view's renames are written as. */
const WRITER = { writer: "view" };
/** Each permission a view on a remote screen is served, and the call whose rules decide it for the
 *  caller: the view does nothing its caller could not. A prompt the view writes and a past session
 *  it continues ask the person at this computer, so neither is served. */
const SERVED: Partial<Record<ViewPermission, string>> = {
  "workspace:spawn": "agent.start",
  "workspace:close": "agent.close",
  "workspace:edit": "store.setCore",
};

export interface ViewsOptions {
  /** The views installed on this device. */
  installed(): Promise<InstalledView[]>;
  /** The view SDK this device serves its views (`__sdk.js`), its windows' and a remote screen's. */
  sdk(): Promise<string>;
  /** The workspaces here: the boards a view shows, where it renames a tile. */
  store(): Pick<WorkspaceStore, "getCore" | "renameTile">;
  /** Whose events say what changes: the boards, the agents' statuses and the links between them. */
  server(): Pick<WorkspaceServer, "connect">;
  /** An agent's status now. */
  status(tile: string): SessionStatus | undefined;
  /** The links between agents now. */
  links(): Links;
  /** Start an agent in the workspace at `repo` as `agent.start` does (no program: the person's
   *  default): its tile. */
  start(repo: string, start: { program?: string; frame?: string; name?: string }): Promise<string>;
  /** End a tile's session and take it off its board, as `agent.close` does: false when no board here has it. */
  close(tile: string): Promise<boolean>;
  /** The machines this device knows, by what each is called. */
  machines: KnownMachines;
  /** How this device's link to the machine a frame's folder is on is doing; none: not known here. */
  linkState?(folder: string): ViewFrameMachine["state"];
  intents: Pick<Intents, "perform">;
  onWarn(message: string): void;
}

/** One view open on a remote screen. */
interface Session {
  id: string;
  view: string;
  repo: string;
  from: Connection;
  capabilities: ViewPermission[];
  link: CommunityLink;
  /** The tiles and frames on its board, and what each agent there said it is doing, as it was
   *  last told. */
  tiles: Set<string>;
  frames: Set<string>;
  titles: Record<string, string>;
  selection: { tileId: string | null; frameId: string | null };
  /** What the view was last told of its board, as sent. */
  told: { structure: string; names: string };
  /** The screen it is shown on now, as its caller last said. */
  screen: ViewScreen;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const COLOR = /^#[0-9a-f]{6}$/i;
const TOKEN = /^[a-z0-9-]{1,40}$/;

/** The look a remote screen gives views, as its caller says it, checked here once and kept to what
 *  the protocol's theme has: its colours (`#rrggbb`, by token), and, when said, its mode, accent,
 *  corner radius, fonts, surface and terminal colours, glass, and a colour for each status tone. */
function themeOf(raw: unknown): ViewTheme {
  const bad = (why: string) => new ApiError("BAD_REQUEST", `screen.theme: ${why}`);
  if (!isObject(raw)) throw bad("not an object");
  const color = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !COLOR.test(v)) throw bad(`${what} is not a colour #rrggbb`);
    return v.toLowerCase();
  };
  if (!isObject(raw.colors)) throw bad("colors is not an object");
  const colors = Object.fromEntries(Object.entries(raw.colors).map(([token, v]) => {
    if (!TOKEN.test(token)) throw bad(`${token} is not a colour token`);
    return [token, color(v, `colors.${token}`)];
  }));
  const theme: ViewTheme = { colors };
  if (raw.mode !== undefined) {
    if (raw.mode !== "dark" && raw.mode !== "light") throw bad("mode is dark or light");
    theme.mode = raw.mode;
  }
  if (raw.accent !== undefined) theme.accent = color(raw.accent, "accent");
  if (raw.radius !== undefined) {
    if (typeof raw.radius !== "number" || !(raw.radius >= 0 && raw.radius <= 100)) throw bad("radius is 0 to 100 pixels");
    theme.radius = raw.radius;
  }
  if (raw.fonts !== undefined) {
    const font = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[;{}<>]/.test(v);
    if (!isObject(raw.fonts) || !font(raw.fonts.ui) || !font(raw.fonts.mono)) throw bad("fonts are {ui, mono}, each a font family");
    theme.fonts = { ui: raw.fonts.ui as string, mono: raw.fonts.mono as string };
  }
  if (raw.surface !== undefined) theme.surface = color(raw.surface, "surface");
  if (raw.terminalBackground !== undefined) theme.terminalBackground = color(raw.terminalBackground, "terminalBackground");
  if (raw.glass !== undefined) {
    if (typeof raw.glass !== "boolean") throw bad("glass is true or false");
    theme.glass = raw.glass;
  }
  if (raw.status !== undefined) {
    if (!isObject(raw.status)) throw bad("status is not an object");
    const status = raw.status;
    theme.status = Object.fromEntries(STATUS_TONES.filter((tone) => status[tone] !== undefined).map((tone) => [tone, color(status[tone], `status.${tone}`)]));
  }
  return theme;
}

/** The screen a view is shown on, as its caller says it (`view.open`, `view.screen`): its size in
 *  whole CSS pixels, and its look. Checked here once; anything else is refused. */
function screenOf(raw: unknown): ViewScreen {
  if (!isObject(raw)) throw new ApiError("BAD_REQUEST", "screen: not an object");
  const size = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= SCREEN_MAX;
  if (!size(raw.w) || !size(raw.h)) throw new ApiError("BAD_REQUEST", "screen: w and h are whole numbers of pixels");
  return { w: raw.w, h: raw.h, theme: themeOf(raw.theme) };
}

/** A frame's colour as `#rrggbb`, from what a window saves (frame-color.ts): `oklch(L C H)`, or the
 *  hex the person picked. A device has no CSS engine: anything else is the window's own fallback. */
function frameHex(css: unknown): string {
  if (typeof css !== "string") return "#8899aa";
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toLowerCase()}`;
  const ok = css.trim().match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i);
  if (!ok) return "#8899aa";
  // OKLCH → OKLab → linear sRGB (Björn Ottosson's matrices), each channel clipped to the gamut.
  const L = Number(ok[1]) / (ok[2] ? 100 : 1);
  const C = Number(ok[3]) * (ok[4] ? 0.4 / 100 : 1);
  const h = (Number(ok[5]) * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  };
  return `#${linear.map(channel).join("")}`;
}

/** The agent a tile runs, its catalog id, as the window reads it. */
const agentOf = (t: TileRecord): string | undefined => (t.kind === AGENT_TILE_KIND ? agentForCmd(t.cmd)?.id : undefined);

export function views(o: ViewsOptions): Domain<"view.list" | "view.file" | "view.open" | "view.close", "view.post" | "view.screen"> {
  /** Each caller's sessions, by id; and every session open, for what this device hears. */
  const opened = new WeakMap<Connection, Map<string, Session>>();
  const live = new Set<Session>();
  /** Who follows each tile's status: the views shown it, through their links. */
  const watching = new Map<string, Set<(s: SessionStatus) => void>>();
  let listening = false;

  const phoneViews = async (): Promise<Array<InstalledView & { manifest: ViewManifest }>> =>
    (await o.installed()).filter((v): v is InstalledView & { manifest: ViewManifest } => !v.error && v.manifest?.phone === true);
  const viewNamed = async (id: unknown) => {
    const name = text(id, "view");
    const view = (await phoneViews()).find((v) => v.id === name);
    if (!view) throw new ApiError("BAD_REQUEST", `no view ${name} here works on a phone`);
    return view;
  };

  /** Follow `tile`'s status: `l` is handed it now, when there is one, then each change, until stopped. */
  const watch = (tile: string, l: (s: SessionStatus) => void): (() => void) => {
    let set = watching.get(tile);
    if (!set) watching.set(tile, (set = new Set()));
    set.add(l);
    const now = o.status(tile);
    if (now) l(now);
    return () => {
      set!.delete(l);
      if (set!.size === 0) watching.delete(tile);
    };
  };

  /** Hear what changes what a view is told, once the first is opened. */
  const listen = (): void => {
    if (listening) return;
    listening = true;
    o.server().connect({
      actor: { kind: "person" },
      send: (e) => {
        if (e.event === "status.changed") {
          const change = e.params[0] as StatusChange;
          for (const l of [...(watching.get(change.tileId) ?? [])]) l(change.status);
          // What an agent says it is doing names its tile.
          for (const s of live) if (s.tiles.has(change.tileId) && s.titles[change.tileId] !== change.status.title) tell(s);
        } else if (e.event === "store.changed") {
          const { repo, part } = e.params[0] as { repo: string; part: string };
          if (part === "core") for (const s of live) if (s.repo === repo) tell(s);
        } else if (e.event === "link.pipe" || e.event === "link.spawn") {
          for (const s of live) tell(s);
        }
      },
      closed: new AbortController().signal,
    });
  };

  /** Change what `s`'s view has selected, and tell it, once it is ready. */
  const select = (s: Session, change: Partial<Session["selection"]>): void => {
    const next = { ...s.selection, ...change };
    if (next.tileId === s.selection.tileId && next.frameId === s.selection.frameId) return;
    s.selection = next;
    if (s.link.stats.ready) s.link.send({ type: "selection", ...next, fresh: true });
  };

  /** Tell `s`'s view what its board holds now, what it has not heard yet: its structure and its
   *  names; and that what it had selected is gone. Before it is ready, only remember the board. */
  const tell = (s: Session): void => {
    const core = o.store().getCore(s.repo) ?? { frames: [], tiles: [] };
    const tiles = new Set(core.tiles.map((t) => t.id));
    for (const id of s.tiles) if (!tiles.has(id)) s.link.dropTile(id);
    s.tiles = tiles;
    s.frames = new Set(core.frames.map((f) => f.id));
    if (!s.link.stats.ready) return;
    const titles: Record<string, string> = {};
    for (const t of core.tiles) {
      const title = o.status(t.id)?.title;
      if (title) titles[t.id] = title;
    }
    s.titles = titles;
    const names = Object.fromEntries(core.tiles.map((t) => [t.id, tileName(core.tileNames ?? {}, titles, t)]));
    const structure = viewStructure({
      frames: core.frames, tiles: core.tiles, frameOf: core.frameOf ?? {},
      name: (t) => names[t.id], agent: agentOf, links: o.links(),
      color: (f) => frameHex((f as { color?: unknown }).color),
      machine: (f) => (f.workspacePath && isRemote(f.workspacePath)
        ? { name: machineCalled(f.workspacePath, o.machines), state: o.linkState?.(f.workspacePath) ?? "idle" }
        : undefined),
    });
    const told = { structure: JSON.stringify(structure), names: JSON.stringify(names) };
    if (told.structure !== s.told.structure) s.link.send(structure);
    if (told.names !== s.told.names) s.link.send({ type: "names", names });
    s.told = told;
    select(s, {
      ...(s.selection.tileId !== null && !s.tiles.has(s.selection.tileId) ? { tileId: null } : {}),
      ...(s.selection.frameId !== null && !s.frames.has(s.selection.frameId) ? { frameId: null } : {}),
    });
  };

  /** The view is ready: tell it where it is, then all it shows. */
  const hello = (s: Session): void => {
    // Its look and size are the screen's, as its caller says them; no saved layout from here.
    s.link.send({
      type: "hello", v: PROTOCOL_VERSION, pluginId: s.view, capabilities: s.capabilities, theme: s.screen.theme,
      layout: null, viewport: { w: s.screen.w, h: s.screen.h }, visible: true, features: s.link.features, device: DEVICE,
    });
    tell(s);
    s.link.send({ type: "selection", ...s.selection, fresh: false });
  };

  /** Carry out what `s`'s view asked as its caller, recorded as the view's. */
  const act = <R>(s: Session, intent: Omit<Intent<R>, "detail">, run: () => Promise<R>): void => {
    o.intents.perform(s.from.actor, { ...intent, detail: `view ${s.view}` }, run).catch((e: unknown) =>
      o.onWarn(`view "${s.view}": ${intent.verb} failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  /** What `s`'s view may ask of the workspace, from here: no tile but an agent's, no frame, no folder picker. */
  const commandsOf = (s: Session): LinkCommands => ({
    selectTile: (id) => select(s, { tileId: id }),
    selectFrame: (id) => select(s, { frameId: id }),
    // There is nothing to bring the tile into but the view: as other views do, it is selected.
    focusTile: (id) => select(s, { tileId: id }),
    closeTile: (id) => act(s, { verb: "agent.close", target: id }, () => o.close(id)),
    spawnClaude: () => act(s, { verb: "agent.start", target: (tile: string) => tile }, () => o.start(s.repo, {})),
    spawnAgent: (agent, frame, opts) => {
      if (agent !== null && !spawnableAgents().some((d) => d.id === agent)) return false;
      const want = { ...(agent ? { program: agent } : {}), ...(frame ? { frame } : {}), ...(opts?.name ? { name: opts.name } : {}) };
      act(s, { verb: "agent.start", target: (tile: string) => tile }, () => o.start(s.repo, want));
      return true;
    },
    renameTile: (id, name) => { o.store().renameTile(id, cleanName(name), WRITER); },
    subscribeTileStatus: (tile, cb) => watch(tile, (status) => cb(tileStatusOf(status).status)),
  });

  /** `s` ends: closed by its caller, its caller gone, or its view disabled (`why`, which it is told). */
  const end = (s: Session, why?: string): void => {
    if (!live.delete(s)) return;
    opened.get(s.from)?.delete(s.id);
    s.link.dispose();
    if (why !== undefined) s.from.send({ event: "view.ended", params: [s.id, why] });
  };

  const sessionOf = (from: Connection, session: unknown): Session | undefined => opened.get(from)?.get(text(session, "session"));

  return {
    answers: {
      "view.list": async (): Promise<ViewListing[]> =>
        (await phoneViews()).map(({ id, manifest: m }) => ({ id, name: m.name, version: m.version, entry: m.entry, page: pageOf(m.entry) })),
      "view.file": async (_from, id, at): Promise<ViewFile> => {
        const view = await viewNamed(id);
        const rel = text(at, "path");
        // As the app serves its windows, but for the page that runs a `.js` entry: that entry is the manifest's.
        const entry = view.manifest.entry;
        const file = await serveViewFile(view.dir, rel, { js: entry, sdk: o.sdk });
        if (file.status === 400) throw new ApiError("BAD_REQUEST", `${view.id} has no ${rel}: its entry, ${entry}, is a page`);
        if (file.status !== 200) throw new ApiError("BAD_REQUEST", file.status === 403 ? `${rel} is not inside ${view.id}` : `${view.id} has no file ${rel}`);
        if ("file" in file && (await stat(file.file)).size > FILE_MAX) throw new ApiError("BAD_REQUEST", `${rel} is larger than 4 MiB`);
        const data = "text" in file ? Buffer.from(file.text) : await readFile(file.file);
        if (data.length > FILE_MAX) throw new ApiError("BAD_REQUEST", `${rel} is larger than 4 MiB`);
        return { data: data.toString("base64"), type: file.type, csp: file.csp };
      },
      "view.open": async (from, id, workspace, screen, surfaces) => {
        const view = await viewNamed(id);
        const repo = text(workspace, "workspace");
        const shown = screen == null ? UNSAID : screenOf(screen);
        if (surfaces != null && typeof surfaces !== "boolean") throw new ApiError("BAD_REQUEST", "surfaces is true or false");
        if (!o.store().getCore(repo)) throw new ApiError("BAD_REQUEST", "no such workspace here");
        if (view.manifest.protocol > PROTOCOL_VERSION) {
          throw new ApiError("BAD_REQUEST", `${view.id} speaks view protocol ${view.manifest.protocol}, and this device ${PROTOCOL_VERSION}`);
        }
        const capabilities = view.manifest.permissions.filter((p) => {
          const method = SERVED[p];
          return method !== undefined && (from.may?.(method) ?? true);
        });
        const s = {
          id: randomUUID(), view: view.id, repo, from, capabilities, tiles: new Set(), frames: new Set(), titles: {},
          selection: { tileId: null, frameId: null }, told: { structure: "", names: "" }, screen: shown,
        } as Omit<Session, "link"> as Session;
        s.link = new CommunityLink({
          pluginId: view.id,
          capabilities,
          commands: commandsOf(s),
          hasTile: (tile) => s.tiles.has(tile),
          hasFrame: (frame) => s.frames.has(frame),
          onReady: () => hello(s),
          // A screen that places live surfaces itself (0.15: a phone's app, over the view's web
          // view) is said to; the rects are its own, and nothing here draws them.
          ...(surfaces === true ? { onSurfaceRects: () => {} } : {}),
          // A remote screen keeps no layout here, and its frames are its own.
          onLayout: () => {},
          onFramesDrawn: () => {},
          onError: (message) => o.onWarn(`view "${view.id}" on a remote screen: ${message}`),
          onDisable: (why) => end(s, why),
          services: { agentStatus: (tile, cb) => watch(tile, (status) => cb(viewAgentStatus(status))) },
        });
        s.link.attach({ postMessage: (message) => from.send({ event: "view.said", params: [s.id, message] }), onmessage: null });
        let mine = opened.get(from);
        if (!mine) opened.set(from, (mine = new Map()));
        mine.set(s.id, s);
        live.add(s);
        listen();
        tell(s);
        return { session: s.id };
      },
      "view.close": (from, session) => {
        const s = sessionOf(from, session);
        if (s) end(s);
        return { closed: s !== undefined };
      },
    },
    effects: {},
    notices: {
      "view.post": (from, session, message) => {
        const s = sessionOf(from, session);
        if (!s) throw new ApiError("BAD_REQUEST", "no such view session");
        s.link.handle(message);
      },
      // The screen changed: a ready view is told what did, as the window tells its iframe; one not
      // ready yet is told it all in `hello`.
      "view.screen": (from, session, screen) => {
        const s = sessionOf(from, session);
        if (!s) throw new ApiError("BAD_REQUEST", "no such view session");
        const [was, now] = [s.screen, screenOf(screen)];
        s.screen = now;
        if (!s.link.stats.ready) return;
        if (now.w !== was.w || now.h !== was.h) s.link.send({ type: "resize", w: now.w, h: now.h });
        if (JSON.stringify(now.theme) !== JSON.stringify(was.theme)) s.link.send({ type: "theme", theme: now.theme });
      },
    },
    gone: (connection) => {
      for (const s of [...(opened.get(connection)?.values() ?? [])]) end(s);
      opened.delete(connection);
    },
  };
}
