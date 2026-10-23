/**
 * What only the person at this machine decides: which plugins run and with what settings, and
 * the app's sounds and notifications. An agent in a tile (`HCP_TOKEN`) or a program with a grant
 * (`HIVE_DRIVE_TOKEN`) runs `hive` as itself, and is refused these, told to ask the person.
 *
 * Advisory, not a wall: it reads environment variables, which a process can unset, and the file
 * it guards is the person's own. It keeps an agent that follows its brief from doing these by
 * mistake; it does not stop one that sets out to. What the drive socket refuses an agent's tile
 * (`notifications.play`, workspace-api roles.ts) is the enforced half.
 */
import { err, type OutCtx } from "./format.js";

/** Who runs this, when it is not the person: an agent in a tile, or a program with a grant. */
export function notThePerson(env: NodeJS.ProcessEnv = process.env): "an agent" | "a program" | null {
  if (env.HCP_TOKEN || env.HIVEMIND_TILE) return "an agent";
  if (env.HIVE_DRIVE_TOKEN) return "a program";
  return null;
}

/** Refuse `what` (e.g. "switch plugins on") unless the person runs it; `command` is what the
 *  person would run instead, `page` the Settings page that does it. */
export function personOnly(ctx: OutCtx, what: string, command: string, page = "Plugins"): void {
  const who = notThePerson();
  if (who) err(ctx, "PERSON_ONLY", `only the person can ${what}, not ${who}; ask them to run \`${command}\``, undefined, `ask the person to run \`${command}\`, or to use Settings ▸ ${page}`);
}
