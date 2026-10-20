/**
 * What only the person at this machine decides: which plugins run, and with what settings. An
 * agent in a tile (`HCP_TOKEN`) or a program with a grant (`HIVE_DRIVE_TOKEN`) runs `hive` as
 * itself, and is refused these, told to ask the person.
 */
import { err, type OutCtx } from "./format.js";

/** Who runs this, when it is not the person: an agent in a tile, or a program with a grant. */
export function notThePerson(env: NodeJS.ProcessEnv = process.env): "an agent" | "a program" | null {
  if (env.HCP_TOKEN || env.HIVEMIND_TILE) return "an agent";
  if (env.HIVE_DRIVE_TOKEN) return "a program";
  return null;
}

/** Refuse `what` (e.g. "switch plugins on") unless the person runs it; `command` is what the
 *  person would run instead. */
export function personOnly(ctx: OutCtx, what: string, command: string): void {
  const who = notThePerson();
  if (who) err(ctx, "PERSON_ONLY", `only the person can ${what}, not ${who}; ask them to run \`${command}\``, undefined, `ask the person to run \`${command}\`, or to use Settings ▸ Plugins`);
}
