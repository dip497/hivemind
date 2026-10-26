/** Whether a folder is a plugin Hivemind accepts, and what it is. A hub runs this on a folder
 *  before it lists it, and the app runs it on what it downloaded before it installs it, so the
 *  two cannot disagree. Bytes in, a listing or a reason out: no network, no file system. */
import YAML from "yaml";
import { agentDisclosures, defFromManifest, RESERVED_AGENTS, type AgentProviderDef } from "@hivemind/agents";
import { parseToolManifest, type ToolPackage } from "@hivemind/core/tool-format";
import { readTheme, THEME_MANIFEST, themeFiles } from "@hivemind/core/theme-format";
import { parseCategory, type PluginCategory } from "@hivemind/view-sdk/category";
import { permissionWords } from "@hivemind/view-sdk/protocol";
import { idProblem, pathsProblem, safeRelative, smallJson, UNSAFE_TEXT_RE, type CatalogFile, type CatalogType } from "./index-format.js";
import { laterOf, sinceOf } from "./since.js";
import { checkPackageManifest, entriesOf, MEMBER_FORMATS, memberFolders, ownedBy, PACKAGE_MANIFEST, packageFiles, type AgentPreset, type FolderEntry, type MemberFormat, type MemberRuns, type PackageManifest } from "./package-format.js";

export const MAX_PLUGIN_FILES = 200;
export const MAX_PLUGIN_FILE_BYTES = 2 << 20;
export const MAX_PLUGIN_BYTES = 8 << 20;
/** The most of a README a listing keeps: it is a page to read, not a place to store files. */
const MAX_README = 64 << 10;
/** Files larger than this are hashed but never read as text. */
const MAX_TEXT = 256 << 10;
/** An SVG icon this size or smaller is kept in the listing; a larger one is not shown. */
const MAX_ICON = 16 << 10;
/** The manifests that make a folder one plugin, as the check looks for them at its top. */
const PLUGIN_MANIFESTS = ["agent.yaml", "agent.yml", "hivemind-view.json", "widget.json", "hivemind-tool.json"];
/** The manifests a package's member folder is read by. */
const MEMBER_MANIFESTS = new Set([...PLUGIN_MANIFESTS, THEME_MANIFEST]);
const NO_MANIFEST = `no ${PACKAGE_MANIFEST}, agent.yaml, hivemind-view.json, widget.json or hivemind-tool.json in that folder`;

/** An agent is one global name for one CLI. */
export const AGENT_ID_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{0,31}$/;
/** A view or a widget is `@owner/name`. */
export const SCOPED_ID_RE = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginFile { path: string; bytes: Uint8Array }

/** A file of a plugin folder as the check reads it: its path, its size, its SHA-256, and its text
 *  when the check reads it (`planRead`'s `text`). A hub that reads a folder a few files at a time
 *  keeps this much of each file, not its bytes. */
export interface ListedFile { path: string; bytes: number; sha256: string; text?: string }

/** A plugin folder as a hub lists it. */
export interface CheckedPlugin {
  id: string;
  type: CatalogType;
  name: string;
  /** The manifest's own sentence, or a plain one for its kind. */
  description: string;
  version: string;
  category: PluginCategory;
  files: CatalogFile[];
  /** The manifest file as written. */
  manifest: string;
  /** What it does past its own folder, in the words the app shows before it installs. */
  does: string[];
  minAppVersion: string | null;
  readme: string | null;
  /** Agents: the CLI it runs, its note, what it can do, and its install page. */
  bin: string | null;
  note: string | null;
  traits: { worker: boolean; resumes: boolean; supervises: boolean } | null;
  homepage: string | null;
  /** The mark the list shows: an agent's `icon` block, or `{ image }` with a one-colour SVG kept as a data URL. */
  icon: unknown;
  /** A widget's icon when it is a picture file in the folder, for the hub to link to. */
  iconFile: string | null;
  /** A package's members; null for one plugin. */
  members: CheckedMember[] | null;
}

/** A package's member as a hub lists it: its kind, where its code runs, and what it asks for. */
export interface CheckedMember { kind: MemberFormat["kind"]; id: string; name: string; runs: MemberRuns; permissions: string[]; does: string[] }

