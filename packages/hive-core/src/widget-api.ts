/**
 * The API a widget's code is given, as the global `hive`: the code that defines it (run before the
 * widget's own, in a worker, by the app's window or by `hive host`), and its type declarations,
 * for an author's editor (`hive plugins new widget` writes them beside the widget). One owner, so what
 * the declarations say is what runs.
 *
 * What it reads of the workspace and does there is `hive.hm`: the client a view and a tool's tile
 * have (`@hivemind/view-sdk`), held in the window and reached from the worker by message. Its
 * calls return promises; one given a callback returns its unsubscribe at once.
 */

import { CLIENT_VALUES_UNTIL_KNOWN } from "@hivemind/view-sdk/protocol";

/** Run first in a widget's worker: defines `hive` over the messages its runner sends and takes. */
export const WIDGET_PRELUDE = `const hive = (() => {
  const on = {}; let state; let options = {}; let spot = { x: 1, y: 0 }; let still = false;
  // hive.hm: each call goes to the client the window holds for this widget, by name.
  const waiting = new Map(); const fns = new Map(); let n = 0; let values = ${JSON.stringify(CLIENT_VALUES_UNTIL_KNOWN)};
  const call = (path, args) => {
    const req = ++n; let sub = false;
    const wire = args.map((a) => { if (typeof a !== "function") return a; sub = true; const id = ++n; fns.set(id, a); return { __fn: id }; });
    postMessage({ type: "hm-call", req, path, args: wire });
    if (sub) return () => postMessage({ type: "hm-unsub", req });
    return new Promise((resolve, reject) => waiting.set(req, { resolve, reject }));
  };
  const commands = new Proxy({}, { get: (_, name) => (...a) => call(["commands", String(name)], a) });
  const issues = new Proxy({}, { get: (_, name) => (...a) => call(["issues", String(name)], a) });
  // Not a promise, nor anything a symbol names: \`await hive.hm\` and logging it stay plain.
  const hm = new Proxy({}, { get: (_, k) => (typeof k !== "string" || k === "then" ? undefined : k === "commands" ? commands : k === "issues" ? issues : k in values ? values[k] : (...a) => call([k], a)) });
  const fire = (t, p) => (on[t] || []).forEach((f) => { try { f(p); } catch (e) { console.error(e); } });
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") { state = m.state; options = m.options; still = m.reducedMotion === true; }
    if (m.type === "motion") still = m.payload === true;
    if (m.type === "options") options = m.payload;
    if (m.type === "hm-values") { values = m.values; fire("hm"); return; }
    if (m.type === "hm-reply") { const w = waiting.get(m.req); waiting.delete(m.req); if (w) m.ok ? w.resolve(m.value) : w.reject(new Error(m.error)); return; }
    if (m.type === "hm-cb" && !m.answer) { const f = fns.get(m.fn); if (f) try { f(...m.args); } catch (e) { console.error(e); } return; }
    // A callback asked for its answer (a command's handler): what it returns, or why it failed.
    if (m.type === "hm-cb") {
      const f = fns.get(m.fn);
      const send = (r) => { try { postMessage({ type: "hm-answer", answer: m.answer, ...r }); } catch (e) { postMessage({ type: "hm-answer", answer: m.answer, ok: false, error: "its answer is not JSON" }); } };
      Promise.resolve().then(() => { if (!f) throw new Error("it is gone"); return f(...m.args); })
        .then((value) => send({ ok: true, value: value === undefined ? null : value }), (e) => send({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
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
    /** The person asked for less motion: draw it still and do not move its card. */
    get reducedMotion() { return still; },
    hm,
    get state() { return state; },
    get options() { return options; },
    setState: (s) => { state = s; postMessage({ type: "state", state: s }); },
    notify: (text) => postMessage({ type: "notify", text: String(text) }),
    on: (t, f) => { (on[t] = on[t] || []).push(f); },
  };
})();
`;

