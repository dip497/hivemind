import { useEffect, useId, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { identifyAgent, detectTileStatus, stabilizeClaudeStatus, normalizeAgentTitle, type TileStatus } from "./agent-state";
import { registerClaude, unregisterClaude, shouldDeliver, claimWork, clearWork, type SendToClaudeDetail } from "./claude-bus";
import { publishStatus, clearStatus, type TileStatusKind } from "./agent-status-bus";
import { Pencil } from "lucide-react";

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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
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
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        // Cool deep-navy to match the Huly/Plane theme (was warm orange/black).
        background: "#0d0e12",
        foreground: "#e7e9ee",
        cursor: "#5b6cff",
        cursorAccent: "#0d0e12",
        selectionBackground: "rgba(91,108,255,0.30)",
        black: "#0d0e12",
        brightBlack: "#6b7280",
        red: "#f43f5e",
        brightRed: "#fb7185",
        green: "#22c55e",
        brightGreen: "#4ade80",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        blue: "#5b6cff",
        brightBlue: "#818cf8",
        magenta: "#a855f7",
        brightMagenta: "#c084fc",
        cyan: "#38bdf8",
        brightCyan: "#7dd3fc",
        white: "#e7e9ee",
        brightWhite: "#ffffff",
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
      letterSpacing: 0,
      windowsMode: false,
      // Atlas (glyph cache) — "dynamic" is default in xterm 5 but be explicit.
      // The WebGL renderer (loaded below) reuses the atlas across frames.
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // WebGL renderer with onContextLoss handler: GPU drivers can yank the
    // context (sleep/wake, driver reset, tab discard) — without disposing the
    // addon, xterm keeps issuing draw calls into a dead context and the term
    // freezes mid-paint. onContextLoss → dispose addon → xterm falls back to
    // the DOM renderer transparently on the next refresh.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl?.dispose(); } catch { /* already disposed */ }
        webgl = undefined;
      });
      term.loadAddon(webgl);
    } catch {
      /* WebGL not available — falls back to DOM renderer automatically. */
    }
    fit.fit();
    termRef.current = term;

    // Agents set the terminal window title (OSC 0/2) to a live task summary —
    // claude's "session name". Surface it to Canvas as this tile's name. Skip
    // plain shells, whose titles are noisy "user@host:cwd" chrome.
    const offTitle = agent
      ? term.onTitleChange((t) => {
          const title = normalizeAgentTitle(t);
          if (title) onAgentTitle?.(tileId, title);
        })
      : undefined;

    let cancelled = false;
    let exited = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubClaude: (() => void) | undefined;

    // Rebuild the glyph atlas once the web font is truly loaded. xterm measures
    // the font at open(); "JetBrains Mono" loads async (web font), so the first
    // atlas is often built from the FALLBACK metrics → permanently blurry /
    // misaligned glyphs that never self-correct. Force-load the exact faces, then
    // re-fit + clear the WebGL texture atlas + refresh so glyphs re-rasterize at
    // the correct metrics. Usually instant (font is cached after the first tile).
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
    // Clipboard: xterm does NOT copy/paste on its own (Ctrl+C just sends SIGINT).
    // Wire the standard terminal behavior:
    //   • Cmd/Ctrl(+Shift)+C → copy the selection (and clear it, so a second
    //     press still sends SIGINT). Plain Ctrl+C with NOTHING selected falls
    //     through to the PTY as ^C. This is the VS Code / Windows Terminal rule.
    //   • Cmd/Ctrl(+Shift)+V → paste (term.paste respects bracketed-paste mode).
    // Returning false stops xterm from also forwarding the key to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!(e.ctrlKey || e.metaKey)) return true;
      const k = e.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          void navigator.clipboard.writeText(sel).catch(() => {});
          term.clearSelection();
          return false; // copied → don't send ^C
        }
        return true; // nothing selected → ^C / SIGINT
      }
      if (k === "v") {
        e.preventDefault(); // stop the browser pasting into xterm's helper textarea too
        void navigator.clipboard.readText().then((t) => {
          if (t && !exited) term.paste(t);
        }).catch(() => {});
        return false;
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
              const next = isClaude
                ? stabilizeClaudeStatus(lastReported, raw, Date.now(), lastWorkingAt)
                : raw;
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
      try {
        // Persistent + not an explicit close → detach (keep the session alive
        // in the daemon). Otherwise kill.
        if (persistent && !killOnUnmountRef.current) window.hive.ptyDetach(ptyId);
        else window.hive.ptyKill(ptyId);
      } catch {
        /* ignore */
      }
      try { webgl?.dispose(); } catch { /* already gone */ }
      term.dispose();
      termRef.current = null;
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
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !selected;
    if (selected) term.focus();
    else term.blur();
  }, [selected]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* Entire header is the drag handle. Previously only the ⋮⋮ icon (~5px
          wide) carried `.tile-drag-handle` — invisible target, users
          clicked the wide header bar expecting drag and nothing happened
          (verified via playwright element-from-point probe). */}
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <span aria-hidden className="text-[var(--color-fg3)] tracking-tighter">
          ⋮⋮
        </span>
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
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px]" title="agent status — working / idle / blocked / exited">
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
      <div ref={hostRef} className="flex-1 bg-black p-1.5" />
    </div>
  );
}
