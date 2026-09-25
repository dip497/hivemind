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
// Namespace import: bundlers disagree on whether these expose `.default` or named ESM exports.
import * as HeadlessXtermNS from "@xterm/headless";
import * as SerializeAddonNS from "@xterm/addon-serialize";
import type { SessionInfo } from "./pty-protocol.js";
import { randomUUID } from "node:crypto";
type HeadlessCtor = typeof import("@xterm/headless").Terminal;
type SerializeCtor = typeof import("@xterm/addon-serialize").SerializeAddon;
const pick = <T>(ns: unknown, name: string): T => {
  const m = ns as Record<string, unknown> & { default?: Record<string, unknown> };
  return (m[name] ?? m.default?.[name] ?? m.default) as T;
};
const HeadlessTerminal = pick<HeadlessCtor>(HeadlessXtermNS, "Terminal");
const SerializeAddon = pick<SerializeCtor>(SerializeAddonNS, "SerializeAddon");
type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;
type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

export interface ManagedPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number, signal: number | undefined) => void): void;
  /** Flow control (optional — node-pty has it, test fakes may not). `pause`
   *  stops reading the child's output so it blocks on a full pty buffer;
   *  `resume` drains again. Driven by the renderer's write-queue watermarks. */
  pause?(): void;
  resume?(): void;
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
  /** `seq`: the session's output position after `data` (for resuming a viewer from where it left off). */
  onData: (data: string, seq?: number) => void;
  onExit: (code: number, signal: number | undefined) => void;
}

export interface AttachResult {
  pid: number;
  isNew: boolean;
  /** Buffered output to replay into xterm so the screen looks continuous. */
  replay: string;
  /** Output position the replay covers, within this session instance (`epoch`). */
  seq: number;
  epoch: string;
}

/** Output kept per session so a returning viewer gets only what it missed. */
const RING_CHARS = 256 * 1024;

export type { SessionInfo };

interface Session {
  id: string;
  pty: ManagedPty;
  /** Headless xterm fed every byte the PTY emits. `serializer.serialize()` on
   *  this produces the replay payload — Mosh-style coalesced visible state. */
  term: HeadlessTerminalInstance;
  serializer: SerializeAddonInstance;
  spec: SpawnSpec;
  exited: boolean;
  /** Output and exit fan out to every viewer. */
  clients: Set<SessionClient>;
  /** In interaction order: the last entry owns the PTY size and inherits it when the owner leaves. */
  sizes: Map<SessionClient, { cols: number; rows: number }>;
  /** Paused while any viewer is (`null` = a caller that didn't say which viewer it is). */
  pausedBy: Set<SessionClient | null>;
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
  /** Output seen while `retryWatch` is active; the watch retires once this
   *  passes RETRY_WATCH_MAX_BYTES (the resume error prints at startup, so a
   *  session that has emitted that much has clearly come up). */
  retryWatchBytes: number;
  /** Latest OSC 0/2 window title the process set (claude's live "session name"),
   *  captured from the headless term. SerializeAddon does NOT serialize the title,
   *  so a reattach's replay would otherwise lose it — we re-emit it (see
   *  `withTitle`) so the client's xterm re-fires onTitleChange on reattach. */
  lastTitle?: string;
  /** Derived from `pausedBy`; a leaving viewer's pause goes with it. */
  paused?: boolean;
  /** Set by kill: a snapshot serialized after this must not be written. */
  killed?: boolean;
  /** Output emitted so far; positions only mean something within one `epoch`. */
  seq: number;
  epoch: string;
  /** Recent output as chunks ending at `end`, capped at RING_CHARS. */
  ring: { end: number; data: string }[];
  ringChars: number;
}

// claude's resume-failure message (stable across recent versions). Matched
// against a restored session's output to fire the fresh-restart retry the
// instant it prints. Loose enough to survive minor wording changes.
const RESUME_FAIL_RE = /No conversation found with session ID|session ID:\s*\S+\s*(?:not found|does not exist)/i;

const DEFAULT_SCROLLBACK = 5000; // lines of replay scrollback per session
// Stop scanning restored-session output for the resume-failure message after
// this much output. Bounded by BYTES, not time: a slow start on a loaded box
// must not retire the watch before claude has printed anything.
const RETRY_WATCH_MAX_BYTES = 512 * 1024;