export type FolderCheck = { plugin: CheckedPlugin } | { problem: string };

class Refused extends Error {}
const refuse = (problem: string): never => { throw new Refused(problem); };

/** A value from the folder, as a reason quotes it: cut short, with anything that could rewrite a
 *  terminal written as an escape. */
const shown = (v: unknown): string => escaped(JSON.stringify(String(v).slice(0, 100)));
/** Text with anything that could rewrite a terminal written as an escape. */
const escaped = (v: string): string => v.replace(new RegExp(UNSAFE_TEXT_RE.source, "g"), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Text the app shows, from a manifest: refused when it holds a character that could rewrite a
 *  terminal or reorder what is read. */
const plain = (file: string, field: string, v: string): string =>
  UNSAFE_TEXT_RE.test(v) ? refuse(`${file}: its ${field} has a control character in it`) : v;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const svgData = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** What a view's or widget's permissions let it do, in the words the app shows before it installs. */
const asks = (perms: unknown): string[] =>
  permissionWords(Array.isArray(perms) ? perms.filter((p): p is string => typeof p === "string") : [])
    .map((w) => w[0]!.toUpperCase() + w.slice(1));

/** A manifest's category, as the app reads it: none is `other`, one it does not know is refused. */
const categoryOf = (file: string, raw: unknown): PluginCategory => {
  const c = parseCategory(raw);
  return "category" in c ? c.category : refuse(`${file}: ${c.error}`);
};

/** One file of a folder as the check reads it, from its bytes: its text too when `keepText`. A
 *  README's text is kept as far as a listing keeps it. */
export async function listedFile(path: string, bytes: Uint8Array, keepText = false): Promise<ListedFile> {
  const file: ListedFile = { path, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  if (keepText) {
    const text = new TextDecoder().decode(bytes);
    file.text = README_RE.test(path) ? text.slice(0, MAX_README) : text;
  }
  return file;
}

/** Check a plugin folder: its files, its manifest, its id and its category. */
export async function checkPluginFolder(folder: readonly PluginFile[]): Promise<FolderCheck> {
  try {
    // The texts the check reads, found as a hub finds them: the top's first, then what they name.
    const sized = folder.map((f) => ({ path: f.path, bytes: f.bytes.byteLength }));
    const first = new Set(rootTexts(sized));
    const texts = Object.fromEntries(folder.filter((f) => first.has(f.path)).map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
    const planned = planRead(sized, texts);
    const keep = new Set([...first, ...("text" in planned ? planned.text : [])]);
    return await checkPluginListing(await Promise.all(folder.map((f) => listedFile(f.path, f.bytes, keep.has(f.path)))));
  } catch (e) {
    return { problem: unreadable(e) };
  }
}

/** Check a folder from its files as `listedFile` reads them, with the texts `planRead` names: what
 *  a hub keeps of a folder it reads a few files at a time. For the same files it gives the answer
 *  `checkPluginFolder` gives. Every file it is given is held to the limits, so a hub gives it the
 *  files `planRead` names: for a package, what installs, without its sources beside. */
export async function checkPluginListing(listing: readonly ListedFile[]): Promise<FolderCheck> {
  try {
    return { plugin: check(listing) };
  } catch (e) {
    return { problem: e instanceof Refused ? e.message : unreadable(e) };
  }
}

/** A folder is someone else's bytes: whatever it holds is a reason to refuse it, never a crash. */
const unreadable = (e: unknown) => `the folder could not be read: ${escaped(String((e as Error)?.message ?? e))}`;

/** What a hub reads of a folder first, from its paths and sizes: the manifests and README at its
 *  top, which say what the rest is. Refuses what the paths and sizes already refuse. */
export function firstReads(files: readonly { path: string; bytes: number }[]): { read: string[] } | { problem: string } {
  if (!files.length) return { problem: "the folder is empty" };
  const problem = isPackage(files) ? null : pluginProblem(files);
  return problem ? { problem } : { read: rootTexts(files) };
}

/** Everything a hub reads to check a folder, once it has the texts of `firstReads` (by path): what
 *  installs, which is every file of one plugin or what a package lists (`packageFiles`), and of
 *  those the files whose text the check reads (`text`): the manifests, the README at the top, and
 *  the SVG icon a plugin's manifest names. Its sources, build scripts and other READMEs are not read.
 *  Refuses what the paths, the sizes and a package's manifest already refuse. */
export function planRead(files: readonly { path: string; bytes: number }[], texts: Readonly<Record<string, string>>): { read: string[]; text: string[] } | { problem: string } {
  try {
    const { read, text } = plan(files, (p) => texts[p]);
    return { read, text };
  } catch (e) {
    if (e instanceof Refused) return { problem: e.message };
    throw e;
  }
}

/** What a hub refuses a folder for by its size alone: more than 200 files, a file over 2 MB, or
 *  more than 8 MB in all. `hive plugins check` runs it too, so a plugin it passes is one HiveHub takes. */
export function sizeProblem(files: readonly { path: string; bytes: number }[]): string | null {
  if (files.length > MAX_PLUGIN_FILES) return `a plugin may have at most ${MAX_PLUGIN_FILES} files`;
  const big = files.find((f) => f.bytes > MAX_PLUGIN_FILE_BYTES);
  if (big) return `${big.path} is larger than 2 MB`;
  return files.reduce((n, f) => n + f.bytes, 0) > MAX_PLUGIN_BYTES ? "a plugin folder may be at most 8 MB" : null;
}

/** What files are refused for by their paths and sizes alone: too many, a path that is not plain,
 *  too large, or two that would land on one another. */
function folderProblem(files: readonly { path: string; bytes: number }[]): string | null {
  if (files.length > MAX_PLUGIN_FILES) return `a plugin may have at most ${MAX_PLUGIN_FILES} files`;
  const odd = files.find((f) => !safeRelative(f.path));
  if (odd) return `${shown(odd.path)} is not a plain relative path`;
  return sizeProblem(files) ?? pathsProblem(files.map((f) => f.path));
}

const README_RE = /^readme\.md$/i;
/** Whether the folder is a package: it has a package manifest the check reads. */
const isPackage = (files: readonly { path: string; bytes: number }[]) => files.some((f) => f.path === PACKAGE_MANIFEST && f.bytes < MAX_TEXT);
/** The files at a folder's top whose text the check reads first: a package's manifest, or one
 *  plugin's, and the README. */
const rootTexts = (files: readonly { path: string; bytes: number }[]): string[] => {
  const pkg = isPackage(files);
  return files.filter((f) => f.bytes < MAX_TEXT && (pkg ? f.path === PACKAGE_MANIFEST : PLUGIN_MANIFESTS.includes(f.path)) || (f.bytes < MAX_TEXT && README_RE.test(f.path)))
    .map((f) => f.path);
};
/** Why one plugin's folder is refused by its paths and sizes, or for having no manifest it reads. */
const pluginProblem = (files: readonly { path: string; bytes: number }[]) =>
  folderProblem(files) ?? (files.some((f) => f.bytes < MAX_TEXT && PLUGIN_MANIFESTS.includes(f.path)) ? null
    : files.some((f) => f.path === PACKAGE_MANIFEST) ? `${PACKAGE_MANIFEST} is larger than 256 KB` : NO_MANIFEST);

/** A package manifest's text, read as the check reads it. */
function manifestOf(json: string): { raw: unknown; manifest: PackageManifest } | { problem: string } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { problem: `${PACKAGE_MANIFEST} is not valid JSON` }; }
  const checked = checkPackageManifest(raw);
  return "problem" in checked ? { problem: `${PACKAGE_MANIFEST}: ${checked.problem}` } : { raw, manifest: checked.manifest };
}

interface Plan { read: string[]; text: string[]; pkg: { raw: unknown; manifest: PackageManifest; json: string } | null }

/** `planRead`, with `textOf` giving each text of `rootTexts`; throws a refusal. */
function plan(files: readonly { path: string; bytes: number }[], textOf: (path: string) => string | undefined): Plan {
  if (!files.length) refuse("the folder is empty");
  const first = rootTexts(files);
  if (!isPackage(files)) {
    const problem = pluginProblem(files);
    if (problem) refuse(problem);
    const has = (p: unknown): p is string => typeof p === "string" && files.some((f) => f.path === p);
    const icon = iconNamed(has, textOf);
    const small = icon !== null && /\.svg$/i.test(icon) && files.some((f) => f.path === icon && f.bytes <= MAX_ICON);
    return { read: files.map((f) => f.path), text: small && !first.includes(icon) ? [...first, icon] : first, pkg: null };
  }
  const json = textOf(PACKAGE_MANIFEST) ?? refuse(`${PACKAGE_MANIFEST} was listed without its text`);
  const m = manifestOf(json);
  if ("problem" in m) return refuse(m.problem);
  const listed = packageFiles(m.manifest, files);
  const problem = folderProblem(listed);
  if (problem) refuse(problem);
  // A member is read by the manifests at its folder's top.
  const roots = memberFolders(m.manifest).map((a) => (a === "." ? "" : `${a}/`));
  const members = listed.filter((f) => f.bytes < MAX_TEXT && roots.some((r) => f.path.startsWith(r) && MEMBER_MANIFESTS.has(f.path.slice(r.length))));
  return { read: listed.map((f) => f.path), text: [...new Set([...first, ...members.map((f) => f.path)])], pkg: { ...m, json } };
}

/** The icon file a plugin's manifest names, when it is in the folder: a view's or widget's `icon`,
 *  or a tool's first tile icon. An agent's icon is a block in its manifest, not a file. */
function iconNamed(has: (p: unknown) => p is string, textOf: (path: string) => string | undefined): string | null {
  const json = (name: string): Record<string, unknown> | null => {
    try { return JSON.parse(textOf(name) ?? "null"); } catch { return null; }
  };
  if (textOf("agent.yaml") !== undefined || textOf("agent.yml") !== undefined) return null;
  if (textOf("hivemind-view.json") !== undefined) {
    const icon = json("hivemind-view.json")?.icon;
    return has(icon) && /\.(svg|png|webp|gif|jpe?g)$/i.test(icon) ? icon : null;
  }
  if (textOf("widget.json") !== undefined) {
    const icon = json("widget.json")?.icon;
    return has(icon) ? icon : null;
  }
  if (textOf("hivemind-tool.json") !== undefined) {
    try { return Object.values(parseToolManifest(json("hivemind-tool.json"), ".", null).tiles).map((tile) => tile.icon).find(has) ?? null; } catch { return null; }
  }
  return null;
}

/** An SVG icon as the listing keeps it: a data URL, drawn in an image, where it cannot run. One
 *  over MAX_ICON as written out (an SVG that is not UTF-8 grows) is not shown. */
const iconOf = (svg: string | undefined) => (svg !== undefined && new TextEncoder().encode(svg).byteLength <= MAX_ICON ? { image: svgData(svg) } : null);

function check(listing: readonly ListedFile[]): CheckedPlugin {
  if (!listing.length) refuse("the folder is empty");
  // Everything it is given: what the app downloaded, or what a hub read, which is what installs.
  const problem = folderProblem(listing);
  if (problem) refuse(problem);
  const byPath = new Map(listing.map((f) => [f.path, f]));
  const textOf = (p: string) => byPath.get(p)?.text ?? refuse(`${shown(p)} was listed without its text`);
  // The plan sees the texts a hub reads first, and no other, as `planRead` does.
  const first = new Set(rootTexts(listing));
  const { read, text: texts, pkg } = plan(listing, (p) => (first.has(p) ? textOf(p) : undefined));
  const wanted = new Set(read);
  const held = listing.filter((f) => wanted.has(f.path));
  const files: CatalogFile[] = [];
  const sizes = new Map<string, number>();
  for (const f of held) {
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) refuse(`${shown(f.path)} was listed without its SHA-256`);
    files.push({ path: f.path, sha256: f.sha256 });
    sizes.set(f.path, f.bytes);
  }
  // Only the texts the plan names, so a hub that keeps no other text gets the same answer.
  const text = new Map(texts.map((p) => [p, textOf(p)]));
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (pkg) return readPackage(pkg, files, text, sizes);
  return readPlugin(files, text) ?? refuse(NO_MANIFEST);
}

