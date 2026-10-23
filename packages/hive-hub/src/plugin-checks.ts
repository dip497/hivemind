/** Whether a folder is a plugin Hivemind accepts, and what it is. A hub runs this on a folder
 *  before it lists it, and the app runs it on what it downloaded before it installs it, so the
 *  two cannot disagree. Bytes in, a listing or a reason out: no network, no file system. */
import YAML from "yaml";
import { agentDisclosures, defFromManifest, RESERVED_AGENTS, type AgentProviderDef } from "@hivemind/agents";
import { parseToolManifest, type ToolPackage } from "@hivemind/core/tool-format";
import { parseCategory, type PluginCategory } from "@hivemind/view-sdk/category";
import { permissionWords } from "@hivemind/view-sdk/protocol";
import { idProblem, pathsProblem, safeRelative, smallJson, UNSAFE_TEXT_RE, type CatalogFile, type CatalogType } from "./index-format.js";
import { laterOf, sinceOf } from "./since.js";
import { checkPackageManifest, entriesOf, MEMBER_FORMATS, ownedBy, PACKAGE_MANIFEST, type AgentPreset, type FolderEntry, type MemberFormat, type MemberRuns } from "./package-format.js";

export const MAX_PLUGIN_FILES = 200;
export const MAX_PLUGIN_FILE_BYTES = 2 << 20;
export const MAX_PLUGIN_BYTES = 8 << 20;
/** The most of a README a listing keeps: it is a page to read, not a place to store files. */
const MAX_README = 64 << 10;
/** Files larger than this are hashed but never read as text. */
const MAX_TEXT = 256 << 10;

/** An agent is one global name for one CLI. */
export const AGENT_ID_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{0,31}$/;
/** A view or a widget is `@owner/name`. */
export const SCOPED_ID_RE = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginFile { path: string; bytes: Uint8Array }

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

/** Check a plugin folder: its files, its manifest, its id and its category. */
export async function checkPluginFolder(folder: readonly PluginFile[]): Promise<FolderCheck> {
  try {
    return { plugin: await check(folder) };
  } catch (e) {
    // A folder is someone else's bytes: whatever it holds is a reason to refuse it, never a crash.
    return { problem: e instanceof Refused ? e.message : `the folder could not be read: ${escaped(String((e as Error)?.message ?? e))}` };
  }
}

async function check(folder: readonly PluginFile[]): Promise<CheckedPlugin> {
  if (!folder.length) refuse("the folder is empty");
  if (folder.length > MAX_PLUGIN_FILES) refuse(`a plugin may have at most ${MAX_PLUGIN_FILES} files`);
  let total = 0;
  const files: CatalogFile[] = [];
  const text = new Map<string, string>();
  for (const f of folder) {
    if (!safeRelative(f.path)) refuse(`${shown(f.path)} is not a plain relative path`);
    if (f.bytes.byteLength > MAX_PLUGIN_FILE_BYTES) refuse(`${f.path} is larger than 2 MB`);
    total += f.bytes.byteLength;
    files.push({ path: f.path, sha256: await sha256(f.bytes) });
    if (f.bytes.byteLength < MAX_TEXT) text.set(f.path, new TextDecoder().decode(f.bytes));
  }
  if (total > MAX_PLUGIN_BYTES) refuse("a plugin folder may be at most 8 MB");
  const clash = pathsProblem(folder.map((f) => f.path));
  if (clash) refuse(clash);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const pkg = text.get(PACKAGE_MANIFEST);
  if (pkg !== undefined) return readPackage(pkg, files, text);
  return readPlugin(files, text) ?? refuse(`no ${PACKAGE_MANIFEST}, agent.yaml, hivemind-view.json, widget.json or hivemind-tool.json in that folder`);
}

