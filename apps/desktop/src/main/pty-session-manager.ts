/**
 * SessionManager — the persistence core for tmux-style terminal survival.
 *
 * Owns a set of long-lived PTY sessions keyed by a STABLE id (`repo:tileId`).
 * Each session feeds output into BOTH the connected client AND a server-side
 * headless xterm.js instance — replay on reattach is `SerializeAddon.serialize()`
 * (a coalesced VT-escape string that reproduces the current visible screen +
 * scrollback). This is the Mosh-style "current state, not raw byte tail" model:
 * reopening a tile after hours of idle shows the LAST screen, correctly handling
 * alt-screen (vim/htop), SGR colors, cursor — not a fast-forward of the last
 * 256 KB of stream. See research/persistence-plan.md.
 *
 * The PTY is abstracted behind an injected factory so the persistence logic
 * (attach / detach-keeps-alive / replay / kill / idle-shutdown) is unit-testable
 * with a fake PTY — real `@lydell/node-pty` needs the Electron ABI and won't
 * load under `tsx --test`.
 *
 * The daemon (pty-daemon.ts) wraps this in a Unix-socket server. Persistence:
 *   - attach   → spawn if new, else replay headless-snapshot + resume live
 *   - detach   → drop the client but KEEP the process running (window closed)
 *   - kill     → terminate the process + remove snapshot (explicit × close)
 *   - idle     → when zero sessions remain, fire onEmpty after idleMs (daemon exit)
 *   - reboot   → daemon dies → on next boot, frozen snapshots are restored as
 *                "frozen sessions". On attach, daemon REPLAYS the snapshot to
 *                the client, then SPAWNS a fresh PTY with the stored spec
 *                (cwd/cmd/env). PTY itself can't survive reboot — but the
 *                user sees their last visible state + a working fresh shell.
 */
// @xterm/headless + @xterm/addon-serialize ship as CommonJS bundles. ESM
// named-import interop is fragile across Node versions (tsx-loader fails the
// static analysis), so we go through the default export and destructure at
// runtime — that path is stable in both ESM and CJS.
import HeadlessXterm from "@xterm/headless";
import SerializeAddonNS from "@xterm/addon-serialize";
const HeadlessTerminal = (HeadlessXterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal }).Terminal
  ?? (HeadlessXterm as unknown as typeof import("@xterm/headless").Terminal);
const SerializeAddon = (SerializeAddonNS as unknown as { SerializeAddon: typeof import("@xterm/addon-serialize").SerializeAddon }).SerializeAddon
  ?? (SerializeAddonNS as unknown as typeof import("@xterm/addon-serialize").SerializeAddon);
type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;
type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

export interface ManagedPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number, signal: number | undefined) => void): void;
}

