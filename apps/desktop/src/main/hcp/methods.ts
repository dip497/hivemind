/**
 * HCP verb dispatch. Splits work by where it must run:
 *   - RENDERER verbs (tile.spawn_agent) delegate to `deps.callRenderer` — the
 *     request-id-correlated main→renderer channel (the plan-bridge pattern).
 *   - MAIN verbs (agent.send, agent.read) run here: send writes to the pty;
 *     read awaits the next Stop-hook turn and returns the transcript reply, with
 *     a buffered-output timeout fallback.
 *
 * Phase 1 surface: tile.spawn_agent, agent.send, agent.read. (tile.list/focus/
 * close, agent.status/stream, review.open, issue.* land in later phases.)
 */
import { randomUUID } from "node:crypto";
import { HcpError } from "./protocol.js";
import type { TurnTracker } from "./turn-tracker.js";
import type { OutputRecorder } from "./output-recorder.js";
import { readLastAssistantMessage } from "./transcript.js";
import { toPtyId as ptyId, toBareId as bareOf } from "../../shared/tile-id.js";
import { SUBMIT_DELAY_MS } from "../../shared/agent-io.js";

/** Max agent-spawn depth (user = 0). Bounds recursive agent-spawns-agent fan-out
 *  alongside the rate cap — the review flagged this gate as specified-but-unenforced. */
const MAX_SPAWN_DEPTH = 3;

/** Default brokered tools when `supervise` is on but unspecified — the mutating /
 *  external ones worth a supervisor's eyes; safe reads pass through untouched. */
const DEFAULT_BROKER_TOOLS = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch";

/** A supervisor has up to this long to answer before the worker falls back to its
 *  own (human) permission prompt. < the hook's command timeout. */
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;

/** Symbolic key → terminal bytes, for driving a worker's TUI (e.g. answering a
 *  native AskUserQuestion picker). A raw ESC byte can't be expressed through a
 *  plain-text param from a tool call, so agent.send_keys maps tokens here; any
 *  unknown token is sent as literal text (so digits / words type themselves). */
const KEYMAP: Record<string, string> = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  enter: "\r", return: "\r", esc: "\x1b", escape: "\x1b",
  tab: "\t", space: " ", backspace: "\x7f", del: "\x1b[3~", delete: "\x1b[3~",
  home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
};
/** Gap between successive keys, so a TUI registers each (e.g. arrow THEN enter)
 *  rather than processing a bundled write at once — mirrors SUBMIT_DELAY_MS. */
const KEY_GAP_MS = 40;

/** Normalize a `supervise` arg into the HIVE_SUPERVISE env string (a tool list or
 *  "all"), or null to disable. */
function normalizeSupervise(s: unknown): string | null {
  if (s === true || s === "parent" || s === "default" || s === "on") return DEFAULT_BROKER_TOOLS;
  if (s === "all" || s === "*") return "all";
  if (Array.isArray(s)) { const j = s.map(String).map((x) => x.trim()).filter(Boolean).join(","); return j || null; }
  if (typeof s === "string" && s.trim()) return s.trim();
  return null;
}

/** A short human-readable summary of a tool call for the approval prompt. */
function summarizeTool(tool: string, inp: Record<string, unknown>): string {
  if (tool === "Bash" && typeof inp.command === "string") return inp.command.slice(0, 300);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.url === "string") return inp.url;
  try { return JSON.stringify(inp).slice(0, 200); } catch { return "(unprintable input)"; }
}

export interface MethodDeps {
  /** Run a renderer verb (returns its result); rejects/throws HcpError on
   *  no-renderer / timeout. */
  callRenderer: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Write to a tile's pty. Returns false if the tile has no live pty. */
  writeToTile: (tileId: string, data: string) => boolean;
  turns: TurnTracker;
  recorder: OutputRecorder;
  /** Sliding-window spawn gate (reuse the ptySpawn rate-limit). false → refuse. */
  spawnAllowed: () => boolean;
  /** Pipe src's finished-turn replies into dst's input. Returns false on a bad
   *  pair (e.g. src === dst). */
  connect: (srcTileId: string, dstTileId: string) => boolean;
  /** Remove a pipe (or all of src's pipes when dst is omitted). */
  disconnect: (srcTileId: string, dstTileId?: string) => void;
  /** Drop a tile from the pipe graph entirely (both directions) on close. */
  forgetPipes: (tileId: string) => void;
  /** Record (or clear, with null) a worker's supervision policy. Main injects it
   *  as HIVE_SUPERVISE into the worker's spawn env so the daemon installs the
   *  permission-broker hook. */
  setSupervise: (tileId: string, spec: string | null) => void;
  /** Push a control-plane "wait" status for a tile (e.g. "awaiting_approval")
   *  to the renderer's status bus, or null to clear. */
  pushWait: (tileId: string, status: string | null) => void;
}

