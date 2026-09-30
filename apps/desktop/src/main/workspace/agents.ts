/**
 * Agents' status and the links between them (the workspace API's `status.all` and `link.list`):
 * what there is now. Each change after it is an event the host publishes to every client
 * (`status.changed`, `link.pipe`, `link.spawn`).
 */
import type { Domain } from "@hivemind/workspace-api/server";
import type { Result } from "@hivemind/workspace-api/methods";

export interface AgentsHost {
  statuses(): Result<"status.all">;
  links(): Result<"link.list">;
}

export function agents(host: AgentsHost): Domain<"status.all" | "link.list"> {
  return {
    answers: {
      "status.all": () => host.statuses(),
      "link.list": () => host.links(),
    },
    effects: {},
  };
}
