import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { trackOpenSession } from "./machines/open-sessions";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { followsLink, linkHint, registerFileLinks } from "./terminal-file-links";
import { installCrispDpr } from "./terminal-dpr";
import { drawnSize, nextPtySize, resizeBurst, scaleToFit, type PtySize } from "./pty-size-sync";
import { oscColorReply } from "./osc-color";
import { answerThemeNotify, colorFgBg, isDarkBackground, ThemeNotify } from "./theme-notify";
import { takeClipboardWrites } from "./terminal-clipboard";
import { patchTerminalMouseWithRetry } from "./terminal-mouse-patch";
import { wantsDomRenderer } from "./terminal-renderer-policy";
import { registerWebglSlotClient, unregisterWebglSlotClient, reconcileWebglSlots } from "./webgl-slots";
import { useTileFont, FontScaleControl } from "./tile-font";
import { actionKey, IS_MAC, onShortcut, runShortcut } from "./shortcut";
import { actionsFor } from "../../shared/keymap";
import { identifyAgent } from "./agent-state";
import { agentById } from "@hivemind/agents";
import { registerAgentTile, unregisterAgentTile, shouldDeliver, type SendToAgentDetail } from "./agent-send";
import { peekWork, claimWork } from "./work-queue";
import { publishStatus, clearStatus, setLabel, statusOf, subscribeTileStatus, type TileStatusKind } from "./agent-status-bus";
import { typeKeys } from "@hivemind/agent-host/keys";
import { SUBMIT_DELAY_MS, deliversPromptViaArgv } from "@hivemind/agent-host/agent-io";
import { AgentStart, START_TICK_MS } from "@hivemind/agent-host/agent-start";
import { Pencil, GripVertical, Moon } from "./components/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { acquireBoot, bootPosition, cancelBoot, isRestored, subscribeBoot } from "./boot-queue";
import { whenTerminalMayBuild } from "./terminal-mount-queue";
import { isRemote } from "@hivemind/core/remote-uri";
import { toPtyId } from "@hivemind/workspace-api/tile-id";
import { webUrlForInternalBrowser } from "./browser-open";
import { TILE_KEYBOARD } from "./workspace/workspace-view";
import { useThemeField, useSurfacePolicy, getTheme, effectiveGlass, type ThemeState } from "./theme-store";
import { terminalThemeFor } from "@hivemind/core/settings-schema";
import { FullscreenShell, useReparentFullscreen } from "./tile-fullscreen";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { SURFACE_ADOPTED, SURFACE_PARKED } from "./workspace/tile-host";
import { exitFailed, LOOKS, paintGlyph, StatusGlyph, statusLook, statusWord } from "./workspace/status-look";
import { useAgentsScanned } from "./agent-plugins";
import { KeyboardChip, KeyboardPill, useTerminalKeyboard, type TerminalKeyboard } from "./multiplayer/keyboard";
import { useShown } from "./multiplayer/shown";

// Default terminal font size. Each tile remembers its OWN size (useTileFont keyed
// by tileId) — A−/A+ in the header + Ctrl/Cmd +/−/0 adjust it. Crispness is
// DPR-driven (see terminal-dpr.ts); 15 is the default for comfortable reading.
const DEFAULT_FONT = 15;
/** The faces xterm measures for a font list: its first family, regular and bold. A generic name
 *  (monospace) is the system's and is already there. */