/** The one plugin a folder holds, read by its manifest; null when it holds none. */
function readPlugin(files: CatalogFile[], text: Map<string, string>): CheckedPlugin | null {
  const has = (p: unknown): p is string => typeof p === "string" && files.some((f) => f.path === p);
  // Its icon as the app shows it: a one-colour SVG kept in the listing (drawn in the page's colour,
  // in an image, where it cannot run), any other picture linked from the folder.
  const iconFile = iconNamed(has, (p) => text.get(p));
  const svg = iconFile && /\.svg$/i.test(iconFile) ? text.get(iconFile) : undefined;
  // Every kind may say what it is in a README.md; it is shown as text, never run.
  const readmeName = [...text.keys()].find((f) => README_RE.test(f));
  const common = { files, readme: readmeName ? text.get(readmeName)!.slice(0, MAX_README) : null, iconFile: null, members: null };

  const yaml = text.get("agent.yaml") ?? text.get("agent.yml");
  if (yaml !== undefined) {
    let def: AgentProviderDef;
    let raw: { icon?: unknown } = {};
    try {
      raw = YAML.parse(yaml) ?? {};
      def = defFromManifest(raw, {});
    } catch (e) {
      return refuse(`the manifest is not one Hivemind would accept — ${escaped(String((e as Error).message))}`);
    }
    if (!AGENT_ID_RE.test(def.id)) refuse(`agent.yaml's id is ${shown(def.id)} — an agent's id is one name, like "gemini"`);
    if (raw.icon !== undefined && (typeof raw.icon !== "object" || raw.icon === null || !smallJson(raw.icon, 4096))) refuse("agent.yaml: its icon must be a small block");
    if (RESERVED_AGENTS[def.id] && RESERVED_AGENTS[def.id] !== def.bin) {
      refuse(`the id "${def.id}" is reserved for the agent that runs ${RESERVED_AGENTS[def.id]}`);
    }
    // The whole note, as the listing keeps it, not only the part on the card.
    const note = def.note ? plain("agent.yaml", "note", def.note) : null;
    return {
      ...common, id: def.id, type: "agent", name: plain("agent.yaml", "label", (def.label ?? def.id).slice(0, 80)), category: "agents",
      description: (note || `Runs ${def.bin}.`).slice(0, 400),
      version: "1.0.0", bin: def.bin, homepage: def.install?.url ?? null,
      // The manifest's own shapes, not rendered markup: clients draw it from a closed vocabulary.
      icon: raw.icon ?? null, manifest: yaml,
      does: agentDisclosures(def).map((d) => plain("agent.yaml", "launch settings", d)), note, minAppVersion: def.minAppVersion ?? null,
      traits: { worker: def.caps.turnSignal, resumes: def.caps.resume !== "none", supervises: def.caps.supervise !== "human" },
    };
  }

  const viewJson = text.get("hivemind-view.json");
  if (viewJson !== undefined) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(viewJson); } catch { return refuse("hivemind-view.json is not valid JSON"); }
    const id = String(v.id ?? "");
    if (!SCOPED_ID_RE.test(id)) refuse(`hivemind-view.json's id is ${shown(id)} — a published view's id is @owner/name`);
    if (!has(v.entry)) refuse("hivemind-view.json names an entry file that is not in the folder");
    return {
      ...common, id, type: "view", name: plain("hivemind-view.json", "name", String(v.name ?? id).slice(0, 80)), category: categoryOf("hivemind-view.json", v.category),
      description: plain("hivemind-view.json", "description", String(v.description ?? "A workspace view.").slice(0, 400)),
      version: plain("hivemind-view.json", "version", String(v.version ?? "0.1.0").slice(0, 40)),
      bin: null, homepage: null, manifest: viewJson,
      icon: iconOf(svg),
      iconFile: iconFile && !/\.svg$/i.test(iconFile) ? iconFile : null,
      does: asks(v.permissions), traits: null, note: null, minAppVersion: sinceOf("view", v),
    };
  }

  const widgetJson = text.get("widget.json");
  if (widgetJson !== undefined) {
    let w: Record<string, unknown>;
    try { w = JSON.parse(widgetJson); } catch { return refuse("widget.json is not valid JSON"); }
    const id = String(w.id ?? "");
    if (!SCOPED_ID_RE.test(id)) refuse(`widget.json's id is ${id ? shown(id) : "missing"} — a published widget says its id, @owner/name, in its widget.json`);
    // The same rule the app applies to a folder: code, or a drawing without code.
    if (!has("widget.js") && w.draw === undefined) refuse("a widget needs a widget.js, or a draw in its widget.json");
    // What the app compares an installed copy against to offer an update.
    if (typeof w.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(w.version)) refuse('widget.json needs a "version", like "1.0.0"');
    return {
      ...common, id, type: "widget", name: plain("widget.json", "name", String(w.name ?? id).slice(0, 80)), category: categoryOf("widget.json", w.category),
      description: plain("widget.json", "description", String(w.description ?? "A widget.").slice(0, 400)),
      version: w.version as string,
      bin: null, homepage: null, manifest: widgetJson,
      icon: iconOf(svg),
      iconFile: iconFile && /\.(png|webp|gif|jpe?g)$/i.test(iconFile) ? iconFile : null,
      does: asks(w.permissions), traits: null, note: null, minAppVersion: sinceOf("widget", w),
    };
  }

  const toolJson = text.get("hivemind-tool.json");
  if (toolJson !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(toolJson); } catch { return refuse("hivemind-tool.json is not valid JSON"); }
    let t: ToolPackage;
    try { t = parseToolManifest(raw, ".", null); } catch (e) { return refuse(`the manifest is not one Hivemind would accept — ${escaped(String((e as Error).message))}`); }
    if (t.problem) refuse(t.problem);
    const badId = idProblem("tool", t.id);
    if (badId) refuse(`hivemind-tool.json: ${badId}`);
    if (!has(t.entry)) refuse(`hivemind-tool.json names an entry file, ${shown(t.entry)}, that is not in the folder`);
    if (!t.version) refuse('hivemind-tool.json needs a "version", like "1.0.0"');
    return {
      ...common, id: t.id, type: "tool", name: plain("hivemind-tool.json", "name", t.name.slice(0, 80)), category: t.category,
      description: plain("hivemind-tool.json", "description", (t.description || "A tool.").slice(0, 400)),
      version: t.version!,
      bin: null, homepage: null, manifest: toolJson,
      icon: iconOf(svg),
      // It is code the app loads into itself, which is why it arrives switched off.
      does: [
        "Runs inside Hivemind, with the app's access to your files and network, once you switch it on",
        ...asks(t.permissions),
        ...(t.service ? [`Keeps a program running while it is on: ${plain("hivemind-tool.json", "service command", t.service.command.join(" "))}`] : []),
      ],
      traits: null, note: null, minAppVersion: t.minAppVersion ?? null,
    };
  }

  return null;
}

