/**
 * The conversation of an agent here, for whoever asks (M5, spec/agents.md "Conversation"): the
 * session file its manifest says it keeps, what that says so far, then each piece written to it,
 * sent to that caller as it comes, and the next session's from its start once the agent begins
 * another (as Claude Code's `/clear` does), until the caller goes.
 */
import { agentForCmd, readTrackedSession, sessionFile, sessionFor, sessionNamed, type AgentProviderDef, type AgentTranscript } from "@hivemind/agents/node";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { ToolAsked } from "@hivemind/workspace-api/agents";
import fs from "node:fs";
import { conversationStart, followConversation, lastSaidSince, pendingTool, readConversation, toolUse, type Said } from "./conversation.js";
import { runsIn, tileOn, type HeldBoard } from "./needs.js";

/** A session an agent keeps its conversation in: its id (empty while none is known), its file
 *  (null until the agent writes it), and how the file's records say what was said, as its manifest
 *  maps them. */
export interface Transcript {
  session: string;
  file: string | null;
  format: AgentTranscript;
}
type Kept = Transcript & { file: string };

/** Whether an agent run as `def` keeps a conversation the phone can read: its manifest maps its
 *  transcript and says where its file is. */
export function keepsConversation(def: AgentProviderDef | undefined): boolean {
  return !!def?.session?.transcript && !!def.session.resume?.exists;
}

/** How often a followed agent is looked at for a session it began since: an agent with no hooks
 *  says nothing of one. */
const SESSION_CHECK_MS = 1000;
/** The least time between two looks for the file of an agent that keeps none yet, however often it
 *  reports from the same session: each look may scan the agent's store. */
export const RESOLVE_EVERY_MS = 3000;
/** How long since which file `s`'s agent keeps was last looked for, on the clock the timers run on. */
const sinceLook = (s: { resolvedAt: number }): number => performance.now() - s.resolvedAt;

/** The session the agent of `tile` keeps its conversation in now, among the boards `held`, and its
 *  file, as its manifest says it is kept (`session.transcript`, `session.resume.exists`); null
 *  when no agent there maps a transcript. The session is the one last recorded for the tile
 *  in `tileSessionsDir` (by its tracker hook, or by the daemon as it bound one at its start), else
 *  the one its manifest would resume. */
export function transcriptOf(held: HeldBoard[], tile: string, tileSessionsDir: string, home?: string): Transcript | null {
  const bare = toBareId(tile);
  const record = tileOn(held, bare)?.record as { cmd?: string; args?: string[] } | undefined;
  const def = agentForCmd(record?.cmd);
  if (!record || !def || !keepsConversation(def)) return null;
  const exists = def.session!.resume!.exists!;
  const format = def.session!.transcript!;
  const spec = { cwd: runsIn(held, bare) ?? "", args: record.args ?? [] };
  const session = conversationOf(held, bare, tileSessionsDir) ?? sessionFor(def, spec);
  return { session: session ?? "", file: session ? sessionFile(exists, session, home) : null, format };
}

/** The conversation the agent of `tile`, among the boards `held`, is in: the one recorded for its
 *  tile in `tileSessionsDir` (by its tracker hook, its agent's report, the daemon as it bound one at
 *  its start or as it put it to sleep), else the one its command line names; undefined when neither
 *  says. Never looked for in the agent's own store: that finds a folder's, not a tile's. */
export function conversationOf(held: HeldBoard[], tile: string, tileSessionsDir: string): string | undefined {
  const bare = toBareId(tile);
  const record = held.flatMap((h) => h.core?.tiles ?? []).find((t) => t.id === bare) as { cmd?: string; args?: string[] } | undefined;
  const def = agentForCmd(record?.cmd);
  if (!record || !def?.session?.resume) return undefined;
  return readTrackedSession(tileSessionsDir, `hm:${bare}`) ?? readTrackedSession(tileSessionsDir, bare) ?? sessionNamed(def, record.args ?? []);
}

/** The tool use the agent of `tile`, among the boards `held`, waits on, as its session file says
 *  (`pendingTool`); undefined when it keeps none, or waits on no tool. */
export function askingOf(held: HeldBoard[], tile: string, tileSessionsDir: string, home?: string): ToolAsked | undefined {
  const t = transcriptOf(held, tile, tileSessionsDir, home);
  if (!t?.file) return undefined;
  let size: number, mtimeMs: number;
  try { ({ size, mtimeMs } = fs.statSync(t.file)); } catch { return undefined; }
  const bare = toBareId(tile);
  const was = asked.get(bare);
  if (was?.file === t.file && was.format === t.format && was.size === size && was.mtimeMs === mtimeMs) return was.tool;
  const tool = pendingTool(t.file, t.format);
  asked.set(bare, { file: t.file, format: t.format, size, mtimeMs, tool });
  return tool;
}

