/**
 * A host for a view's own tests (protocol 1.5): no app and no window. It hands the view its port and
 * `hello`, sends what the test scripts, and checks everything the view sends as the app does
 * (`parsePluginMessage`, then `refusal`), keeping it for the test to read.
 *
 *   import { fakeHost } from "@hivemind/view-sdk/testing";
 *
 *   const host = fakeHost({ capabilities: ["workspace:spawn"], device: { touch: true, compact: true } });
 *   const hm = await host.connect();              // or host.handshake(window) before the page's connect()
 *   host.send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
 *   await host.settle();
 *   host.rects;     // the live surfaces the view asked for
 *   host.refused;   // what the app would have refused, and why: [] for a view that behaves
 *
 * What it does not do is the app's: start tiles, or refuse a kind of tile the app cannot spawn.
 */
import { connect, type ViewClient } from "./client.js";
import {
  PORT_HANDSHAKE, PROTOCOL_VERSION, VIEW_FEATURES, parsePluginMessage, refusal,
  type CommandName, type HostMessage, type HostScope, type PluginMessage, type RequestErrorCode, type SurfaceRect,
  type ViewDevice, type ViewEventKind, type ViewFeature, type ViewPermission, type ViewRect, type ViewTheme,
} from "./protocol.js";

type Request = Extract<PluginMessage, { type: "request" }>;
export type RequestName = Request["name"];
/** What a view asked with a request of this name. */
export type RequestArgs<N extends RequestName> = Extract<Request, { name: N }>["args"][0];

export interface FakeHostOptions {
  pluginId?: string;
  /** The permissions the manifest was granted. Default: none. */
  capabilities?: ViewPermission[];
  /** What the host wired. Default: every feature there is. */
  features?: ViewFeature[];
  /** Default: a desktop's, no touch and not compact. */
  device?: ViewDevice;
  theme?: ViewTheme;
  /** The layout the view saved last time, back in `hello.layout`. */
  layout?: unknown;
  viewport?: { w: number; h: number };
  visible?: boolean;
  /** The result for each request, by name; one not given is answered `UNSUPPORTED`. A throw is
   *  answered as an error, with the thrown `code` if it has one. */
  answers?: { [N in RequestName]?: (args: RequestArgs<N>) => unknown };
}

export interface FakeHost {
  /** Every message from the view that parsed, in order. */
  readonly received: readonly PluginMessage[];
  /** Why the app would have refused what it refused, in order. Enough of these disable a view. */
  readonly refused: readonly string[];
  /** The commands the app would have run. */
  readonly commands: readonly { name: CommandName; args: unknown[] }[];
  /** Where the view last asked for live surfaces, of tiles that are there. */
  readonly rects: readonly SurfaceRect[];
  /** The view's last saved layout; undefined before it saves one. */
  readonly layout: unknown;
  /** What the view listens to now. */
  readonly subscribed: {
    readonly status: ReadonlySet<string>;
    readonly events: { kinds: ViewEventKind[]; custom: string[] } | null;
    readonly activity: readonly string[];
    readonly presence: boolean;
    readonly participants: boolean;
  };
  /** A client of this host, as `connect()` gives a view. */
  connect(opts?: { timeoutMs?: number }): Promise<ViewClient>;
  /** Hand the port to a page that calls `connect()` itself, on `target` (its window). */
  handshake(target: EventTarget): void;
  /** Tell the view something. A `structure` also says which tiles and frames are there. */
  send(msg: HostMessage): void;
  /** Ask the view where a tile is, as the app does to show one. */
  reveal(tileId: string): Promise<ViewRect | null>;
  /** Resolves once what is in flight has crossed, both ways. */
  settle(): Promise<void>;
  close(): void;
}

const DESKTOP: ViewDevice = { touch: false, compact: false };
const THEME: ViewTheme = { colors: { bg: "#101114", bg2: "#17181c", fg: "#e6e6e6", fg3: "#8a8f98", brand: "#6d9eff", ok: "#3fb950", warn: "#d29922", err: "#f85149" }, mode: "dark" };