const RENDERER_TIMEOUT = 15_000;
const DEFAULT_READ_TIMEOUT = 120_000;
const REVIEW_TIMEOUT = 24 * 60 * 60 * 1000; // human review may take a long time

export function makeDispatch(deps: MethodDeps): (method: string, params: unknown) => Promise<unknown> {
  // Per-tile read epoch: set at spawn/send so agent.read waits for the turn that
  // FOLLOWS the prompt we just delivered (not a stale earlier turn).
  const sendSeq = new Map<string, number>();
  const sendMark = new Map<string, number>();

  // Bare↔pty id mapping lives in shared/tile-id (imported as ptyId/bareOf). The
  // pty, recorder, turn-tracker and HIVEMIND_TILE are keyed by the pty id; the
  // control surface uses the bare id.

  // child (bare) → parent (bare): set when a parent spawns a child via
  // tile.spawn_agent, read by agent.report so a worker can push a result back to
  // the agent that spawned it (mailbox-style, no polling).
  const parentOf = new Map<string, string>();
  // bare tileId → spawn depth (HCP-spawned children only; user-spawned agents
  // are absent → treated as depth 0). Enforced against MAX_SPAWN_DEPTH.
  const depthOf = new Map<string, number>();
  // Agent-supervised approvals (HCP Phase 6). A supervised worker's PreToolUse
  // broker hook calls `agent.await_approval` (held here until the parent answers
  // via `agent.approve`). `approveCache` remembers always/never per worker+tool.
  const pendingApprovals = new Map<string, { resolve: (d: { decision: "allow" | "deny"; reason?: string }) => void; timer: ReturnType<typeof setTimeout>; cacheKey: string; worker: string }>();
  const approveCache = new Map<string, "allow" | "deny">();

  const armRead = (tileId: string) => {
    const pid = ptyId(tileId);
    sendSeq.set(pid, deps.turns.currentSeq(pid));
    sendMark.set(pid, deps.recorder.mark(pid));
  };

  return async (method, rawParams) => {
    const p = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case "tile.spawn_agent": {
        // Anti-fork-bomb: bound recursion depth (agent→agent→agent…) in addition
        // to the per-minute rate cap. The caller's depth is what it spawned AT
        // (0 for a user-spawned agent with no record); its child is one deeper.
        const callerDepth = p.callerTile ? (depthOf.get(bareOf(String(p.callerTile))) ?? 0) : 0;
        const childDepth = callerDepth + 1;
        if (childDepth > MAX_SPAWN_DEPTH) {
          throw new HcpError("DEPTH_EXCEEDED", `agent spawn depth ${childDepth} exceeds max ${MAX_SPAWN_DEPTH}`);
        }
        if (!deps.spawnAllowed()) throw new HcpError("RATE_LIMITED", "spawn rate limit exceeded");
        const agent = String(p.agent ?? "claude");
        const res = (await deps.callRenderer(
          "tile.spawn_agent",
          { agent, prompt: p.prompt, frame: p.frame, mode: p.mode, callerTile: p.callerTile },
          RENDERER_TIMEOUT,
        )) as { tileId?: string };
        if (!res?.tileId) throw new HcpError("INTERNAL", "spawn returned no tileId");
        depthOf.set(res.tileId, childDepth);
        if (p.callerTile) {
          const parentBare = bareOf(String(p.callerTile));
          // Remember who spawned this child (for hive_report).
          parentOf.set(res.tileId, parentBare);
          // AUTO-REPORT (default on): pipe the worker's finished-turn replies
          // back to the parent, so the parent learns the result the moment the
          // worker is done — no blocking read, no screen-scrape (the forward
          // reads the clean transcript). Draws a visible reporting edge. The
          // caller can opt out with report:false. self-pipe is impossible here
          // (parent ≠ freshly-minted child id), and connect() refuses cycles.
          if (p.report !== false && parentBare !== res.tileId) {
            deps.connect(res.tileId, parentBare);
          }
          // SUPERVISE (opt-in): broker the worker's tool-permission decisions to
          // this parent. Recorded in main → injected as HIVE_SUPERVISE into the
          // worker's spawn env → daemon installs the PreToolUse broker hook.
          const sup = normalizeSupervise(p.supervise);
          if (sup) deps.setSupervise(res.tileId, sup);
        }
        // Arm the read epoch so a follow-up agent.read waits for THIS agent's
        // first turn (the prompt was delivered at spawn via queueWork).
        armRead(res.tileId);
        return { tileId: res.tileId };
      }

      case "agent.send": {
        const tileId = String(p.tileId ?? "");
        const text = String(p.text ?? "");
        if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        const submit = p.submit !== false; // default: press Enter
        armRead(tileId);
        // Type the text, then press Enter as a SEPARATE keystroke a tick later —
        // claude's TUI drops a newline that arrives in the same write as the text
        // (the prompt would sit unsubmitted). Mirrors tmux send-keys.
        const ok = deps.writeToTile(ptyId(tileId), text);
        if (!ok) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
        if (submit) setTimeout(() => deps.writeToTile(ptyId(tileId), "\r"), SUBMIT_DELAY_MS);
        return { ok: true };
      }

      case "agent.send_keys": {
        // Send a sequence of symbolic keys to a tile's TUI (e.g. answer a native
        // AskUserQuestion picker: ["Down","Enter"]). Each token maps via KEYMAP
        // (arrows/enter/esc/…) or is sent as literal text. Staggered so the TUI
        // registers each key — a bundled arrow+enter write can miss the move.
        const tileId = String(p.tileId ?? "");
        if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        const raw = p.keys;
        const keys = Array.isArray(raw) ? raw.map(String) : raw != null ? [String(raw)] : [];
        if (!keys.length) throw new HcpError("BAD_REQUEST", "keys required");
        const pid = ptyId(tileId);
        const bytesOf = (k: string) => KEYMAP[k.toLowerCase()] ?? k;
        const ok = deps.writeToTile(pid, bytesOf(keys[0]!));
        if (!ok) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
        for (let i = 1; i < keys.length; i++) {
          const b = bytesOf(keys[i]!);
          setTimeout(() => deps.writeToTile(pid, b), KEY_GAP_MS * i);
        }
        return { ok: true, keys: keys.length };
      }

      case "agent.report": {
        // A spawned worker pushes a result back to the agent that spawned it.
        // The caller passes its OWN tile id (HIVEMIND_TILE); we look up its
        // parent and deliver the message into the parent's terminal (typed +
        // Enter, like agent.send) so the parent reads it on its next turn.
        const child = bareOf(String(p.callerTile ?? ""));
        const parent = parentOf.get(child);
        if (!parent) throw new HcpError("TILE_NOT_FOUND", "no parent agent to report to");
        const message = String(p.message ?? "").trim();
        if (!message) throw new HcpError("BAD_REQUEST", "message required");
        const banner = `\n[hive] report from ${child}:\n${message}\n`;
        deps.writeToTile(ptyId(parent), banner);
        setTimeout(() => deps.writeToTile(ptyId(parent), "\r"), SUBMIT_DELAY_MS);
        return { delivered: true, parent };
      }

      case "agent.await_approval": {
        // Called by a SUPERVISED worker's PreToolUse broker hook before a tool
        // runs. Resolve from the remember-cache, else ask the parent and BLOCK
        // (held in pendingApprovals) until `agent.approve` or the timeout.
        const worker = bareOf(String(p.callerTile ?? ""));
        const tool = String(p.tool_name ?? "");
        if (!worker || !tool) return { decision: "ask" };
        const cacheKey = `${worker}:${tool}`;
        const cached = approveCache.get(cacheKey);
        if (cached) return { decision: cached };
        const parent = parentOf.get(worker);
        if (!parent) return { decision: "ask" }; // no supervisor → fall back to human prompt
        const inp = (p.tool_input ?? {}) as Record<string, unknown>;
        const reqId = randomUUID();
        const summary = summarizeTool(tool, inp);
        const banner =
          `\n[hive] APPROVAL — worker ${worker} wants to run ${tool}: ${summary}\n` +
          `Reply: hive_approve("${reqId}", "allow" | "deny" | "always" | "never")\n`;
        deps.writeToTile(ptyId(parent), banner);
        setTimeout(() => deps.writeToTile(ptyId(parent), "\r"), SUBMIT_DELAY_MS);
        // Surface the pause in the UI: this worker is now waiting on its parent.
        deps.pushWait(worker, "awaiting_approval");
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(reqId);
            deps.pushWait(worker, null);
            resolve({ decision: "ask" }); // timed out → human prompt (fail-safe)
          }, APPROVAL_TIMEOUT_MS);
          if (typeof timer.unref === "function") timer.unref();
          pendingApprovals.set(reqId, { resolve, timer, cacheKey, worker });
        });
      }

      case "agent.approve": {
        // The supervising agent answers an approval request (by reqId). always /
        // never also remember the decision for this worker+tool (no more
        // round-trips for it).
        const reqId = String(p.reqId ?? "");
        const decision = String(p.decision ?? "");
        const reason = p.reason != null ? String(p.reason) : undefined;
        const pend = pendingApprovals.get(reqId);
        if (!pend) throw new HcpError("BAD_REQUEST", `no pending approval ${reqId} (expired or already answered)`);
        let d: "allow" | "deny";
        if (decision === "allow" || decision === "always") d = "allow";
        else if (decision === "deny" || decision === "never") d = "deny";
        else throw new HcpError("BAD_REQUEST", "decision must be allow | deny | always | never");
        if (decision === "always") approveCache.set(pend.cacheKey, "allow");
        if (decision === "never") approveCache.set(pend.cacheKey, "deny");
        clearTimeout(pend.timer);
        pendingApprovals.delete(reqId);
        deps.pushWait(pend.worker, null); // resolved → clear the "waiting" status
        pend.resolve({ decision: d, reason });
        return { ok: true, decision: d };
      }

      case "agent.read": {
        const tileId = String(p.tileId ?? "");
        if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_READ_TIMEOUT;
        const pid = ptyId(tileId);
        const afterSeq = sendSeq.get(pid) ?? deps.turns.currentSeq(pid);
        const rec = await deps.turns.waitForTurn(pid, afterSeq, timeoutMs);
        if (rec?.transcriptPath) {
          // Clean reply from the session transcript JSONL (NOT screen-scrape).
          const text = readLastAssistantMessage(rec.transcriptPath);
          if (text != null) return { text, finalStatus: "turn", truncated: false };
          return { text: null, finalStatus: "turn", truncated: false, note: "turn completed but its transcript was unreadable" };
        }
        // No completed turn within the timeout. Report status honestly instead of
        // scraping the raw ANSI terminal buffer (which returned garbled bytes, not
        // the agent's words). The agent is still working; if it was spawned with
        // report:true it will auto-deliver its reply to the parent when done.
        return { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" };
      }

      // ── canvas verbs (renderer) ──────────────────────────────────────────
      case "tile.list":
        return await deps.callRenderer("tile.list", { frame: p.frame }, RENDERER_TIMEOUT);
      case "tile.list_frames":
        return await deps.callRenderer("tile.list_frames", {}, RENDERER_TIMEOUT);
      case "tile.focus": {
        if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        return await deps.callRenderer("tile.focus", { tileId: p.tileId }, RENDERER_TIMEOUT);
      }
      case "tile.close": {
        if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        const tileId = String(p.tileId);
        const r = await deps.callRenderer("tile.close", { tileId }, RENDERER_TIMEOUT);
        // Drop ALL per-tile state so nothing leaks for the session + the pipe
        // graph never forwards into a closed tile (pid-keyed: turns/recorder/
        // epochs; bare-keyed: pipes/parent/depth).
        const pid = ptyId(tileId);
        const bare = bareOf(tileId);
        deps.turns.forget(pid);
        deps.recorder.forget(pid);
        deps.forgetPipes(bare);
        sendSeq.delete(pid);
        sendMark.delete(pid);
        parentOf.delete(bare);
        depthOf.delete(bare);
        deps.setSupervise(bare, null);
        // Resolve + drop any approvals in flight for this worker (it's gone) and
        // forget its remembered decisions.
        for (const [reqId, pend] of pendingApprovals) {
          if (pend.cacheKey.startsWith(`${bare}:`)) {
            clearTimeout(pend.timer);
            pend.resolve({ decision: "deny", reason: "worker closed" });
            pendingApprovals.delete(reqId);
          }
        }
        for (const key of approveCache.keys()) if (key.startsWith(`${bare}:`)) approveCache.delete(key);
        deps.pushWait(bare, null);
        return r;
      }

      case "review.open": {
        // Open a plan-review tile and BLOCK until the human decides. The
        // renderer doesn't reply on open — the tile resolves this caller via
        // hcpResult on the decision, which is why the timeout is generous.
        if (!p.plan) throw new HcpError("BAD_REQUEST", "plan required");
        return await deps.callRenderer("review.open", { plan: p.plan, cwd: p.cwd ?? "" }, REVIEW_TIMEOUT);
      }

      // ── pipes (main) ─────────────────────────────────────────────────────
      case "tile.connect": {
        const src = String(p.srcTileId ?? "");
        const dst = String(p.dstTileId ?? "");
        if (!src || !dst) throw new HcpError("BAD_REQUEST", "srcTileId and dstTileId required");
        if (!deps.connect(src, dst)) throw new HcpError("BAD_REQUEST", "cannot pipe a tile to itself or create a cycle");
        return { ok: true };
      }
      case "tile.disconnect": {
        const src = String(p.srcTileId ?? "");
        if (!src) throw new HcpError("BAD_REQUEST", "srcTileId required");
        deps.disconnect(src, p.dstTileId ? String(p.dstTileId) : undefined);
        return { ok: true };
      }

      default:
        throw new HcpError("UNKNOWN_METHOD", `unknown method: ${method}`);
    }
  };
}