/** What each tile's session file last said its agent waits on, as of the file's size and time:
 *  read again only once the agent wrote to it. */
const asked = new Map<string, { file: string; format: AgentTranscript; size: number; mtimeMs: number; tool: ToolAsked | undefined }>();

/** One tile's agent's last words, as `LastSaid` keeps them: where its session file is (null: it
 *  keeps no conversation), what it last said there, how far it was read, and its read now. */
interface SaidOf {
  t: Transcript | null;
  line?: string;
  cursor?: number;
  /** Read once it is its turn, or being read (`reading`); `again`: asked for again meanwhile. */
  queued: boolean;
  reading: boolean;
  again: boolean;
  /** Which file it keeps is looked for again before its next read. */
  resolve: boolean;
  /** When which file it keeps was last looked for (`performance.now()`, the clock the timers run on),
   *  and the session its agent last reported from. */
  resolvedAt: number;
  reported?: string;
  /** Asked for within 3 s of that look, its file not written yet: looked for once they are up. */
  later?: ReturnType<typeof setTimeout>;
  /** Its agent reported while no one followed its tile: read before its line is next told. */
  stale: boolean;
  /** Called once no read of it is due. */
  settled: Array<() => void>;
}

export interface LastSaidOptions {
  /** The session the agent of `bare` keeps its conversation in now, and its file; null when it
   *  keeps none (`transcriptOf`). */
  transcriptOf(bare: string): Transcript | null;
  /** What the agent of `bare` last said changed to `line`. */
  said(bare: string, line: string): void;
}

/**
 * What each agent here that keeps a conversation last said (docs/design/last-line-2026-10-23.md
 * §1), for its tile's line (`TileLines`, which says when to read). Read only when asked: its first
 * read is from the end of its session file, wider until it says something; each one after reads
 * only what was written since. Reads are asynchronous and one at a time for every tile here, so
 * fifty agents are never parsed at once, and a tile asked for again while it is read is read once
 * more after. Which file a tile's agent keeps is looked for once, then again when it reports
 * another session, or, while it keeps none yet, as it reports at most every 3 s (one report within
 * the 3 s, once they are up); a tile found keeping no conversation is looked for again as it is
 * asked for: never on a repeating timer.
 * An agent that reports while no one follows its tile is only marked (`stale`), and read once its
 * line is next asked for.
 */
export class LastSaid {
  private readonly tiles = new Map<string, SaidOf>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(private readonly o: LastSaidOptions) {}

  /** Whether the agent of `bare` keeps a conversation. One found keeping none is looked for again
   *  each time it is asked for, as its tile may be asked for before the board holds it (its line
   *  comes a moment after it starts): for a tile that keeps none, a lookup in what the boards keep,
   *  no file read (~0.4 µs at 50 tiles). Found, its line is told: "" until it is read. */
  keeps(bare: string): boolean {
    const s = this.tiles.get(bare);
    if (!s) return this.of(bare).t !== null;
    if (!s.t) {
      this.resolve(bare, s);
      if (s.t) this.o.said(bare, s.line ?? "");
    }
    return s.t !== null;
  }

  /** What the agent of `bare` last said, once read: "" when it keeps a conversation but has said
   *  nothing there yet; undefined when it keeps none, or before its first read. */
  line(bare: string): string | undefined {
    const s = this.of(bare);
    return s.t ? s.line : undefined;
  }

  /** Whether `bare`'s agent keeps a conversation whose words were never read, or reported since
   *  they were (`stale`), and no read of it is due. */
  unread(bare: string): boolean {
    const s = this.of(bare);
    return !!s.t && !s.queued && (s.stale || (!!s.t.file && s.cursor === undefined));
  }

  /** The agent of `bare` reported from `session` while no one follows its tile: nothing is read or
   *  looked for now, and its words are read before its line is next asked for (`unread`). */
  stale(bare: string, session?: string): void {
    const s = this.tiles.get(bare);
    // Never asked for: its first read is from the end anyway.
    if (!s) return;
    s.stale = true;
    this.reportedFrom(s, session);
  }