export interface SpawnSpec {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export type PtyFactory = (spec: SpawnSpec) => ManagedPty;

export interface SessionClient {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
}

export interface AttachResult {
  pid: number;
  isNew: boolean;
  /** Buffered output to replay into xterm so the screen looks continuous. */
  replay: string;
}

interface Session {
  id: string;
  pty: ManagedPty;
  /** Headless xterm fed every byte the PTY emits. `serializer.serialize()` on
   *  this produces the replay payload — Mosh-style coalesced visible state. */
  term: HeadlessTerminalInstance;
  serializer: SerializeAddonInstance;
  spec: SpawnSpec;
  exited: boolean;
  client: SessionClient | null;
  /** Bytes written to the term since last snapshot — drives the debounced disk
   *  write (skipped while inactive to avoid wasting fs writes on idle sessions). */
  dirty: boolean;
  /** Reboot-restore mode: this session was loaded from disk and the PTY behind
   *  it is FRESH. The headless term already contains the pre-reboot screen so
   *  attach replays correctly; the live shell takes over from here. */
  frozen?: boolean;
  /** Snapshot the spec came from (only set when frozen). Used by the quick-fail
   *  retry path to recompute the retry spec from the ORIGINAL stored args, not
   *  the transformed `--resume` ones. */
  frozenSpec?: SpawnSpec;
  /** Wall-clock ms when this PTY was spawned. Used by `restoreRetryMs`. */
  spawnedAt: number;
  /** Whether the manager already exhausted its one retry for this session. */
  retried?: boolean;
  /** Small rolling buffer of recent output for a restored session spawned with
   *  `--resume`, scanned for claude's "No conversation found" error so the
   *  retry fires the instant the error prints — not when the PTY finally exits
   *  (a slow SessionEnd hook can delay exit well past restoreRetryMs). */
  retryWatch?: string;
}

// claude's resume-failure message (stable across recent versions). Matched
// against a restored session's output to fire the fresh-restart retry the
// instant it prints. Loose enough to survive minor wording changes.
const RESUME_FAIL_RE = /No conversation found with session ID|session ID:\s*\S+\s*(?:not found|does not exist)/i;

const DEFAULT_SCROLLBACK = 5000; // lines of replay scrollback per session

export interface SessionManagerOptions {
  /** Scrollback lines kept in each session's headless xterm (replay capacity). */
  scrollback?: number;
  /** Fire onEmpty after this many ms of zero live sessions (daemon idle exit). */
  idleMs?: number;
  /** Called when the manager has been idle (no sessions) for idleMs. */
  onEmpty?: () => void;
  /** OPTIONAL — invoked by the daemon to persist a snapshot to disk. Wired
   *  externally so SessionManager stays storage-agnostic (and unit-testable). */
  onSnapshot?: (id: string, snapshot: SessionSnapshot) => void;
  /** OPTIONAL — invoked when a session is explicitly killed so the daemon can
   *  unlink its on-disk snapshot file. */
  onSnapshotEvict?: (id: string) => void;
  /** Trailing-debounce window for snapshot writes during active output. */
  snapshotDebounceMs?: number;
  /** OPTIONAL — transform the SpawnSpec when respawning from a frozen
   *  (reboot-restored) snapshot. Lets the daemon inject CLI flags that ask
   *  the underlying agent to resume its prior session — e.g. claude has
   *  `--continue` to pick up the most recent conversation in the cwd, so a
   *  reboot replay isn't just a screen image but an actual resume of the
   *  agent's task. If unset, the original spec is used verbatim (the user
   *  sees their last screen but the agent forgets prior context). */
  transformSpecOnRestore?: (spec: SpawnSpec, id: string) => SpawnSpec;
  /** OPTIONAL — transform the SpawnSpec when spawning a BRAND-NEW session.
   *  Used to inject e.g. `--session-id <uuid>` for claude so the snapshot
   *  remembers the binding and restore can `--resume <uuid>` deterministically.
   *  Applied BEFORE the spec is stored on the session, so the value survives
   *  into snapshots. */
  transformSpecOnSpawn?: (spec: SpawnSpec, id: string) => SpawnSpec;
  /** OPTIONAL — if a RESTORED session (frozen → live) exits with non-zero
   *  within `restoreRetryMs`, the manager respawns it ONCE using this
   *  transform. Lets claude's `--resume <uuid>` fall back to
   *  `--session-id <uuid>` (fresh session, same deterministic id) when the
   *  on-disk JSONL is missing — turns "dead tile with No-conversation-found
   *  error" into "tile keeps working, new conversation, banner injected". */
  restoreRetryTransform?: (spec: SpawnSpec) => SpawnSpec | null;
  /** Window after restore spawn during which a non-zero exit triggers
   *  retry. Default 5s — long enough for claude to print its error and
   *  bail, short enough to skip retry for legitimate later exits. */
  restoreRetryMs?: number;
}

/** Persisted snapshot shape — the daemon serializes this to disk so a reboot
 *  restores the visible screen state (PTY itself is unrecoverable). */
export interface SessionSnapshot {
  id: string;
  spec: SpawnSpec;
  /** Output of SerializeAddon.serialize() — a VT-escape string. */
  replay: string;
  /** Wall-clock at write time. Old snapshots can be evicted by the daemon. */
  savedAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Sessions restored from disk on daemon boot but not yet live. On attach, a
   *  fresh PTY is spawned with the stored spec; the headless term already
   *  carries the pre-reboot screen so the user sees their last state plus a
   *  working new shell. Evicted when attach actually happens or on explicit kill. */
  private frozen = new Map<string, SessionSnapshot>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scrollback: number;
  private readonly idleMs: number;
  private readonly onEmpty?: () => void;
  private readonly onSnapshot?: (id: string, snap: SessionSnapshot) => void;
  private readonly onSnapshotEvict?: (id: string) => void;
  private readonly snapshotDebounceMs: number;
  private readonly transformSpecOnRestore?: (spec: SpawnSpec, id: string) => SpawnSpec;
  private readonly transformSpecOnSpawn?: (spec: SpawnSpec, id: string) => SpawnSpec;
  private readonly restoreRetryTransform?: (spec: SpawnSpec) => SpawnSpec | null;
  private readonly restoreRetryMs: number;