/** `hive`'s declarations, as a file an editor reads (`hive.d.ts`). */
export const WIDGET_TYPES = `// The API a Hivemind widget's code is given. Written by \`hive plugins new widget\`; not loaded at run time.

/** Something to draw. The app draws it in the theme; a widget never draws pixels itself. */
type Node =
  /** \`tint\` on the outermost stack colours the card as a note (\`yellow\`, \`pink\`, \`blue\`…). */
  | { type: "stack"; children: Node[]; fill?: boolean; tint?: string }
  | { type: "row"; children: Node[] }
  /** One line, cut short with … when too long, unless \`wrap\`: then whole, on as many lines as it needs. */
  | { type: "text"; text: string | number; size?: "large"; muted?: boolean; wrap?: boolean }
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

/** \`hive.hm\`: the client a view has (\`@hivemind/view-sdk\` ViewClient), reached from the
 *  worker. Its values (\`hello\`, \`settings\`, \`capabilities\`, \`features\`…) are there to read
 *  from the first line of code: empty (\`[]\`, \`{}\`, \`hello\` null) until the window sends them,
 *  when \`hive.on("hm")\` fires. Every call returns a promise, and one given a callback returns its
 *  unsubscribe at once. */
interface Hm {
  readonly hello: any;
  readonly capabilities: readonly string[];
  readonly features: readonly string[];
  readonly settings: Record<string, string | number | boolean | string[]>;
  /** The workspace's frames and tiles (\`structure\`), their names, what is selected. */
  on(event: "structure" | "names" | "selection" | "settings" | "theme", cb: (payload: any) => void): () => void;
  /** An agent tile's status, now and on each change, with what it is doing (\`info.agent\`). */
  subscribeStatus(tileId: string, cb: (status: string, info?: any) => void): () => void;
  /** What happens: a turn ended, an agent needs input, a tile closed. */
  onEvents(kinds: string[], cb: (event: any) => void): () => void;
  supports(feature: string): Promise<boolean>;
  agents(): Promise<any[]>;
  /** Tell an agent something; the person sends or cancels it. Needs "workspace:prompt". */
  prompt(tileId: string, text: string): Promise<"sent" | "cancelled">;
  commands: {
    focusTile(id: string): Promise<void>;
    selectTile(id: string | null): Promise<void>;
    /** Needs "workspace:close". */
    closeTile(id: string): Promise<void>;
    /** Start an agent (null: the person's default) in a frame (null: the host picks). Needs
     *  "workspace:spawn"; a \`prompt\` also "workspace:prompt", and the person sends or cancels it. */
    spawnAgent(agent: string | null, frameId: string | null, opts?: { prompt?: string; name?: string }): Promise<void>;
    [name: string]: (...args: any[]) => Promise<unknown>;
  };
  /** The workspace's issues, now and on each change. Needs "workspace:issues". */
  onIssues(cb: (issues: IssueSummary[]) => void): () => void;
  /** Its issue methods (\`read\`, \`create\`, \`update\`, \`setState\`, \`comment\`, \`delete\`, \`link\`,
   *  \`unlink\`, \`move\`). Need "workspace:issues". */
  issues: { read(id: string): Promise<Issue>; [call: string]: (...args: any[]) => Promise<any> };
  /** Answer the command \`name\` your widget.json declares when an agent runs it
   *  (\`hive ctl plugin call\`): what the handler returns is the agent's answer. */
  onCommand(name: string, handler: (args: any) => unknown): () => void;
  [name: string]: any;
}

/** Who an issue is given to: an agent or a person, by id. Not text: show \`assignee.id\`. */
interface Assignee { type: "agent" | "member"; id: string; model?: string }
interface IssueSummary {
  id: string;
  title: string;
  state: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
  parent: string | null;
  labels: string[];
  assignee: Assignee | null;
  github?: number | null;
  created: string;
  updated: string;
}
/** One issue read in full: its sections as written in its Markdown file. */
interface Issue extends IssueSummary {
  links?: { id: string; type: string }[];
  sections: {
    description: string;
    acceptanceCriteria: { done: boolean; text: string }[];
    activity: { at: string; who: string; message: string }[];
  };
}

interface Hive {
  /** Draw this. Every viewer of the workspace sees it. */
  render(tree: Node): void;
  /** Move the card to (x, y), each 0 to 1 across the screen, over \`over\` ms. Every viewer animates it. */
  moveTo(to: { x: number; y: number | "top" | "bottom" }, how?: { over?: number }): void;
  readonly spot: { x: number; y: number };
  /** The person asked their system for less motion: hold still, and do not move the card. */
  readonly reducedMotion: boolean;
  /** What it keeps: saved with the workspace, shared with everyone in it. */
  readonly state: any;
  setState(state: unknown): void;
  /** What the person set it to, as its widget.json's \`options\` declare. */
  readonly options: Record<string, string | number | boolean | string[]>;
  /** A desktop notification on the machine that runs it. */
  notify(text: string): void;
  /** The workspace, as a view sees it, held to the permissions in widget.json. */
  readonly hm: Hm;
  on(event: "start", f: () => void): void;
  /** A button was pressed: its \`action\`. */
  on(event: "action", f: (action: any) => void): void;
  /** The card was clicked, not on a button. */
  on(event: "click", f: () => void): void;
  on(event: "options", f: (options: Record<string, string | number | boolean | string[]>) => void): void;
  /** Reduced motion was turned on or off: \`hive.reducedMotion\` is now \`reduced\`. */
  on(event: "motion", f: (reduced: boolean) => void): void;
  /** \`hive.hm\`'s values arrived from the window, or changed (its settings). */
  on(event: "hm", f: () => void): void;
}

declare const hive: Hive;
`;

/** Every node type a widget may draw: the \`Node\` above, each drawn by the app. */
export const WIDGET_NODE_TYPES = ["stack", "row", "text", "number", "meter", "button", "image", "sprite", "input", "textarea", "list"] as const;

/** Why \`tree\` cannot be drawn whole: its first node of a type the app does not draw, or null. */
export function drawingProblem(tree: unknown, at = "the tree", depth = 0): string | null {
  if (tree === null || tree === undefined || depth > 8) return null;
  if (typeof tree !== "object" || Array.isArray(tree)) return `${at} is not a node: write { type: "text", text: "…" }`;
  const { type, children } = tree as { type?: unknown; children?: unknown };
  if (!(WIDGET_NODE_TYPES as readonly unknown[]).includes(type)) {
    return `${at} is ${typeof type === "string" ? `a "${type}"` : "a node with no type"}, which the app does not draw; it draws: ${WIDGET_NODE_TYPES.join(", ")}`;
  }
  if (!Array.isArray(children)) return null;
  for (let i = 0; i < children.length && i < 50; i++) {
    const why = drawingProblem(children[i], `${at === "the tree" ? "" : `${at}.`}children[${i}]`.replace(/^\./, ""), depth + 1);
    if (why) return why;
  }
  return null;
}