  /** Read what the agent of `bare` said since it was last read, soon; `session`: the session it
   *  reports from, looked for again when another; `resolve`: look for which file it keeps first. */
  refresh(bare: string, o: { session?: string; resolve?: boolean } = {}): void {
    const s = this.of(bare);
    s.stale = false;
    this.reportedFrom(s, o.session);
    if (o.resolve || (!s.t?.file && sinceLook(s) >= RESOLVE_EVERY_MS)) s.resolve = true;
    else if (s.t && !s.t.file) this.lookLater(bare, s);
    if (s.resolve) this.resolve(bare, s);
    if (!s.t) return;
    if (s.queued) { if (s.reading) s.again = true; return; }
    s.queued = true;
    this.queue.push(bare);
    void this.run();
  }

  /** Read each tile whose agent reported while no one followed it (`stale`), soon. */
  refreshStale(): void {
    for (const [bare, s] of this.tiles) if (s.stale) this.refresh(bare);
  }

  /** Resolves once no read of `bare` is due: at once when none is. */
  settled(bare: string): Promise<void> {
    const s = this.tiles.get(bare);
    if (!s?.queued) return Promise.resolve();
    return new Promise((r) => s.settled.push(r));
  }

  /** `bare` is closed. */
  forget(bare: string): void {
    const s = this.tiles.get(bare);
    clearTimeout(s?.later);
    this.tiles.delete(bare);
    for (const r of s?.settled ?? []) r();
  }

  private of(bare: string): SaidOf {
    let s = this.tiles.get(bare);
    if (!s) {
      s = { t: null, queued: false, reading: false, again: false, resolve: false, resolvedAt: 0, stale: false, settled: [] };
      this.tiles.set(bare, s);
      this.resolve(bare, s);
    }
    return s;
  }

  /** `s`'s agent reported from `session`: which file it keeps is looked for again before its next
   *  read when that is another than it last reported, and than the one it keeps. */
  private reportedFrom(s: SaidOf, session: string | undefined): void {
    if (!session || session === s.reported) return;
    s.reported = session;
    if (session !== s.t?.session) s.resolve = true;
  }

  /** `s`'s agent, whose file is not written yet, asked to be read within 3 s of the last look for
   *  it: it is looked for, and read, once the 3 s are up. An agent's first words are often written
   *  in that time, and an agent that reports nothing may not report again (its screen still). */
  private lookLater(bare: string, s: SaidOf): void {
    if (s.later) return;
    s.later = setTimeout(() => {
      s.later = undefined;
      if (this.tiles.get(bare) === s && !s.t?.file) this.refresh(bare);
    }, RESOLVE_EVERY_MS - sinceLook(s));
    (s.later as { unref?: () => void }).unref?.();
  }

  /** Look for which file `bare`'s agent keeps now: another one is read from its end. */
  private resolve(bare: string, s: SaidOf): void {
    s.resolve = false;
    s.resolvedAt = performance.now();
    const t = this.o.transcriptOf(bare);
    if (t?.file === s.t?.file && t?.format === s.t?.format) { s.t = t; return; }
    s.t = t;
    s.cursor = undefined;
    if (!t?.file && s.line !== undefined && s.line !== "") this.tell(bare, s, "");
    if (t && s.line === undefined) s.line = "";
  }

  private tell(bare: string, s: SaidOf, line: string): void {
    if (s.line === line) return;
    s.line = line;
    this.o.said(bare, line);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let bare = this.queue.shift(); bare !== undefined; bare = this.queue.shift()) {
        const s = this.tiles.get(bare);
        if (!s) continue;
        if (s.resolve) this.resolve(bare, s);
        const t = s.t;
        if (t?.file) {
          s.reading = true;
          try {
            const read = await lastSaidSince(t.file, t.format, s.cursor);
            // Closed, or another file looked for, while it was read: what it read is not this tile's now.
            if (this.tiles.get(bare) === s && s.t === t) {
              s.cursor = read.cursor;
              if (read.line !== undefined) this.tell(bare, s, read.line);
              else if (s.line === undefined) this.tell(bare, s, "");
            }
          } catch { /* unreadable now: read again with its next report */ } finally {
            s.reading = false;
          }
        }
        if (s.again && this.tiles.get(bare) === s) {
          s.again = false;
          this.queue.push(bare);
          continue;
        }
        s.queued = false;
        for (const r of s.settled.splice(0)) r();
      }
    } finally {
      this.running = false;
    }
  }
}

export interface ConversationsOptions {
  /** The session the agent of `tile` keeps its conversation in now, its file, and how its manifest
   *  maps the file's records; null when no agent there keeps one. */
  transcriptOf(tile: string): Transcript | null;
  /** Whether the agent of `tile` runs on this machine, so its session file is here. */
  runsHere(tile: string): boolean;
}

