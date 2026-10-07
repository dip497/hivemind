/**
 * The API a widget's code is given, as the global `hive`: the code that defines it (run before the
 * widget's own, in a worker, by the app's window or by `hive host`), and its type declarations,
 * for an author's editor (`hive widgets new` writes them beside the widget). One owner, so what
 * the declarations say is what runs.
 */

/** Run first in a widget's worker: defines `hive` over the messages its runner sends and takes. */
export const WIDGET_PRELUDE = `const hive = (() => {
  const on = {}; let state; let options = {}; let spot = { x: 1, y: 0 }; let agents = [];
  const waiting = new Map(); let asks = 0;
  const ask = (verb, args) => new Promise((resolve, reject) => {
    const req = ++asks; waiting.set(req, { resolve, reject });
    postMessage({ type: "act", req, verb, args });
  });
  const fire = (t, p) => (on[t] || []).forEach((f) => { try { f(p); } catch (e) { console.error(e); } });
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") { state = m.state; options = m.options; }
    if (m.type === "options") options = m.payload;
    if (m.type === "agents") agents = m.payload;
    if (m.type === "acted") { const w = waiting.get(m.req); waiting.delete(m.req); if (w) m.ok ? w.resolve(m.result) : w.reject(new Error(m.error)); return; }
    fire(m.type === "init" ? "start" : m.type, m.type === "options" ? options : m.payload);
  };
  return {
    render: (tree) => postMessage({ type: "render", tree }),
    /** Move the card to (x, y), each 0 to 1 across the screen (y: "bottom" is the bottom edge),
     *  over \`over\` ms. Every viewer animates it. */
    moveTo: (to, how) => {
      const x = Math.min(1, Math.max(0, Number(to && to.x) || 0));
      const y = to && to.y === "bottom" ? 1 : to && to.y === "top" ? 0 : Math.min(1, Math.max(0, Number(to && to.y) || 0));
      spot = { x, y };
      postMessage({ type: "move", x, y, over: Math.min(60000, Math.max(0, Number(how && how.over) || 0)) });
    },
    get spot() { return spot; },
    /** The workspace: its agents, and what the widget may do there (as its manifest asked). */
    workspace: {
      agents: () => agents,
      focus: (tile) => ask("focus", [tile]),
      spawn: (agent, opts) => ask("spawn", [agent ?? null, opts ?? {}]),
      prompt: (tile, text) => ask("prompt", [tile, text]),
      close: (tile) => ask("close", [tile]),
    },
    get state() { return state; },
    get options() { return options; },
    setState: (s) => { state = s; postMessage({ type: "state", state: s }); },
    notify: (text) => postMessage({ type: "notify", text: String(text) }),
    on: (t, f) => { (on[t] = on[t] || []).push(f); },
  };
})();
`;

/** `hive`'s declarations, as a file an editor reads (`hive.d.ts`). */
export const WIDGET_TYPES = `// The API a Hivemind widget's code is given. Written by \`hive widgets new\`; not loaded at run time.

/** Something to draw. The app draws it in the theme; a widget never draws pixels itself. */
type Node =
  | { type: "stack"; children: Node[]; fill?: boolean; tint?: string }
  | { type: "row"; children: Node[] }
  | { type: "text"; text: string | number; size?: "large"; muted?: boolean }
  | { type: "number"; value: number | string; label?: string }
  | { type: "meter"; value: number; max?: number; label?: string }
  | { type: "button"; label: string; action: unknown }
  /** An image from the widget's folder, by file name. */
  | { type: "image"; src: string; w?: number; h?: number; label?: string }
  /** A row of frames from a sprite sheet in the widget's folder, played at \`fps\`. */
  | { type: "sprite"; src: string; frameW: number; frameH: number; frames?: number; fps?: number; row?: number; scale?: number; flip?: boolean; pixelated?: boolean; label?: string }
  /** Text everyone in the workspace can write in at once: the widget's own \`text\`. */
  | { type: "input" | "textarea"; placeholder?: string; size?: "large" }
  /** Lines to tick, add and reorder: the widget's own \`items\`. */
  | { type: "list"; title?: boolean; placeholder?: string };

/** An agent in the workspace, as \`hive.workspace.agents()\` and the \`agents\` event give it. */
interface Agent {
  tile: string;
  agent: string;
  program?: { id: string; label: string };
  state: string;
  since: number;
  machine: string;
  waiting?: { kind: string; since: number };
}

/** What happened to an agent: it came, went, ended a turn, started waiting, was answered. */
interface AgentEvent { seq: number; at: number; kind: "came" | "went" | "turnEnded" | "waiting" | "answered"; tile: string; detail?: string }

interface Hive {
  /** Draw this. Every viewer of the workspace sees it. */
  render(tree: Node): void;
  /** Move the card to (x, y), each 0 to 1 across the screen, over \`over\` ms. Every viewer animates it. */
  moveTo(to: { x: number; y: number | "top" | "bottom" }, how?: { over?: number }): void;
  readonly spot: { x: number; y: number };
  /** What it keeps: saved with the workspace, shared with everyone in it. */
  readonly state: any;
  setState(state: unknown): void;
  /** What the person set it to, as its widget.json's \`options\` declare. */
  readonly options: Record<string, string | number | boolean>;
  /** A desktop notification on the machine that runs it. */
  notify(text: string): void;
  /** The workspace. Starting, closing or telling an agent something needs the permission in widget.json. */
  workspace: {
    agents(): Agent[];
    focus(tile: string): Promise<null>;
    /** Start an agent (null: the person's default); a \`prompt\` is sent only once the person agrees. */
    spawn(agent: string | null, opts?: { frame?: string; prompt?: string }): Promise<{ started: boolean }>;
    /** Tell an agent something; the person sends or cancels it first. */
    prompt(tile: string, text: string): Promise<{ sent: boolean }>;
    close(tile: string): Promise<null>;
  };
  on(event: "start", f: () => void): void;
  /** A button was pressed: its \`action\`. */
  on(event: "action", f: (action: any) => void): void;
  /** The card was clicked, not on a button. */
  on(event: "click", f: () => void): void;
  on(event: "options", f: (options: Record<string, string | number | boolean>) => void): void;
  on(event: "agents", f: (agents: Agent[]) => void): void;
  on(event: "agent", f: (event: AgentEvent) => void): void;
}

declare const hive: Hive;
`;