export interface SessionManagerOptions {
  /** Scrollback lines kept in each session's headless xterm (replay capacity). */
  scrollback?: number;
  /** Fire onEmpty after this many ms of zero live sessions (daemon idle exit). */
  idleMs?: number;
  /** Called when the manager has been idle (no sessions) for idleMs. */
  onEmpty?: () => void;
  /** OPTIONAL — invoked by the daemon to persist a snapshot to disk. Wired
   *  externally so SessionManager stays storage-agnostic (and unit-testable).
   *  May return a Promise (async disk write); flushSnapshot/flushAll resolve
   *  only after it settles, and a rejection re-dirties the session so a later
   *  flush retries. */
  onSnapshot?: (id: string, snapshot: SessionSnapshot) => void | Promise<void>;
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
  /** Last OSC window title (SerializeAddon omits it) so a reboot-restored
   *  session re-emits the agent's name ahead of its replay, same as a live
   *  reattach — the daemon is the single source of truth for the title. */
  title?: string;
  /** Wall-clock at write time. Old snapshots can be evicted by the daemon. */
  savedAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Sessions restored from disk on daemon boot but not yet live. On attach, a
   *  fresh PTY is spawned with the stored spec; the headless term already
   *  carries the pre-reboot screen so the user sees their last state plus a
   *  working new shell. Evicted when attach actually happens or on explicit kill. */
  private frozen = new Map<string, () => SessionSnapshot | undefined>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scrollback: number;
  private readonly idleMs: number;
  private readonly onEmpty?: () => void;
  private readonly onSnapshot?: (id: string, snap: SessionSnapshot) => void | Promise<void>;
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

  /** Materialized as a live session on the next `createOrAttach`. */
  restoreSnapshot(snap: SessionSnapshot): void {
    this.frozen.set(snap.id, () => snap);
  }

  /** `load` runs when the tile attaches, and must be synchronous (see createOrAttach). */
  restoreLazySnapshot(id: string, load: () => SessionSnapshot | undefined): void {
    this.frozen.set(id, load);
  }

  frozenIds(): string[] {
    return Array.from(this.frozen.keys());
  }

  /** Spawn a new session, or attach to an existing one and replay its buffer.
   *  ASYNC because xterm.js `write` is async — `serialize()` only sees data
   *  once the write queue drains. We await a no-op write callback before
   *  serializing so the replay carries the latest bytes (not a stale snapshot
   *  that misses output emitted in the same tick). */
  /** Re-emit the session's last OSC window title ahead of the replay so the
   *  client's xterm re-fires onTitleChange on reattach (SerializeAddon drops the
   *  title). Control chars stripped so an embedded BEL/ESC can't truncate it. */
  private withTitle(s: Session, replay: string): string {
    if (!s.lastTitle) return replay;
    const t = s.lastTitle.replace(/[\x00-\x1f\x7f]/g, " ").trim();
    return t ? `\x1b]0;${t}\x07${replay}` : replay;
  }