/** What a member's code may do, said before it installs: where it runs, then what it asks for. */
const RUNS: Record<MemberRuns, string> = {
  sandboxed: "Runs in a sandbox that holds it to what it asks for",
  "in the app": "Runs inside Hivemind, with the app's access to your files and network, once you switch it on",
  "as an agent's instructions": "Instructions an agent follows",
  "nothing: it is data": "Has no code",
};

/** What a theme does, in the words the app shows before it installs. */
const THEME_DOES = "Changes how the app looks and sounds, once you apply it";

/** Whether dotted version `a` is later than `b`. */
const later = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** A package: its `hivemind-package.json`, and every member in its folder read as that kind is
 *  read alone. Every member is the package owner's. Its files are the package's, checked as one. */
function readPackage(pkg: { raw: unknown; manifest: PackageManifest; json: string }, files: CatalogFile[], text: Map<string, string>, sizes: Map<string, number>): CheckedPlugin {
  const { raw, manifest: m, json } = pkg;
  const owner = m.id.slice(0, m.id.indexOf("/"));
  const members: CheckedMember[] = [];
  // The package's own fields first, then the highest any member needs.
  let minAppVersion = sinceOf("package", raw);
  for (const format of MEMBER_FORMATS) {
    for (const entry of entriesOf(m, format)) {
      if (!format.manifest) {
        // Written in the package's manifest itself: an agent preset.
        const p = entry as AgentPreset;
        members.push({ kind: format.kind, id: p.id, name: p.name, runs: format.runs, permissions: [],
          does: [`${RUNS[format.runs]}: starts ${p.provider}${p.model ? ` (${p.model})` : ""} with the prompt in ${PACKAGE_MANIFEST}`] });
        continue;
      }
      const at = (entry as FolderEntry).path.replace(/\/$/, "");
      const prefix = at === "." ? "" : `${at}/`;
      const inside = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
      const sub = new Map([...text].filter(([f]) => f.startsWith(prefix)).map(([f, t]) => [f.slice(prefix.length), t]));
      if (format.kind === "theme") {
        // A theme is data: read from its folder as the app reads it (`readTheme`).
        const source = sub.get(THEME_MANIFEST) ?? refuse(`${shown(at)}: ${format.list} names a folder holding no ${THEME_MANIFEST}`);
        const t = readTheme(at.slice(at.lastIndexOf("/") + 1), m.id, source, inside.map((f) => ({ path: f.path, bytes: sizes.get(prefix + f.path) ?? 0 })));
        if ("problem" in t) return refuse(`${shown(at)}: ${escaped(t.problem)}`);
        const holds = themeFiles(t.theme).length;
        members.push({ kind: "theme", id: t.id, name: t.theme.name, runs: format.runs, permissions: [],
          does: [`${THEME_DOES}${holds ? ` (${holds} file${holds === 1 ? "" : "s"}: fonts, a wallpaper or sounds)` : ""}`] });
        continue;
      }
      let d: CheckedPlugin | null;
      try { d = readPlugin(inside, sub); } catch (e) { return refuse(`${shown(at)}: ${(e as Error).message}`); }
      if (!d || d.type !== format.kind) return refuse(`${shown(at)}: ${format.list} names a folder holding no ${format.manifest}`);
      const permissions = (() => { try { return (JSON.parse(d.manifest) as { permissions?: unknown }).permissions; } catch { return []; } })();
      members.push({ kind: format.kind, id: d.id, name: d.name, runs: format.runs,
        permissions: Array.isArray(permissions) ? permissions.filter((x): x is string => typeof x === "string") : [],
        does: format.runs === "sandboxed" ? [RUNS[format.runs], ...d.does] : d.does });
      minAppVersion = laterOf(minAppVersion, d.minAppVersion);
    }
  }
  // Each member's files are its own: a folder inside another member's would be shown as one kind
  // and installed as part of the other.
  const folders = memberFolders(m);
  for (const a of folders) for (const b of folders) {
    if (a !== b && (a === "." || b.startsWith(`${a}/`))) refuse(`${shown(b)} is inside ${shown(a)}, another member's folder`);
  }
  for (const x of members) if (!ownedBy(m.id, x.id)) refuse(`${x.kind} ${x.id} is not ${owner}'s: every member of ${m.id} is ${owner}/<name>`);
  const ids = members.map((x) => `${x.kind}:${x.id}`);
  if (new Set(ids).size !== ids.length) refuse("a member is named twice");
  const readmeName = [...text.keys()].find((f) => README_RE.test(f));
  // What is listed is what installs (`packageFiles`): `files` are those already.
  return {
    id: m.id, type: "package", name: m.name.slice(0, 80), category: "other", files,
    readme: readmeName ? text.get(readmeName)!.slice(0, MAX_README) : null,
    description: `A package of ${members.length}: ${members.map((x) => x.name).join(", ")}.`.slice(0, 400),
    version: m.version, bin: null, homepage: null, icon: null, iconFile: null, manifest: json,
    does: [...new Set(members.flatMap((x) => x.does))], traits: null, note: null, minAppVersion, members,
  };
}

/** Why `login` may not publish this id, or null. A view's, a widget's, a tool's or a package's
 *  owner must be the account publishing it. Agents are not owned by an account: a hub decides where they come from. */
export function ownerProblem(type: CatalogType, id: string, login: string): string | null {
  const owner = login.toLowerCase();
  if (type === "agent") return null;
  const want = `@${owner}/`;
  if (!SCOPED_ID_RE.test(id)) {
    const name = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    return `its id is "${id}" — a published ${type}'s id is @owner/name; set it to "${want}${/^(?!.*--)[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : "<name>"}"`;
  }
  if (!id.startsWith(want)) return `its id is "${id}", but you are publishing as ${login}; the scope must be ${want.slice(0, -1)}`;
  return null;
}
