/**
 * The conversation of an agent here, for whoever asks (M5, spec/agents.md "Conversation"): the
 * session file its manifest says it keeps, what that says so far, then each piece written to it,
 * sent to that caller as it comes, and the next session's from its start once the agent begins
 * another (as Claude Code's `/clear` does), until the caller goes.
 */
import { agentForCmd, readTrackedSession, sessionFile, sessionFor } from "@hivemind/agents/node";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { followConversation, readConversation, type Said } from "./conversation.js";
import { runsIn, type HeldBoard } from "./needs.js";

/** A session an agent keeps its conversation in: its id, and its file. */
export interface Transcript {
  session: string;
  file: string;
}

/** How often a followed agent is looked at for a session it began since. */
const SESSION_CHECK_MS = 1000;

/** The session the agent of `tile` keeps its conversation in now, among the boards `held`, and its
 *  file, as its manifest says it is kept (`session.transcript`, `session.resume.exists`); null
 *  when it names no format, or no file is found. The session is the one last recorded for the tile
 *  in `tileSessionsDir` (by its tracker hook, or by the daemon as it bound one at its start), else
 *  the one its manifest would resume. */
export function transcriptOf(held: HeldBoard[], tile: string, tileSessionsDir: string, home?: string): Transcript | null {
  const bare = toBareId(tile);
  const record = held.flatMap((h) => h.core?.tiles ?? []).find((t) => t.id === bare) as { cmd?: string; args?: string[] } | undefined;
  const def = agentForCmd(record?.cmd);
  const exists = def?.session?.resume?.exists;
  if (!record || !def?.session?.transcript || !exists) return null;
  const spec = { cwd: runsIn(held, bare) ?? "", args: record.args ?? [] };
  const session = readTrackedSession(tileSessionsDir, `hm:${bare}`) ?? readTrackedSession(tileSessionsDir, bare) ?? sessionFor(def, spec);
  const file = session ? sessionFile(exists, session, home) : null;
  return session && file ? { session, file } : null;
}

export interface ConversationsOptions {
  /** The session the agent of `tile` keeps its conversation in now, and its file, in a format its
   *  manifest names; null when none. */
  transcriptOf(tile: string): Transcript | null;
}

export function conversations(o: ConversationsOptions): Domain<"agent.conversation"> {
  /** What each caller follows, by tile: how to stop it. */
  const following = new WeakMap<Connection, Map<string, () => void>>();
  return {
    answers: {
      "agent.conversation": (from, tile, cursor, session) => {
        const bare = toBareId(text(tile, "tile"));
        if (cursor != null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) throw new ApiError("BAD_REQUEST", "cursor must be a whole number");
        if (session != null && typeof session !== "string") throw new ApiError("BAD_REQUEST", "session must be text");
        const now = o.transcriptOf(bare);
        if (!now) return { entries: [], cursor: 0 };
        // A cursor counts in the session it was given in, and only there.
        const first = readConversation(now.file, session === now.session ? (cursor ?? undefined) : undefined);
        let mine = following.get(from);
        if (!mine) following.set(from, (mine = new Map()));
        mine.get(bare)?.();
        mine.set(bare, followAgent(() => o.transcriptOf(bare), now, first.cursor, (said, of) => from.send({ event: "agent.said", params: [bare, said.entries, said.cursor, of] })));
        return { ...first, session: now.session };
      },
    },
    effects: {},
    gone: (connection) => {
      for (const stop of following.get(connection)?.values() ?? []) stop();
      following.delete(connection);
    },
  };
}

/** Follow an agent's conversation from `cursor` in the session `at`: `send` is handed what is
 *  written to its file next, as it comes, and, once `now` says the agent keeps another session
 *  whose file there is, the last of that one, then what is written to it; each with its session.
 *  Stop it with what it returns. */
function followAgent(now: () => Transcript | null, at: Transcript, cursor: number, send: (said: Said, session: string) => void): () => void {
  let current = at;
  const follow = (t: Transcript, from: number) => followConversation(t.file, from, (said) => send(said, t.session));
  let stop = follow(at, cursor);
  const check = setInterval(() => {
    const next = now();
    if (!next || next.session === current.session) return;
    stop();
    current = next;
    const first = readConversation(next.file);
    send(first, next.session);
    stop = follow(next, first.cursor);
  }, SESSION_CHECK_MS);
  return () => {
    clearInterval(check);
    stop();
  };
}
