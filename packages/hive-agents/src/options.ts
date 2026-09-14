/** Agent launch options: argv from chosen values, and the values themselves read
 *  from the agent's own CLI output. Pure, so the renderer and tests share it. */
import type { AgentOption, AgentProviderDef, SpawnOptions } from "./types.js";

export function agentOption(def: AgentProviderDef, id: string): AgentOption | undefined {
  return def.options?.find((o) => o.id === id);
}

/** "default" means not chosen (`hive ctl spawn --mode default`). A value starting
 *  with "-" would read as another flag, so it is dropped. */
function valueOf(o: AgentOption, opts: SpawnOptions): string | undefined {
  const chosen = opts[o.id];
  const v = chosen && chosen !== "default" ? chosen : o.default;
  return v && !v.startsWith("-") ? v : undefined;
}

export function optionArgs(def: AgentProviderDef, opts: SpawnOptions): string[] {
  const args = [...(def.defaultArgs ?? [])];
  for (const o of def.options ?? []) {
    const v = valueOf(o, opts);
    // Own keys only: `--mode constructor` must not find Object.prototype.
    const special = v && o.values && Object.hasOwn(o.values, v) ? o.values[v] : undefined;
    const argv = v ? special ?? (o.flag ? [o.flag, v] : undefined) : undefined;
    if (argv) args.push(...argv);
  }
  return args;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TOKEN = /^[\w.:/@+-]+$/;
const uniq = (xs: string[]): string[] => [...new Set(xs.filter((x) => TOKEN.test(x)))];

/** The help lines describing `flag`: its own line and its continuation, up to the next option. */
function flagBlock(help: string, flag: string): string[] | null {
  const lines = help.replace(ANSI, "").split("\n");
  const at = lines.findIndex((l) => /^\s*-/.test(l) && l.split(/[\s,=]+/).includes(flag));
  if (at < 0) return null;
  const block = [lines[at]!];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l) || /^\s*--?[A-Za-z]/.test(l)) break;
    block.push(l);
  }
  return block;
}

/** Values the CLI's own help lists for `flag`, in the formats argument parsers print. */
export function choicesFromHelp(help: string, flag: string): string[] {
  const block = flagBlock(help, flag);
  if (!block) return [];
  const text = block.join(" ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const quoted = /choices:\s*((?:"[^"]*"[\s,]*)+)/i.exec(text);
  if (quoted) return uniq([...quoted[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
  const inline = /possible values:\s*([^\]]+)\]/i.exec(text);
  if (inline) return uniq(inline[1]!.split(",").map((s) => s.trim()));
  if (/possible values:/i.test(text)) {
    return uniq(block.map((l) => /^\s*-\s+([\w.-]+):/.exec(l)?.[1] ?? ""));
  }
  const paren = /\(([\w.-]+(?:,\s*[\w.-]+)+)\)/.exec(text);
  // "(e.g., gpt-5, sonnet)" lists examples, not the choices.
  if (paren && !/^(e\.?g|i\.?e)\.?$/i.test(paren[1]!.split(",")[0]!)) return uniq(paren[1]!.split(",").map((s) => s.trim()));
  const piped = /(?:^|[\s:])([\w.-]+(?:\|[\w.-]+)+)(?=[\s.,)]|$)/.exec(text);
  return piped ? uniq(piped[1]!.split("|")) : [];
}

/** Values from a listing command: one per line, or columns joined by `format` ("{1}/{2}"). */
export function choicesFromList(out: string, spec: { skip?: number; format?: string }): string[] {
  const rows = out.replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(spec.skip ?? 0);
  const fmt = spec.format ?? "{1}";
  return uniq(rows.map((r) => {
    const cols = r.split(/\s+/);
    return fmt.replace(/\{(\d+)\}/g, (_, i: string) => cols[Number(i) - 1] ?? "");
  })).slice(0, 1000);
}

/** Discovered values plus any the agent maps specially and hivemind's default. */
export function optionChoices(o: AgentOption, discovered: readonly string[]): string[] {
  return [...new Set([...discovered, ...Object.keys(o.values ?? {}), ...(o.default ? [o.default] : [])])];
}