function measuredFaces(fontList: string): string[] {
  const first = fontList.split(",")[0]?.trim() ?? "";
  if (!first || /^(monospace|ui-monospace|sans-serif|serif|system-ui)$/.test(first)) return [];
  const family = /^["']/.test(first) ? first : `"${first}"`;
  return [`400 12px ${family}`, `700 12px ${family}`];
}
/**
 * Terminals whose host resized are fitted together, once per frame: every visibility read
 * first, then every fit. Reading visibility inside the ResizeObserver callback forced a
 * restyle in the middle of the observer chain (xyflow's own observer has just changed the
 * DOM), once per terminal per resize frame; interleaving reads and fits across terminals
 * made each read force a restyle of the previous fit's writes.
 */
type FitJob = { shown: () => boolean | null; fit: () => void; hidden: () => void };
const fitQueue = new Map<object, FitJob>();
let fitQueueRaf = 0;
function queueFit(key: object, job: FitJob): void {
  fitQueue.set(key, job);
  if (!fitQueueRaf) fitQueueRaf = requestAnimationFrame(flushFits);
}
function flushFits(): void {
  fitQueueRaf = 0;
  const jobs = [...fitQueue.values()];
  fitQueue.clear();
  const shown = jobs.map((j) => j.shown()); // reads, all of them
  jobs.forEach((j, i) => { if (shown[i] === true) j.fit(); else if (shown[i] === false) j.hidden(); }); // then writes
}

/** A booting agent gives its slot back after this long without output — at its prompt. */
const BOOT_SETTLE_MS = 1500;
/** ...but not before this: an agent's MCP servers and plugins start after its prompt. */
const BOOT_MIN_MS = 8000;
/** ...or after this, whatever it is doing: one slow agent must not stall the rest. */
const BOOT_CAP_MS = 12_000;
/** How long a terminal no view shows keeps its stream before it stops receiving bytes. */
const INTEREST_HIDE_MS = 1000;
/** Lines of scrollback a terminal keeps. */
const SCROLLBACK = 5000;
/** Lines of scrollback a terminal is sent when it opens; scrolled to the top of them, it asks for
 *  the rest. */
const FIRST_HISTORY = 1000;
/** What starts a screen the host sends in place of what a terminal shows. */
const SCREEN_RESET = "\x1bc";

// The terminal palette comes from settings.appearance.terminal (the ubuntu
// preset is the historical Ubuntu / GNOME Terminal palette, byte-identical —
// golden-tested in hive-core). `allowTransparency` must be set at construction,
// so it follows the user's glass setting, not the per-view gate.
/** Mounted tiles per session id: a tile shares its id with its remount. */
const liveMounts = new Map<string, number>();
/** Each mounted terminal's "your tile is closing", by tile id. */
const closing = new Map<string, Set<() => void>>();

/** The kitty keyboard flags the program turned on; 0 while it reads keys the old way. */
function kittyFlags(term: Terminal): number {
  return (term as unknown as { _core?: { coreService?: { kittyKeyboard?: { flags?: number } } } })._core?.coreService?.kittyKeyboard?.flags ?? 0;
}

/**
 * A tile is closing, however it is closed: end what runs in it. A mounted terminal kills its
 * session as it unmounts, and kills what a spawn still in flight attaches to; with none mounted
 * (a restored tile no view has shown yet) it is killed here. A session the tile adopted (`hive
 * run`, another device) is someone else's job, and is only let go. Unmounting alone means
 * nothing: a project switch unmounts every tile, and the daemon keeps their sessions.
 */
export function endTileSession(tileId: string, adopted: boolean): void {
  const mounts = closing.get(tileId);
  if (mounts?.size) for (const close of mounts) close();
  else if (!adopted) window.hive.ptyKill(toPtyId(tileId));
}

const termThemeFor = (t: ThemeState) => withScrollbar(terminalThemeFor(t.terminal));

/** xterm 6 colours its scrollbar from the theme, not CSS; follow the foreground. */
function withScrollbar(theme: Record<string, string>): Record<string, string> {
  const fg = theme.foreground ?? "";
  const hex = /^#([0-9a-f]{3})$/i.test(fg) ? `#${[...fg.slice(1)].map((c) => c + c).join("")}` : fg;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return theme;
  return {
    ...theme,
    scrollbarSliderBackground: `${hex}33`,
    scrollbarSliderHoverBackground: `${hex}59`,
    scrollbarSliderActiveBackground: `${hex}80`,
  };
}
/** The terminal background: FULLY transparent when content-glass is on, so the
 *  single tint lives on the tile ROOT (.hm-term-root, like every other tile) and
 *  the whole body — including the host's padding band — reads as one uniform tint
 *  (no "gap" frame). Else the opaque aubergine. */
// Scene views may opt out of glass; otherwise their wallpaper lives in the
// docked slot. The runtime surface policy determines the terminal background.
const termBgFor = (t: ThemeState): string =>
  effectiveGlass(t) && t.contentGlass ? "rgba(0,0,0,0)" : t.terminal.background;

/**
 * WebGL slots are shared across live terminals. Low-DPI terminals can opt into
 * DOM text rendering; both renderers use the display's native pixel ratio.
 */

interface Props {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  /** An existing daemon session (`hive run`, another device) to show; the tile never starts one. */
  session?: string;
  /** Display label for the canvas session chip / toasts (e.g. "claude #2"). */
  label?: string;
  /** What the tile is called (tile-name.ts): its name, then what it is doing. */
  name?: string;
  /** The name alone (a given one, else the label): what a rename edits. */
  given?: string;
  onRename?: (id: string, name: string) => void;
  /** Open URL targets in the frame's browser tile instead of the OS browser. */
  onOpenInBrowser?: (url: string) => void;
  /** Open text file paths in the frame's editor tile instead of the OS app. */
  onOpenInEditor?: (path: string) => void;
  /** Clip-to-pile: open Canvas-level popover to add this tile to a pile. */
  onClose?: () => void;
  /** Tile selection — when false, xterm stdin is disabled + blurred so an
   *  unselected tile can't receive keystrokes (pointer-events:none only blocks
   *  the mouse, not the keyboard). Click the tile to select → typing works. */
  selected?: boolean;
  /** Pin state + toggle (injected via node data). The pin button is docked in
   *  this tile's header next to close — no floating chip. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
  /** Put its agent to sleep; absent where it cannot sleep (a shell, a session started elsewhere). */
  onSleep?: () => Promise<void>;
  /** Its session sleeps, as an exit or an open says: the tile shows it asleep. */
  onAsleep?: () => void;
}

export function TerminalTile({ tileId, cwd, cmd, args, session, label, name, given, onRename, onOpenInBrowser, onOpenInEditor, onClose, selected, pinned, onTogglePin, onSleep, onAsleep }: Props) {
  // Editable header name: starts in display mode; double-click opens input.
  // Persists via onRename → Canvas tileNames → the workspace store (canvas-persistence.ts).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  // Crisp fit-to-screen overlay. When on, the LIVE .xterm DOM node is re-parented
  // into a fullscreen portal at document.body (see the reparent effect) — the
  // canvas layout + every other node stay untouched, and the bigger viewport
  // grows the grid (more cols/rows) at 100% zoom instead of scaling/zooming.
  const [overlay, setOverlay] = useState(false);
  const bootWait = useSyncExternalStore(subscribeBoot, () => bootPosition(tileId));
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // A size change that arrived while the tile was hidden (inactive Windows tab)
  // — applied by the selection effect when the tile is shown again.
  const pendingFitRef = useRef(false);
  const scheduleFitRef = useRef<(() => void) | null>(null);
  // What we last told the pty. xterm only emits onResize when ITS size changes,
  // so the pty is kept in step from here after every fit — see pty-size-sync.ts.
  const sentSizeRef = useRef<PtySize | null>(null);
  const syncSizeRef = useRef<(() => void) | null>(null);
  /** Fits the terminal to its tile (or draws it at the size another gave the session). */
  const fitRef = useRef<{ fit(): void; draw(): void } | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Live `selected` for the WebGL slot manager's priority() (read outside render).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const openInBrowserRef = useRef(onOpenInBrowser);
  openInBrowserRef.current = onOpenInBrowser;
  /** An http(s) link opens where the workspace opens addresses; any other kind not at all. */
  const openLink = (uri: string) => { const web = webUrlForInternalBrowser(uri); if (web) openInBrowserRef.current?.(web); };
  const openInEditorRef = useRef(onOpenInEditor);
  openInEditorRef.current = onOpenInEditor;
  const asleepRef = useRef(onAsleep);
  asleepRef.current = onAsleep;
  // Live cwd so the terminal file-link provider resolves relative paths against
  // the tile's CURRENT cwd even after a frame rebind.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Per-tile font size (A−/A+ + Ctrl/Cmd +/−/0). fontSizeRef gives the mount
  // effect the initial size; fontCtlRef lets the xterm key handler (a closure)
  // call the current inc/dec/reset.
  const font = useTileFont(tileId, DEFAULT_FONT);
  const fontSizeRef = useRef(font.size);
  fontSizeRef.current = font.size;
  const fontCtlRef = useRef(font);
  fontCtlRef.current = font;
  // Frost-tile-content: live-swap the terminal background (transparent ↔ opaque)
  // when the theme toggles, WITHOUT recreating the terminal. xterm applies
  // `theme` updates at runtime; the effect is gated on the COMPUTED bg, so
  // opacity-slider drags (which don't change it) never trigger a refresh.
  const termPalette = useThemeField("terminal");
  const contentGlass = useThemeField("contentGlass");
  const surfacePolicy = useSurfacePolicy();
  const termBg = surfacePolicy.glass && contentGlass ? "rgba(0,0,0,0)" : termPalette.background;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = { ...withScrollbar(terminalThemeFor(termPalette)), background: termBg };
    // A program that asked (mode 2031) hears the background went light or dark; the window whose
    // keys reach the session tells it, so two windows showing it do not say it twice.
    const report = themeNotifyRef.current?.theme(isDarkBackground(termPalette.background));
    if (report && kbRef.current.mayType) window.hive.ptyWrite(ptyIdRef.current, report);
  }, [termBg, termPalette]);
  // One session per tile, its id the tile's: the same tile reattaches to its session in the daemon
  // across restarts, a remount (StrictMode, a view move) shares it, and an unmount lets go of it
  // (only a close kills it). Not keyed on cwd: a frame rebinding its folder keeps the session, which
  // the daemon keeps at the folder it began in, where an agent's history is.
  const ptyId = session ?? toPtyId(tileId);
  const ptyIdRef = useRef(ptyId);
  ptyIdRef.current = ptyId;
  useEffect(() => trackOpenSession(ptyId), [ptyId]);
  // One keyboard per terminal (M2): who has it, whether this window's keys reach the session, and
  // the size the session was given. Heard before the session is opened, which tells it both.
  const kb = useTerminalKeyboard(ptyId, cwd);
  const kbRef = useRef<TerminalKeyboard>(kb);
  kbRef.current = kb;
  /** The mounted terminal's mode 2031 (theme-notify.ts). */
  const themeNotifyRef = useRef<ThemeNotify | null>(null);
  // What fits this tile, and the sizes this window last asked the session to take (drawnSize).
  const ownSizeRef = useRef<PtySize | null>(null);
  // The session has a size another screen gave it (a phone fitted it), not this window's.
  const [sizedElsewhere, setSizedElsewhere] = useState(false);
  const askedRef = useRef<PtySize[]>([]);
  // In a workspace joined from elsewhere: whether the session is shown from its host now, and how
  // to show it again once the connection to the host is back (the host let go of it as it went).
  const { shared } = useShown();
  const attachedRef = useRef(false);
  const reattachRef = useRef<(() => void) | null>(null);
  // True once the tile is closing (endTileSession): then the unmount kills its session. App-close
  // and project-switch unmounts leave it false: they let go of it.
  const killOnUnmountRef = useRef(false);

  // Agent/terminal status — driven by PTY activity, mutated imperatively via
  // refs (NOT React state) so high-frequency output never triggers re-renders.
  //   working = output within the last ~1.5s · idle = quiet · exited = PTY gone
  const dotRef = useRef<SVGSVGElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Wrapper around the status dot+label — hidden entirely while idle. */
  const statusWrapRef = useRef<HTMLSpanElement>(null);

  // null = plain shell. Read after the first agent scan: before it, every restored agent tile
  // would look like a shell.
  const agentsScanned = useAgentsScanned();
  // Restored with the workspace, its terminal is built when on screen, or at an idle moment; one
  // opened since, or selected, at once.
  const [mayBuild, setMayBuild] = useState(() => !isRestored(tileId));
  const builtOnScreenRef = useRef(true);
  useEffect(() => {
    if (mayBuild) return;
    if (selected) { setMayBuild(true); return; }
    const host = hostRef.current;
    if (host) return whenTerminalMayBuild(host, (onScreen) => { builtOnScreenRef.current = onScreen; setMayBuild(true); });
  }, [mayBuild, selected]);
  const agent = identifyAgent(cmd);
  // The label shown on canvas chips / toasts / notifications: the tile's name (tile-name.ts).
  // Kept in a ref so the long-lived status effect always publishes the CURRENT label.
  const effLabel = name?.trim() || label || agent || cmd.split("/").slice(-1)[0] || "shell";
  const chipLabelRef = useRef(effLabel);
  const lastStatusRef = useRef<TileStatusKind | null>(null);
  // A new session name (the agent wrote a title, or a rename) re-labels its chips, toasts and
  // any pending notification at once.
  useEffect(() => {
    chipLabelRef.current = effLabel;
    setLabel(tileId, effLabel);
  }, [effLabel, tileId]);

  useEffect(() => {
    if (!agentsScanned || !mayBuild) return;
    // permission/question = needs the human (from the real Claude-state scrape); working/idle
    // from screen or PTY activity. The words, shape and colour are workspace/status-look's, so
    // this header agrees with Layers and every surface bar.
    /** The header chip. An agent tile's follows the bus (the host's status); a shell's its own activity. */
    const paint = (s: TileStatusKind, extra?: { exitCode?: number; failed?: boolean; detail?: string }) => {
      const dot = dotRef.current;
      const label = labelRef.current;
      if (!dot || !label) return;
      // A shell calls this on every output chunk; rewriting an unchanged chip
      // replaced its text node and dirtied the header's layout each time.
      if (s === lastStatusRef.current && !extra) return;
      // Only a failed exit is not neutral.
      const failed = exitFailed({ status: s, ...extra });
      const look = statusLook(s, { failed });
      // `idle` is the ABSENCE of a state, not a state — and it rendered as a green
      // dot, which reads as "success" when it means "nothing is happening". Hide the
      // whole chip so a quiet tile has a quiet header, and every chip that remains
      // (working / approve? / blocked / exited) is worth looking at. Matches
      // LayersPanel, which already skips idle rows.
      if (statusWrapRef.current) statusWrapRef.current.style.display = s === "idle" ? "none" : "inline-flex";
      paintGlyph(dot, look);
      label.textContent = statusWord(s, { failed });
      label.style.color = LOOKS[look].text;
      lastStatusRef.current = s;
    };
    const offStatus = agent ? subscribeTileStatus(tileId, (e) => paint(e.status, e.status === "exited" ? e : undefined)) : undefined;
    /** What the tile itself knows: a shell's activity, and how any process exited — the code
     *  and detail let the awareness layer tell a crash from a clean close. */
    const setStatus = (s: "working" | "idle" | "exited", extra?: { exitCode?: number; signal?: number; failed?: boolean; detail?: string }) => {
      paint(s, extra);
      if (s === "exited") publishStatus({ tileId, label: chipLabelRef.current, status: s, ...extra });
    };
    const markActivity = () => {
      setStatus("working");
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setStatus("idle"), 1500);
    };

    // The viewport as text, for tests (a WebGL terminal renders none into the DOM).
    // The agent's first seconds: a startup screen its launch flags answered, its first task.
    const starting = new AgentStart(agent ? agentById(agent) : undefined, Date.now());
    const readScreen = (): string => {
      const buf = term.buffer.active;
      const out: string[] = [];
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.viewportY + y);
        out.push(line ? line.translateToString(true) : "");
      }
      return out.join("\n");
    };
    let agentPoll: ReturnType<typeof setInterval> | undefined;

    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: getTheme().monoFont,
      fontSize: fontSizeRef.current,
      lineHeight: 1.3,
      // ONLY when Frost-tile-content is on at mount. allowTransparency disables
      // subpixel-antialiased text (text goes grayscale → softer/blurrier vs a
      // native terminal), so opaque terminals must keep it OFF to stay crisp.
      // (Toggling content-glass later needs a reload to apply to open terminals.)
      allowTransparency: getTheme().glass && getTheme().contentGlass,
      theme: { ...termThemeFor(getTheme()), background: termBgFor(getTheme()) },
      // No blink — a blinking cursor repaints EVERY terminal ~2×/s forever, so
      // the canvas never feels fully still/crisp (perpetual GPU compositing
      // across all tiles). Cursor stays solid + visible; zero idle repaint.
      cursorBlink: false,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      // A program may ask for keys by the kitty protocol: Shift+Enter, Ctrl+I and Tab stay apart.
      // Mode 2031 is theme-notify.ts's alone: xterm's own reports on every colour change and reads a
      // glass terminal's clear background as dark.
      vtExtensions: { kittyKeyboard: true, colorSchemeQuery: false },
      // Render perf + UX tuning
      fastScrollSensitivity: 5,           // Alt-wheel jumps 5x faster
      scrollSensitivity: 1,
      smoothScrollDuration: 0,            // no smooth-scroll animation; cuts paints
      drawBoldTextInBrightColors: true,   // crisper bold rendering on dark bg
      minimumContrastRatio: 4.5,          // auto-adjust low-contrast cells to WCAG AA
                                          // (color only — doesn't affect sharpness)
      letterSpacing: 0,
      // OSC 8 hyperlinks (claude emits these), on Ctrl/⌘+click.
      linkHandler: {
        activate: (e, uri) => { if (followsLink(e)) openLink(uri); },
        ...linkHint(() => term.element),
      },
      // Rescale glyphs that overflow their cell (powerline, wide Unicode,
      // ligature-ish forms) instead of letting them clip/smear — sharper edges.
      rescaleOverlappingGlyphs: true,
      // Atlas (glyph cache) — "dynamic" is the default; be explicit.
      // The WebGL renderer (loaded below) reuses the atlas across frames.
    });
    // http(s) URLs in terminal output (claude, build logs, etc.), on Ctrl/⌘+click.
    term.loadAddon(new WebLinksAddon((e, uri) => { if (followsLink(e)) openLink(uri); }, linkHint(() => term.element)));
    // File PATHS too (open in the OS default app): WebLinksAddon only handles http(s) URLs.
    // Disposed with the terminal on unmount.
    registerFileLinks(
      term,
      () => cwdRef.current,
      (url) => openInBrowserRef.current?.(url),
      (path) => openInEditorRef.current?.(path),
    );
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Widths by grapheme, as programs measure their text: 👍 and ⚠️ take two columns, a Devanagari
    // syllable one. The daemon's screens count the same way (screen-worker.ts).
    term.loadAddon(new UnicodeGraphemesAddon());
    term.open(host);
    // The screen as text for tests: a WebGL terminal renders none into the DOM.
    (host as HTMLElement & { __hmScreen?: () => string }).__hmScreen = readScreen;
    if (term.element) term.element.style.transformOrigin = "0 0";
    /** Fit the grid to the tile; or, while the session has a size someone else gave it, draw it
     *  at that size: letterboxed, or scaled down to fit when it is the larger. */
    const fitTerm = (): void => {
      const own = fit.proposeDimensions();
      if (!own) return;
      ownSizeRef.current = own;
      drawTerm();
    };
    /** Draw at the size last measured: this window's, or the one the session was given. Measuring
     *  again here would take a size a resize burst is still holding back. */
    const drawTerm = (): void => {
      const own = ownSizeRef.current;
      if (!own) return;
      const drawn = drawnSize(own, askedRef.current, kbRef.current.size);
      setSizedElsewhere(drawn.cols !== own.cols || drawn.rows !== own.rows);
      if (term.cols !== drawn.cols || term.rows !== drawn.rows) term.resize(drawn.cols, drawn.rows);
      const scale = scaleToFit(own, drawn);
      if (term.element) term.element.style.transform = scale < 1 ? `scale(${scale})` : "";
    };
    fitRef.current = { fit: fitTerm, draw: drawTerm };
    fitTerm();
    termRef.current = term;
    const notify = new ThemeNotify(isDarkBackground(getTheme().terminal.background));
    themeNotifyRef.current = notify;
    /** Ask the session to take this tile's size, when it has not been asked already. Only while
     *  this window's keys reach it: the keyboard's holder sizes a session (R4). */
    const syncPtySize = (): void => {
      const own = ownSizeRef.current;
      if (!own || !kbRef.current.mayType) return;
      const next = nextPtySize(sentSizeRef.current, own.cols, own.rows);
      if (!next) return;
      sentSizeRef.current = next;
      askedRef.current = [...askedRef.current.slice(-2), next];
      window.hive.ptyResize(ptyId, next.cols, next.rows);
    };
    syncSizeRef.current = syncPtySize;
    // ── FOCUS GUARANTEE ──────────────────────────────────────────────────────
    // While claude STREAMS, its title/status churn re-renders the react-flow node,
    // and react-flow re-focuses the SELECTED node's wrapper <div> (nodes are
    // focusable for a11y) — yanking focus off xterm's input mid-type. Keystrokes
    // then go to the node wrapper / react-flow, not the terminal → "can't type
    // while it's working". A `=== document.body` check misses this (focus is on a
    // node wrapper, not body). So: when xterm's input blurs WHILE this tile is
    // selected and focus landed on the CANVAS CHROME — body, the react-flow pane,
    // or ANY node wrapper (a re-render/selection steal) and NOT a real editable
    // field — take focus straight back next frame. Never fights a deliberate move
    // into another tile's terminal, a rename box, or a search field (all
    // editable elements), so it can't trap focus.
    const reclaimFocusIfStolen = () => {
      if (!selectedRef.current) return;
      requestAnimationFrame(() => {
        if (!selectedRef.current) return;
        const ae = document.activeElement as HTMLElement | null;
        const editable = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
        if (editable) return; // user moved into a real input — leave it
        const onCanvasChrome = !ae || ae === document.body
          || ae.classList?.contains("react-flow__pane")
          || !!ae.closest?.(".react-flow__node");
        if (onCanvasChrome) { try { termRef.current?.focus(); } catch { /* torn down */ } }
      });
    };
    const onInputBlur = reclaimFocusIfStolen;
    const inputEl = term.textarea;
    inputEl?.addEventListener("blur", onInputBlur);
    // Make selection zoom-aware so it works at ANY canvas zoom (not just 100%) —
    // lets focus fit a terminal to the screen without breaking drag-select.
    const cancelMousePatch = patchTerminalMouseWithRetry(term);

    // ── WebGL renderer follows ATTENTION (see webgl-slots.ts) ────────────────
    // Browsers cap WebGL contexts (~16) and we keep every terminal mounted, so we
    // can't give them all WebGL. Start on the DOM renderer; the slot manager
    // hot-swaps THIS tile to the crisp WebGL renderer when it's focused or
    // visible (and back to DOM when it scrolls off-screen / loses focus). The PTY
    // is never touched. acquire/release are idempotent.
    // `cancelled` is declared HERE (not below with the spawn vars) because
    // registerWebglSlotClient() synchronously calls acquireWebgl, which reads it.
    let cancelled = false;
    liveMounts.set(ptyId, (liveMounts.get(ptyId) ?? 0) + 1);
    const markClosing = () => { killOnUnmountRef.current = true; };
    const closers = closing.get(tileId) ?? new Set<() => void>();
    closers.add(markClosing);
    closing.set(tileId, closers);
    let webgl: WebglAddon | undefined;
    let disposeDpr: (() => void) | undefined;
    // WebGL context-loss back-off (opencove pattern). The packaged app's GPU
    // sandbox evicts WebGL contexts far more aggressively than the dev server —
    // and re-acquiring immediately just loses it again, thrashing the canvas
    // (recreated each cycle) → the cursor flickers and keyboard focus drops while
    // an agent streams output. After a loss we fall to the DOM renderer and stay
    // there for a cooldown (wantsDom() honors this), breaking the loop. The DOM
    // renderer handles output fine — just slightly softer until the cooldown ends.
    let webglCooldownUntil = 0;
    const WEBGL_COOLDOWN_MS = 30_000;
    // ── Flow control ────────────────────────────────────────────────────────
    // xterm parses writes on its own frame budget, so when output arrives faster
    // than it can parse (a `cat` of a big file, a runaway build log, a whole
    // replay on reattach) the unparsed backlog just grows in memory — unbounded,
    // and every frame spent draining it is a frame the canvas doesn't get. Count
    // the bytes still queued (write callbacks fire as each chunk is consumed)
    // and, past a high-water mark, ask main to PAUSE the pty: the child blocks
    // on its full pty buffer instead of us buffering on its behalf. Resume once
    // the queue drains under the low mark. Same scheme as VS Code's terminal.
    //
    // A pause is a short LEASE that main lets expire on its own (so a child that
    // exits while paused still gets its final bytes drained — see main's
    // PTY_PAUSE_MAX_MS). We therefore re-request it on EVERY batch that arrives
    // while still over the mark; the explicit resume below is the fast path.
    const FLOW_HIGH_CHARS = 200_000;
    const FLOW_LOW_CHARS = 20_000;
    let flowPending = 0;
    let flowPaused = false;
    const requestFlowPause = () => {
      flowPaused = true;
      try { window.hive.ptyFlow(ptyId, true); } catch { /* bridge without flow control */ }
    };
    const releaseFlowPause = () => {
      if (!flowPaused) return;
      flowPaused = false;
      try { window.hive.ptyFlow(ptyId, false); } catch { /* bridge without flow control */ }
    };
    // Restore keyboard focus after an operation that recreates the renderer canvas
    // (acquire/release/context-loss) — a focused selected terminal must not silently
    // lose input. Deferred a frame so it runs after the DOM swap settles. Only focus the
    // swap dropped: focus put elsewhere since (a menu, a field) stays there.
    const restoreFocusIfSelected = () => {
      if (!selectedRef.current) return;
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (at && at !== document.body && !termRef.current?.element?.contains(at)) return;
        try { if (selectedRef.current) termRef.current?.focus(); } catch { /* torn down */ }
      });
    };
    const acquireWebgl = () => {
      if (webgl || cancelled) return;
      try {
        const w = new WebglAddon();
        webgl = w;
        webglRef.current = w;
        // Context can be evicted (driver reset, GL pressure). Drop to DOM, repaint
        // so the tile is never blank, and reconcile so the slot frees for another.
        w.onContextLoss(() => {
          // Back off WebGL for a cooldown so we don't immediately re-acquire and
          // lose it again (the prod GPU thrash). wantsDom() now forces this tile to
          // the DOM renderer until the cooldown expires.
          webglCooldownUntil = Date.now() + WEBGL_COOLDOWN_MS;
          // Confirms the prod-only "pointer flicker / focus loss while working"
          // hypothesis: if render-diag.log fills with these, GPU context churn is
          // the cause and the cooldown is doing its job.
          void window.hive.diagLog?.(`[webgl-context-loss] tile=${effLabel} cooldown=${WEBGL_COOLDOWN_MS}ms`);
          try { disposeDpr?.(); } catch { /* gone */ }
          disposeDpr = undefined;
          try { w.dispose(); } catch { /* disposed */ }
          if (webgl === w) { webgl = undefined; webglRef.current = null; }
          try { term.refresh(0, term.rows - 1); } catch { /* torn down */ }
          restoreFocusIfSelected();
          reconcileWebglSlots();
        });
        term.loadAddon(w);
        disposeDpr = installCrispDpr(term);
        // Do NOT fit() here. cols is anchored to the DOM cell size (see
        // releaseWebgl). At dpr=1 the WebGL renderer rounds the device cell width
        // DOWN, so its cells are slightly NARROWER than the DOM renderer's —
        // rendering the DOM-sized cols on WebGL just leaves a few px of right
        // margin, never an overflow. Re-fitting here would bump cols to WebGL's
        // larger count, and the next focus (→DOM) would overflow + reflow claude.
        try { term.refresh(0, term.rows - 1); } catch { /* torn down */ }
        restoreFocusIfSelected();
      } catch {
        try { webgl?.dispose(); } catch { /* */ }
        webgl = undefined;
        webglRef.current = null;
        disposeDpr = undefined;
      }
    };
    const releaseWebgl = () => {
      if (!webgl) return;
      try { disposeDpr?.(); } catch { /* gone */ }
      disposeDpr = undefined;
      try { webgl.dispose(); } catch { /* disposed */ }
      webgl = undefined;
      webglRef.current = null;
      // Re-fit on the DOM renderer. DOM cells are WIDER than WebGL's at dpr=1, so
      // any cols WebGL fit to would overflow the DOM rows — text clips at the
      // right edge instead of wrapping (the reported bug). Recompute cols for the
      // DOM cell size so the (focused) terminal fits exactly; fit() → onResize →
      // ptyResize reflows claude to the real visible width. The second fit on the
      // next frame is a safety net: disposing the WebGL addon may not recompute
      // the DOM render dimensions until the following paint, and a stale first fit
      // would re-introduce the overflow. (A no-op when the first fit already won.)
      try { fitRef.current?.fit(); syncSizeRef.current?.(); term.refresh(0, term.rows - 1); } catch { /* torn down */ }
      requestAnimationFrame(() => { try { fitRef.current?.fit(); syncSizeRef.current?.(); } catch { /* torn down */ } });
      restoreFocusIfSelected();
    };
    // Viewport visibility → priority. Built off screen, it starts off screen; else it
    // is assumed visible (a fresh tile is usually in view) and the observer corrects
    // on the next frame. A PARKED
    // surface (no view shows this tile — see workspace/tile-host.tsx) still
    // intersects geometrically, so the host's park/adopt events override it:
    // parked tiles rank 0 and never hold a WebGL slot.
    let inViewport = builtOnScreenRef.current;
    let parked = !!host.closest("#hm-tile-park");
    /** Laid out AND visible (not under a `visibility:hidden` ancestor — an
     *  inactive Windows tab, the park). */
    const hostShown = () => {
      try { return host.checkVisibility({ visibilityProperty: true }); } catch { return true; }
    };
    // Bytes reach this terminal only while a view shows it (see main's ptyInterest). A tile
    // scrolled past or switched away from for a moment keeps its stream; one gone longer is
    // sent its screen as the host keeps it when it comes back.
    let interested = true;
    let loseInterest: ReturnType<typeof setTimeout> | undefined;
    const reconcileInterest = () => {
      if (!parked && inViewport) {
        if (loseInterest) { clearTimeout(loseInterest); loseInterest = undefined; }
        if (!interested) { interested = true; window.hive.ptyInterest(ptyId, true); }
        return;
      }
      if (!interested || loseInterest) return;
      loseInterest = setTimeout(() => { loseInterest = undefined; interested = false; window.hive.ptyInterest(ptyId, false); }, INTEREST_HIDE_MS);
    };
    // A remount (a view switch) picks the stream back up if main had stopped sending it.
    window.hive.ptyInterest(ptyId, true);
    // Opened with the newest FIRST_HISTORY lines of scrollback. Scrolled to the top of them, it asks
    // for all of it, and keeps the line it was reading in place when that screen arrives.
    let history: number | undefined = FIRST_HISTORY;
    let keepPlace: number | undefined;
    /** Every spawn and attach of this tile's session: its size now, and the history it holds. */
    const spawn = (more: Partial<Parameters<typeof window.hive.ptySpawn>[0]> = {}) => window.hive.ptySpawn({
      tileId: ptyId, tile: tileId, cwd, cmd, args: args ?? [], cols: term.cols, rows: term.rows,
      // What it starts on: a program that reads its colours from COLORFGBG picks them for this.
      env: { COLORFGBG: colorFgBg(isDarkBackground(getTheme().terminal.background)) },
      ...(history === undefined ? {} : { history }), ...more,
    });
    term.onScroll(() => {
      const buf = term.buffer.active;
      if (history === undefined || buf.viewportY > 0 || buf.baseY < history) return;
      history = undefined;
      keepPlace = buf.baseY;
      window.hive.ptyHistory(ptyId, SCROLLBACK);
    });
    // Back in touch with the host of a workspace joined from elsewhere: show its session again,
    // from the host's screen, at this window's size if its keys reach it.
    reattachRef.current = () => {
      attachedRef.current = true;
      exited = false;
      spawn({ attachOnly: true })
        .then(({ pid }) => { if (pid === -1) attachedRef.current = false; }, () => { attachedRef.current = false; });
      if (interested) window.hive.ptyInterest(ptyId, true);
      sentSizeRef.current = null;
      syncPtySize();
    };
    const io = new IntersectionObserver(
      (entries) => {
        const v = !!entries[entries.length - 1]?.isIntersecting;
        if (v !== inViewport) { inViewport = v; reconcileWebglSlots(); reconcileInterest(); }
      },
      { threshold: 0.01 },
    );
    io.observe(host);
    reconcileInterest();
    const surfaceEl = host.closest(".hm-tile-surface");
    const onAdopted = () => {
      parked = false;
      reconcileInterest();
      // The park freezes the surface at its last slot size, so adopting into a
      // different-size slot fires the ResizeObserver below (one fit per tile),
      // and adopting into a same-size slot needs none, unless it was parked at
      // another size than it was drawn at: then it fits once shown.
      reconcileWebglSlots();
      if (pendingFitRef.current) fitWhenShown();
    };
    const onParked = (e: Event) => {
      parked = true;
      reconcileInterest();
      reconcileWebglSlots();
      // Parked at a size other than the slot we just left (a slot overlay hands
      // the tile back at its arranging view's size): fit when it is shown again,
      // not now. Hidden, a fit would resize the program for a size nobody sees,
      // and resize it back when it is shown where it was.
      if ((e as CustomEvent<{ resized?: boolean }>).detail?.resized) pendingFitRef.current = true;
    };
    surfaceEl?.addEventListener(SURFACE_ADOPTED, onAdopted);
    surfaceEl?.addEventListener(SURFACE_PARKED, onParked);
    registerWebglSlotClient({
      id: ptyId,
      // A hidden host (inactive Windows tab, parked surface) ranks like an
      // off-screen tile: it neither needs nor should acquire a WebGL context
      // — acquiring one costs a GL context + shader compile, and doing it for
      // every tab that merely intersects the viewport behind the active one
      // made the first switch into Windows a long task.
      priority: () => (parked || !hostShown() ? 0 : selectedRef.current ? 2 : inViewport ? 1 : 0),
      acquire: acquireWebgl,
      release: releaseWebgl,
      // Fallback pin: after a WebGL context loss this tile stays on the DOM
      // renderer for the cooldown and never holds a slot — re-acquiring would
      // just lose the context again and thrash the canvas.
      wantsDom: () => wantsDomRenderer({ now: Date.now(), webglCooldownUntil }),
    });


    let exited = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubAgentSend: (() => void) | undefined;

    // Rebuild the glyph atlas once the web font is truly loaded. xterm measures
    // the font at open(); the terminal font (JetBrains Mono unless the person chose
    // another) loads async, so the first atlas is often built from FALLBACK metrics
    // → permanently blurry glyphs that never self-correct. Force-load the exact
    // faces, then re-fit + clear the WebGL texture atlas so glyphs re-rasterize at
    // the right metrics + density.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      const fams = measuredFaces(getTheme().monoFont);
      Promise.all(fams.map((f) => document.fonts.load(f).catch(() => undefined)))
        .then(() => document.fonts.ready)
        .then(() => {
          if (cancelled) return;
          try {
            fitTerm();
            syncPtySize();
            webgl?.clearTextureAtlas();
            term.refresh(0, term.rows - 1);
          } catch { /* terminal torn down mid-load */ }
        })
        .catch(() => { /* fonts API unavailable */ });
    }
    // Dirty flag for the agent-status poll: only re-scan the (expensive to
    // stringify) xterm viewport when the PTY has emitted output since the last
    // scan. A state change is always preceded by output, so gating on this
    // skips the per-1.2s full-viewport materialize + regex when nothing changed.
    // Starts true so the first tick establishes the initial state.
    let agentDirty = true;

    // A restored agent holds a boot slot until it has drawn its prompt and gone quiet
    // (BOOT_SETTLE_MS without output), or BOOT_CAP_MS passes — whichever comes first.
    let bootRelease: (() => void) | undefined;
    let bootSettle: ReturnType<typeof setTimeout> | undefined;
    let bootCap: ReturnType<typeof setTimeout> | undefined;
    let bootAt = 0;
    const releaseBoot = () => {
      if (bootSettle) clearTimeout(bootSettle);
      if (bootCap) clearTimeout(bootCap);
      bootRelease?.();
      bootRelease = undefined;
    };

    // Subscribe to PTY data/exit BEFORE awaiting ptySpawn. The main process
    // attaches its `p.onData` listener inside spawnPty() and the kernel pipe
    // can deliver bytes (e.g. shell rc-file prompt) before our await resolves
    // here. Subscribing first means we never drop the opening banner.
    unsubData = window.hive.onPtyData(ptyId, (d) => {
      if (bootRelease) {
        if (bootSettle) clearTimeout(bootSettle);
        bootSettle = setTimeout(releaseBoot, Math.max(BOOT_SETTLE_MS, bootAt + BOOT_MIN_MS - Date.now()));
      }
      flowPending += d.length;
      // Once the reset is drawn. In the data's own write: xterm's resize stopped at an empty write
      // and dropped it with every write after it (see screen-worker's inTurn). Our patch of
      // @xterm/xterm fixes that loop; folding the scroll into this write keeps it right without it.
      const had = keepPlace !== undefined && d.startsWith(SCREEN_RESET) ? keepPlace : undefined;
      if (had !== undefined) keepPlace = undefined;
      term.write(d, () => {
        flowPending -= d.length;
        if (flowPaused && flowPending <= FLOW_LOW_CHARS) releaseFlowPause();
        if (had !== undefined) term.scrollToLine(Math.max(0, term.buffer.active.baseY - had));
      });
      if (flowPending >= FLOW_HIGH_CHARS) requestFlowPause();
      // An agent tile's status comes from the host; a plain shell uses the cheap heuristic.
      if (agent) agentDirty = true;
      else markActivity();
    });
    unsubExit = window.hive.onPtyExit(ptyId, ({ code, signal, slept }) => {
      releaseBoot();
      if (slept) {
        // Not ended: it waits for Resume, which the sleeping tile shows.
        exited = true;
        if (idleTimer.current) clearTimeout(idleTimer.current);
        if (agentPoll) { clearInterval(agentPoll); agentPoll = undefined; }
        asleepRef.current?.();
        return;
      }
      term.writeln(
        `\r\n\x1b[2m[hivemind] exited code=${code} signal=${signal ?? ""} — press Enter to restart\x1b[0m`,
      );
      exited = true;
      // Enter starts the next program in this session, which asks for itself.
      notify.reset();
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (agentPoll) { clearInterval(agentPoll); agentPoll = undefined; }
      // Thread the exit code + a one-line detail so the awareness layer can
      // raise an "error" toast for a crash (non-zero) vs. stay quiet on a clean
      // close, and show the code in the body. (signal here is the numeric value
      // sent by node-pty; name it generically — a non-null signal implies kill.)
      const detail = signal !== undefined && signal !== null ? `killed by signal ${signal}` : undefined;
      setStatus("exited", { exitCode: code, ...(signal != null ? { signal } : {}), detail });
    });
    term.onData((d) => {
      // Someone else has the keyboard: this window's keys (and its terminal's replies) are not the
      // session's. The pill says who has it.
      if (!kbRef.current.mayType) return;
      if (exited) {
        // After exit, swallow chars except Enter (which respawns). Avoids
        // confusing dead-term input.
        if (d === "\r" || d === "\n") {
          exited = false;
          term.writeln("\x1b[2m[hivemind] restarting…\x1b[0m");
          void doSpawn();
        }
        return;
      }
      starting.touch(); // the person is driving now: nothing is sent for them
      window.hive.ptyWrite(ptyId, d);
    });
    term.onResize(() => syncPtySize());
    // A glass terminal's background is transparent, which xterm reports as black; answer with
    // the theme's colour so a TUI tinting its panels from it blends toward what the user chose.
    term.parser.registerOscHandler(11, (data) => {
      if (data !== "?" || termBgFor(getTheme()) === getTheme().terminal.background) return false;
      const reply = oscColorReply(getTheme().terminal.background);
      if (!reply) return false;
      window.hive.ptyWrite(ptyId, `\x1b]11;${reply}\x1b\\`);
      return true;
    });
    // Mode 2031: the program asks to hear when the background goes light or dark, or asks now. One
    // for this mount, the restarts in it too; a later mount learns the mode from the replay.
    answerThemeNotify(term.parser, notify, (reply) => { if (kbRef.current.mayType) window.hive.ptyWrite(ptyId, reply); });
    // What the program copies (Claude Code's mouse selection): only while the person is at this terminal.
    takeClipboardWrites(term.parser, () => !!selectedRef.current && !!kbRef.current.mayType, (text) => { void navigator.clipboard.writeText(text).catch(() => {}); });
    // Clipboard COPY only. xterm doesn't copy on its own (Ctrl+C just sends
    // SIGINT): Cmd/Ctrl(+Shift)+C copies the selection (and clears it, so a
    // second press still sends SIGINT); plain Ctrl+C with NOTHING selected falls
    // through to the PTY as ^C (VS Code / Windows Terminal rule).
    //
    // PASTE is intentionally NOT intercepted. The terminal's native paste path
    // already works, and — crucially — claude reads IMAGES from the system
    // clipboard on paste. Grabbing Ctrl/Cmd+V here (text-only readText) would
    // swallow image pastes, so we leave paste entirely to xterm/the PTY/claude.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Alt+Left/Right moves by word; xterm 6 no longer remaps it.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const left = e.key === "ArrowLeft";
        term.input(IS_MAC ? (left ? "\x1bb" : "\x1bf") : (left ? "\x1b[1;5D" : "\x1b[1;5C"), true);
        e.preventDefault();
        return false;
      }
      for (const action of actionsFor(e, "terminal", IS_MAC)) {
        if (!runTerminalKey(action)) continue;
        e.preventDefault();
        return false;
      }
      return true;
    });
    /** The terminal's own keys (shared/keymap.ts). False: nothing to do, the key goes to the program. */
    function runTerminalKey(action: string): boolean {
      const font = fontCtlRef.current;
      switch (action) {
        case "copy": {
          // Copy only with a selection; otherwise Ctrl+C is the program's interrupt.
          const sel = term.getSelection();
          if (!sel) return false;
          void navigator.clipboard.writeText(sel).catch(() => {});
          term.clearSelection();
          return true;
        }
        // Shift+Enter: a new line in the prompt, not a send. A program that turned the kitty protocol
        // on is told Shift+Enter as itself; any other gets ESC CR, which agents read as Alt+Enter.
        case "new-line":
          if (kittyFlags(term)) return false;
          term.input("\x1b\r", true);
          return true;
        case "take-keyboard":
          if (!kbRef.current.mayTake) return false;
          window.hive.keyboardTake(ptyId);
          return true;
        case "font-bigger": font.inc(); return true;
        case "font-smaller": font.dec(); return true;
        case "font-reset": font.reset(); return true;
        // The slot bar of the view this terminal is docked in undocks it (slot-chrome.tsx).
        case "undock": return runShortcut("undock");
        default: return false;
      }
    }
    // Cross-tile bus: an agent session accepts ADDRESSED text (see agent-send.ts), whichever
    // agent it is. Registering makes this the latest agent tile so a bare/`latest` send lands
    // here only — no more broadcast to every agent.
    if (agent) {
      registerAgentTile(tileId);
      const onSend = (e: Event) => {
        const detail = (e as CustomEvent<string | SendToAgentDetail>).detail;
        const { deliver, text } = shouldDeliver(tileId, detail);
        // Type the text, THEN press Enter as a SEPARATE keystroke a tick later.
        // A single "text\n" write reaches claude's TUI before it has staged the
        // paste, so the newline is dropped and the prompt sits unsubmitted.
        if (deliver && text) {
          window.hive.ptyWrite(ptyId, text);
          setTimeout(() => window.hive.ptyWrite(ptyId, "\r"), SUBMIT_DELAY_MS);
        }
      };
      window.addEventListener("hivemind:send-to-agent", onSend as EventListener);
      unsubAgentSend = () => {
        unregisterAgentTile(tileId);
        window.removeEventListener("hivemind:send-to-agent", onSend as EventListener);
      };
    }

    async function doSpawn() {
      try {
        // Deliver a queued ▶ Work prompt as the agent's positional ARGV — claude and
        // pi both auto-submit it as a real turn, so there's no race against the
        // booting TUI that used to swallow the typed prompt's Enter (▶ Work / a
        // spawned pi worker silently doing nothing on a cold start). claimWork
        // consumes once, so a re-attach/respawn never re-delivers, and the daemon
        // strips it on frozen-restore — the task runs exactly once.
        // Agents without an argv prompt (codex/droid/opencode) still take the typed-
        // delivery path in the poll below: peekWork stays set because we don't claim.
        // Work is queued under the bare tile id; ptyId carries the daemon's `hm:` scope.
        const initialPrompt = deliversPromptViaArgv(agent) ? claimWork(tileId) : undefined;
        // A restored agent re-attaches if its session is still alive — instant, the whole
        // story after an app restart. With nothing to attach to (after a reboot) it waits
        // its turn, so a restore does not start every agent in the same second. Remote
        // agents run on another machine and never queue here.
        let attachedPid: number | undefined;
        if (agent && !session && isRestored(tileId) && !isRemote(cwd)) {
          // liveOnly: a session saved before a reboot restores on attach, which is the
          // start this queue is for; it must wait its turn like any other.
          const probe = await spawn({ attachOnly: true, liveOnly: true });
          if (probe.asleep) { asleepRef.current?.(); return; }
          if (probe.pid !== -1) attachedPid = probe.pid;
          if (attachedPid === undefined && !cancelled) {
            bootRelease = await acquireBoot(tileId);
            if (cancelled) { releaseBoot(); return; }
          }
        }
        attachedRef.current = true;
        const { pid, joined, asleep } = attachedPid !== undefined ? { pid: attachedPid, joined: false, asleep: undefined } : await spawn({
          ...(initialPrompt ? { initialPrompt } : {}),
          ...(session ? { attachOnly: true } : {}),
        });
        if (cancelled) {
          // An adopted session is someone's running job: an abandoned mount only lets go of it.
          // Otherwise the id is shared with the remount (StrictMode, a view move) that
          // now owns the session; only an explicit close may kill it. With no remount,
          // let go of the attach this spawn made after the unmount already detached.
          if (session) window.hive.ptyDetach(ptyId);
          else if (killOnUnmountRef.current) window.hive.ptyKill(ptyId);
          else if (!liveMounts.get(ptyId)) window.hive.ptyDetach(ptyId);
          return;
        }
        if (asleep) {
          attachedRef.current = false;
          asleepRef.current?.();
          return;
        }
        // Another window started this session and gave it its task: this one only shows it.
        if (joined) claimWork(tileId);
        // -1 is "no such session"; other negative pids are remote ones, negated on purpose.
        if (pid === -1) {
          // An adopted session that is gone; or, in a workspace joined from elsewhere, one its host
          // is not running.
          const detail = session
            ? `could not open session ${session}: it has ended, or its machine is unreachable`
            : "this terminal is not running on the machine it belongs to";
          term.writeln(`\x1b[2m[hivemind] ${detail}\x1b[0m`);
          attachedRef.current = false;
          exited = true;
          setStatus("exited", { failed: true, detail });
          return;
        }
        // Force the live PTY to match our CURRENT geometry. On a RE-ATTACH the
        // daemon keeps the session's ORIGINAL cols/rows (the spawn spec is
        // frozen), and our init fit() already set term.cols — so term.onResize
        // won't fire and the daemon never learns the real size. Result: claude
        // stays stuck at the old (often smaller) size and its TUI renders narrow
        // / oversized inside the actual tile, and the replayed snapshot wraps at
        // the stale width — "text looks bigger after restart". Pushing our dims
        // explicitly every spawn reflows claude (SIGWINCH) to the true tile size.
        try { fitTerm(); } catch { /* torn down */ }
        syncPtySize();
        term.writeln(`\x1b[2m[hivemind] spawned ${cmd} (pid ${pid})\x1b[0m`);
        if (bootRelease) { bootAt = Date.now(); bootCap = setTimeout(releaseBoot, BOOT_CAP_MS); }
        if (!agent) setStatus("idle");
        if (agent && !agentPoll) {
          // Queued-prompt ("Work on this" / workflow) delivery: deliver EXACTLY
          // ONCE, when the agent's screen has SETTLED (boot/splash output stopped
          // = it's at a ready input prompt), then consume it (agent-start.ts).
          // Delivering on the first scrape-"idle" raced droid's ~6s boot (its splash
          // scrapes as idle the WHOLE time, before the input is interactive);
          // re-delivering on each idle poll caused DUPLICATE submissions (droid
          // buffers them all).
          void window.hive.diagLog?.(`[work-poll] start tile=${tileId} agent=${agent} peek=${!!peekWork(tileId)}`);
          agentPoll = setInterval(() => {
            // One-shot delivery — runs BEFORE the agentDirty early-return so it can
            // fire while the agent is quiet (the exact "ready" moment). claimWork
            // consumes, so the prompt can never be submitted twice.
            // A screen this agent opens before it will take anything, which our own launch
            // flags already answered: skip it once so the tile reaches its prompt.
            const now = Date.now();
            const keys = starting.mayDismiss(now) ? starting.dismiss(readScreen(), now) : null;
            if (keys) typeKeys((bytes) => window.hive.ptyWrite(ptyId, bytes), keys);
            // Quiet alone is not ready: a first run can open a trust or update chooser and
            // sit there, and a task typed into a chooser picks an option instead. Only a
            // screen that WAITS holds the task back — a booting agent has no status yet, and
            // its own splash can read as working; neither means a chooser is up.
            if (agent && peekWork(tileId) && starting.settled(agentDirty, statusOf(tileId), readScreen())) {
              const work = claimWork(tileId);
              if (work) {
                starting.typeTask((data, paste) => window.hive.ptyWrite(ptyId, data, paste), work, async () => ({ status: statusOf(tileId), screen: readScreen() }));
                void window.hive.diagLog?.(`[work-deliver] tile=${tileId} agent=${agent} settled`);
              }
            }
            agentDirty = false;
          }, START_TICK_MS);
        }
      } catch (e) {
        attachedRef.current = false;
        releaseBoot();
        const detail = `spawn failed: ${(e as Error).message}`;
        term.writeln(`\x1b[31m[hivemind] ${detail}\x1b[0m`);
        exited = true;
        setStatus("exited", { failed: true, detail });
      }
    }
    void doSpawn();

    // Debounce fit() across ResizeObserver bursts. During a drag-resize, RO
    // fires ~60Hz; each fit recomputes cell geometry AND triggers an IPC
    // ioctl resize on the kernel PTY. Coalescing to one rAF tick cuts that
    // to display-refresh rate and stops the resize handle from jittering.
    let fitRaf = 0;
    const doFit = () => {
      // Put off to a frame or a burst's end, it may be hidden by then: it fits once shown.
      if (parked || !hostShown()) { pendingFitRef.current = true; return; }
      try {
        const buf = term.buffer.active;
        const atBottom = buf.viewportY >= buf.baseY;
        const before = `${term.cols}x${term.rows}`;
        fitTerm();
        syncPtySize();
        // At the bottom it stays there, with the latest output and the prompt (a reflow can
        // leave it scrolled up); scrolled up to read, it stays put.
        if (atBottom) term.scrollToBottom();
        // A new grid is drawn whole: rows the reflow did not touch keep no glyphs of the old one.
        if (`${term.cols}x${term.rows}` !== before) term.refresh(0, term.rows - 1);
      } catch {
        /* ignore */
      }
    };
    // Coming back to the window (focus, or shown again) the GPU may have dropped what it drew:
    // rebuild the glyphs and draw it whole, at most every 120 ms.
    let lastRecovery = 0;
    const recover = () => {
      if (document.hidden || parked || !hostShown()) return;
      const now = Date.now();
      if (now - lastRecovery < 120) return;
      lastRecovery = now;
      try {
        webgl?.clearTextureAtlas();
        fitTerm();
        syncPtySize();
        term.refresh(0, term.rows - 1);
      } catch { /* torn down */ }
    };
    const onVisible = () => { if (!document.hidden) recover(); };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", onVisible);
    const scheduleFit = () => {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(() => { fitRaf = 0; doFit(); });
    };
    // Resizing a live WebGL terminal is the single most expensive thing a view
    // switch can do: Chromium must flush the context's pending draws before it
    // can reallocate the canvas (100-600 ms per tile on software GL, and still
    // the dominant cost on a GPU), so refitting every terminal on every switch
    // made the switch a 0.5-1 s long task. A tile that is NOT SHOWN (an inactive
    // Windows tab is laid out but visibility:hidden; a parked surface likewise)
    // doesn't need its new size until it is shown: defer the fit, and let the
    // shown tile be the only one that resizes. On the way back the deferred
    // tiles are at their old size again, so their fit is a no-op.
    const fitKey = {};
    // Grid and program resize together, in one step per burst (see resizeBurst).
    const burst = resizeBurst();
    const ro = new ResizeObserver(() => {
      if (parked) return; // a parked surface holds its size; adoption refits
      queueFit(fitKey, {
        shown: () => (parked ? null : hostShown()),
        fit: () => {
          pendingFitRef.current = false;
          if (fitRaf) { cancelAnimationFrame(fitRaf); fitRaf = 0; }
          burst.run(() => {
            doFit();
            // Ranked while xyflow still had the node hidden; now shown, it can take a WebGL slot.
            if (!webgl) reconcileWebglSlots();
          });
        },
        hidden: () => {
          pendingFitRef.current = true;
          fitWhenShown();
        },
      });
    });
    scheduleFitRef.current = () => { pendingFitRef.current = false; scheduleFit(); };
    /** A fit put off while hidden: now if it is shown, else two frames on. Hidden for a frame only?
     *  xyflow mounts a node `visibility:hidden` until it has measured it, so a freshly (re)mounted
     *  canvas node is hidden exactly when it is laid out. A tab that stays hidden waits for its
     *  selection instead. */
    function fitWhenShown(): void {
      if (!parked && hostShown()) { scheduleFitRef.current?.(); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (pendingFitRef.current && !parked && hostShown()) scheduleFitRef.current?.();
      }));
    }
    ro.observe(host);

    return () => {
      cancelled = true;
      releaseBoot();
      cancelBoot(tileId);
      fitQueue.delete(fitKey);
      const left = (liveMounts.get(ptyId) ?? 1) - 1;
      if (left > 0) liveMounts.set(ptyId, left); else liveMounts.delete(ptyId);
      closers.delete(markClosing);
      if (closers.size === 0) closing.delete(tileId);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (agentPoll) clearInterval(agentPoll);
      unsubData?.();
      unsubExit?.();
      unsubAgentSend?.();
      inputEl?.removeEventListener("blur", onInputBlur);
      offStatus?.();
      clearStatus(tileId);
      // The queued task is NOT dropped here: a body unmounts on a view switch, on a park,
      // and twice on every mount in development — the task belongs to the tile, and the
      // tile is still open. Closing one drops it (Workspace.closeTile).
      ro.disconnect();
      io.disconnect();
      burst.cancel();
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", onVisible);
      if (loseInterest) clearTimeout(loseInterest);
      surfaceEl?.removeEventListener(SURFACE_ADOPTED, onAdopted);
      surfaceEl?.removeEventListener(SURFACE_PARKED, onParked);
      // Unregister from the slot manager — this releases our WebGL slot (disposes
      // the addon + dpr override) and lets another tile claim it.
      unregisterWebglSlotClient(ptyId);
      // Never leave the child paused on our behalf once we stop reading — the
      // daemon resumes on detach too, but the in-process/remote paths rely on
      // this. (term.dispose() below drops the write callbacks that would have.)
      releaseFlowPause();
      try {
        // Not an explicit close → detach (keep the session alive in the daemon). Otherwise kill.
        // An adopted session is someone's job (`hive run`, another device): closing the tile only lets go.
        if (session || !killOnUnmountRef.current) window.hive.ptyDetach(ptyId);
        else window.hive.ptyKill(ptyId);
      } catch {
        /* ignore */
      }
      scheduleFitRef.current = null;
      syncSizeRef.current = null;
      cancelMousePatch();
      term.dispose();
      termRef.current = null;
      themeNotifyRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
    // `args` is excluded from deps intentionally — Canvas/parent recreates the
    // array on every render so reference equality would always fail and cause
    // a PTY respawn on every parent re-render. We freeze args on first mount.
    // (For real argv changes, change the cmd or destroy/recreate the tile.)
    //
    // `cwd` is excluded too: ptyId is keyed on the tile only (frame-stable across workspace
    // rebinding), and the daemon keeps the original spawn cwd. A cwd-only prop change with a live
    // session would otherwise tear down and re-attach silently (the daemon ignores a new cwd on
    // re-attach), looking like nothing happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, cmd, agentsScanned, mayBuild]);

  // Gate keyboard on selection. pointer-events:none (tile-locked) blocks the
  // mouse but NOT the keyboard — a focused xterm keeps eating keystrokes after
  // you deselect the tile. disableStdin makes xterm ignore input entirely when
  // unselected; selecting re-enables + focuses so one click puts you in.
  useEffect(() => {
    // Focus changed → re-rank slots. Every tile that holds a slot renders WebGL;
    // focus ranks a tile above its neighbours for the budget. (selectedRef is
    // already current from render.)
    reconcileWebglSlots();
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !selected;
    if (selected) {
      // Shown now (the active tab / the focused tile): apply a fit that was
      // deferred while hidden, before focusing.
      if (pendingFitRef.current) scheduleFitRef.current?.();
      term.focus();
      // Focusing a terminal (e.g. from the Layers panel) snaps to the LATEST
      // output / live prompt — never leave it parked mid-scrollback. Editor /
      // diff tiles keep their own (top-anchored) scroll position.
      term.scrollToBottom();
      // Re-rasterize AFTER the select zoom-snap settles. Selecting snaps the
      // canvas to 100% (SelectZoomReset), but the DOM renderer's text sits in the
      // canvas's composited layer and keeps its raster from the PRE-snap zoom
      // (you were at 80–120%) — so it looks blurry until the next manual zoom
      // invalidates it ("zooming in sharpens it"). A delayed full refresh repaints
      // the rows → invalidates the stale raster → crisp at the final 100%. Two
      // ticks (after the ~150ms zoom animation + buffer) catch the settle robustly.
      const repaint = () => { try { termRef.current?.refresh(0, (termRef.current?.rows ?? 1) - 1); } catch { /* torn down */ } };
      const t1 = setTimeout(repaint, 280);
      const t2 = setTimeout(repaint, 560);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    } else term.blur();
  }, [selected, mayBuild]);

  // Apply THIS tile's font size to xterm whenever it changes, then re-fit so
  // cols/rows track the new cell size.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = font.size;
    try {
      fitRef.current?.fit();
      syncSizeRef.current?.();
      term.refresh(0, term.rows - 1);
    } catch { /* torn down */ }
  }, [font.size]);

  // The person's terminal font, applied as it changes: once its faces have loaded, the cells are
  // measured again (the pty follows the new size) and the glyph atlas is drawn afresh.
  const monoFont = useThemeField("monoFont");
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontFamily === monoFont) return;
    term.options.fontFamily = monoFont;
    let gone = false;
    void Promise.all(measuredFaces(monoFont).map((f) => document.fonts.load(f).catch(() => undefined))).then(() => {
      if (gone) return;
      try {
        fitRef.current?.fit();
        syncSizeRef.current?.();
        webglRef.current?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
      } catch { /* torn down */ }
    });
    return () => { gone = true; };
  }, [monoFont]);

  // A workspace joined from elsewhere: once the connection to its host is back, the session is
  // shown again (the host let go of it as the connection went); until then it is not.
  const joined = !!shared;
  const connected = shared?.state === "connected";
  useEffect(() => {
    if (!joined) return;
    if (!connected) attachedRef.current = false;
    else if (!attachedRef.current) reattachRef.current?.();
  }, [joined, connected]);

  // The session was given a size: draw it again, at this window's size or at the one given.
  useEffect(() => {
    try { fitRef.current?.draw(); } catch { /* torn down */ }
  }, [kb.size?.cols, kb.size?.rows]);
  // The keyboard moved. Keys reaching the session again (it was given to this window, or came
  // back to its host): this window asks for its size again, to be the session's. Keys no longer
  // reaching it: the sizes it asked for are not the session's any more.
  const typedBefore = useRef(kb.mayType);
  useEffect(() => {
    if (typedBefore.current === kb.mayType) return;
    typedBefore.current = kb.mayType;
    if (kb.mayType) sentSizeRef.current = null;
    else askedRef.current = [];
    // The background may have changed while another window had the keys: a program that asked hears it.
    const report = kb.mayType ? themeNotifyRef.current?.now() : null;
    if (report) window.hive.ptyWrite(ptyIdRef.current, report);
    try { fitRef.current?.fit(); syncSizeRef.current?.(); } catch { /* torn down */ }
  }, [kb.mayType]);

  // ── CRISP FIT-TO-SCREEN OVERLAY ───────────────────────────────────────────
  // Move the LIVE .xterm node into the fullscreen glass panel and back, WITHOUT
  // recreating the terminal: the xterm buffer + PTY are independent of the DOM
  // parent, so the shared hook just re-parents term.element (we hold the ref).
  // After each move, fit() recomputes cols/rows → term.onResize → PTY SIGWINCH, so
  // the grid GROWS into the bigger viewport at 100% zoom (crisp), no scaling.
  useReparentFullscreen({
    open: overlay,
    node: () => termRef.current?.element,
    homeRef: hostRef,
    hostRef: overlayHostRef,
    afterMove: () => {
      const term = termRef.current;
      if (!term) return;
      fitRef.current?.fit();
      syncSizeRef.current?.();
      term.refresh(0, term.rows - 1);
      if (selectedRef.current) term.focus();
    },
  });

  // The selected terminal's screen keys: fit it to the screen (and back), or size its text to fit.
  useEffect(() => {
    const offFit = onShortcut("fit-to-screen", () => { if (!selectedRef.current) return false; setOverlay((v) => !v); });
    const offReset = onShortcut("reset-scale", () => { if (!selectedRef.current) return false; fontCtlRef.current.best(); });
    return () => { offFit(); offReset(); };
  }, []);

  useEffect(() => {
    const onKeyboard = (e: Event) => { if ((e as CustomEvent<string>).detail === tileId && selectedRef.current) termRef.current?.focus(); };
    window.addEventListener(TILE_KEYBOARD, onKeyboard);
    return () => window.removeEventListener(TILE_KEYBOARD, onKeyboard);
  }, [tileId]);

  return (
    <div className="hm-term-root flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]" data-term-bg={termBg}>
      {/* Entire header is the drag handle. Previously only the ⋮⋮ icon (~5px
          wide) carried `.tile-drag-handle` — invisible target, users
          clicked the wide header bar expecting drag and nothing happened
          (verified via playwright element-from-point probe). */}
      <div data-tile-titlebar className="group tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { onRename?.(tileId, draft); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename?.(tileId, draft); setEditing(false); }
              if (e.key === "Escape") { setDraft(given ?? name ?? ""); setEditing(false); }
            }}
            font="mono"
            className="nodrag w-32"
            placeholder="Terminal"
          />
        ) : (
          <>
            <button
              onDoubleClick={() => { setDraft(given ?? name ?? "Terminal"); setEditing(true); }}
              // No `nodrag` here: it would force drag-suppression on the WHOLE
              // width the name occupies (most of the header) — which is exactly
              // where users grab the tile to drag. xyflow's drag has a movement
              // threshold so a stationary click still fires onDoubleClick reliably.
              className="font-semibold text-[var(--color-fg)] cursor-text"
              title="Double-click to rename"
            >
              {name?.trim() || "Terminal"}
            </button>
            {/* Pencil icon = "this name is editable". `nodrag` so the icon's
                single-click enters edit mode without arming xyflow's drag. */}
            <Button
              variant="ghost"
              size="icon-micro"
              onClick={() => { setDraft(given ?? name ?? "Terminal"); setEditing(true); }}
              reveal="hidden"
              className="nodrag"
              aria-label="rename tile"
              title="Rename tile"
            >
              <Pencil />
            </Button>
          </>
        )}
        {/* The command is dropped when the tile name already contains it — the
            default agent tile is literally "claude #1 · claude". It stays for a
            renamed tile, or a shell whose command isn't obvious from the name. */}
        {(() => {
          const bin = cmd.split("/").slice(-1)[0] ?? "";
          const shown = (name?.trim() || "Terminal").toLowerCase();
          if (!bin || shown.startsWith(bin.toLowerCase())) return null;
          return (
            <>
              <span aria-hidden className="text-[var(--color-line2)]">·</span>
              <span className="text-[var(--color-fg2)]">{bin}</span>
            </>
          );
        })()}
        <KeyboardChip tile={ptyId} name={name?.trim() || "Terminal"} kb={kb} />
        {/* Font / scale / fullscreen controls — revealed only on header hover
            (group-hover). Two SEPARATE controls: font size (A−/A+, density only)
            and whole-tile scale (−/+, grows the node box + font in proportion). */}
        <span className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
          {/* Font size only (A−/A+) */}
          <span className="nodrag inline-flex items-center divide-x divide-[var(--color-line2)] rounded bg-[var(--color-bg)] border border-[var(--color-line2)] overflow-hidden" title={`Font size (${actionKey("font-bigger")} / ${actionKey("font-smaller")})`}>
            <Button variant="ghost" size="micro" onClick={font.dec} aria-label="decrease font size">
              A−
            </Button>
            <Button variant="ghost" size="micro" onClick={font.inc} aria-label="increase font size">
              A+
            </Button>
          </span>
          {/* Whole-tile scale (− size +) */}
          <FontScaleControl
            {...font}
            onScale={(ratio) =>
              window.dispatchEvent(
                new CustomEvent("hivemind:scale-tile", { detail: { tileId, ratio } }),
              )
            }
          />
          {/* Fullscreen: re-parents the live terminal into a wallpaper overlay and
              GROWS the grid (no zoom). nodrag so it doesn't drag. */}
          <Button
            variant="ghost"
            size="icon-micro"
            onClick={() => setOverlay((v) => !v)}
            className="nodrag"
            aria-label="fullscreen terminal"
            title={`Fullscreen (${actionKey("fit-to-screen")})`}
          >
            ⤢
          </Button>
        </span>
        <span
          ref={statusWrapRef}
          className="inline-flex items-center gap-1.5 text-chip"
          title="agent status — working / blocked / exited (idle is not shown)"
        >
          <StatusGlyph ref={dotRef} look="idle" className="size-1.5" />
          <span ref={labelRef} style={{ color: "var(--color-fg3)" }}>
            starting
          </span>
        </span>
        {onSleep && (
          <Button variant="ghost" size="icon-micro" className="nodrag" aria-label="put agent to sleep" title="Sleep: end its process, keep its screen and conversation" onClick={() => void onSleep().catch(() => {})}>
            <Moon />
          </Button>
        )}
        {/* Pin toggle — docked in the header next to close (not a floating chip). */}
        <HeaderPinButton tileId={tileId} pinned={pinned} onToggle={onTogglePin} />
        {/* nodrag — react-flow ignores drag from elements with this class so
            clicking the × button doesn't start a tile drag. */}
        <Button
          variant="ghost"
          size="icon-micro"
          className="nodrag"
          aria-label="close tile"
          onClick={() => onClose?.()}
          title="close tile"
        >
          ×
        </Button>
      </div>
      {/* `nowheel` tells react-flow to ignore wheel events inside this element
          (default class react-flow checks for) — without it, scrolling the
          terminal pans the entire canvas. */}
      {/* min-h-0/min-w-0 let this flex child shrink BELOW its content size —
          without them a flex item floors at content height, so shrinking the
          tile didn't shrink the host, fit() never reflowed, and the parent's
          overflow-hidden cropped the terminal. With them the host tracks the
          tile and the ResizeObserver re-fits, so the terminal reflows (cols/
          rows scale) on resize down AND up instead of being clipped. */}
      <div className="hm-term-host relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[var(--color-terminal-bg)] p-1.5">
        <div ref={hostRef} className="w-full h-full overflow-hidden" />
        {selected && <KeyboardPill tile={ptyId} kb={kb} />}
        {sizedElsewhere && kb.mayType && (
          <div className="nodrag pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-[var(--color-line)] bg-[var(--color-bg2)] px-3 py-1 text-label shadow-md" role="status" data-sized-elsewhere={ptyId}>
            <span>Sized for another screen</span>
            <Button size="sm" variant="secondary" onClick={() => {
              const own = ownSizeRef.current;
              if (!own) return;
              sentSizeRef.current = own;
              askedRef.current = [...askedRef.current.slice(-2), own];
              window.hive.ptyFit(ptyId, own.cols, own.rows);
            }}>Use this window's size</Button>
          </div>
        )}
        {bootWait !== null && (
          <div role="status" aria-label="Waiting to start" className="absolute inset-1.5 z-10 flex flex-col gap-2 bg-[var(--color-terminal-bg)] p-2">
            <Skeleton className="h-2.5 w-7/12" />
            <Skeleton className="h-2.5 w-9/12" />
            <Skeleton className="h-2.5 w-5/12" />
            <span className="mt-auto text-count text-[var(--color-fg3)]">
              Starting soon{bootWait > 0 ? ` · ${bootWait} ahead` : ""}
            </span>
          </div>
        )}
      </div>
      {/* Fullscreen: the live .xterm node is reparented into the shared shell's
          glass panel (overlayHostRef) by useReparentFullscreen — PTY + buffer
          preserved — floating over a clean copy of the live wallpaper. */}
      {overlay && (
        <FullscreenShell
          title={name?.trim() || "Terminal"}
          font={font}
          hostRef={overlayHostRef}
          onClose={() => setOverlay(false)}
        />
      )}
    </div>
  );
}