export function fakeHost(opts: FakeHostOptions = {}): FakeHost {
  const channel = new MessageChannel();
  const port = channel.port1;
  const capabilities = opts.capabilities ?? [];
  const features = opts.features ?? [...VIEW_FEATURES];
  let tiles = new Set<string>();
  let frames = new Set<string>();
  const announced = new Set<string>();
  const scope: HostScope = { capabilities, features, hasTile: (id) => tiles.has(id), hasFrame: (id) => frames.has(id), announced: (id) => announced.has(id) };
  const received: PluginMessage[] = [];
  const refused: string[] = [];
  const commands: { name: CommandName; args: unknown[] }[] = [];
  const status = new Set<string>();
  const reveals = new Map<number, (rect: ViewRect | null) => void>();
  let nextReveal = 1;
  let ready = false;
  const host = {
    received, refused, commands,
    rects: [] as SurfaceRect[],
    layout: undefined as unknown,
    subscribed: { status, events: null as { kinds: ViewEventKind[]; custom: string[] } | null, activity: [] as string[], presence: false, participants: false },
  };
  const post = (msg: HostMessage) => port.postMessage(msg);
  const answer = async (m: Request) => {
    const fail = (code: RequestErrorCode, message: string) => post({ type: "response", requestId: m.requestId, ok: false, error: { code, message } });
    const give = opts.answers?.[m.name] as ((args: unknown) => unknown) | undefined;
    if (!give) return fail("UNSUPPORTED", `this host does not answer ${m.name}`);
    try {
      post({ type: "response", requestId: m.requestId, ok: true, result: await give(m.args[0]) });
    } catch (e) {
      const code = (e as { code?: RequestErrorCode }).code;
      fail(code ?? "INTERNAL", e instanceof Error ? e.message : String(e));
    }
  };

  port.onmessage = (e) => {
    const r = parsePluginMessage(e.data);
    if (!r.ok) { refused.push(r.reason); return; }
    const m = r.msg;
    received.push(m);
    if (!ready) {
      if (m.type !== "ready") { refused.push(`${m.type} before ready`); return; }
      if (m.v !== PROTOCOL_VERSION) { refused.push(`protocol version ${m.v} is not supported (host speaks ${PROTOCOL_VERSION})`); return; }
      ready = true;
      post({
        type: "hello", v: PROTOCOL_VERSION, pluginId: opts.pluginId ?? "test-view", capabilities, theme: opts.theme ?? THEME,
        layout: opts.layout ?? null, viewport: opts.viewport ?? { w: 1280, h: 800 }, visible: opts.visible ?? true, features, device: opts.device ?? DESKTOP,
      });
      return;
    }
    if (m.type === "ready") { refused.push("duplicate ready"); return; }
    const no = refusal(m, scope);
    if (no) {
      refused.push(no.why);
      if (!no.partly) return;
    }
    const s = host.subscribed;
    switch (m.type) {
      case "command": commands.push({ name: m.name, args: m.args }); return;
      case "subscribeStatus": status.add(m.tileId); return;
      case "unsubscribeStatus": status.delete(m.tileId); return;
      case "surfaceRects": host.rects = m.rects.filter((rect) => tiles.has(rect.tileId)); return;
      case "revealed": {
        const done = reveals.get(m.requestId);
        if (!done) { refused.push(`revealed: unknown requestId ${m.requestId}`); return; }
        reveals.delete(m.requestId);
        done(m.rect);
        return;
      }
      case "layout": host.layout = m.data; return;
      case "subscribeEvents": s.events = { kinds: m.kinds, custom: m.custom ?? [] }; return;
      case "unsubscribeEvents": s.events = null; return;
      case "watchActivity": s.activity = m.tileIds.filter((id) => tiles.has(id)); return;
      case "subscribePresence": s.presence = true; return;
      case "unsubscribePresence": s.presence = false; return;
      case "subscribeParticipants": s.participants = true; return;
      case "unsubscribeParticipants": s.participants = false; return;
      case "request": void answer(m); return;
      default: return;
    }
  };
  port.start();

  const handshake = (target: EventTarget) => {
    target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [channel.port2] }));
  };

  return Object.assign(host, {
    connect: (o: { timeoutMs?: number } = {}) => {
      const target = new EventTarget();
      const client = connect({ target: target as unknown as Window, timeoutMs: o.timeoutMs ?? 2000 });
      handshake(target);
      return client;
    },
    handshake,
    send: (msg: HostMessage) => {
      if (msg.type === "structure") {
        tiles = new Set(msg.tiles.map((t) => t.id));
        frames = new Set(msg.frames.map((f) => f.id));
        for (const id of tiles) announced.add(id);
      }
      post(msg);
    },
    reveal: (tileId: string) => new Promise<ViewRect | null>((resolve) => {
      const requestId = nextReveal++;
      reveals.set(requestId, resolve);
      post({ type: "reveal", requestId, tileId });
    }),
    settle: async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); },
    close: () => { port.onmessage = null; port.close(); },
  });
}