  async createOrAttach(id: string, spec: SpawnSpec, client: SessionClient): Promise<AttachResult> {
    const existing = this.sessions.get(id);
    if (existing && !existing.exited) {
      existing.clients.add(client);
      // A viewer that paused and then lost its link may never resume, so a fresh attach clears every pause.
      existing.pausedBy.clear();
      this.applyPause(existing);
      // Attaching is interacting: the new viewer's size wins.
      this.touch(existing, client, { cols: spec.cols, rows: spec.rows });
      this.applySize(existing, spec.cols, spec.rows);
      this.cancelIdle();
      const snap = await this.serializeDrained(existing);
      return { pid: existing.pty.pid, isNew: false, replay: this.withTitle(existing, snap.replay), seq: snap.seq, epoch: existing.epoch };
    }

    // Reboot-restore path: snapshot on disk but no live PTY → spawn a fresh
    // PTY with the stored spec, then prime the headless term with the saved
    // VT-escape replay so the client sees its last screen before the new shell
    // emits its first byte. The user's session feels continuous.
    // No await between take and spawn, or a second attach would spawn fresh.
    const loadFrozen = this.frozen.get(id);
    if (loadFrozen) this.frozen.delete(id);
    const frozenSnap = loadFrozen ? loadFrozen() : undefined;
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
      clients: new Set([client]),
      sizes: new Map([[client, { cols: effectiveSpec.cols, rows: effectiveSpec.rows }]]),
      pausedBy: new Set(),
      seq: 0,
      epoch: randomUUID(),
      ring: [],
      ringChars: 0,
      dirty: !!frozenSnap, // restored sessions should re-persist with their new PTY's first activity
      frozen: !!frozenSnap,
      frozenSpec: frozenSnap ? frozenSnap.spec : undefined,
      spawnedAt: Date.now(),
      // Seed the title from the snapshot so a reboot-restored session re-emits
      // the agent name on its first attach (before the fresh claude re-sets it).
      lastTitle: frozenSnap?.title,
      // Watch output for a resume failure only when this is a restored session
      // spawned with --resume and a retry transform exists.
      retryWatch:
        frozenSnap && this.restoreRetryTransform && (effectiveSpec.args ?? []).includes("--resume")
          ? ""
          : undefined,
      retryWatchBytes: 0,
    };
    this.sessions.set(id, session);
    // Capture the OSC 0/2 window title the headless term parses. SerializeAddon
    // omits it from the replay, so without this a reattach shows the generic
    // spawn label instead of claude's live task summary.
    try { session.term.onTitleChange((t) => { session.lastTitle = t; }); } catch { /* headless build w/o title API */ }
    p.onData((d) => {
      // Stale-pty guard: after a retry respawn, the old pty may still flush a
      // trailing chunk — it must not write to the now-retried session.
      if (session.pty !== p) return;
      session.term.write(d);
      session.dirty = true;
      this.scheduleSnapshot(session);
      this.emit(session, d);
      // Output-driven resume retry: scan a small rolling buffer for claude's
      // "No conversation found" error. Firing here (not on PTY exit) is robust
      // to a slow SessionEnd hook that delays the exit past restoreRetryMs.
      // The watch is BOUNDED by output volume: the resume error is among the
      // first things claude prints, so once a restored session has emitted
      // RETRY_WATCH_MAX_BYTES it has clearly come up — stop paying a 4 KB
      // concat + regex on every chunk for the rest of the session's life.
      if (session.retryWatch !== undefined && !session.retried) {
        session.retryWatch = (session.retryWatch + d).slice(-4096);
        session.retryWatchBytes += d.length;
        if (RESUME_FAIL_RE.test(session.retryWatch)) {
          session.retryWatch = undefined;
          if (this.tryRestoreRetry(session)) return;
        } else if (session.retryWatchBytes > RETRY_WATCH_MAX_BYTES) {
          session.retryWatch = undefined;
        }
      }
    });
    p.onExit((code, signal) => {
      // Ignore a STALE pty's late exit: tryRestoreRetry kills this pty and
      // swaps in a fresh one (session.pty), so the kill-induced exit arrives
      // AFTER the replacement. Without this guard it would delete the live
      // retried session — turning the missing-JSONL recovery into "tile
      // vanishes". (Caught by claude-resume.integration.test.ts.)
      if (session.pty !== p) return;
      session.exited = true;
      // Timing fallback (in case the error string changed / wasn't captured):
      // a restored session that died non-zero within restoreRetryMs almost
      // certainly hit `--resume` with a missing JSONL. Retry once.
      const sinceSpawn = Date.now() - session.spawnedAt;
      if (code !== 0 && sinceSpawn < this.restoreRetryMs && this.tryRestoreRetry(session)) return;
      for (const c of session.clients) c.onExit(code, signal);
      this.flushSnapshot(session); // last write before drop
      this.sessions.delete(id);
      this.scheduleIdle();
    });
    this.cancelIdle();
    // For frozen snapshots the replay is the persisted VT string (and we
    // already wrote it into the headless term above, so re-serializing would
    // duplicate it). For brand-new sessions there's nothing to replay yet —
    // serialize() returns the empty initial buffer cheaply.
    const snap = frozenSnap?.replay
      ? { replay: frozenSnap.replay, seq: session.seq }
      : await this.serializeDrained(session);
    // `isNew` = a fresh PTY was just spawned (vs attached to a live one). Both
    // brand-new sessions AND reboot-restored ones produce a new PTY — the only
    // !isNew path is the early-return up top for a still-live existing session.
    return { pid: p.pid, isNew: true, replay: this.withTitle(session, snap.replay), seq: snap.seq, epoch: session.epoch };
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
    this.emit(session, banner);
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
    session.paused = false; // fresh pty starts flowing
    session.pausedBy.clear();
    session.spec = retrySpec;
    session.exited = false;
    session.spawnedAt = Date.now();
    p.onData((d) => {
      // Ignore output from a pty that's already been replaced by a later retry.
      if (session.pty !== p) return;
      session.term.write(d);
      session.dirty = true;
      this.scheduleSnapshot(session);
      this.emit(session, d);
    });
    p.onExit((code, signal) => {
      // Stale-pty guard (see the spawn path) — a replaced pty's late exit must
      // not tear down the live session.
      if (session.pty !== p) return;
      session.exited = true;
      for (const c of session.clients) c.onExit(code, signal);
      this.flushSnapshot(session);
      this.sessions.delete(session.id);
      this.scheduleIdle();
    });
  }

  /** Wait for the xterm.js write queue to drain, then serialize. xterm batches
   *  writes via setTimeout(0); calling serialize() before drain returns "". */
  private serializeDrained(s: Session, tries = 3): Promise<{ replay: string; seq: number }> {
    return new Promise((resolve) => {
      // The screen covers output up to `at`; output that arrived while it drained follows it raw.
      const at = s.seq;
      s.term.write("", () => {
        const screen = s.serializer.serialize({ scrollback: this.scrollback });
        const tail = this.ringSince(s, at);
        if (tail !== null) resolve({ replay: screen + tail, seq: s.seq });
        // ponytail: a flood that outruns the ring between drains ends with a gap after three tries.
        else if (tries > 1) void this.serializeDrained(s, tries - 1).then(resolve);
        else resolve({ replay: screen, seq: s.seq });
      });
    });
  }

  /** Output after `seq`, or null when the ring no longer holds all of it. */
  private ringSince(s: Session, seq: number): string | null {
    if (seq < s.seq - s.ringChars) return null;
    let out = "";
    for (const chunk of s.ring) {
      if (chunk.end <= seq) continue;
      const begin = chunk.end - chunk.data.length;
      out += seq > begin ? chunk.data.slice(seq - begin) : chunk.data;
    }
    return out;
  }

  private emit(s: Session, d: string): void {
    s.seq += d.length;
    s.ring.push({ end: s.seq, data: d });
    s.ringChars += d.length;
    while (s.ringChars > RING_CHARS && s.ring.length > 1) s.ringChars -= s.ring.shift()!.data.length;
    for (const c of s.clients) c.onData(d, s.seq);
  }

  /** Re-attach a returning viewer with only the output it missed; null when that can't be exact
   *  (other session instance, or the gap is older than the ring) — then attach normally. */
  attachDelta(id: string, client: SessionClient, since: { seq: number; epoch: string }, cols: number, rows: number): AttachResult | null {
    const s = this.sessions.get(id);
    if (!s || s.exited || s.epoch !== since.epoch || since.seq > s.seq) return null;
    const replay = this.ringSince(s, since.seq);
    if (replay === null) return null;
    s.clients.add(client);
    s.pausedBy.clear();
    this.applyPause(s);
    this.touch(s, client, { cols, rows });
    this.applySize(s, cols, rows);
    this.cancelIdle();
    return { pid: s.pty.pid, isNew: false, replay, seq: s.seq, epoch: s.epoch };
  }

  /** The current screen, for a viewer that fell too far behind to be sent every byte. */
  async snapshot(id: string): Promise<{ replay: string; seq: number; epoch: string } | null> {
    const s = this.sessions.get(id);
    if (!s || s.exited) return null;
    const snap = await this.serializeDrained(s);
    return { replay: this.withTitle(s, snap.replay), seq: snap.seq, epoch: s.epoch };
  }

  /** Typing is interacting: the typing viewer takes the size back. */
  write(id: string, data: string, client?: SessionClient): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const own = client && s.sizes.get(client);
    if (own) {
      this.touch(s, client!, own);
      if (own.cols !== s.spec.cols || own.rows !== s.spec.rows) this.applySize(s, own.cols, own.rows);
    }
    s.pty.write(data);
  }

  /** Record a viewer's size and make it the most recent interactor. */
  private touch(s: Session, client: SessionClient, size: { cols: number; rows: number }): void {
    s.sizes.delete(client);
    s.sizes.set(client, size);
  }

  /** Stop reading the child's output while any viewer is paused. */
  pause(id: string, client?: SessionClient): void {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    s.pausedBy.add(client ?? null);
    this.applyPause(s);
  }
  /** Undo that viewer's `pause`. */
  resume(id: string, client?: SessionClient): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.pausedBy.delete(client ?? null);
    this.applyPause(s);
  }
  private applyPause(s: Session): void {
    const paused = s.pausedBy.size > 0;
    if (!!s.paused === paused) return;
    s.paused = paused;
    try {
      if (paused) s.pty.pause?.();
      else s.pty.resume?.();
    } catch {
      /* pty already gone */
    }
  }

  /** Resizing is interacting: that viewer's size wins. */
  resize(id: string, cols: number, rows: number, client?: SessionClient): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (client && s.clients.has(client)) this.touch(s, client, { cols, rows });
    this.applySize(s, cols, rows);
  }
  private applySize(s: Session, cols: number, rows: number): void {
    s.spec = { ...s.spec, cols, rows };
    try {
      s.pty.resize(cols, rows);
    } catch {
      /* resize on a dying pty — ignore */
    }
    try {
      s.term.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  /** Stop streaming to a viewer but keep the process alive; no `client` drops every viewer. */
  detach(id: string, client?: SessionClient): void {
    const s = this.sessions.get(id);
    if (s) {
      if (client) {
        s.clients.delete(client);
        s.sizes.delete(client);
        s.pausedBy.delete(client);
        // A departing size owner hands the size to the most recent remaining viewer.
        const heir = Array.from(s.sizes.values()).pop();
        if (heir && (heir.cols !== s.spec.cols || heir.rows !== s.spec.rows)) this.applySize(s, heir.cols, heir.rows);
      } else {
        s.clients.clear();
        s.sizes.clear();
        s.pausedBy.clear();
      }
      if (s.clients.size === 0) s.pausedBy.clear();
      this.applyPause(s);
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
  kill(id: string, killer?: SessionClient): void {
    const s = this.sessions.get(id);
    if (s) {
      s.dirty = false;     // makes any subsequent flushSnapshot a no-op
      s.killed = true;
      // Other viewers must learn it's gone (reported like a SIGHUP exit); the killer already knows.
      const others = Array.from(s.clients).filter((c) => c !== killer);
      s.clients.clear();   // suppresses the pty's late onExit to anyone
      for (const c of others) { try { c.onExit(0, 1); } catch { /* viewer gone */ } }
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

  /** Live and frozen sessions, for `hive ps`. */
  info(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (s.exited) continue;
      out.push({
        id: s.id, state: "live", cmd: s.spec.cmd, args: s.spec.args ?? [], cwd: s.spec.cwd,
        pid: s.pty.pid, viewers: s.clients.size, cols: s.spec.cols, rows: s.spec.rows,
        ...(s.lastTitle ? { title: s.lastTitle } : {}),
      });
    }
    // Frozen snapshots are read on demand (startup no longer loads them all), so this costs
    // a read per frozen session — only when something actually asks for the list.
    for (const [id, load] of this.frozen) {
      if (this.sessions.has(id)) continue;
      const f = load();
      if (!f) continue;
      out.push({
        id: f.id, state: "frozen", cmd: f.spec.cmd, args: f.spec.args ?? [], cwd: f.spec.cwd,
        pid: null, viewers: 0, cols: f.spec.cols, rows: f.spec.rows,
        ...(f.title ? { title: f.title } : {}),
      });
    }
    return out;
  }

  has(id: string): boolean {
    return this.hasLive(id) || this.frozen.has(id);
  }

  /** Running now, as opposed to saved before a reboot and restored on attach. */
  hasLive(id: string): boolean {
    const s = this.sessions.get(id);
    return !!s && !s.exited;
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
        // Killed while the queue drained: writing now would resurrect it on the next boot.
        if (s.killed) { resolve(); return; }
        let r: void | Promise<void>;
        try {
          r = this.onSnapshot?.(s.id, {
            id: s.id,
            spec: s.spec,
            replay: s.serializer.serialize({ scrollback: this.scrollback }),
            title: s.lastTitle,
            savedAt: Date.now(),
          });
        } catch {
          // Disk write failed — re-dirty so a later attempt retries.
          s.dirty = true;
          resolve();
          return;
        }
        // Async persist: settle only once the bytes are on disk (flushAll on
        // SIGTERM awaits this); a rejection re-dirties for a later retry.
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).then(
            () => resolve(),
            () => { s.dirty = true; resolve(); },
          );
        } else {
          resolve();
        }
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
