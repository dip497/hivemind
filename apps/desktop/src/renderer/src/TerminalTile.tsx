import { useEffect, useId, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { installCrispDpr, effectiveDpr } from "./terminal-dpr";
import { registerWebglSlotClient, unregisterWebglSlotClient, reconcileWebglSlots } from "./webgl-slots";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import { identifyAgent, detectTileStatus, stabilizeClaudeStatus, normalizeAgentTitle, type TileStatus } from "./agent-state";
import { registerClaude, unregisterClaude, shouldDeliver, claimWork, clearWork, type SendToClaudeDetail } from "./claude-bus";
import { publishStatus, clearStatus, type TileStatusKind } from "./agent-status-bus";
import { Pencil, GripVertical } from "lucide-react";

/** Open a terminal link in the OS browser. window.open is intercepted by main's
 *  setWindowOpenHandler → shell.openExternal (and the in-app navigation denied),
 *  so no popup window appears. Only http(s) — never file:/ javascript: etc. */
function openExternalLink(uri: string): void {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") {
      window.open(uri, "_blank", "noopener,noreferrer");
    }
  } catch { /* not a parseable URL — ignore */ }
}

// Default terminal font size. Each tile remembers its OWN size (useTileFont keyed
// by tileId) — A−/A+ in the header + Ctrl/Cmd +/−/0 adjust it. Crispness is
// DPR-driven (see terminal-dpr.ts), so 12 is the default purely for density.
const DEFAULT_FONT = 12;

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
  /** Clip-to-pile: open Canvas-level popover to add this tile to a pile. */
  onClose?: () => void;
  /** Tile selection — when false, xterm stdin is disabled + blurred so an
   *  unselected tile can't receive keystrokes (pointer-events:none only blocks
   *  the mouse, not the keyboard). Click the tile to select → typing works. */
  selected?: boolean;
}

