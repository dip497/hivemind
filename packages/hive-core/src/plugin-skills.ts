/**
 * Agent skills a tool plugin ships (`"skills": ["skills/<name>"]` in its manifest), installed into a
 * workspace's `.claude/skills/<name>/` where the plugin is on, beside hive's own skills.
 *
 * The folder is the plugin's, and hive only touches one it wrote:
 *   - each one it writes holds `.hive-plugin`: the plugin's id and a hash of the files as written.
 *     A folder without one is the person's, and a plugin skill of that name is refused, not written.
 *   - it is updated with the plugin, and removed when the plugin is off or gone, only while its
 *     files are as hive wrote them; one the person changed is left as it is, and said so.
 *   - it never shows in `git status`: each folder hive manages is listed in the clone's
 *     `info/exclude` (per clone, shared by its linked worktrees; never the tracked .gitignore), and
 *     the line goes when the folder does. Claude Code reads project skills only from the work
 *     tree's `.claude/skills/`, so they cannot live outside it.
 *
 * A workspace with no plugin skill and no folder hive wrote costs one `readdir` and runs no git.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { skillName } from "./tool-format.js";

const run = promisify(execFile);

/** Hive's own skills (`./agentic.ts` writes them): names no plugin's skill may take. */
export const HIVE_SKILL_NAMES = ["hive-work", "hivemind", "hive-browser", "hive-workflow"] as const;

/** The file that marks a skill folder as one hive installed for a plugin. */
export const SKILL_MARKER = ".hive-plugin";
/** What one plugin skill may hold: its files, and their size together. */
const MAX_FILES = 32;
const MAX_BYTES = 512 * 1024;

/** One plugin's skills, as installing reads them. */
export interface PluginSkillSource {
  plugin: string;
  version?: string;
  /** The plugin's folder. */
  dir: string;
  /** Its skill folders, relative to `dir`. */
  skills: string[];
}

export interface PluginSkillsReport {
  /** Written for the first time. */
  installed: string[];
  /** Replaced by the plugin's newer copy. */
  updated: string[];
  /** Taken away: its plugin is off or gone, or no longer ships it. */
  removed: string[];
  /** Left as they are because the person changed them since hive wrote them. */
  kept: { name: string; plugin: string; why: string }[];
  /** Not written: the name is taken by a skill hive did not write. */
  refused: { name: string; plugin: string; why: string }[];
}

interface Marker { plugin: string; version?: string; hash: string }
interface SkillFile { rel: string; bytes: Buffer }

/** The files of a skill folder, sorted, checked for size; a link or anything but a file or folder is refused. */
async function readFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === SKILL_MARKER) continue;
      if (e.isDirectory()) { await walk(r); continue; }
      if (!e.isFile()) throw new Error(`${r} is not a file (a link or a device)`);
      const bytes = await fs.readFile(path.join(dir, r));
      total += bytes.length;
      out.push({ rel: r, bytes });
      if (out.length > MAX_FILES) throw new Error(`it holds more than ${MAX_FILES} files`);
      if (total > MAX_BYTES) throw new Error(`it is over ${MAX_BYTES / 1024} KB`);
    }
  };
  await walk("");
  return out;
}

const hashOf = (files: SkillFile[]): string => {
  const h = createHash("sha256");
  for (const f of files) h.update(f.rel).update("\0").update(f.bytes).update("\0");
  return h.digest("hex");
};

/** The `name` and `description` of a SKILL.md's frontmatter. */
function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return {};
  const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(m[1]!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
  return { name: field("name"), description: field("description") };
}

/** Why the skill in folder `rel` of the plugin in `dir` cannot be installed; null when it can. */
export async function skillProblem(dir: string, rel: string): Promise<string | null> {
  const name = skillName(rel);
  if ((HIVE_SKILL_NAMES as readonly string[]).includes(name)) return `skill "${name}" has the name of one of hive's own skills`;
  const folder = path.join(dir, rel);
  const st = await fs.lstat(folder).catch(() => null);
  if (!st?.isDirectory()) return `skill folder ${rel} is missing`;
  let files: SkillFile[];
  try { files = await readFiles(folder); } catch (e) { return `skill ${rel}: ${(e as Error).message}`; }
  const main = files.find((f) => f.rel === "SKILL.md");
  if (!main) return `skill ${rel} has no SKILL.md`;
  const fm = frontmatter(main.bytes.toString("utf8"));
  if (fm.name !== name) return `skill ${rel}: its SKILL.md frontmatter says name: ${fm.name ?? "(none)"}, not ${name}`;
  if (!fm.description) return `skill ${rel}: its SKILL.md frontmatter has no description, which is what an agent picks it by`;
  return null;
}

async function readMarker(folder: string): Promise<Marker | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(folder, SKILL_MARKER), "utf8")) as Partial<Marker>;
    return typeof m.plugin === "string" && typeof m.hash === "string" ? (m as Marker) : null;
  } catch { return null; }
}

/** Whether the folder's files are as hive wrote them. */
const asWritten = async (folder: string, marker: Marker): Promise<boolean> =>
  readFiles(folder).then((f) => hashOf(f) === marker.hash, () => false);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try { return (await run("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout; } catch { return null; }
}

/** The clone's exclude file and where `cwd` sits in its work tree; null outside a git work tree. */
async function gitPlace(cwd: string): Promise<{ exclude: string; top: string; prefix: string } | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "info/exclude"]);
  const [top, prefix, exclude] = out?.split("\n") ?? [];
  if (!top || prefix === undefined || !exclude) return null;
  return { top, prefix, exclude: path.resolve(cwd, exclude) };
}

