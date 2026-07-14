import { useEffect, useId, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { registerFileLinks } from "./terminal-file-links";
import { installCrispDpr, effectiveDpr } from "./terminal-dpr";
import { patchTerminalMouseWithRetry } from "./terminal-mouse-patch";
import { registerWebglSlotClient, unregisterWebglSlotClient, reconcileWebglSlots } from "./webgl-slots";
import { useTileFont, FontScaleControl, handleFontKey } from "./tile-font";
import { identifyAgent, detectTileStatus, stabilizeClaudeStatus, normalizeAgentTitle, type TileStatus } from "./agent-state";
import { registerClaude, unregisterClaude, shouldDeliver, peekWork, claimWork, clearWork, type SendToClaudeDetail } from "./claude-bus";
import { publishStatus, clearStatus, noteOutput, revalidate, type TileStatusKind } from "./agent-status-bus";
import { SUBMIT_DELAY_MS, SPAWN_SUBMIT_RETRY_MS, deliversPromptViaArgv } from "../../shared/agent-io";
import { Pencil, GripVertical } from "lucide-react";
import { webUrlForInternalBrowser } from "./browser-open";
import { useTheme, getTheme } from "./theme-store";
import { FullscreenShell, useReparentFullscreen } from "./tile-fullscreen";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";

/** Open a terminal link in the OS browser. window.open is intercepted by main's
 *  setWindowOpenHandler → shell.openExternal (and the in-app navigation denied),
 *  so no popup window appears. Only http(s) — never file:/ javascript: etc. */
function openExternalLink(uri: string, openInBrowser?: (url: string) => void): void {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") {
      if (openInBrowser) {
        openInBrowser(uri);
        return;
      }
      window.open(uri, "_blank", "noopener,noreferrer");
    }
  } catch { /* not a parseable URL — ignore */ }
}

// Default terminal font size. Each tile remembers its OWN size (useTileFont keyed
// by tileId) — A−/A+ in the header + Ctrl/Cmd +/−/0 adjust it. Crispness is
// DPR-driven (see terminal-dpr.ts); 15 is the default for comfortable reading.
const DEFAULT_FONT = 15;

// Ubuntu / GNOME Terminal palette — the signature aubergine background + Tango
// ANSI colors. Extracted so the "Frost tile content" theme option can swap just
// the background to transparent live (xterm honors `theme` updates at runtime;
// `allowTransparency` must be set at construction, so it's always on — it costs
// nothing while the bg stays opaque).
const TERM_THEME = {
  background: "#300A24",
  foreground: "#FFFFFF",
  cursor: "#FFFFFF",
  cursorAccent: "#300A24",
  selectionBackground: "rgba(255,255,255,0.25)",
  black: "#2E3436",
  brightBlack: "#555753",
  red: "#CC0000",
  brightRed: "#EF2929",
  green: "#4E9A06",
  brightGreen: "#8AE234",
  yellow: "#C4A000",
  brightYellow: "#FCE94F",
  blue: "#3465A4",
  brightBlue: "#729FCF",
  magenta: "#75507B",
  brightMagenta: "#AD7FA8",
  cyan: "#06989A",
  brightCyan: "#34E2E2",
  white: "#D3D7CF",
  brightWhite: "#EEEEEC",
} as const;
/** The terminal background: FULLY transparent when content-glass is on, so the
 *  single tint lives on the tile ROOT (.hm-term-root, like every other tile) and
 *  the whole body — including the host's padding band — reads as one uniform tint
 *  (no "gap" frame). Else the opaque aubergine. */
const termBgFor = (t: { glass: boolean; contentGlass: boolean }): string =>
  t.glass && t.contentGlass ? "rgba(0,0,0,0)" : TERM_THEME.background;

