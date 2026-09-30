/**
 * Intents (R7): the one path a side effect takes on the machine that carries it out. An intent
 * names who asks (the actor), what they ask (the verb) and what it acts on (the target);
 * `perform` checks it against the policy, runs it, and records how it ended in the audit log.
 * The layout, the views and the board are not changed by intents: those are the document's own
 * edits, each attributed to its writer. Keystrokes, resizes and flow control are not intents
 * either.
 *
 * The policy: an intent that only one tile may ask for is refused to any other tile. A person
 * at this machine may ask for anything.
 */
import type { Access } from "./access.js";
import type { AuditLog } from "./audit-log.js";

/** Who asks: whoever runs in a tile (an agent, or a person at a shell tile), named by the tile;
 *  a person at this machine, outside any tile; or someone on another device, reaching a workspace
 *  shared from here (M1), named by their person and device keys, with what their access allows. */
export type Actor =
  | { kind: "tile"; tile: string }
  | { kind: "person" }
  | { kind: "peer"; person: string; device: string; access: Access };

/** What is asked. `R` is what carrying it out returns. */
export interface Intent<R = unknown> {
  /** In the control plane's words: `tile.spawn_agent`, `agent.send`, … */
  verb: string;
  /** What it acts on: a tile, or a pipe (`src->dst`). An intent that opens a tile names it
   *  from what it returns. */
  target?: string | ((result: R) => string | undefined);
  /** What it says that the verb and the target do not: an approval's decision, the tool an
   *  approval is asked for; for one that ends in a decision (a review), the decision, read from
   *  what it returns. Never what someone wrote. */
  detail?: string | ((result: R) => string | undefined);
  /** The one tile that may ask for it, when only one may: the supervisor an approval was asked
   *  of, the tile a call names as its caller. */
  onlyBy?: string;
}

/** What `perform` throws for an intent the policy refuses. It never ran. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** One line of the audit log. */
export interface AuditRecord {
  /** When it was asked (ISO 8601). The line is written when it ends. */
  at: string;
  actor: Actor;
  verb: string;
  target?: string;
  detail?: string;
  /** `refused`: the policy said no, and it never ran. */
  outcome: "ok" | "error" | "refused";
  /** The code of the error it failed with (`TILE_NOT_FOUND`, `RATE_LIMITED`, …), if it had one. */
  code?: string;
}

export class Intents {
  constructor(private readonly audit: Pick<AuditLog, "write">) {}

  /** Carry out what `actor` asks and record how it ended. Returns what `run` returns, and throws
   *  what it throws; throws `Refused` for what the policy does not allow. */
  async perform<R>(actor: Actor, intent: Intent<R>, run: () => R | Promise<R>): Promise<R> {
    const at = new Date().toISOString();
    const asked = (v: Intent<R>["target"]) => (typeof v === "string" ? v : undefined);
    const record = (target: string | undefined, detail: string | undefined, end: Pick<AuditRecord, "outcome" | "code">): void =>
      this.audit.write({ at, actor, verb: intent.verb, ...(target ? { target } : {}), ...(detail ? { detail } : {}), ...end });
    if (intent.onlyBy !== undefined && actor.kind === "tile" && actor.tile !== intent.onlyBy) {
      record(asked(intent.target), asked(intent.detail), { outcome: "refused" });
      throw new Refused(`${intent.verb} is for ${intent.onlyBy} to ask, or a person at this machine, not ${actor.tile}`);
    }
    let result: R;
    try {
      result = await run();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      record(asked(intent.target), asked(intent.detail), { outcome: "error", ...(typeof code === "string" && code ? { code } : {}) });
      throw e;
    }
    const of = (v: Intent<R>["target"]) => (typeof v === "function" ? v(result) : v);
    record(of(intent.target), of(intent.detail), { outcome: "ok" });
    return result;
  }
}
