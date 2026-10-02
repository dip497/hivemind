/**
 * The conversation of an agent here, for whoever asks (M5, spec/agents.md "Conversation"): the
 * session file its manifest says it keeps, what that says so far, then each piece written to it,
 * sent to that caller as it comes, until the caller goes.
 */
import { agentForCmd, readTrackedSession, sessionFile, sessionFor } from "@hivemind/agents/node";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { followConversation, readConversation } from "./conversation.js";
import { runsIn, type HeldBoard } from "./needs.js";

/** The session file the agent of `tile` keeps its conversation in, among the boards `held`, as its
 *  manifest says it is kept (`session.transcript`, `session.resume.exists`); null when it names no
 *  format, or no file is found. The session is the one last recorded for the tile in
 *  `tileSessionsDir` (by its tracker hook, or by the daemon as it bound one at its start), else the
 *  one its manifest would resume. */
export function transcriptFile(held: HeldBoard[], tile: string, tileSessionsDir: string, home?: string): string | null {
  const bare = toBareId(tile);
  const record = held.flatMap((h) => h.core?.tiles ?? []).find((t) => t.id === bare) as { cmd?: string; args?: string[] } | undefined;
  const def = agentForCmd(record?.cmd);
  const exists = def?.session?.resume?.exists;
  if (!record || !def?.session?.transcript || !exists) return null;
  const spec = { cwd: runsIn(held, bare) ?? "", args: record.args ?? [] };
  const id = readTrackedSession(tileSessionsDir, `hm:${bare}`) ?? readTrackedSession(tileSessionsDir, bare) ?? sessionFor(def, spec);
  return id ? sessionFile(exists, id, home) : null;
}

export interface ConversationsOptions {
  /** The session file of the agent of `tile`, in a format its manifest names; null when none. */
  fileOf(tile: string): string | null;
}

export function conversations(o: ConversationsOptions): Domain<"agent.conversation"> {
  /** What each caller follows, by tile: how to stop it. */
  const following = new WeakMap<Connection, Map<string, () => void>>();
  return {
    answers: {
      "agent.conversation": (from, tile, cursor) => {
        const bare = toBareId(text(tile, "tile"));
        if (cursor != null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) throw new ApiError("BAD_REQUEST", "cursor must be a whole number");
        const file = o.fileOf(bare);
        if (!file) return { entries: [], cursor: 0 };
        const first = readConversation(file, cursor ?? undefined);
        let mine = following.get(from);
        if (!mine) following.set(from, (mine = new Map()));
        mine.get(bare)?.();
        mine.set(bare, followConversation(file, first.cursor, (said) => from.send({ event: "agent.said", params: [bare, said.entries, said.cursor] })));
        return first;
      },
    },
    effects: {},
    gone: (connection) => {
      for (const stop of following.get(connection)?.values() ?? []) stop();
      following.delete(connection);
    },
  };
}
