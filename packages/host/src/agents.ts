/**
 * Agents' status and the links between them (the workspace API's `status.all` and `link.list`),
 * and the agents of one workspace as everything that shows them reads them (`agent.list`): what
 * there is now. Each change after it is an event the host publishes to every client
 * (`status.changed`, `link.pipe`, `link.spawn`).
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { AgentFeed } from "./agent-feed.js";
import type { Domain } from "@hivemind/workspace-api/server";
import type { Result } from "@hivemind/workspace-api/methods";

export interface AgentsHost {
  statuses(): Result<"status.all">;
  links(): Result<"link.list">;
  /** The agents here, as one feed (agent-feed.ts), and the id of the workspace at a folder. */
  feed?(): AgentFeed | null;
  workspaceOf?(repo: string): string | null;
}

export function agents(host: AgentsHost): Domain<"status.all" | "link.list" | "agent.list" | "agent.since"> {
  const ws = (repo: unknown): string | null => host.workspaceOf?.(text(repo, "repo")) ?? null;
  return {
    answers: {
      "status.all": () => host.statuses(),
      "link.list": () => host.links(),
      "agent.list": (_from, repo) => {
        const id = ws(repo);
        const feed = host.feed?.();
        return id && feed ? feed.list(id) : { seq: 0, agents: [] };
      },
      "agent.since": (_from, repo, seq) => {
        const id = ws(repo);
        const feed = host.feed?.();
        if (typeof seq !== "number" || !Number.isInteger(seq)) throw new ApiError("BAD_REQUEST", "seq: a whole number");
        return id && feed ? feed.since(id, seq) : null;
      },
    },
    effects: {},
  };
}