/** The block of `info/exclude` hive writes for one work tree: a linked worktree has its own. */
const blockStart = (top: string) => `# hive: plugin skills in ${top} (written by hive; it rewrites this block)`;
const BLOCK_END = "# hive: end of plugin skills";

/** Make `names` (folders under `.claude/skills/`) the ones this work tree's block of the clone's
 *  `info/exclude` lists: added, kept, or taken out. */
async function setExcluded(place: { exclude: string; top: string; prefix: string }, names: string[]): Promise<void> {
  const before = await fs.readFile(place.exclude, "utf8").catch(() => "");
  const lines = before.split("\n");
  const start = lines.indexOf(blockStart(place.top));
  const end = start < 0 ? -1 : lines.indexOf(BLOCK_END, start);
  const rest = start < 0 ? lines : [...lines.slice(0, start), ...lines.slice(end < 0 ? lines.length : end + 1)];
  while (rest.length && rest[rest.length - 1] === "") rest.pop();
  const block = names.length ? [blockStart(place.top), ...names.sort().map((n) => `/${place.prefix}.claude/skills/${n}/`), BLOCK_END] : [];
  const after = [...rest, ...block].join("\n") + "\n";
  if (after === (before.endsWith("\n") ? before : before + "\n")) return;
  await fs.mkdir(path.dirname(place.exclude), { recursive: true });
  await fs.writeFile(place.exclude, after, "utf8");
}

/** Copy a plugin's skill into `target` (which is not there), with its marker. */
async function write(target: string, files: SkillFile[], marker: Marker): Promise<void> {
  const tmp = `${target}.hive-tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const f of files) {
    await fs.mkdir(path.dirname(path.join(tmp, f.rel)), { recursive: true });
    await fs.writeFile(path.join(tmp, f.rel), f.bytes);
  }
  await fs.writeFile(path.join(tmp, SKILL_MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

const changed = (plugin: string) =>
  `changed since hive installed it, so hive leaves it as it is and no longer updates or removes it: delete the folder to get ${plugin}'s copy back, or its ${SKILL_MARKER} to keep it as yours`;

/**
 * Bring the plugin skills under `cwd/.claude/skills/` in line with `sources` (the plugins on for
 * this workspace): write the missing, update the ones the plugin changed, remove the ones no plugin
 * ships here any more, and keep every folder hive manages out of `git status`.
 */
export async function syncPluginSkills(cwd: string, sources: readonly PluginSkillSource[]): Promise<PluginSkillsReport> {
  const report: PluginSkillsReport = { installed: [], updated: [], removed: [], kept: [], refused: [] };
  const root = path.join(cwd, ".claude", "skills");
  const present = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const marked = new Map<string, Marker>();
  for (const e of present) {
    if (!e.isDirectory()) continue;
    const m = await readMarker(path.join(root, e.name));
    if (m) marked.set(e.name, m);
  }
  const wanted = new Map<string, { plugin: string; version?: string; folder: string }>();
  for (const s of sources) {
    for (const rel of s.skills) {
      const name = skillName(rel);
      const other = wanted.get(name);
      if (other) { report.refused.push({ name, plugin: s.plugin, why: `${other.plugin} ships a skill of that name too` }); continue; }
      wanted.set(name, { plugin: s.plugin, ...(s.version ? { version: s.version } : {}), folder: path.join(s.dir, rel) });
    }
  }
  if (!wanted.size && !marked.size) return report;

  const place = await gitPlace(cwd);
  // A folder in git is the person's, whatever it holds: hive never changes a tracked file.
  const tracked = new Set(
    place ? (await git(cwd, ["ls-files", "--", ".claude/skills"]) ?? "").split("\n").filter(Boolean).map((f) => f.split("/")[2]!) : [],
  );

  for (const [name, marker] of marked) {
    if (wanted.get(name)?.plugin === marker.plugin || tracked.has(name)) continue;
    const folder = path.join(root, name);
    if (await asWritten(folder, marker)) {
      await fs.rm(folder, { recursive: true, force: true });
      marked.delete(name);
      report.removed.push(name);
    } else {
      report.kept.push({ name, plugin: marker.plugin, why: changed(marker.plugin) });
    }
  }

  for (const [name, w] of wanted) {
    const target = path.join(root, name);
    const marker = marked.get(name);
    const there = marker || (await fs.lstat(target).catch(() => null));
    if (there && (!marker || tracked.has(name))) {
      report.refused.push({ name, plugin: w.plugin, why: `.claude/skills/${name} is a skill hive did not install: rename it, or that plugin's skill is not installed here` });
      continue;
    }
    if (marker && marker.plugin !== w.plugin) {
      report.refused.push({ name, plugin: w.plugin, why: `.claude/skills/${name} holds ${marker.plugin}'s skill, which was changed since hive installed it` });
      continue;
    }
    let files: SkillFile[];
    try { files = await readFiles(w.folder); } catch (e) {
      report.refused.push({ name, plugin: w.plugin, why: `its skill folder cannot be read: ${(e as Error).message}` });
      continue;
    }
    const next: Marker = { plugin: w.plugin, ...(w.version ? { version: w.version } : {}), hash: hashOf(files) };
    if (marker) {
      if (!(await asWritten(target, marker))) { report.kept.push({ name, plugin: w.plugin, why: changed(w.plugin) }); continue; }
      if (marker.hash === next.hash) continue;
      await fs.rm(target, { recursive: true, force: true });
      await write(target, files, next);
      report.updated.push(name);
    } else {
      await fs.mkdir(root, { recursive: true });
      await write(target, files, next);
      report.installed.push(name);
    }
    marked.set(name, next);
  }

  if (place) await setExcluded(place, [...marked.keys()].filter((n) => !tracked.has(n)));
  return report;
}
