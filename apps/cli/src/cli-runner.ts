/**
 * Runs a `hive` command line: finds the command it names, shows its help with the exit codes, and
 * refuses what it cannot run before it runs: an unknown command, an unknown flag, a missing
 * argument. Each is a usage error, printed as every failure is (exit-codes.ts), exit 2.
 */
import { renderUsage, runCommand, type ArgsDef, type CommandDef } from "citty";
import { EXIT, exitCodesHelp, printFailure, setHelpCommand } from "./exit-codes.js";

type Command = CommandDef<ArgsDef>;
type Arg = { type?: string; alias?: string | string[] };

const resolved = async <T>(v: T | (() => T | Promise<T>) | Promise<T>): Promise<T> => (typeof v === "function" ? await (v as () => T | Promise<T>)() : await v);
const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A flag's name without its dashes and value: `--timeout=5s` is `timeout`. */
const flagName = (token: string): string => token.replace(/^-{1,2}/, "").split("=")[0]!;
/** Whether `token` is a flag: `-` alone (stdin) and a negative number are values. */
const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && !/^-\d/.test(token);

/** The flags a command takes, by each name it answers to, and whether each takes a value. */
function flagsOf(args: Record<string, Arg>): Map<string, boolean> {
  const flags = new Map<string, boolean>([["help", false], ["h", false]]);
  for (const [name, def] of Object.entries(args)) {
    if (def.type === "positional") continue;
    const value = def.type === "string" || def.type === "enum";
    const aliases = Array.isArray(def.alias) ? def.alias : def.alias ? [def.alias] : [];
    for (const n of [name, kebab(name), camel(name), ...aliases]) {
      flags.set(n, value);
      if (def.type === "boolean") flags.set(`no-${n}`, false);
    }
  }
  return flags;
}

class Usage extends Error {
  constructor(message: string, readonly names: string[]) { super(message); }
}

/** The command `tokens` names under `root`, its names from the root, and what is left for it. */
async function commandOf(root: Command, tokens: string[]): Promise<{ chain: Command[]; names: string[]; rest: string[] }> {
  const chain = [root];
  const names: string[] = [];
  let rest = tokens;
  for (;;) {
    const cmd = chain.at(-1)!;
    const subs = await resolved(cmd.subCommands);
    if (!subs || Object.keys(subs).length === 0) return { chain, names, rest };
    const flags = flagsOf((await resolved(cmd.args ?? {})) as Record<string, Arg>);
    let i = 0;
    for (; i < rest.length && rest[i] !== "--" && isFlag(rest[i]!); i++) if (flags.get(flagName(rest[i]!)) && !rest[i]!.includes("=")) i++;
    const name = rest[i];
    if (name === undefined || name === "--") {
      if (cmd.run) return { chain, names, rest };
      return { chain, names, rest: [] };
    }
    const sub = (subs as Record<string, Command | (() => Promise<Command>)>)[name];
    if (!sub) throw new Usage(`${["hive", ...names].join(" ")} has no command ${name}: it has ${Object.keys(subs).join(", ")}`, names);
    chain.push(await resolved(sub));
    names.push(name);
    rest = rest.slice(i + 1);
  }
}

/** The flags in `tokens` that `cmd` does not take. */
async function unknownFlags(cmd: Command, tokens: string[]): Promise<string[]> {
  const flags = flagsOf((await resolved(cmd.args ?? {})) as Record<string, Arg>);
  const unknown: string[] = [];
  for (let i = 0; i < tokens.length && tokens[i] !== "--"; i++) {
    const t = tokens[i]!;
    if (!isFlag(t)) continue;
    const takes = flags.get(flagName(t));
    if (takes === undefined) unknown.push(t.split("=")[0]!);
    else if (takes && !t.includes("=")) i++;
  }
  return unknown;
}

/** Run the command line `tokens` (argv after the program). */
export async function runCli(root: Command, tokens: string[]): Promise<void> {
  const before = tokens.includes("--") ? tokens.slice(0, tokens.indexOf("--")) : tokens;
  const json = before.includes("--json");
  let names: string[] = [];
  const usage = (message: string): never => printFailure(json, { code: "USAGE", message, fix: `${["hive", ...names].join(" ")} --help` }, EXIT.usage);
  try {
    const found = await commandOf(root, tokens);
    names = found.names;
    const cmd = found.chain.at(-1)!;
    setHelpCommand(`${["hive", ...names].join(" ")} --help`);
    if (before.includes("--help") || before.includes("-h")) {
      // The usage line names the whole command, as it is typed.
      const shownAs = { meta: { name: ["hive", ...names.slice(0, -1)].join(" "), version: (await resolved(root.meta))?.version } } as Command;
      console.log(`${await renderUsage(cmd, names.length ? shownAs : undefined)}\n\n${exitCodesHelp()}\n`);
      return;
    }
    if (tokens.length === 1 && (tokens[0] === "--version" || tokens[0] === "-v")) {
      console.log((await resolved(root.meta))?.version ?? "");
      return;
    }
    if (!cmd.run) usage(`say which: ${["hive", ...names].join(" ")} <command>; --help lists them`);
    const unknown = await unknownFlags(cmd, found.rest);
    if (unknown.length) usage(`${["hive", ...names].join(" ")} takes no ${unknown.join(", ")}`);
  } catch (e) {
    if (e instanceof Usage) { names = e.names; usage(e.message); }
    throw e;
  }
  try {
    await runCommand(root, { rawArgs: tokens });
  } catch (e) {
    // citty's own: a required argument missing, a value not one of a choice.
    if ((e as Error)?.name === "CLIError") usage((e as Error).message.replace(/\x1b\[[0-9;]*m/g, ""));
    printFailure(json, { code: "FAILED", message: e instanceof Error ? e.message : String(e) });
  }
}
