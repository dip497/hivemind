/**
 * The screen worker: every session's headless terminal, on a thread of its own, so parsing a flood
 * or serializing a long scrollback never holds the daemon's I/O thread (docs/design/daemon-screens-2026-10-17.md).
 * Started by `ScreenThread` in pty-session-manager.ts; speaks `ToScreens` / `FromScreens`.
 */
import { parentPort } from "node:worker_threads";
// Namespace import: bundlers disagree on whether these expose `.default` or named ESM exports.
import * as HeadlessXtermNS from "@xterm/headless";
import * as SerializeAddonNS from "@xterm/addon-serialize";
// Type imports only: run from source, a worker gets no loader that maps `./x.js` to `./x.ts`.
import type { FromScreens, ToScreens } from "./screen-messages.js";

type HeadlessCtor = typeof import("@xterm/headless").Terminal;
type SerializeCtor = typeof import("@xterm/addon-serialize").SerializeAddon;
const pick = <T>(ns: unknown, name: string): T => {
  const m = ns as Record<string, unknown> & { default?: Record<string, unknown> };
  return (m[name] ?? m.default?.[name] ?? m.default) as T;
};
const Terminal = pick<HeadlessCtor>(HeadlessXtermNS, "Terminal");
const SerializeAddon = pick<SerializeCtor>(SerializeAddonNS, "SerializeAddon");

/**
 * What a reattach's replay loses about the mouse. `SerializeAddon` writes the tracking mode an app
 * turned on (`?1003h`) but not how it asked for the coordinates to be encoded. An app that asked for
 * SGR (`?1006h`) is then answered in the original 1978 encoding, which it does not parse: its
 * screen keeps updating and its keyboard works, and nothing happens when you click or scroll.
 * Sent after the screen so the client's terminal reports the way the app expects.
 */
function mouseEncodingSeq(term: InstanceType<HeadlessCtor>): string {
  const t = term as unknown as { modes: { mouseTrackingMode: string }; _core?: { coreMouseService?: { activeEncoding?: string } } };
  if (t.modes.mouseTrackingMode === "none") return "";
  switch (t._core?.coreMouseService?.activeEncoding) {
    case "SGR": return "\x1b[?1006h";
    case "SGR_PIXELS": return "\x1b[?1016h";
    default: return "";
  }
}

interface Screen {
  id: string;
  /** The session instance it belongs to: what it tells main is dropped when another holds the id. */
  epoch: string;
  term: InstanceType<HeadlessCtor>;
  serializer: InstanceType<SerializeCtor>;
  /** Output position the terminal has taken in, within its session. */
  parsed: number;
  paste: boolean;
  /** The last screen serialized, given again while no output or resize changed it. */
  last?: { at: number; lines: number; text: string };
}

const port = parentPort!;
const screens = new Map<string, Screen>();
const post = (m: FromScreens) => port.postMessage(m);

// Progress is told once per turn for every session that moved, not once per chunk.
const moved = new Set<Screen>();
let telling = false;
function tellParsed(s: Screen): void {
  moved.add(s);
  if (telling) return;
  telling = true;
  setImmediate(() => {
    telling = false;
    const at = [...moved].map((m): [string, string, number] => [m.id, m.epoch, m.parsed]);
    moved.clear();
    post({ t: "parsed", at });
  });
}

/** Ends a terminal once what was asked of it before is answered. */
function close(id: string): void {
  const s = screens.get(id);
  if (!s) return;
  screens.delete(id);
  inTurn(s, () => s.term.dispose());
}

/** The terminal of session instance `epoch`, if it still holds the id. */
function current(id: string, epoch: string): Screen | undefined {
  const s = screens.get(id);
  return s?.epoch === epoch ? s : undefined;
}

function open(m: Extract<ToScreens, { t: "open" }>): void {
  close(m.id);
  const term = new Terminal({ cols: m.cols, rows: m.rows, scrollback: m.scrollback, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const s: Screen = { id: m.id, epoch: m.epoch, term, serializer, parsed: m.parsed, paste: false };
  screens.set(m.id, s);
  term.onTitleChange((title) => post({ t: "title", id: s.id, epoch: s.epoch, title }));
  if (m.seed) write(s, m.seed, m.parsed);
}

function write(s: Screen, data: string, end: number): void {
  s.term.write(data, () => {
    s.parsed = end;
    const paste = s.term.modes.bracketedPasteMode;
    if (paste !== s.paste) { s.paste = paste; post({ t: "paste", id: s.id, epoch: s.epoch, on: paste }); }
    tellParsed(s);
  });
}

/** Run `then` once the terminal has taken in everything sent before it: a resize, a screen, the
 *  rows or its end keep their place among the session's output. */
function inTurn(s: Screen, then: () => void): void {
  s.term.write("", then);
}

function screenOf(s: Screen, lines: number): string {
  const kept = s.last;
  if (kept && kept.at === s.parsed && kept.lines === lines) return kept.text;
  const text = s.serializer.serialize({ scrollback: lines });
  s.last = { at: s.parsed, lines, text };
  return text;
}

function visibleRows(s: Screen): string {
  const buf = s.term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < s.term.rows; y++) rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
  return rows.join("\n");
}

port.on("message", (m: ToScreens) => {
  switch (m.t) {
    case "open": open(m); break;
    case "write": { const s = current(m.id, m.epoch); if (s) write(s, m.data, m.end); break; }
    case "resize": {
      const s = current(m.id, m.epoch);
      if (s) inTurn(s, () => { s.last = undefined; s.term.resize(m.cols, m.rows); });
      break;
    }
    case "screen": {
      const s = current(m.id, m.epoch);
      if (!s) { post({ t: "screen", req: m.req, text: null, at: 0, mouse: "" }); break; }
      inTurn(s, () => post({ t: "screen", req: m.req, text: screenOf(s, m.lines), at: s.parsed, mouse: mouseEncodingSeq(s.term) }));
      break;
    }
    case "rows": {
      const rows: Array<[string, string]> = [];
      const ready = m.ids.flatMap((id) => {
        const s = screens.get(id);
        return s ? [new Promise<void>((r) => inTurn(s, () => { rows.push([id, visibleRows(s)]); r(); }))] : [];
      });
      void Promise.all(ready).then(() => post({ t: "rows", req: m.req, rows }));
      break;
    }
    case "close": if (current(m.id, m.epoch)) close(m.id); break;
  }
});