/** The one plugin a folder holds, read by its manifest; null when it holds none. */
function readPlugin(files: CatalogFile[], text: Map<string, string>): CheckedPlugin | null {
  const has = (p: unknown) => typeof p === "string" && files.some((f) => f.path === p);
  // Every kind may say what it is in a README.md; it is shown as text, never run.
  const readmeName = [...text.keys()].find((f) => /^readme\.md$/i.test(f));
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
      bin: null, homepage: null, icon: null, manifest: viewJson,
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
    // Its icon as the app shows it: a one-colour SVG kept in the listing (drawn in the page's
    // colour, in an image, where it cannot run), any other picture linked from the folder.
    const iconFile = has(w.icon) ? (w.icon as string) : null;
    const svg = iconFile && /\.svg$/i.test(iconFile) ? text.get(iconFile) : undefined;
    return {
      ...common, id, type: "widget", name: plain("widget.json", "name", String(w.name ?? id).slice(0, 80)), category: categoryOf("widget.json", w.category),
      description: plain("widget.json", "description", String(w.description ?? "A widget.").slice(0, 400)),
      version: w.version as string,
      bin: null, homepage: null, manifest: widgetJson,
      icon: svg && svg.length <= 16 << 10 ? { image: svgData(svg) } : null,
      iconFile: !svg && iconFile && /\.(png|webp|gif|jpe?g)$/i.test(iconFile) ? iconFile : null,
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
    // Its first tool's icon as the app shows it: a one-colour SVG from its folder, kept in the listing.
    const iconFile = Object.values(t.tiles).map((tile) => tile.icon).find((f) => has(f));
    const svg = iconFile ? text.get(iconFile) : undefined;
    return {
      ...common, id: t.id, type: "tool", name: plain("hivemind-tool.json", "name", t.name.slice(0, 80)), category: t.category,
      description: plain("hivemind-tool.json", "description", (t.description || "A tool.").slice(0, 400)),
      version: t.version!,
      bin: null, homepage: null, manifest: toolJson,
      icon: svg && svg.length <= 16 << 10 ? { image: svgData(svg) } : null,
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
};

/** A file of the package itself, beside its manifest and its members: its README and licence. */
const OWN_FILE = /^(?:readme|licen[cs]e|copying|notice)(?:\.[a-z]+)?$/i;

/** A package: its `hivemind-package.json`, and every member in its folder read as that kind is
 *  read alone. Every member is the package owner's. Its files are the package's, checked as one. */
function readPackage(json: string, files: CatalogFile[], text: Map<string, string>): CheckedPlugin {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return refuse(`${PACKAGE_MANIFEST} is not valid JSON`); }
  const checked = checkPackageManifest(raw);
  if ("problem" in checked) return refuse(`${PACKAGE_MANIFEST}: ${checked.problem}`);
  const m = checked.manifest;
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
  const folders = MEMBER_FORMATS.filter((f) => f.manifest).flatMap((f) => entriesOf(m, f).map((e) => (e as FolderEntry).path.replace(/\/$/, "")));
  for (const a of folders) for (const b of folders) {
    if (a !== b && (a === "." || b.startsWith(`${a}/`))) refuse(`${shown(b)} is inside ${shown(a)}, another member's folder`);
  }
  for (const x of members) if (!ownedBy(m.id, x.id)) refuse(`${x.kind} ${x.id} is not ${owner}'s: every member of ${m.id} is ${owner}/<name>`);
  const ids = members.map((x) => `${x.kind}:${x.id}`);
  if (new Set(ids).size !== ids.length) refuse("a member is named twice");
  const readmeName = [...text.keys()].find((f) => /^readme\.md$/i.test(f));
  // What is listed is what installs: the package's own manifest, README and licence, and its
  // members' folders. Anything else beside them (sources, build scripts, notes) is left out, so
  // the app never downloads it and a view can never fetch it.
  const listed = files.filter((f) => f.path === PACKAGE_MANIFEST || OWN_FILE.test(f.path) || folders.some((a) => a === "." || f.path.startsWith(`${a}/`)));
  return {
    id: m.id, type: "package", name: m.name.slice(0, 80), category: "other", files: listed,
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
