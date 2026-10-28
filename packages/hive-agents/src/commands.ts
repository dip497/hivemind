/**
 * The slash commands an agent takes at its prompt (spec/agents.md "Commands"), as its manifest's
 * `commands` says: its own, and those in the folders it reads, the person's and the project's.
 * Node-only: it reads those folders.
 */
import { constants } from "node:fs";
import { readdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { COMMAND_NAME_RE } from "./manifest.js";
import type { AgentProviderDef } from "./types.js";

/** A command as a device offers it: `from`, whose it is. */
export interface SlashCommand {
  name: string;
  description?: string;
  from: "built-in" | "yours" | "project";
}

/** The most commands listed, folders read deep, and bytes of a file read for its description. */
const LISTED_MAX = 500;
const DEPTH_MAX = 3;
const HEAD_BYTES = 4096;
const DESCRIPTION_MAX = 200;

/** The first `HEAD_BYTES` of `file`; "" when it cannot be read, or is a link and `follow` is not set. */
async function headOf(file: string, follow: boolean): Promise<string> {
  const f = await open(file, follow ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!f) return "";
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await f.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await f.close();
  }
}

/** A command file's front matter, its `key: value` lines, and the first line of what follows. */
function said(text: string): { fields: Record<string, string>; first: string } {
  const fields: Record<string, string> = {};
  let body = text;
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (front) {
    body = text.slice(front[0].length);
    for (const line of front[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
    }
  }
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return { fields, first };
}

const described = (d: string | undefined) => (d ? { description: d.slice(0, DESCRIPTION_MAX) } : {});

/** The `*.md` files under `dir`, by their path from it without `.md`, `DEPTH_MAX` folders deep. */
async function files(dir: string, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory() && depth < DEPTH_MAX) out.push(...(await files(path.join(dir, e.name), depth + 1)).map((f) => `${e.name}/${f}`));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(e.name.slice(0, -3));
  }
  return out;
}

/** The commands in one folder the manifest names. */
async function inFolder(dir: string, skills: boolean, prefix: string, from: SlashCommand["from"]): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  // A project is anyone's to write: a link in it never leads the reading outside it.
  const follow = from === "yours";
  if (skills) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const text = await headOf(path.join(dir, e.name, "SKILL.md"), follow);
      if (!text) continue;
      const { fields } = said(text);
      // One the person may not call is the agent's own to use.
      if (fields["user-invocable"] === "false") continue;
      out.push({ name: prefix + (fields.name || e.name), ...described(fields.description), from });
    }
  } else {
    for (const f of await files(dir)) {
      const { fields, first } = said(await headOf(path.join(dir, `${f}.md`), follow));
      out.push({ name: prefix + f.split("/").join(":"), ...described(fields.description || first), from });
    }
  }
  return out.filter((c) => COMMAND_NAME_RE.test(c.name));
}

/** Whether `dir`, links resolved, is still inside `root`. */
async function within(root: string, dir: string): Promise<boolean> {
  const [r, d] = await Promise.all([realpath(root).catch(() => null), realpath(dir).catch(() => null)]);
  return r !== null && d !== null && (d === r || d.startsWith(r + path.sep));
}

/** The commands `def` takes, run in `at.folder` by the person whose home is `at.home` (null: on
 *  another machine, whose folders are read there, so only its own; a null home: asked by someone
 *  who is not that person, so not theirs): one of a name the last said, ordered by name. */
export async function commandsOf(def: AgentProviderDef, at: { home: string | null; folder: string } | null): Promise<SlashCommand[]> {
  const byName = new Map<string, SlashCommand>();
  for (const b of def.commands?.builtIn ?? []) byName.set(b.name, { name: b.name, ...described(b.description), from: "built-in" });
  for (const f of at ? def.commands?.folders ?? [] : []) {
    const yours = f.path.startsWith("{home}/");
    if (yours && at!.home === null) continue;
    const dir = yours ? path.join(at!.home!, f.path.slice("{home}/".length)) : path.join(at!.folder, f.path.slice("{folder}/".length));
    if (!yours && !(await within(at!.folder, dir))) continue;
    for (const c of await inFolder(dir, f.skills === true, f.prefix ?? "", yours ? "yours" : "project")) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, LISTED_MAX);
}