export function TerminalTile({ tileId, cwd, cmd, args, label, name, onRename, onAgentTitle, onClose, selected }: Props) {
  // Editable header name: starts in display mode; double-click opens input.
  // Persists via onRename → Canvas tileNames → LAYOUT_KEY localStorage.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  // Render-quality HUD (Ctrl/Cmd+Shift+D). `diag` holds the live readings.
  const [debug, setDebug] = useState<boolean>(loadTermDebug);
  const [diag, setDiag] = useState<Record<string, string>>({});
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Live `selected` for the WebGL slot manager's priority() (read outside render).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Per-tile font size (A−/A+ + Ctrl/Cmd +/−/0). fontSizeRef gives the mount
  // effect the initial size; fontCtlRef lets the xterm key handler (a closure)
  // call the current inc/dec/reset.
  const font = useTileFont(tileId, DEFAULT_FONT);
  const fontSizeRef = useRef(font.size);
  fontSizeRef.current = font.size;
  const fontCtlRef = useRef(font);
  fontCtlRef.current = font;
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

  // Which agent (if any) is running. herdr-ported detection covers 15 CLI
  // agents (claude, codex, gemini, cursor, droid, amp, opencode, grok, …);
  // null = plain shell → cheap activity heuristic only. `isClaude` keeps the
  // send-to-claude bus wiring claude-only.
  const agent = identifyAgent(cmd);
  const isClaude = agent === "claude";
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
    const setStatus = (s: "working" | "idle" | "exited" | "permission" | "question" | "blocked") => {
      const dot = dotRef.current;
      const label = labelRef.current;
      if (!dot || !label) return;
      const [color, text, pulse] = STATUS[s]!;
      dot.style.background = color;
      // No glow (box-shadow) — the pulsing-glow-on-dark dot is a textbook
      // AI-slop tell. A solid dot + pulse on actionable states reads cleaner.
      dot.classList.toggle("animate-pulse", pulse);
      label.textContent = text;
      label.style.color = color;
      lastStatusRef.current = s;
      // Broadcast to the Canvas (chips / toasts / done-unseen). Only agent tiles
      // and exits are interesting — a plain shell's working/idle churn is noise.
      if (agent || s === "exited") {
        publishStatus({ tileId, label: chipLabelRef.current, status: s });
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
      theme: {
        // Ubuntu / GNOME Terminal defaults: the signature aubergine background +
        // the Tango ANSI palette. Applies to every terminal tile (claude + shells).
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
      },
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
      // OSC 8 hyperlinks (claude emits these) → open in the OS browser. Plain
      // http(s) URLs are handled by WebLinksAddon below; both route through
      // window.open, which main's setWindowOpenHandler sends to shell.openExternal.
      linkHandler: {
        activate: (_e, uri) => openExternalLink(uri),
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
    // etc.) — single click opens in the OS browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => openExternalLink(uri)));
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

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
    const acquireWebgl = () => {
      if (webgl || cancelled) return;
      try {
        const w = new WebglAddon();
        webgl = w;
        webglRef.current = w;
        // Context can be evicted (driver reset, GL pressure). Drop to DOM, repaint
        // so the tile is never blank, and reconcile so the slot frees for another.
        w.onContextLoss(() => {
          try { disposeDpr?.(); } catch { /* gone */ }
          disposeDpr = undefined;
          try { w.dispose(); } catch { /* disposed */ }
          if (webgl === w) { webgl = undefined; webglRef.current = null; }
          try { term.refresh(0, term.rows - 1); } catch { /* torn down */ }
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
      wantsDom: () => selectedRef.current === true && (window.devicePixelRatio || 1) < 2,
    });

    // Agents set the terminal window title (OSC 0/2) to a live task summary —
    // claude's "session name". Surface it to Canvas as this tile's name. Skip
    // plain shells, whose titles are noisy "user@host:cwd" chrome.
    const offTitle = agent
      ? term.onTitleChange((t) => {
          const title = normalizeAgentTitle(t);
          if (title) onAgentTitle?.(tileId, title);
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
      // Agent tiles get authoritative state from the screen poll (mark dirty so
      // the next poll tick actually scans); plain shells use the cheap heuristic.
      if (agent) agentDirty = true;
      else markActivity();
    });
    unsubExit = window.hive.onPtyExit(ptyId, ({ code, signal }) => {
      term.writeln(
        `\r\n\x1b[2m[hivemind] exited code=${code} signal=${signal ?? ""} — press Enter to restart\x1b[0m`,
      );
      exited = true;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (agentPoll) { clearInterval(agentPoll); agentPoll = undefined; }
      setStatus("exited");
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
        if (deliver && text) window.hive.ptyWrite(ptyId, text + "\n");
      };
      window.addEventListener("hivemind:send-to-claude", onSend as EventListener);
      unsubClaude = () => {
        unregisterClaude(tileId);
        window.removeEventListener("hivemind:send-to-claude", onSend as EventListener);
      };
    }

    async function doSpawn() {
      try {
        const { pid } = await window.hive.ptySpawn({
          tileId: ptyId,
          cwd,
          cmd,
          args: args ?? [],
          cols: term.cols,
          rows: term.rows,
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
          agentPoll = setInterval(() => {
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
              // First time claude reaches a ready input prompt, deliver any
              // queued "Work on this" prompt to ITSELF (claimWork is one-shot).
              // This replaces the old blind 2500ms send and waits for real
              // readiness instead of racing claude+MCP startup.
              if (isClaude && next === "idle") {
                const work = claimWork(tileId);
                if (work) window.hive.ptyWrite(ptyId, work + "\n");
              }
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
      unsubData?.();
      unsubExit?.();
      unsubClaude?.();
      offTitle?.dispose();
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
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* Entire header is the drag handle. Previously only the ⋮⋮ icon (~5px
          wide) carried `.tile-drag-handle` — invisible target, users
          clicked the wide header bar expecting drag and nothing happened
          (verified via playwright element-from-point probe). */}
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
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
              className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-colors cursor-pointer"
              aria-label="rename tile"
              title="Rename tile"
            >
              <Pencil size={10} aria-hidden />
            </button>
          </>
        )}
        <span aria-hidden className="text-[var(--color-line2)]">·</span>
        <span className="text-[var(--color-fg2)]">{cmd.split("/").slice(-1)[0]}</span>
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px]" title="agent status — working / idle / blocked / exited">
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
      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[#300A24] p-1.5">
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
    </div>
  );
}
