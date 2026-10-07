/** What a plugin lets an agent do with it: commands its manifest declares and its code answers
 *  (`hm.onCommand`). An agent lists them with `hive ctl plugin commands` and runs one with
 *  `hive ctl plugin call`, while the plugin is running: the active view, an open tool tile, a
 *  widget on the board. */
export interface PluginCommand {
  name: string;
  /** What it does, for the agent deciding whether to run it. */
  description: string;
  /** What its JSON argument holds, in a line: `{ "text": string }`. Absent: it takes none. */
  args?: string;
}

export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const COMMANDS_MAX = 32;

/** A manifest's `commands`, or why they are not. */
export function parsePluginCommands(raw: unknown): { commands: PluginCommand[] } | { error: string } {
  if (raw === undefined) return { commands: [] };
  if (!Array.isArray(raw) || raw.length > COMMANDS_MAX) return { error: `"commands" must be a list of at most ${COMMANDS_MAX}` };
  const commands: PluginCommand[] = [];
  for (const c of raw) {
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof o.name !== "string" || !COMMAND_NAME_RE.test(o.name)) return { error: `a command's "name" is lowercase letters, digits and dashes (got ${JSON.stringify(o.name)})` };
    if (commands.some((x) => x.name === o.name)) return { error: `command "${o.name}" is listed twice` };
    if (typeof o.description !== "string" || !o.description.trim() || o.description.length > 300) return { error: `command "${o.name}" needs a "description" of at most 300 characters` };
    if (o.args !== undefined && (typeof o.args !== "string" || o.args.length > 300)) return { error: `command "${o.name}": "args" is one line saying what its JSON argument holds` };
    commands.push({ name: o.name, description: o.description.trim(), ...(typeof o.args === "string" ? { args: o.args } : {}) });
  }
  return { commands };
}
