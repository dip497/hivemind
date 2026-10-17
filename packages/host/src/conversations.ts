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
import { conversationStart, followConversation, lastSaid, pendingTool, readConversation, toolUse, type Said } from "./conversation.js";
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

/** How long which session file an agent keeps is taken as known. */
const SESSION_KNOWN_MS = 5000;

/** What each agent here that keeps a conversation last said (`lastSaid`), for Home: which file it
 *  keeps is looked for until found, then again after `SESSION_KNOWN_MS`, and the file read again
 *  only when it grew or shrank, so a board of agents costs a stat each. */
export class LastSaid {
  private files = new Map<string, { t: Transcript | null; at: number }>();
  private said = new Map<string, { file: string; size: number; line: string | undefined }>();

  constructor(private readonly o: { tileSessionsDir: string; home?: string; now?(): number }) {}

  /** What the agent of `tile`, among `held`, last said; "" when it keeps a conversation but has
   *  said nothing there yet, so nothing from its screen stands in; undefined when it keeps none. */
  line(held: HeldBoard[], tile: string): string | undefined {
    const now = this.o.now?.() ?? Date.now();
    let known = this.files.get(tile);
    if (!known?.t?.file || now - known.at >= SESSION_KNOWN_MS) {
      known = { t: transcriptOf(held, tile, this.o.tileSessionsDir, this.o.home), at: now };
      this.files.set(tile, known);
    }
    if (!known.t) return undefined;
    const file = known.t.file;
    if (!file) return "";
    let size: number;
    try { size = fs.statSync(file).size; } catch { return ""; }
    const was = this.said.get(tile);
    if (was?.file === file && was.size === size) return was.line ?? "";
    const line = lastSaid(file, known.t.format);
    this.said.set(tile, { file, size, line });
    return line ?? "";
  }
}

export interface ConversationsOptions {
  /** The session the agent of `tile` keeps its conversation in now, its file, and how its manifest
   *  maps the file's records; null when no agent there keeps one. */
  transcriptOf(tile: string): Transcript | null;
}

export function conversations(o: ConversationsOptions): Domain<"agent.conversation" | "agent.tool"> {
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