  constructor(
    private readonly factory: PtyFactory,
    opts: SessionManagerOptions = {},
  ) {
    this.scrollback = opts.scrollback ?? DEFAULT_SCROLLBACK;
    this.idleMs = opts.idleMs ?? 0;
    this.onEmpty = opts.onEmpty;
    this.onSnapshot = opts.onSnapshot;
    this.onSnapshotEvict = opts.onSnapshotEvict;
    this.snapshotDebounceMs = opts.snapshotDebounceMs ?? 2000;
    this.transformSpecOnRestore = opts.transformSpecOnRestore;
    this.transformSpecOnSpawn = opts.transformSpecOnSpawn;
    this.restoreRetryTransform = opts.restoreRetryTransform;
    this.restoreRetryMs = opts.restoreRetryMs ?? 5000;
  }

  /** Pre-load a snapshot (called during daemon boot for each *.json on disk).
   *  The frozen session is materialized as a live one on the next `createOrAttach`. */
  restoreSnapshot(snap: SessionSnapshot): void {
    this.frozen.set(snap.id, snap);
  }

  /** Spawn a new session, or attach to an existing one and replay its buffer.
   *  ASYNC because xterm.js `write` is async — `serialize()` only sees data
   *  once the write queue drains. We await a no-op write callback before
   *  serializing so the replay carries the latest bytes (not a stale snapshot
   *  that misses output emitted in the same tick). */
  async createOrAttach(id: string, spec: SpawnSpec, client: SessionClient): Promise<AttachResult> {
    const existing = this.sessions.get(id);
    if (existing && !existing.exited) {
      existing.client = client;
      existing.spec = { ...existing.spec, cols: spec.cols, rows: spec.rows };
      try {
        existing.pty.resize(spec.cols, spec.rows);
      } catch {
        /* resize on a dying pty — ignore */
      }
      this.cancelIdle();
      const replay = await this.serializeDrained(existing);
      return { pid: existing.pty.pid, isNew: false, replay };
    }

    // Reboot-restore path: snapshot on disk but no live PTY → spawn a fresh
    // PTY with the stored spec, then prime the headless term with the saved
    // VT-escape replay so the client sees its last screen before the new shell
    // emits its first byte. The user's session feels continuous.
    const frozenSnap = this.frozen.get(id);
    if (frozenSnap) this.frozen.delete(id);
    // Spec from the snapshot wins over the caller's (cwd/cmd/env are what the
    // user had); only cols/rows from the live attach apply (window dims).
    // For RESTORE paths, also run the optional transform so the daemon can
    // inject e.g. `claude --continue` and get a real agent-level resume, not
    // just a screen image with a fresh-amnesiac claude underneath.
    let effectiveSpec: SpawnSpec = frozenSnap
      ? { ...frozenSnap.spec, cols: spec.cols, rows: spec.rows }
      : spec;
    if (frozenSnap && this.transformSpecOnRestore) {
      effectiveSpec = this.transformSpecOnRestore(effectiveSpec, id);
    } else if (!frozenSnap && this.transformSpecOnSpawn) {
      // Brand-new session: inject e.g. `--session-id <uuid>` BEFORE the spec
      // is stored on the session — snapshots persist this so future restores
      // can swap `--session-id` → `--resume <uuid>` for deterministic resume.
      effectiveSpec = this.transformSpecOnSpawn(effectiveSpec, id);
    }
    const p = this.factory(effectiveSpec);
    const term = new HeadlessTerminal({
      cols: effectiveSpec.cols,
      rows: effectiveSpec.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    if (frozenSnap?.replay) {
      // Seed the headless term with the pre-reboot screen so the replay sent
      // back to the client carries that history forward.
      term.write(frozenSnap.replay);
    }
    const session: Session = {
      id,
      pty: p,
      term,
      serializer,
      spec: effectiveSpec,
      exited: false,
      client,
      dirty: !!frozenSnap, // restored sessions should re-persist with their new PTY's first activity
      frozen: !!frozenSnap,
      frozenSpec: frozenSnap ? frozenSnap.spec : undefined,
      spawnedAt: Date.now(),
      // Watch output for a resume failure only when this is a restored session
      // spawned with --resume and a retry transform exists.
      retryWatch:
        frozenSnap && this.restoreRetryTransform && (effectiveSpec.args ?? []).includes("--resume")
          ? ""
          : undefined,
    };
    this.sessions.set(id, session);
    p.onData((d) => {
      session.term.write(d);
      session.dirty = true;
      this.scheduleSnapshot(session);
      session.client?.onData(d);
      // Output-driven resume retry: scan a small rolling buffer for claude's
      // "No conversation found" error. Firing here (not on PTY exit) is robust
      // to a slow SessionEnd hook that delays the exit past restoreRetryMs.
      if (session.retryWatch !== undefined && !session.retried) {
        session.retryWatch = (session.retryWatch + d).slice(-4096);
        if (RESUME_FAIL_RE.test(session.retryWatch)) {
          session.retryWatch = undefined;
          if (this.tryRestoreRetry(session)) return;
        }
      }
    });
    p.onExit((code, signal) => {
      session.exited = true;
      // Timing fallback (in case the error string changed / wasn't captured):
      // a restored session that died non-zero within restoreRetryMs almost
      // certainly hit `--resume` with a missing JSONL. Retry once.
      const sinceSpawn = Date.now() - session.spawnedAt;
      if (code !== 0 && sinceSpawn < this.restoreRetryMs && this.tryRestoreRetry(session)) return;
      session.client?.onExit(code, signal);
      this.flushSnapshot(session); // last write before drop
      this.sessions.delete(id);
      this.scheduleIdle();
    });
    this.cancelIdle();
    // For frozen snapshots the replay is the persisted VT string (and we
    // already wrote it into the headless term above, so re-serializing would
    // duplicate it). For brand-new sessions there's nothing to replay yet —
    // serialize() returns the empty initial buffer cheaply.
    const replay = frozenSnap?.replay
      ? frozenSnap.replay
      : await this.serializeDrained(session);
    // `isNew` = a fresh PTY was just spawned (vs attached to a live one). Both
    // brand-new sessions AND reboot-restored ones produce a new PTY — the only
    // !isNew path is the early-return up top for a still-live existing session.
    return { pid: p.pid, isNew: true, replay };
  }
  /** Fire the one-shot restore retry for a session whose `--resume` failed.
   *  Returns true if a retry was launched (caller should NOT proceed to the
   *  normal exit/cleanup path). Guards: not already retried, is a restored
   *  session, retry transform produces a spec. */
  private tryRestoreRetry(session: Session): boolean {
    if (session.retried || session.frozenSpec === undefined || !this.restoreRetryTransform) return false;
    // Pass the EFFECTIVE spec (the one actually spawned — carries `--resume`),
    // NOT the original frozen spec (which still has `--session-id`). The retry
    // transform swaps `--resume <uuid>` → `--session-id <uuid>`.
    const retrySpec = this.restoreRetryTransform(session.spec);
    if (!retrySpec) return false;
    session.retried = true;
    // Kill the old PTY if it's still alive (output-driven path fires before
    // the process exits — e.g. claude printed the error but a SessionEnd hook
    // is still running). Ignore errors on an already-dead pty.
    try { session.pty.kill(); } catch { /* already gone */ }
    // One-shot banner so the user sees history is gone (the Mosh-style replay
    // would otherwise show the old transcript + a blank prompt — invisible
    // amnesia).
    const banner =
      "\r\n\x1b[33m[hivemind] previous claude session not found — starting fresh with same id\x1b[0m\r\n";
    session.term.write(banner);
    session.client?.onData(banner);
    this.respawnInPlace(session, retrySpec);
    return true;
  }

  /** Replace a dead session's PTY with a fresh one using `retrySpec`. Keeps
   *  the same id, headless term, serializer, and client — the user sees a
   *  continuous tile that just spawned a different process underneath. Used
   *  by the quick-fail retry path on restored sessions whose first spawn
   *  hard-failed (e.g. `claude --resume <uuid>` with a missing JSONL). */
  private respawnInPlace(session: Session, retrySpec: SpawnSpec): void {
    const p = this.factory(retrySpec);
    session.pty = p;
    session.spec = retrySpec;
    session.exited = false;
    session.spawnedAt = Date.now();
    p.onData((d) => {
      session.term.write(d);
      session.dirty = true;
      this.scheduleSnapshot(session);
      session.client?.onData(d);
    });
    p.onExit((code, signal) => {
      session.exited = true;
      session.client?.onExit(code, signal);
      this.flushSnapshot(session);
      this.sessions.delete(session.id);
      this.scheduleIdle();
    });
  }

  /** Wait for the xterm.js write queue to drain, then serialize. xterm batches
   *  writes via setTimeout(0); calling serialize() before drain returns "". */
  private serializeDrained(s: Session): Promise<string> {
    return new Promise((resolve) => {
      // Empty write's callback fires after the queue is processed.
      s.term.write("", () => resolve(s.serializer.serialize({ scrollback: this.scrollback })));
    });
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.spec = { ...s.spec, cols, rows };
    try {
      s.pty.resize(cols, rows);
    } catch {
      /* ignore */
    }
    try {
      s.term.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  /** Window closed / tile unmounted: stop streaming but KEEP the process alive.
   *  Flush any pending snapshot so closing the window persists the last screen. */
  detach(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.client = null;
      this.flushSnapshot(s);
    }
    this.scheduleIdle();
  }

  /** Explicit close: terminate the process AND remove its persisted snapshot.
   *  Order matters: suppress further flush + client emission BEFORE killing
   *  the PTY, so node-pty's async `onExit` (which fires AFTER kill returns)
   *  doesn't (a) call write() on a disposed term — would throw — and (b)
   *  resurrect the just-evicted snapshot file via flushSnapshot's persist
   *  callback. Both bugs were live before this guard. */
  kill(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.dirty = false;     // makes any subsequent flushSnapshot a no-op
      s.client = null;     // suppresses onExit emission to a dead client
      this.cancelSnapshotTimer(id);
      try {
        s.pty.kill();
      } catch {
        /* already gone */
      }
      try {
        s.term.dispose();
      } catch { /* ignore */ }
      this.sessions.delete(id);
    }
    // Also evict from frozen + on disk — kill ≠ detach.
    if (this.frozen.delete(id) || s) this.onSnapshotEvict?.(id);
    this.scheduleIdle();
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }

  list(): string[] {
    const ids = new Set(this.sessions.keys());
    for (const id of this.frozen.keys()) ids.add(id);
    return Array.from(ids);
  }

  has(id: string): boolean {
    const s = this.sessions.get(id);
    if (s && !s.exited) return true;
    return this.frozen.has(id);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Force a snapshot of every live session — call on graceful daemon shutdown.
   *  RETURNS a Promise that resolves AFTER every snapshot is flushed to disk.
   *  Process-exit handlers MUST `await` this before `process.exit(0)`; without
   *  the await, the xterm write callbacks never fire (event loop dead) and the
   *  debounce window's worth of state is silently lost on every graceful stop. */
  flushAll(): Promise<void> {
    const all: Promise<void>[] = [];
    for (const s of this.sessions.values()) all.push(this.flushSnapshot(s));
    return Promise.all(all).then(() => undefined);
  }

  // ── snapshot scheduling ────────────────────────────────────────────────────
  /** Debounced disk write. Called on every PTY data event; the actual write
   *  happens snapshotDebounceMs after the LAST event so a chatty session
   *  doesn't hammer the disk. flushSnapshot bypasses the debounce. */
  private scheduleSnapshot(s: Session): void {
    if (!this.onSnapshot) return;
    if (!s.dirty) return;
    this.cancelSnapshotTimer(s.id);
    const t = setTimeout(() => {
      this.snapshotTimers.delete(s.id);
      // Fire-and-forget: the debounced path doesn't need an await chain — the
      // next data event will reschedule if this write is in-flight. flushAll
      // (SIGTERM path) needs the Promise — that's the only awaiting caller.
      void this.flushSnapshot(s);
    }, this.snapshotDebounceMs);
    t.unref?.();
    this.snapshotTimers.set(s.id, t);
  }
  private flushSnapshot(s: Session): Promise<void> {
    if (!this.onSnapshot) return Promise.resolve();
    if (!s.dirty) return Promise.resolve();
    this.cancelSnapshotTimer(s.id);
    s.dirty = false;
    return new Promise<void>((resolve) => {
      // Drain the xterm write queue before serializing — without this, the
      // snapshot misses output emitted in the same tick as the flush trigger.
      s.term.write("", () => {
        try {
          this.onSnapshot?.(s.id, {
            id: s.id,
            spec: s.spec,
            replay: s.serializer.serialize({ scrollback: this.scrollback }),
            savedAt: Date.now(),
          });
        } catch {
          // Disk write failed — re-dirty so a later attempt retries.
          s.dirty = true;
        }
        resolve();
      });
    });
  }
  private cancelSnapshotTimer(id: string): void {
    const t = this.snapshotTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.snapshotTimers.delete(id);
    }
  }

  // ── idle shutdown (no orphan daemons) ──────────────────────────────────────
  private scheduleIdle(): void {
    // Frozen sessions don't block idle exit — they live on disk regardless, so
    // dropping them from memory just means the NEXT daemon boot will reload
    // them (cheap). Holding the daemon up indefinitely waiting for a client
    // that may never come is the worse failure mode.
    if (this.sessions.size > 0 || !this.idleMs || !this.onEmpty) return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      if (this.sessions.size === 0) this.onEmpty?.();
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