// ── render-quality diagnostics ───────────────────────────────────────────────
// A toggleable HUD (Ctrl/Cmd+Shift+D, shared across tiles) that surfaces the
// live values that govern terminal crispness, so a blurry-text report becomes a
// concrete reading instead of a guess: canvas zoom (text is only pixel-perfect
// at exactly 1.000), devicePixelRatio, the rendered font px + grid, and the
// computed styles that quietly degrade text — `will-change`/`transform` on the
// .xterm (GPU-layer promotion kills crisp text) and whether `.canvas-moving` is
// stuck on. Read imperatively (no React subscription) so it costs nothing off.
const TERM_DEBUG_KEY = "hm:termDebug";
function loadTermDebug(): boolean {
  try { return localStorage.getItem(TERM_DEBUG_KEY) === "1"; } catch { return false; }
}
function setTermDebug(on: boolean): void {
  try { localStorage.setItem(TERM_DEBUG_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("hivemind:term-debug", { detail: on }));
}
function readCanvasZoom(): number {
  const vp = document.querySelector(".react-flow__viewport") as HTMLElement | null;
  if (!vp) return 1;
  try { return new DOMMatrixReadOnly(getComputedStyle(vp).transform).a; } catch { return 1; }
}
/**
 * Renderer: WebGL + a per-instance device-pixel-ratio override (see
 * ./terminal-dpr.ts) — the technique opencove uses, adapted for DPR=1 displays.
 *
 * WebGL rasterizes glyphs into a GPU atlas at `cellPx × devicePixelRatio`. On
 * HiDPI (DPR≥2) that's dense → crisp (why opencove looks sharp on retina). On a
 * DPR=1 laptop the atlas is 1× → thin/soft, and the canvas zoom makes it worse.
 * installCrispDpr() overrides xterm's internal dpr to a supersample FLOOR of 2,
 * so the atlas is always rasterized ≥2× and downsampled to the display — crisp
 * at zoom 1, no CSS hacks, no PTY reflow, mouse-mapping intact.
 *
 * (Earlier attempts — a CSS-scale SSAA wrapper, then switching to the DOM
 * renderer — both fell short: the wrapper caused reflow/mouse drift, and the DOM
 * renderer doesn't supersample and still blurs under the canvas transform. The
 * DPR override is the actual fix.)
 */

interface Props {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  /** Display label for the canvas session chip / toasts (e.g. "claude #2"). */
  label?: string;
  /** Display name: user rename ?? agent OSC title ?? auto label. Resolved by
   *  Canvas, so it already reflects claude's live session title. */
  name?: string;
  onRename?: (id: string, name: string) => void;
  /** Report this agent's live OSC window title (claude's task summary) so Canvas
   *  can show it as the session name. */
  onAgentTitle?: (id: string, title: string) => void;
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
}

export function TerminalTile({ tileId, cwd, cmd, args, label, name, onRename, onAgentTitle, onOpenInBrowser, onOpenInEditor, onClose, selected, pinned, onTogglePin }: Props) {
  // Editable header name: starts in display mode; double-click opens input.
  // Persists via onRename → Canvas tileNames → LAYOUT_KEY localStorage.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  // Render-quality HUD (Ctrl/Cmd+Shift+D). `diag` holds the live readings.
  const [debug, setDebug] = useState<boolean>(loadTermDebug);
  const [diag, setDiag] = useState<Record<string, string>>({});
  // Crisp fit-to-screen overlay. When on, the LIVE .xterm DOM node is re-parented
  // into a fullscreen portal at document.body (see the reparent effect) — the
  // canvas layout + every other node stay untouched, and the bigger viewport
  // grows the grid (more cols/rows) at 100% zoom instead of scaling/zooming.
  const [overlay, setOverlay] = useState(false);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Live `selected` for the WebGL slot manager's priority() (read outside render).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const openInBrowserRef = useRef(onOpenInBrowser);
  openInBrowserRef.current = onOpenInBrowser;
  const openInEditorRef = useRef(onOpenInEditor);
  openInEditorRef.current = onOpenInEditor;
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
  const termBg = termBgFor(useTheme());
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Selection stays the neutral white default (TERM_THEME.selectionBackground).
    term.options.theme = { ...TERM_THEME, background: termBg };
  }, [termBg]);
  // Unique PTY identity per MOUNT (not per prop). Fixes React.StrictMode
  // double-mount race: the first mount's awaited ptySpawn could resolve AFTER
  // its cleanup ran, killing the second mount's PTY (same tileId in the
  // pty-host map → SIGHUP, terminal shows "exited code=0 signal=1").
  // With useId(), each mount lifecycle gets its own ptyId — cleanup only ever
  // kills its own PTY.
  const reactId = useId();
  // Persistence mode (HIVEMIND_PTY_DAEMON=1): use a STABLE session id so the
  // same tile reattaches to its surviving daemon session across restarts, and
  // DETACH (not kill) on unmount. The StrictMode double-mount race the per-mount
  // id guarded against dissolves here — detach is harmless and attach is
  // idempotent (the daemon replays the buffer). Non-persistent: keep the
  // per-mount unique id + kill-on-unmount (unchanged legacy behavior).
  //
  // ID is tileId-only, NOT keyed on cwd. tileIds are already unique
  // (timestamp-derived). Earlier `hm:${cwd}:${tileId}` orphaned a session
  // whenever the containing frame's workspacePath rebound, because mkTile
  // re-threads the new zoneRepo into the cwd prop → ptyId mutates →
  // daemon's stored session becomes unreachable → fresh spawn at new cwd
  // (and the old session leaks until idle GC). Session identity should
  // follow the TILE/FRAME, not the path. The original spawn cwd is still
  // preserved inside the daemon's frozen spec, so claude resumes at the
  // path where its history lives — which is the correct semantics for
  // claude (its session JSONL is tied to that repo).
  const persistent = window.hive.persistentPty === true;
  const ptyId = persistent ? `hm:${tileId}` : `${tileId}-${reactId}`;
  // True only when the user clicks × (explicit close) — then we KILL even in
  // persistent mode. App-close / view-cull unmounts leave it false → detach.
  const killOnUnmountRef = useRef(false);

  // Agent/terminal status — driven by PTY activity, mutated imperatively via
  // refs (NOT React state) so high-frequency output never triggers re-renders.
  //   working = output within the last ~1.5s · idle = quiet · exited = PTY gone
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Wrapper around the status dot+label — hidden entirely while idle. */
  const statusWrapRef = useRef<HTMLSpanElement>(null);

  // Which agent (if any) is running. herdr-ported detection covers 15 CLI
  // agents (claude, codex, gemini, cursor, droid, amp, opencode, grok, …);
  // null = plain shell → cheap activity heuristic only. `isClaude` keeps the
  // send-to-claude bus wiring claude-only.
  const agent = identifyAgent(cmd);
  const isClaude = agent === "claude";
  // NOTE: we deliberately DON'T seed claude's hook-driven turn state on mount.
  // liveTurn is authoritative ONLY once a real UserPromptSubmit/Stop hook fires.
  // An earlier version seeded "idle" here to suppress the stale-replayed-buffer
  // "working" on restart — but that idle seed HARD-overrode the scrape, so a
  // claude process WITHOUT the hooks (any session already running before the
  // hooks were injected) got stuck reading idle while actually working. Now
  // hook-less sessions fall back to the scrape; only a real hook overrides it.
  // The label shown on canvas chips / toasts / notifications. `name` already
  // resolves user-rename ?? agent OSC title ?? auto label (Canvas), so the
  // session title claude writes flows through here. Kept in a ref so the
  // long-lived status effect always publishes the CURRENT label.
  const effLabel = name?.trim() || label || agent || cmd.split("/").slice(-1)[0] || "shell";
  const chipLabelRef = useRef(effLabel);
  const lastStatusRef = useRef<TileStatusKind | null>(null);
  // When the session name changes (claude wrote a new title, or a rename), keep
  // the ref current and re-publish the last status under the new label so the
  // chip / toast / pending notification re-label without waiting for the next
  // status transition.
  useEffect(() => {
    chipLabelRef.current = effLabel;
    if ((agent || lastStatusRef.current === "exited") && lastStatusRef.current) {
      publishStatus({ tileId, label: effLabel, status: lastStatusRef.current });
    }
  }, [effLabel, agent, tileId]);

  useEffect(() => {
    // [color, label, pulse]. permission/question = needs the human (from the
    // real Claude-state scrape); working/idle from screen or PTY activity.
    // Colors routed through the theme palette (no off-token hexes). Reds use
    // --color-err (#f43f5e), not the stray #ff5b5b.
    // Only actionable states (approve / input / blocked) pulse — working is a
    // steady amber dot. Pulsing every active state is the slop tell. Exited
    // reads as neutral gray, not alarm-red. Colors match the --color-* tokens.
    const STATUS: Record<string, [string, string, boolean]> = {
      working: ["#f59e0b", "working", false],
      idle: ["#22c55e", "idle", false],
      exited: ["#6b7280", "exited", false],
      permission: ["#f43f5e", "approve?", true],
      question: ["#5b6cff", "input?", true],
      blocked: ["#f43f5e", "blocked", true],
    };
    const setStatus = (
      s: "working" | "idle" | "exited" | "permission" | "question" | "blocked",
      extra?: { exitCode?: number; detail?: string },
    ) => {
      const dot = dotRef.current;
      const label = labelRef.current;
      if (!dot || !label) return;
      const [color, text, pulse] = STATUS[s]!;
      // `idle` is the ABSENCE of a state, not a state — and it rendered as a green
      // dot, which reads as "success" when it means "nothing is happening". Hide the
      // whole chip so a quiet tile has a quiet header, and every chip that remains
      // (working / approve? / blocked / exited) is worth looking at. Matches
      // LayersPanel, which already skips idle rows.
      if (statusWrapRef.current) statusWrapRef.current.style.display = s === "idle" ? "none" : "inline-flex";
      dot.style.background = color;
      // No glow (box-shadow) — the pulsing-glow-on-dark dot is a textbook
      // AI-slop tell. A solid dot + pulse on actionable states reads cleaner.
      dot.classList.toggle("animate-pulse", pulse);
      label.textContent = text;
      label.style.color = color;
      lastStatusRef.current = s;
      // Broadcast to the Canvas (chips / toasts / done-unseen). Only agent tiles
      // and exits are interesting — a plain shell's working/idle churn is noise.
      // exitCode/detail ride along on an `exited` so the awareness layer can
      // tell a crash (non-zero → error toast) from a clean close and show the code.
      if (agent || s === "exited") {
        publishStatus({ tileId, label: chipLabelRef.current, status: s, ...extra });
      }
    };
    const markActivity = () => {
      setStatus("working");
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setStatus("idle"), 1500);
    };

    // Claude-state detection (working / waiting-approval / question / idle) by
    // scraping xterm's rendered viewport — see ./claude-state.ts.
    const readScreen = (): string => {
      const buf = term.buffer.active;
      const out: string[] = [];
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.baseY + y);
        out.push(line ? line.translateToString(true) : "");
      }
      return out.join("\n");
    };
    let agentPoll: ReturnType<typeof setInterval> | undefined;

    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.3,
      // ONLY when Frost-tile-content is on at mount. allowTransparency disables
      // subpixel-antialiased text (text goes grayscale → softer/blurrier vs a
      // native terminal), so opaque terminals must keep it OFF to stay crisp.
      // (Toggling content-glass later needs a reload to apply to open terminals.)
      allowTransparency: getTheme().glass && getTheme().contentGlass,
      theme: { ...TERM_THEME, background: termBgFor(getTheme()) },
      // No blink — a blinking cursor repaints EVERY terminal ~2×/s forever, so
      // the canvas never feels fully still/crisp (perpetual GPU compositing
      // across all tiles). Cursor stays solid + visible; zero idle repaint.
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
      // Render perf + UX tuning
      fastScrollSensitivity: 5,           // Alt-wheel jumps 5x faster
      scrollSensitivity: 1,
      smoothScrollDuration: 0,            // no smooth-scroll animation; cuts paints
      drawBoldTextInBrightColors: true,   // crisper bold rendering on dark bg
      minimumContrastRatio: 4.5,          // auto-adjust low-contrast cells to WCAG AA
                                          // (color only — doesn't affect sharpness)
      letterSpacing: 0,
      // OSC 8 hyperlinks (claude emits these) → prefer the in-app browser tile.
      // If no canvas callback exists, fall back to the OS browser.
      linkHandler: {
        activate: (_e, uri) => openExternalLink(uri, openInBrowserRef.current),
      },
      // Rescale glyphs that overflow their cell (powerline, wide Unicode,
      // ligature-ish forms) instead of letting them clip/smear — sharper edges.
      rescaleOverlappingGlyphs: true,
      // box-drawing / block chars drawn as crisp vectors, not font bitmaps.
      customGlyphs: true,
      windowsMode: false,
      // Atlas (glyph cache) — "dynamic" is default in xterm 5 but be explicit.
      // The WebGL renderer (loaded below) reuses the atlas across frames.
    });
    // Make plain http(s) URLs in terminal output clickable (claude, build logs,
    // etc.) — single click opens in the in-app browser when available.
    term.loadAddon(new WebLinksAddon((_e, uri) => {
      const web = webUrlForInternalBrowser(uri);
      if (web && openInBrowserRef.current) openInBrowserRef.current(web);
      else openExternalLink(uri);
    }));
    // Make file PATHS clickable too (open in the OS default app) — WebLinksAddon
    // only handles http(s) URLs. Disposed with the terminal on unmount.
    registerFileLinks(
      term,
      () => cwdRef.current,
      (url) => openInBrowserRef.current?.(url),
      (path) => openInEditorRef.current?.(path),
    );
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
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
    // into another tile's terminal, a rename box, or the command palette (all
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
    // Crisp-when-idle: background terminals use the sharp DOM renderer too, EXCEPT
    // while actively streaming (then WebGL, so a multi-agent fan-out doesn't spike
    // the renderer). lastStreamTs tracks recent output; renderer swaps happen only
    // on UNSELECTED tiles (invisible — the selected tile is always DOM).
    let lastStreamTs = 0;
    const STREAM_QUIET_MS = 1500;
    let streamQuietTimer: ReturnType<typeof setTimeout> | undefined;
    // Restore keyboard focus after an operation that recreates the renderer canvas
    // (acquire/release/context-loss) — a focused selected terminal must not silently
    // lose input. Deferred a frame so it runs after the DOM swap settles.
    const restoreFocusIfSelected = () => {
      if (!selectedRef.current) return;
      requestAnimationFrame(() => {
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
      try { fitRef.current?.fit(); term.refresh(0, term.rows - 1); } catch { /* torn down */ }
      requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* torn down */ } });
      restoreFocusIfSelected();
    };
    // Viewport visibility → priority. Assume visible on mount (a fresh tile is
    // usually in view); the observer corrects on the next frame.
    let inViewport = true;
    const io = new IntersectionObserver(
      (entries) => {
        const v = !!entries[entries.length - 1]?.isIntersecting;
        if (v !== inViewport) { inViewport = v; reconcileWebglSlots(); }
      },
      { threshold: 0.01 },
    );
    io.observe(host);
    registerWebglSlotClient({
      id: ptyId,
      priority: () => (selectedRef.current ? 2 : inViewport ? 1 : 0),
      acquire: acquireWebgl,
      release: releaseWebgl,
      // Crisp boost: the FOCUSED tile on a low-DPI screen renders via DOM (native
      // font hinting → sharp, like the system terminal). WebGL's GPU atlas is soft
      // at devicePixelRatio=1; on HiDPI it's already crisp, so no boost there. Only
      // the selected tile boosts, so the heavier DOM renderer is bounded to one
      // terminal — the one you're actually reading.
      //
      // EXCEPT agent tiles: a full-screen agent TUI (codex especially) repaints the
      // whole screen many times per second, and xterm's DOM renderer mutates a DOM
      // node per cell per frame → at that frame rate it's layout/paint storms that
      // make the WHOLE window blink + lag. Agents stay on the GPU (WebGL) renderer,
      // which eats high-frame-rate redraws for free. The DOM boost is for reading
      // static shell output, not driving a live TUI.
      // During a WebGL context-loss cooldown, force DOM regardless of agent/DPI —
      // re-acquiring WebGL would just lose the context again and thrash the canvas.
      wantsDom: () =>
        Date.now() < webglCooldownUntil ||
        // DOM renderer = subpixel-antialiased (sharp, like a native terminal);
        // WebGL = grayscale (softer/blurrier). Use DOM at dpr<2 whenever the tile
        // is SELECTED *or* IDLE (no recent output). Only an UNSELECTED tile that's
        // actively STREAMING stays on WebGL, so a multi-agent fan-out can't
        // re-spike the renderer. Swaps happen only on unselected tiles → invisible.
        ((window.devicePixelRatio || 1) < 2 &&
          (selectedRef.current === true || Date.now() - lastStreamTs > STREAM_QUIET_MS)),
    });

    // Agents set the terminal window title (OSC 0/2) to a live task summary —
    // claude's "session name". Surface it to Canvas as this tile's name. Skip
    // plain shells, whose titles are noisy "user@host:cwd" chrome.
    //
    // THROTTLED: claude rewrites its window title repeatedly while working. The
    // canvas node-data memo keys on agentTitles, so an un-throttled stream churns
    // the whole canvas while you're typing into a working tile → input jank /
    // focus loss + lag. Collapse to one trailing update per window; the name is
    // cosmetic so a fraction-of-a-second delay is invisible.
    let titleTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTitle: string | null = null;
    const offTitle = agent
      ? term.onTitleChange((t) => {
          const title = normalizeAgentTitle(t);
          if (!title) return;
          pendingTitle = title;
          if (titleTimer) return;
          titleTimer = setTimeout(() => {
            titleTimer = undefined;
            if (pendingTitle) onAgentTitle?.(tileId, pendingTitle);
          }, 600);
        })
      : undefined;

    let exited = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubClaude: (() => void) | undefined;

    // Rebuild the glyph atlas once the web font is truly loaded. xterm measures
    // the font at open(); "JetBrains Mono" loads async (web font), so the first
    // atlas is often built from FALLBACK metrics → permanently blurry glyphs that
    // never self-correct. Force-load the exact faces, then re-fit + clear the
    // WebGL texture atlas so glyphs re-rasterize at the right metrics + density.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      const fams = ['400 12px "JetBrains Mono"', '700 12px "JetBrains Mono"'];
      Promise.all(fams.map((f) => document.fonts.load(f).catch(() => undefined)))
        .then(() => document.fonts.ready)
        .then(() => {
          if (cancelled) return;
          try {
            fit.fit();
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

    // Subscribe to PTY data/exit BEFORE awaiting ptySpawn. The main process
    // attaches its `p.onData` listener inside spawnPty() and the kernel pipe
    // can deliver bytes (e.g. shell rc-file prompt) before our await resolves
    // here. Subscribing first means we never drop the opening banner.
    unsubData = window.hive.onPtyData(ptyId, (d) => {
      term.write(d);
      // Crisp-when-idle renderer choice: note the stream, and reconcile only on
      // TRANSITIONS (quiet→streaming now, streaming→quiet later) and only for an
      // UNSELECTED tile (the selected tile is always DOM, so it never swaps).
      const wasQuiet = Date.now() - lastStreamTs > STREAM_QUIET_MS;
      lastStreamTs = Date.now();
      if (wasQuiet && !selectedRef.current) reconcileWebglSlots();
      clearTimeout(streamQuietTimer);
      streamQuietTimer = setTimeout(() => {
        if (!selectedRef.current) reconcileWebglSlots();
      }, STREAM_QUIET_MS + 120);
      // Agent tiles get authoritative state from the screen poll (mark dirty so
      // the next poll tick actually scans); plain shells use the cheap heuristic.
      if (agent) {
        agentDirty = true;
        // Ground-truth liveness: a working agent streams output. noteOutput keeps
        // a "working" status honored; its absence lets the status bus decay a
        // stuck "working" (missed Stop hook / frozen replayed buffer) to idle.
        noteOutput(tileId);
      } else markActivity();
    });
    unsubExit = window.hive.onPtyExit(ptyId, ({ code, signal }) => {
      term.writeln(
        `\r\n\x1b[2m[hivemind] exited code=${code} signal=${signal ?? ""} — press Enter to restart\x1b[0m`,
      );
      exited = true;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (agentPoll) { clearInterval(agentPoll); agentPoll = undefined; }
      // Thread the exit code + a one-line detail so the awareness layer can
      // raise an "error" toast for a crash (non-zero) vs. stay quiet on a clean
      // close, and show the code in the body. (signal here is the numeric value
      // sent by node-pty; name it generically — a non-null signal implies kill.)
      const detail = signal !== undefined && signal !== null ? `killed by signal ${signal}` : undefined;
      setStatus("exited", { exitCode: code, detail });
    });
    term.onData((d) => {
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
      window.hive.ptyWrite(ptyId, d);
    });
    term.onResize(({ cols, rows }) => window.hive.ptyResize(ptyId, cols, rows));
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
      if (!(e.ctrlKey || e.metaKey)) return true;
      // Diagnostics HUD toggle (Ctrl/Cmd+Shift+D), broadcast to every tile.
      if (e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setTermDebug(!loadTermDebug());
        return false;
      }
      // Font zoom: Ctrl/Cmd +/−/0 adjusts THIS tile's font (per-tile). The apply
      // effect below pushes the new size into xterm.
      if (handleFontKey(e, fontCtlRef.current)) {
        return false;
      }
      if (e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          void navigator.clipboard.writeText(sel).catch(() => {});
          term.clearSelection();
          return false; // copied → don't send ^C
        }
        return true; // nothing selected → ^C / SIGINT
      }
      return true;
    });
    // Cross-tile bus: if this PTY is a claude session, accept ADDRESSED text
    // (see claude-bus.ts). Registering makes this the "latest" claude so a
    // bare/`latest` send lands here only — no more broadcast to every agent.
    if (isClaude) {
      registerClaude(tileId);
      const onSend = (e: Event) => {
        const detail = (e as CustomEvent<string | SendToClaudeDetail>).detail;
        const { deliver, text } = shouldDeliver(tileId, detail);
        // Type the text, THEN press Enter as a SEPARATE keystroke a tick later.
        // A single "text\n" write reaches claude's TUI before it has staged the
        // paste, so the newline is dropped and the prompt sits unsubmitted.
        if (deliver && text) {
          window.hive.ptyWrite(ptyId, text);
          setTimeout(() => window.hive.ptyWrite(ptyId, "\r"), SUBMIT_DELAY_MS);
        }
      };
      window.addEventListener("hivemind:send-to-claude", onSend as EventListener);
      unsubClaude = () => {
        unregisterClaude(tileId);
        window.removeEventListener("hivemind:send-to-claude", onSend as EventListener);
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
        const initialPrompt = deliversPromptViaArgv(agent) ? claimWork(ptyId) : undefined;
        const { pid } = await window.hive.ptySpawn({
          tileId: ptyId,
          cwd,
          cmd,
          args: args ?? [],
          cols: term.cols,
          rows: term.rows,
          ...(initialPrompt ? { initialPrompt } : {}),
        });
        if (cancelled) {
          window.hive.ptyKill(ptyId);
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
        try { fit.fit(); } catch { /* torn down */ }
        window.hive.ptyResize(ptyId, term.cols, term.rows);
        term.writeln(`\x1b[2m[hivemind] spawned ${cmd} (pid ${pid})\x1b[0m`);
        setStatus("idle");
        if (agent && !agentPoll) {
          // Stabilizer state for claude's between-tool idle blip (see
          // stabilizeClaudeStatus). Tracks the previous reported status and the
          // last time work was seen, across poll ticks.
          let lastReported: TileStatus = "idle";
          const lastWorkingAt = { t: null as number | null };
          // Queued-prompt ("Work on this" / workflow) delivery: deliver EXACTLY
          // ONCE, when the agent's screen has SETTLED (boot/splash output stopped
          // = it's at a ready input prompt), then consume it. Delivering on the
          // first scrape-"idle" raced droid's ~6s boot (its splash scrapes as idle
          // the WHOLE time, before the input is interactive); re-delivering on each
          // idle poll caused DUPLICATE submissions (droid buffers them all). The
          // "settled" signal = N consecutive QUIET ticks (no new pty output) —
          // robust for any agent (claude/codex/droid/…), not tied to scrape status.
          let workQuietTicks = 0;
          const WORK_SETTLE_TICKS = 2; // ~2.4s of quiet after boot → ready prompt
          agentPoll = setInterval(() => {
            // One-shot delivery — runs BEFORE the agentDirty early-return so it can
            // fire while the agent is quiet (the exact "ready" moment). claimWork
            // consumes, so the prompt can never be submitted twice.
            if (agent && peekWork(tileId)) {
              if (agentDirty) workQuietTicks = 0; else workQuietTicks++;
              if (workQuietTicks >= WORK_SETTLE_TICKS) {
                const work = claimWork(tileId);
                if (work) {
                  window.hive.ptyWrite(ptyId, work);
                  setTimeout(() => window.hive.ptyWrite(ptyId, "\r"), SUBMIT_DELAY_MS);
                  // Backstop: a fresh claude TUI can drop that first Enter, leaving
                  // the prompt typed-but-unsubmitted (the "I had to press Enter"
                  // bug). Re-send Enter ONCE, but only if the agent is STILL idle —
                  // i.e. it never submitted. If the first Enter landed, the agent is
                  // "working" by now and this no-ops (no stray empty submit).
                  setTimeout(() => {
                    if (lastReported === "idle") window.hive.ptyWrite(ptyId, "\r");
                  }, SPAWN_SUBMIT_RETRY_MS);
                  void window.hive.diagLog?.(`[work-deliver] tile=${tileId} agent=${agent} settled`);
                }
              }
            }
            // Re-evaluate the bus status every tick (even with no new output) so
            // the time-based staleness gate can decay a stuck "working" (missed
            // Stop hook / frozen replayed buffer) to idle on its own.
            if (agent) revalidate(tileId);
            // Keep scanning even while the window is hidden/minimized — that is
            // exactly when an OS notification matters. Cost is bounded by
            // agentDirty: a quiet, hidden tile never materializes its viewport.
            if (!agentDirty) return; // no output since last scan → nothing changed
            agentDirty = false;
            try {
              const raw = detectTileStatus(agent, readScreen());
              // Anti-flicker for the between-tool idle blip — applied to EVERY
              // agent, not just claude. A momentary idle during work used to
              // publish straight through for non-claude agents, and Canvas
              // re-derives "finished" from working→idle → a spurious done toast
              // + OS notification on the flicker. Debounce uniformly here so the
              // published status is the single source the rest of the app trusts.
              const next = stabilizeClaudeStatus(lastReported, raw, Date.now(), lastWorkingAt);
              lastReported = next;
              setStatus(next);
            } catch { /* buffer not ready */ }
          }, 1200);
        }
      } catch (e) {
        term.writeln(`\x1b[31m[hivemind] spawn failed: ${(e as Error).message}\x1b[0m`);
        exited = true;
        setStatus("exited");
      }
    }
    void doSpawn();

    // Debounce fit() across ResizeObserver bursts. During a drag-resize, RO
    // fires ~60Hz; each fit recomputes cell geometry AND triggers an IPC
    // ioctl resize on the kernel PTY. Coalescing to one rAF tick cuts that
    // to display-refresh rate and stops the resize handle from jittering.
    let fitRaf = 0;
    const ro = new ResizeObserver(() => {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        try {
          fit.fit();
          // Anchor to the bottom after a resize so the LATEST output + prompt
          // stay visible. xterm's reflow can otherwise leave the viewport
          // scrolled up — shrinking a tile "cropped" the live prompt off the
          // bottom and showed stale lines instead.
          term.scrollToBottom();
        } catch {
          /* ignore */
        }
      });
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (agentPoll) clearInterval(agentPoll);
      if (streamQuietTimer) clearTimeout(streamQuietTimer);
      unsubData?.();
      unsubExit?.();
      unsubClaude?.();
      offTitle?.dispose();
      inputEl?.removeEventListener("blur", onInputBlur);
      if (titleTimer) clearTimeout(titleTimer);
      clearWork(tileId);
      clearStatus(tileId);
      clearWork(tileId);
      ro.disconnect();
      io.disconnect();
      // Unregister from the slot manager — this releases our WebGL slot (disposes
      // the addon + dpr override) and lets another tile claim it.
      unregisterWebglSlotClient(ptyId);
      try {
        // Persistent + not an explicit close → detach (keep the session alive
        // in the daemon). Otherwise kill.
        if (persistent && !killOnUnmountRef.current) window.hive.ptyDetach(ptyId);
        else window.hive.ptyKill(ptyId);
      } catch {
        /* ignore */
      }
      cancelMousePatch();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
    // `args` is excluded from deps intentionally — Canvas/parent recreates the
    // array on every render so reference equality would always fail and cause
    // a PTY respawn on every parent re-render. We freeze args on first mount.
    // (For real argv changes, change the cmd or destroy/recreate the tile.)
    //
    // `cwd` is excluded too in PERSISTENT mode: ptyId is now keyed on tileId
    // only (frame-stable across workspace rebinding), and the daemon owns the
    // original spawn cwd inside the frozen spec. A cwd-only prop change with
    // a live session would otherwise tear down → re-attach silently (daemon
    // ignores new cwd on re-attach), looking like "nothing happened" with no
    // visible signal that the rebind didn't apply. Keep cwd in deps for the
    // non-persistent path where a fresh PTY at the new cwd IS the right thing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, persistent ? [ptyId, cmd] : [ptyId, cwd, cmd]);

  // Gate keyboard on selection. pointer-events:none (tile-locked) blocks the
  // mouse but NOT the keyboard — a focused xterm keeps eating keystrokes after
  // you deselect the tile. disableStdin makes xterm ignore input entirely when
  // unselected; selecting re-enables + focuses so one click puts you in.
  useEffect(() => {
    // Focus changed → re-rank renderers. The focused tile boosts to the CRISP
    // renderer: DOM (native hinting) on a low-DPI screen, WebGL on HiDPI. Others
    // hold WebGL within budget. (selectedRef is already current from render.)
    reconcileWebglSlots();
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !selected;
    if (selected) {
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
  }, [selected]);

  // Apply THIS tile's font size to xterm whenever it changes, then re-fit so
  // cols/rows track the new cell size.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = font.size;
    try {
      fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
    } catch { /* torn down */ }
  }, [font.size]);

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
      term.refresh(0, term.rows - 1);
      if (selectedRef.current) term.focus();
    },
  });

  // Global scale shortcuts (main → App → CustomEvent), targeting the SELECTED
  // tile only — mirrors the per-tile font keys. Ctrl/Cmd+Shift+F toggles the fit
  // overlay; Ctrl/Cmd+Shift+0 grows the font to the screen's best (auto-reset).
  useEffect(() => {
    const onFit = () => { if (selectedRef.current) setOverlay((v) => !v); };
    const onReset = () => { if (selectedRef.current) fontCtlRef.current.best(); };
    window.addEventListener("hivemind:fit-overlay", onFit);
    window.addEventListener("hivemind:reset-scale", onReset);
    return () => {
      window.removeEventListener("hivemind:fit-overlay", onFit);
      window.removeEventListener("hivemind:reset-scale", onReset);
    };
  }, []);

  // Sync the HUD toggle across tiles.
  useEffect(() => {
    const onDbg = (e: Event) => setDebug((e as CustomEvent<boolean>).detail);
    window.addEventListener("hivemind:term-debug", onDbg as EventListener);
    return () => window.removeEventListener("hivemind:term-debug", onDbg as EventListener);
  }, []);

  // Poll the live render state while the HUD is open. Reads computed styles
  // imperatively (no React subscription) so it's free when off.
  useEffect(() => {
    if (!debug) return;
    const read = () => {
      const host = hostRef.current;
      const term = termRef.current;
      if (!host) return;
      const xterm = host.querySelector(".xterm") as HTMLElement | null;
      const rows = host.querySelector(".xterm-rows") as HTMLElement | null;
      const csX = xterm ? getComputedStyle(xterm) : null;
      const csR = rows ? getComputedStyle(rows) : null;
      const zoom = readCanvasZoom();
      setDiag({
        zoom: zoom.toFixed(3) + (Math.abs(zoom - 1) < 0.001 ? " ✓1:1" : " ✗blur"),
        dpr: `${window.devicePixelRatio || 1} → atlas@${effectiveDpr(window.devicePixelRatio || 1)}x`,
        font: term ? `${term.options.fontSize}px` : "?",
        grid: term ? `${term.cols}×${term.rows}` : "?",
        "will-change": csX?.willChange || "?",
        transform: csX && csX.transform !== "none" ? "LAYER ✗" : "none ✓",
        smoothing: csR?.getPropertyValue("-webkit-font-smoothing").trim() || "?",
        moving: document.querySelector(".canvas-moving") ? "STUCK ✗" : "no ✓",
        selected: selected ? "yes" : "no",
      });
    };
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
  }, [debug, selected]);

  // Auto-log the render state across a FOCUS (even with the HUD off), so the
  // "quality drops on focus" window is always captured to render-diag.log and
  // readable off disk / over SSH. Sample during the zoom animation and after it
  // settles — the will-change/zoom transients live in that window.
  useEffect(() => {
    if (!selected) return;
    const host = hostRef.current;
    if (!host) return;
    const snap = (phase: string) => {
      const xterm = host.querySelector(".xterm") as HTMLElement | null;
      const rows = host.querySelector(".xterm-rows") as HTMLElement | null;
      const csX = xterm ? getComputedStyle(xterm) : null;
      const csR = rows ? getComputedStyle(rows) : null;
      const term = termRef.current;
      const zoom = readCanvasZoom();
      const line =
        `[focus:${phase}] tile=${effLabel} zoom=${zoom.toFixed(3)} dpr=${window.devicePixelRatio || 1} ` +
        `font=${term?.options.fontSize ?? "?"} grid=${term ? `${term.cols}x${term.rows}` : "?"} ` +
        `will-change=${csX?.willChange ?? "?"} transform=${csX && csX.transform !== "none" ? "LAYER" : "none"} ` +
        `smoothing=${csR?.getPropertyValue("-webkit-font-smoothing").trim() || "?"} ` +
        `moving=${document.querySelector(".canvas-moving") ? "yes" : "no"}`;
      void window.hive.diagLog?.(line);
    };
    snap("t0");
    const t1 = setTimeout(() => snap("t200"), 200);
    const t2 = setTimeout(() => snap("settled"), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [selected, effLabel]);

  return (
    <div className="hm-term-root flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* Entire header is the drag handle. Previously only the ⋮⋮ icon (~5px
          wide) carried `.tile-drag-handle` — invisible target, users
          clicked the wide header bar expecting drag and nothing happened
          (verified via playwright element-from-point probe). */}
      <div className="group tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { onRename?.(tileId, draft); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename?.(tileId, draft); setEditing(false); }
              if (e.key === "Escape") { setDraft(name ?? ""); setEditing(false); }
            }}
            className="nodrag bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1 py-0.5 text-[11px] font-mono text-[var(--color-fg)] outline-none w-32"
            placeholder="Terminal"
          />
        ) : (
          <>
            <button
              onDoubleClick={() => { setDraft(name ?? "Terminal"); setEditing(true); }}
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
            <button
              onClick={() => { setDraft(name ?? "Terminal"); setEditing(true); }}
              className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-[opacity,color,background-color] duration-150 cursor-pointer"
              aria-label="rename tile"
              title="Rename tile"
            >
              <Pencil size={10} aria-hidden />
            </button>
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
        {/* Font / scale / fullscreen controls — revealed only on header hover
            (group-hover). Two SEPARATE controls: font size (A−/A+, density only)
            and whole-tile scale (−/+, grows the node box + font in proportion). */}
        <span className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
          {/* Font size only (A−/A+) */}
          <span className="nodrag inline-flex items-center rounded bg-[var(--color-bg)] border border-[var(--color-line2)] overflow-hidden" title="Font size (Ctrl/Cmd ±)">
            <button
              onClick={font.dec}
              className="px-1 text-[10px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
              aria-label="decrease font size"
            >
              A−
            </button>
            <button
              onClick={font.inc}
              className="px-1 text-[11px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center border-l border-[var(--color-line2)]"
              aria-label="increase font size"
            >
              A+
            </button>
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
          <button
            onClick={() => setOverlay((v) => !v)}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-colors cursor-pointer text-[11px] leading-none"
            aria-label="fullscreen terminal"
            title="Fullscreen (Ctrl/Cmd ⇧F) · Esc to exit"
          >
            ⤢
          </button>
        </span>
        <span
          ref={statusWrapRef}
          className="inline-flex items-center gap-1.5 text-[10px]"
          title="agent status — working / blocked / exited (idle is not shown)"
        >
          <span
            ref={dotRef}
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ background: "var(--color-fg3)" }}
          />
          <span ref={labelRef} style={{ color: "var(--color-fg3)" }}>
            starting
          </span>
        </span>
        {/* Pin toggle — docked in the header next to close (not a floating chip). */}
        <HeaderPinButton tileId={tileId} pinned={pinned} onToggle={onTogglePin} />
        {/* nodrag — react-flow ignores drag from elements with this class so
            clicking the × button doesn't start a tile drag. */}
        <button
          className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-colors cursor-pointer"
          aria-label="close tile"
          onClick={() => {
            // Explicit close kills the session even in persistent mode.
            killOnUnmountRef.current = true;
            onClose?.();
          }}
          title="close tile"
        >
          ×
        </button>
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
      <div className="hm-term-host relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[#300A24] p-1.5">
        <div ref={hostRef} className="w-full h-full overflow-hidden" />
        {debug && (
          <div className="nodrag pointer-events-none absolute top-1 right-1 z-50 rounded bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-[#9fe6a0] ring-1 ring-white/15">
            <div className="mb-0.5 font-semibold text-white/70">render diag · ⌃⇧D</div>
            {Object.entries(diag).map(([k, v]) => (
              <div key={k}>
                <span className="text-white/45">{k}:</span> {v}
              </div>
            ))}
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
