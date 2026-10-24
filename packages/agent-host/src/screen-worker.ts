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
import type { FromScreens, ScreenCursor, ScreenRows, ToScreens } from "./screen-messages.js";

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
  const t = term as unknown as { modes: { mouseTrackingMode: string }; _core?: { mouseStateService?: { activeEncoding?: string } } };
  if (t.modes.mouseTrackingMode === "none") return "";
  switch (t._core?.mouseStateService?.activeEncoding) {
    case "SGR": return "\x1b[?1006h";
    case "SGR_PIXELS": return "\x1b[?1016h";
    default: return "";
  }
}

/**
 * What it loses about the keyboard: the kitty protocol flags a program turned on (`CSI > flags u`).
 * Without them the client's terminal sends keys the old way, and Shift+Enter is Enter again.
 */
function kittyFlagsSeq(term: InstanceType<HeadlessCtor>): string {
  const flags = (term as unknown as { _core?: { coreService?: { kittyKeyboard?: { flags?: number } } } })._core?.coreService?.kittyKeyboard?.flags ?? 0;
  return flags ? `\x1b[=${flags};1u` : "";
}

/**
 * What it loses about the background: whether the program asked to hear when it goes light or dark
 * (mode 2031, `CSI ? 2031 h`; xterm keeps no state for it). Every window that attaches learns it from
 * the replay, so the one holding the keys tells the program after a restart, a reload or another
 * window taking the keyboard.
 */
const THEME_NOTIFY_MODE = 2031;
const themeNotifySeq = (s: Screen): string => (s.themeNotify ? `\x1b[?${THEME_NOTIFY_MODE}h` : "");

interface Screen {
  id: string;
  /** The session instance it belongs to: what it tells main is dropped when another holds the id. */
  epoch: string;
  term: InstanceType<HeadlessCtor>;
  serializer: InstanceType<SerializeCtor>;
  /** Output position the terminal has taken in, within its session. */
  parsed: number;
  paste: boolean;
  /** The program has mode 2031 on (`themeNotifySeq`). */
  themeNotify: boolean;
  /** The last screen serialized, given again while no output or resize changed it. */
  last?: { at: number; lines: number; text: string };
  /** Where the shell's prompt starts, while the shell waits at it, for a shell that marks its prompt
   *  (OSC 133, its "shell integration"): set where a prompt starts (`A`), let go where the command
   *  typed at it starts to run (`C`). */
  prompt?: import("@xterm/headless").IMarker;
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
  const term = new Terminal({ cols: m.cols, rows: m.rows, scrollback: m.scrollback, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const s: Screen = { id: m.id, epoch: m.epoch, term, serializer, parsed: m.parsed, paste: false, themeNotify: false };
  screens.set(m.id, s);
  term.onTitleChange((title) => post({ t: "title", id: s.id, epoch: s.epoch, title }));
  // Heard, and left to xterm (false) for the other modes the same sequence sets.
  const themeMode = (on: boolean) => (params: (number | number[])[]) => { if (params.includes(THEME_NOTIFY_MODE)) s.themeNotify = on; return false; };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, themeMode(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, themeMode(false));
  term.parser.registerOscHandler(133, (data) => {
    const mark = data.split(";", 1)[0];
    if (mark === "A" || mark === "C") { s.prompt?.dispose(); s.prompt = undefined; }
    // None on the alternate screen, where no shell draws its prompt.
    if (mark === "A") s.prompt = term.registerMarker(0) ?? undefined;
    return true;
  });
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

/** Run `then` once the terminal has taken in everything sent before it: a screen, the rows or its
 *  end keep their place among the session's output. Not `write("")`: a resize first takes in what is
 *  queued, and stops at an empty string (it is falsy), dropping it, its `then` and every write after
 *  it, so a window waits for a screen that never comes (xterm's WriteBuffer.flushSync). */
function inTurn(s: Screen, then: () => void): void {
  s.term.write(NOTHING, then);
}
const NOTHING = new Uint8Array(0);

function screenOf(s: Screen, lines: number): string {
  const kept = s.last;
  if (kept && kept.at === s.parsed && kept.lines === lines) return kept.text;
  const text = s.serializer.serialize({ scrollback: lines });
  s.last = { at: s.parsed, lines, text };
  return text;
}

function visibleRows(s: Screen): ScreenRows {
  const buf = s.term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < s.term.rows; y++) rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
  return { text: rows.join("\n"), cursor: cursorOf(s) };
}

/** Read through the public API: `cursorY` counts from `baseY`, the row `visibleRows` starts at. The
 *  input the cursor is in starts where the shell's prompt does, when it marked it, else on the
 *  first row of its line: a command typed past the width wraps onto the rows below it. */
function cursorOf(s: Screen): ScreenCursor {
  const buf = s.term.buffer.active;
  const row = buf.cursorY;
  let top = row;
  while (top > 0 && buf.getLine(buf.baseY + top)?.isWrapped) top--;
  const prompt = buf.type === "normal" && s.prompt && !s.prompt.isDisposed ? s.prompt.line - buf.baseY : row + 1;
  // A prompt below the cursor was drawn before the screen was cleared; one above the screen leaves
  // every row up to the cursor to it.
  const marked = prompt <= row;
  if (marked) top = Math.max(0, Math.min(top, prompt));
  return { x: buf.cursorX, y: row, top, hidden: !s.term.modes.showCursor, ...(marked ? { marked: true as const } : {}) };
}

port.on("message", (m: ToScreens) => {
  switch (m.t) {
    case "open": open(m); break;
    case "write": { const s = current(m.id, m.epoch); if (s) write(s, m.data, m.end); break; }
    case "resize": {
      const s = current(m.id, m.epoch);
      // A resize takes in everything written before it first, so it keeps its place in the output.
      // From inside a write's callback that flush never ends, and nothing after it is answered.
      if (s) { s.last = undefined; s.term.resize(m.cols, m.rows); }
      break;
    }
    case "screen": {
      const s = current(m.id, m.epoch);
      if (!s) { post({ t: "screen", req: m.req, text: null, at: 0, modes: "" }); break; }
      inTurn(s, () => post({ t: "screen", req: m.req, text: screenOf(s, m.lines), at: s.parsed, modes: mouseEncodingSeq(s.term) + kittyFlagsSeq(s.term) + themeNotifySeq(s) }));
      break;
    }
    case "rows": {
      const rows: Array<[string, ScreenRows]> = [];
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