/** Whoever is on this machine: the person, or a program or agent on the drive socket. A device on
 *  the network (a phone, a guest) is not. */
const onThisMachine = (from: Connection): boolean => from.actor.kind === "person" || (from.actor.kind === "peer" && !!from.actor.client);

export function conversations(o: ConversationsOptions): Domain<"agent.conversation" | "agent.tool" | "agent.transcript"> {
  /** What each caller follows, by tile: how to stop it. */
  const following = new WeakMap<Connection, Map<string, () => void>>();
  /** Where each caller's view of each agent's conversation begins, in which session: a tool use
   *  it opens is one it was shown, so it is looked for after that. */
  const shown = new WeakMap<Connection, Map<string, { session?: string; from: number }>>();
  const sizeOf = (file: string): number => { try { return fs.statSync(file).size; } catch { return 0; } };
  return {
    answers: {
      "agent.conversation": (from, tile, cursor, session) => {
        const bare = toBareId(text(tile, "tile"));
        if (cursor != null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) throw new ApiError("BAD_REQUEST", "cursor must be a whole number");
        if (session != null && typeof session !== "string") throw new ApiError("BAD_REQUEST", "session must be text");
        const now = o.transcriptOf(bare);
        // No agent there keeps a conversation: nothing, and nothing to follow.
        if (!now) return { entries: [], cursor: 0 };
        // A cursor counts in the session it was given in, and only there. No file yet (the agent
        // has said nothing): nothing so far, and its session is followed once its file is there.
        const since = session === now.session ? (cursor ?? undefined) : undefined;
        if (now.file) {
          if (!shown.has(from)) shown.set(from, new Map());
          shown.get(from)!.set(bare, { session: now.session, from: conversationStart(sizeOf(now.file), since) });
        }
        const first = now.file ? readConversation(now.file, now.format, since) : { entries: [], cursor: 0 };
        let mine = following.get(from);
        if (!mine) following.set(from, (mine = new Map()));
        mine.get(bare)?.();
        mine.set(bare, followAgent(() => o.transcriptOf(bare), now, first.cursor, (said, of) => from.send({ event: "agent.said", params: [bare, said.entries, said.cursor, of] })));
        return now.file ? { ...first, session: now.session } : first;
      },
      // The agent's own file, for a program here that reads its records: a path is true only here.
      "agent.transcript": (from, tile) => {
        const bare = toBareId(text(tile, "tile"));
        const now = o.transcriptOf(bare);
        if (!now?.file) throw new ApiError("NOT_FOUND", "this agent keeps no session file yet");
        if (!onThisMachine(from) || !o.runsHere(bare)) throw new ApiError("UNSUPPORTED", "a session file is named only to a program on the machine the agent runs on: read it with agent.conversation");
        return { session: now.session, path: now.file };
      },
      // One tool use of its session now, unfolded: asked for when the person opens its row.
      "agent.tool": (from, tile, use) => {
        const bare = toBareId(text(tile, "tile"));
        const now = o.transcriptOf(bare);
        const seen = shown.get(from)?.get(bare);
        const found = now?.file
          ? toolUse(now.file, now.format, text(use, "use"), seen && seen.session === now.session ? seen.from : conversationStart(sizeOf(now.file)))
          : undefined;
        if (!found) throw new ApiError("NOT_FOUND", "no such tool use in what this agent said");
        return found;
      },
    },
    effects: {},
    gone: (connection) => {
      for (const stop of following.get(connection)?.values() ?? []) stop();
      following.delete(connection);
    },
  };
}

/** Follow an agent's conversation from `cursor` in the session `at` (its file not written yet:
 *  from when it is): `send` is handed what is written to its file next, as it comes, and, once
 *  `now` says the agent keeps another session whose file there is, the last of that one, then what
 *  is written to it; each with its session. Stop it with what it returns. */
function followAgent(now: () => Transcript | null, at: Transcript, cursor: number, send: (said: Said, session: string) => void): () => void {
  let current: Kept | null = at.file ? (at as Kept) : null;
  const follow = (t: Kept, from: number) => followConversation(t.file, t.format, from, (said) => send(said, t.session));
  let stop = current ? follow(current, cursor) : () => {};
  const check = setInterval(() => {
    const next = now();
    if (!next?.file || next.session === current?.session) return;
    stop();
    current = next as Kept;
    const first = readConversation(next.file, next.format);
    send(first, next.session);
    stop = follow(current, first.cursor);
  }, SESSION_CHECK_MS);
  return () => {
    clearInterval(check);
    stop();
  };
}
