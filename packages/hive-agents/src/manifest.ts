/** A provider's browser-safe half as data. Takes parsed YAML; never sees YAML,
 *  so this package stays browser-safe. What a manifest cannot express (resume,
 *  hooks) it must wire itself (`launch.hcp`, `session.resume`), and claiming a
 *  capability nothing here delivers is refused. */
import type { AgentAsset, AgentCapabilities, AgentHome, AgentHomeFile, AgentHookEntry, AgentHooks, AgentIcon, AgentInstall, AgentLaunch, AgentOption, AgentProviderDef, AgentSession, SessionFind, TileStatus } from "./types.js";
import { compileDetect, validateExpr, validateScope, type DetectRules } from "./detect-rules.js";
import { GENERIC_AGENT_ICON } from "./icon.js";
import { RESERVED_AGENTS } from "./reserved.js";

export const AGENT_MANIFEST_VERSION = 1;

const SHAPES = ["path", "rect", "circle", "ellipse"] as const;
const ATTRS = [
  "d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "fill-rule", "clip-rule", "opacity", "transform",
] as const;

/** Spread onto <svg/> as React props, so a closed list; both spellings accepted. */
const ROOT_ATTRS = [
  "fill", "stroke", "opacity",
  "fillRule", "fill-rule", "clipRule", "clip-rule",
  "strokeWidth", "stroke-width", "strokeLinecap", "stroke-linecap",
  "strokeLinejoin", "stroke-linejoin",
] as const;

export type IconShape = { [K in (typeof SHAPES)[number]]?: Record<string, string | number> };

export interface ManifestIcon {
  viewBox: string;
  attrs?: Record<string, string>;
  shapes: IconShape[];
}

export interface ManifestSpawn {
  args?: string[];
  /** Tile label; `{n}` is the spawn ordinal, `{label}` the provider label. */
  label?: string;
  /** Appended to the label when a non-default mode is set. `{mode}` interpolates. */
  labelMode?: string;
  /** Window titles this CLI sets, as literal templates: `{task}` is the part worth showing,
   *  `{any}` matches anything. A title matching a template without `{task}` is ignored. */
  titles?: string[];
}

export interface AgentManifest {
  manifestVersion: number;
  id: string;
  label: string;
  bin: string;
  aliases?: string[];
  enabled?: boolean;
  note?: string;
  caps: AgentCapabilities;
  icon?: ManifestIcon;
  spawn?: ManifestSpawn;
  options?: AgentOption[];
  install?: AgentInstall;
  detect?: DetectRules;
  session?: unknown;
  assets?: unknown;
  launch?: unknown;
  hooks?: unknown;
  home?: unknown;
}

export class ManifestError extends Error {}

/** Later sources shadow earlier ones. */
export type AgentSource = "user" | "repo";

/** What crosses IPC: a def's `detect()` function cannot be structured-cloned. */
export interface AgentWireEntry {
  id: string;
  file: string;
  source: AgentSource;
  manifest: unknown;
  error: string | null;
  disabled: boolean;
}

/** The renderer's copy of the loader's precedence (it cannot import the loader). */
export function defsFromWire(
  entries: readonly AgentWireEntry[],
): AgentProviderDef[] {
  const byId = new Map<string, AgentProviderDef>();
  for (const e of entries) {
    if (e.disabled) { byId.delete(e.id); continue; }
    if (e.error) continue; // a broken later entry does not remove a working earlier one
    const def = safeDef(e.manifest);
    if (def) byId.set(e.id, def);
  }
  return [...byId.values()];
}

function safeDef(manifest: unknown): AgentProviderDef | undefined {
  // Main already validated; if the sides disagree, drop one provider, not the catalog.
  try { return defFromManifest(manifest); } catch { return undefined; }
}

/** One name per agent, wherever it comes from: an agent stands for one CLI, so there is no
 *  scope. Published agents come from the plugins repository, where the name is settled. */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STATUSES: readonly TileStatus[] = ["idle", "working", "blocked", "permission", "question"];
const CAP_KEYS = [
  "promptDelivery", "turnSignal", "resume", "supervise",
  "blockedDetection",
] as const;

function esc(v: string | number): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A manifest supplies only escaped values on whitelisted shapes, never markup. Exported
 *  because the catalog carries an agent's icon before its manifest has been downloaded. */
export function iconFromManifest(icon: ManifestIcon): AgentIcon {
  if (typeof icon.viewBox !== "string") throw new ManifestError("icon.viewBox must be a string");
  if (!Array.isArray(icon.shapes)) throw new ManifestError("icon.shapes must be an array");
  for (const [k, v] of Object.entries(icon.attrs ?? {})) {
    if (!(ROOT_ATTRS as readonly string[]).includes(k)) {
      throw new ManifestError(`icon.attrs "${k}" is not allowed (allowed: ${ROOT_ATTRS.join(", ")})`);
    }
    if (typeof v !== "string") throw new ManifestError(`icon.attrs "${k}" must be a string`);
  }
  const body = icon.shapes
    .map((shape) => {
      const kind = SHAPES.find((k) => shape[k]);
      if (!kind) throw new ManifestError(`icon shape must be one of ${SHAPES.join(", ")}`);
      const attrs = shape[kind]!;
      const rendered = Object.entries(attrs)
        .map(([k, v]) => {
          if (!(ATTRS as readonly string[]).includes(k)) {
            throw new ManifestError(`icon attribute "${k}" is not allowed on <${kind}>`);
          }
          return `${k}="${esc(v)}"`;
        })
        .join(" ");
      return `<${kind} ${rendered} />`;
    })
    .join("");
  return { viewBox: icon.viewBox, attrs: icon.attrs, body };
}

const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const OPTION_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FLAG_RE = /^--?[A-Za-z0-9][\w-]*$/;

/** Commands that run whatever you hand them. An agent that claims one of these is not
 *  identified by its CLI at all, so it never installs without a person reading it first. */
const GENERIC_RUNTIMES = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh",
  "node", "nodejs", "npm", "npx", "bun", "bunx", "deno", "python", "python2", "python3",
  "ruby", "perl", "php", "java", "dotnet", "go", "make", "env", "sudo", "ssh", "docker",
  "osascript", "uv", "uvx", "pipx", "pip", "pip3", "cargo", "rustc", "lua", "rscript",
]);

export function isGenericRuntime(bin: string): boolean {
  return GENERIC_RUNTIMES.has(bin.toLowerCase());
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SESSION_ROOT_RE = /^[{}\w./@+-]{1,200}$/;
const DOT_PATH_RE = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*){0,5}$/;

/** A session store is a place on disk this app will read to find the session to resume.
 *  Anyone may declare one; a plugin's must live under the user's home directory, and the
 *  review names it before anything is installed. */
const ASSET_NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Variables that change how a process loads code, not what it does. An agent
 *  installed with a person's review may need one; setting them unattended would
 *  be running code by another name. */
const ENV_DENY = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS", "PATH", "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "SHELL", "IFS", "ELECTRON_RUN_AS_NODE"]);
const PLACEHOLDER_RE = /\{(asset:[A-Za-z0-9][\w.-]{0,63}|hcpSock|hcpToken|tileId|agentId|cwd|private)\}/g;
/** A token may carry placeholders; whatever is left must be plain. */
const plainWithPlaceholders = (v: string, max = 200): boolean =>
  v.length > 0 && v.length <= max && /^[\w{}:@./=+-]*$/.test(v.replace(PLACEHOLDER_RE, ""));

function validateAssets(raw: unknown): AgentAsset[] {
  req(Array.isArray(raw) && raw.length <= 8, "assets must be a list of at most 8 files");
  return raw.map((a, i) => {
    req(isObj(a), `assets[${i}] must be a map`);
    const { name, file, hook } = a as Record<string, unknown>;
    req(typeof name === "string" && ASSET_NAME_RE.test(name), `assets[${i}].name must be a plain file name`);
    req(typeof file === "string" && ASSET_NAME_RE.test(file), `assets[${i}].file must be a file beside the manifest`);
    req(hook === undefined || (typeof hook === "string" && /^[a-z][A-Za-z0-9]{0,31}$/.test(hook)), `assets[${i}].hook must be a hook name`);
    return { name, file, ...(typeof hook === "string" ? { hook } : {}) };
  });
}

function validateLaunch(raw: unknown): AgentLaunch {
  req(isObj(raw), "launch must be a map");
  const m = raw as Record<string, unknown>;
  const out: AgentLaunch = {};
  if (m.hcp !== undefined) { req(typeof m.hcp === "boolean", "launch.hcp must be true or false"); out.hcp = m.hcp; }
  if (m.args !== undefined) {
    req(strArray(m.args) && m.args.length <= 8, "launch.args must be at most 8 tokens");
    for (const t of m.args as string[]) req(plainWithPlaceholders(t), `launch.args: "${t}" is not a plain token`);
    out.args = m.args as string[];
  }
  if (m.requiresHome !== undefined) {
    req(m.requiresHome === true, "launch.requiresHome must be true");
    out.requiresHome = true;
  }
  if (m.subcommand !== undefined) {
    req(typeof m.subcommand === "string" && /^[\w-]{1,32}$/.test(m.subcommand), "launch.subcommand must be a subcommand name");
    out.subcommand = m.subcommand;
  }
  if (m.env !== undefined) {
    req(isObj(m.env), "launch.env must be a map");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.env as Record<string, unknown>)) {
      req(ENV_KEY_RE.test(k), `launch.env: "${k}" is not an environment variable name`);
      // Loader variables are how code gets run under another name; no manifest may set them.
      req(!ENV_DENY.has(k), `launch.env: a plugin may not set ${k}`);
      req(typeof v === "string" && plainWithPlaceholders(v, 1000), `launch.env.${k} is not a plain value`);
      env[k] = v;
    }
    out.env = env;
  }
  return out;
}

const HOOK_NAME_RE = /^[a-z][A-Za-z]{0,31}$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** A private home links a directory of the user's into a place the agent is pointed at.
 *  Anyone may declare one — nothing is ever written back into the real directory — but the
 *  review names the directory before anything is installed, because which one it is is the
 *  whole question. */
function validateHome(raw: unknown): AgentHome {
  req(isObj(raw), "home must be a map");
  const m = raw as Record<string, unknown>;
  const plain = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,64}$/.test(v);
  req(plain(m.root), "home.root must be a plain directory name");
  req(plain(m.dir), "home.dir must be a plain directory name");
  req(typeof m.mirror === "string" && m.mirror.startsWith("{home}/") && !m.mirror.includes(".."), "home.mirror must be a path under {home}/");
  req(typeof m.env === "string" && ENV_KEY_RE.test(m.env), "home.env must be an environment variable name");
  const out: AgentHome = { root: m.root, dir: m.dir, mirror: m.mirror, env: m.env };
  if (m.own !== undefined) {
    req(Array.isArray(m.own) && m.own.length <= 8, "home.own must be a list of at most 8 files");
    out.own = m.own.map((f, i) => {
      req(isObj(f), `home.own[${i}] must be a map`);
      const file = f as Record<string, unknown>;
      req(typeof file.name === "string" && file.name.split("/").every((p) => plain(p)) && file.name.split("/").length <= 2,
        `home.own[${i}].name must be a file name, at most one directory deep`);
      const entry: AgentHomeFile = { name: file.name as string };
      if (file.merge !== undefined) { req(file.merge === true, `home.own[${i}].merge must be true`); entry.merge = true; }
      if (file.set !== undefined) { req(isObj(file.set), `home.own[${i}].set must be a map`); entry.set = file.set as Record<string, unknown>; }
      return entry;
    });
  }
  return out;
}

/** Hooks wire events of the agent's CLI to Hivemind's own scripts. A manifest names a hook;
 *  it never writes the command line, and a name that is not one of ours is dropped when the
 *  document is rendered — so the worst a hostile manifest can do is ask for a script we
 *  wrote. What it does buy is the control plane, which the review says out loud. */
function validateHooks(raw: unknown): AgentHooks {
  req(isObj(raw), "hooks must be a map");
  const m = raw as Record<string, unknown>;
  req(isObj(m.events), "hooks.events must be a map of event name → hook");
  const events: Record<string, AgentHookEntry | AgentHookEntry[]> = {};
  for (const [event, spec] of Object.entries(m.events as Record<string, unknown>)) {
    req(EVENT_RE.test(event), `hooks.events: "${event}" is not an event name`);
    const list = (Array.isArray(spec) ? spec : [spec]).map((e, i) => {
      req(isObj(e), `hooks.events.${event}[${i}] must be a map`);
      const entry = e as Record<string, unknown>;
      req(typeof entry.hook === "string" && HOOK_NAME_RE.test(entry.hook), `hooks.events.${event}[${i}].hook must name one of Hivemind's hooks`);
      if (entry.timeout !== undefined) req(typeof entry.timeout === "number" && entry.timeout > 0 && entry.timeout <= 604800, `hooks.events.${event}[${i}].timeout must be seconds`);
      if (entry.matcher !== undefined) req(typeof entry.matcher === "string" && entry.matcher.length <= 200, `hooks.events.${event}[${i}].matcher must be a string`);
      if (entry.when !== undefined) req(entry.when === "supervised", `hooks.events.${event}[${i}].when: only "supervised"`);
      return entry as unknown as AgentHookEntry;
    });
    events[event] = Array.isArray(spec) ? list : list[0]!;
  }
  const out: AgentHooks = { events };
  if (m.template !== undefined) {
    req(typeof m.template === "string" && m.template.includes("{events}") && m.template.length <= 200, "hooks.template must be a short document containing {events}");
    out.template = m.template;
  }
  if (m.entry !== undefined) {
    req(isObj(m.entry) && Object.keys(m.entry).length <= 8, "hooks.entry must be a small map");
    out.entry = m.entry as Record<string, unknown>;
  }
  if (m.group !== undefined) {
    req(m.group === false || (isObj(m.group) && Object.keys(m.group).length <= 8), "hooks.group must be a small map or false");
    out.group = m.group === false ? false : (m.group as Record<string, unknown>);
  }
  if (m.arg !== undefined) { req(typeof m.arg === "string" && /^--?[\w-]{1,32}$/.test(m.arg), "hooks.arg must be a flag"); out.arg = m.arg; }
  if (m.file !== undefined) {
    req(typeof m.file === "string" && m.file.split("/").every((p) => ASSET_NAME_RE.test(p)) && m.file.split("/").length <= 2,
      "hooks.file must be a file name, at most one directory deep");
    out.file = m.file;
  }
  req(!!out.arg !== !!out.file, "hooks needs exactly one of `arg` (inline) or `file` (written)");
  return out;
}

function validateSession(raw: unknown): AgentSession {
  req(isObj(raw), "session must be a map");
  const m = raw as Record<string, unknown>;
  const out: AgentSession = {};
  if (m.bind !== undefined) {
    req(isObj(m.bind), "session.bind must be a map");
    const b = m.bind as Record<string, unknown>;
    req(strArray(b.args) && b.args.length > 0 && b.args.length <= 4, "session.bind.args must be 1-4 tokens");
    for (const t of b.args as string[]) req(/^[\w{}@./:=-]{1,64}$/.test(t), `session.bind.args: "${t}" is not a plain token`);
    out.bind = { args: b.args as string[] };
    if (b.unless !== undefined) {
      req(strArray(b.unless) && b.unless.length <= 12, "session.bind.unless must be a list of flags");
      for (const f of b.unless as string[]) req(/^--?[\w-]{1,32}$/.test(f), `session.bind.unless: "${f}" is not a flag`);
      out.bind.unless = b.unless as string[];
    }
  }
  if (m.resume === undefined) return out;
  req(isObj(m.resume), "session.resume must be a map");
  const r = m.resume as Record<string, unknown>;
  req(strArray(r.args) && r.args.length > 0 && r.args.length <= 4, "session.resume.args must be 1-4 tokens");
  for (const t of r.args as string[]) req(/^[\w{}@./:=-]{1,64}$/.test(t), `session.resume.args: "${t}" is not a plain token`);
  const resume: AgentSession["resume"] = { args: r.args as string[] };
  if (r.find !== undefined) {
    req(isObj(r.find), "session.resume.find must be a map");
    const f = r.find as Record<string, unknown>;
    req(f.strategy === "jsonl-header" || f.strategy === "dir-meta", "session.resume.find.strategy must be jsonl-header or dir-meta");
    req(typeof f.root === "string" && SESSION_ROOT_RE.test(f.root), "session.resume.find.root must be a plain path");
    // The root is untrusted input: inside the user's home, with no way out of it.
    req((f.root as string).startsWith("{home}/"), "session.resume.find.root must be under {home}/");
    req(!(f.root as string).includes(".."), "session.resume.find.root cannot climb out of {home}");
    const find = { strategy: f.strategy, root: f.root } as SessionFind;
    if (f.strategy === "jsonl-header") {
      for (const key of ["cwdPath", "idPath"] as const) {
        req(typeof f[key] === "string" && DOT_PATH_RE.test(f[key] as string), `session.resume.find.${key} must be a dotted field path`);
        find[key] = f[key] as string;
      }
      if (f.ext !== undefined) { req(typeof f.ext === "string" && /^\.\w{1,10}$/.test(f.ext), "session.resume.find.ext must look like .jsonl"); find.ext = f.ext; }
      if (f.require !== undefined) {
        req(isObj(f.require), "session.resume.find.require must be a map");
        for (const [k, v] of Object.entries(f.require as Record<string, unknown>)) req(DOT_PATH_RE.test(k) && typeof v === "string", "session.resume.find.require: field path → string");
        find.require = f.require as Record<string, string>;
      }
    } else {
      if (f.dirKey !== undefined) { req(f.dirKey === "md5-cwd" || f.dirKey === "cwd", "session.resume.find.dirKey must be md5-cwd or cwd"); find.dirKey = f.dirKey; }
      if (f.meta !== undefined) { req(typeof f.meta === "string" && /^[\w.-]{1,64}$/.test(f.meta), "session.resume.find.meta must be a file name"); find.meta = f.meta; }
      if (f.newestBy !== undefined) { req(strArray(f.newestBy) && (f.newestBy as string[]).every((p) => DOT_PATH_RE.test(p)), "session.resume.find.newestBy must be field paths"); find.newestBy = f.newestBy as string[]; }
      if (f.skipWhen !== undefined) { req(isObj(f.skipWhen), "session.resume.find.skipWhen must be a map"); find.skipWhen = f.skipWhen as Record<string, unknown>; }
    }
    resume.find = find;
  }
  if (r.from !== undefined) {
    req(isObj(r.from), "session.resume.from must be a map");
    const from = r.from as Record<string, unknown>;
    const picked: NonNullable<AgentSession["resume"]>["from"] = {};
    if (from.tracked !== undefined) { req(from.tracked === true, "session.resume.from.tracked must be true"); picked.tracked = true; }
    if (from.bound !== undefined) {
      req(typeof from.bound === "string" && /^--?[\w-]{1,32}$/.test(from.bound), "session.resume.from.bound must be the flag that bound it");
      picked.bound = from.bound;
    }
    resume.from = picked;
  }
  if (r.fallback !== undefined) {
    req(strArray(r.fallback) && r.fallback.length <= 4, "session.resume.fallback must be at most 4 tokens");
    for (const t of r.fallback as string[]) req(/^[\w{}@./:=-]{1,64}$/.test(t), `session.resume.fallback: "${t}" is not a plain token`);
    resume.fallback = r.fallback as string[];
  }
  if (r.position !== undefined) {
    req(r.position === "before" || r.position === "beforeLaunch" || r.position === "after",
      'session.resume.position must be "before", "beforeLaunch" or "after"');
    resume.position = r.position;
  }
  out.resume = resume;
  return out;
}

/** A token for a listing command: a subcommand or flag, never shell punctuation. */
const LIST_ARG_RE = /^[\w.:/@=+-]{1,64}$/;

function validateOptions(raw: unknown): AgentOption[] {
  req(Array.isArray(raw), "options must be a list");
  const seen = new Set<string>();
  return raw.map((o: Record<string, unknown>, i) => {
    const at = `options[${i}]`;
    req(o && typeof o === "object", `${at} must be a map`);
    req(typeof o.id === "string" && OPTION_ID_RE.test(o.id) && !seen.has(o.id), `${at}.id must be a unique lowercase id`);
    seen.add(o.id);
    req(typeof o.label === "string" && o.label.length > 0, `${at}.label is required`);
    req(o.flag === undefined ? !!o.values : typeof o.flag === "string" && FLAG_RE.test(o.flag),
      `${at}.flag must be a flag like --model (or give \`values\`)`);
    for (const k of ["default", "unattended"] as const) {
      req(o[k] === undefined || typeof o[k] === "string", `${at}.${k} must be a string`);
    }
    if (o.values !== undefined) {
      req(o.values && typeof o.values === "object" && !Array.isArray(o.values), `${at}.values must be a map`);
      for (const [k, v] of Object.entries(o.values)) req(strArray(v), `${at}.values["${k}"] must be a string array`);
    }
    if (o.list !== undefined) {
      const l = o.list as Record<string, unknown>;
      req(l && strArray(l.args) && (l.args as string[]).length > 0 && (l.args as string[]).length <= 8,
        `${at}.list.args must be 1-8 tokens`);
      // The agent's own binary is what runs, but a Windows .cmd shim goes through a shell:
      // a token carrying `&` or `|` would be a second command. Plain tokens only, always.
      for (const t of l.args as string[]) req(LIST_ARG_RE.test(t), `${at}.list.args: "${t}" is not a plain token`);
      req(l.skip === undefined || (Number.isInteger(l.skip) && (l.skip as number) >= 0), `${at}.list.skip must be a count`);
      req(l.format === undefined || typeof l.format === "string", `${at}.list.format must be a string`);
    }
    return o as unknown as AgentOption;
  });
}

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ManifestError(msg);
}

export interface ManifestLoadOptions {
  /** A person asked for this one by name, so a reserved id is theirs to take. */
  allowReserved?: boolean;
  reserved?: readonly string[];
}

export function defFromManifest(data: unknown, opts: ManifestLoadOptions = {}): AgentProviderDef {
  req(data && typeof data === "object", "manifest must be an object");
  const m = data as AgentManifest;

  req(m.manifestVersion === AGENT_MANIFEST_VERSION,
    `manifestVersion must be ${AGENT_MANIFEST_VERSION} (got ${String(m.manifestVersion)})`);
  req(typeof m.id === "string" && AGENT_ID_RE.test(m.id), `id must be lowercase letters, digits and dashes (got ${String(m.id)})`);
  req(typeof m.label === "string" && m.label.length > 0, "label is required");
  req(typeof m.bin === "string" && m.bin.length > 0, "bin is required");
  // A path would put the agent's label on an arbitrary executable.
  req(!/[\\/]/.test(m.bin), `bin must be a bare basename, not a path (got ${m.bin})`);
  req(!opts.reserved?.includes(m.id), `id "${m.id}" is reserved: it would replace an agent you already have`);
  // A name Hivemind has shipped stays attached to the command it has always launched.
  const ours = RESERVED_AGENTS[m.id];
  req(!!opts.allowReserved || !ours || ours === m.bin,
    `id "${m.id}" is Hivemind's agent for \`${ours}\`, but this manifest launches \`${m.bin}\``);

  req(m.caps && typeof m.caps === "object", "caps is required");
  for (const k of CAP_KEYS) {
    req(m.caps[k] !== undefined, `caps.${k} is required — an absence must be a decision`);
  }

  // A claimed signal nothing sends would leave the control plane waiting forever. It must
  // be the manifest itself that wires the agent to the control plane and ships the file
  // that does the talking.
  const wiredToControlPlane = !!(m.launch as { hcp?: unknown } | undefined)?.hcp
    && ((Array.isArray(m.assets) && m.assets.length > 0) || !!m.hooks || !!m.home);
  if (!wiredToControlPlane) {
    req(m.caps.turnSignal === false,
      "caps.turnSignal must be false: nothing here sends it — a daemon half, or `launch.hcp` with the asset that talks to it");
    req(m.caps.supervise !== "broker",
      'caps.supervise cannot be "broker": brokering needs a pre-tool hook, which a manifest cannot inject');
    // Resuming needs the session store read — but a manifest can say where it is, and
    // the daemon does the reading (src/session.ts). Claiming it without saying where is
    // the thing that must be refused.
    req(m.caps.resume === "none" || !!(m.session as { resume?: unknown } | undefined)?.resume,
      'caps.resume must be "none" unless `session.resume` says where this CLI keeps its sessions');
  }

  if (m.spawn) {
    const sp = m.spawn as Record<string, unknown>;
    req(sp.args === undefined || strArray(sp.args), "spawn.args must be a string array");
    req(sp.label === undefined || typeof sp.label === "string", "spawn.label must be a string");
    req(sp.labelMode === undefined || typeof sp.labelMode === "string", "spawn.labelMode must be a string");
    req(sp.titles === undefined || strArray(sp.titles), "spawn.titles must be a string array");
  }

  const aliases = m.aliases;
  req(aliases === undefined || (Array.isArray(aliases) && aliases.every((a) => typeof a === "string")),
    "aliases must be a string array");

  const options = m.options === undefined ? undefined : validateOptions(m.options);
  if (m.install !== undefined) {
    const i = m.install as unknown as Record<string, unknown>;
    req(i && typeof i.url === "string" && /^https:\/\/[^\s]+$/.test(i.url), "install.url must be an https link");
    req(i.command === undefined || (typeof i.command === "string" && i.command.length <= 300 && !/[\r\n]/.test(i.command)),
      "install.command must be one line");
  }

  let detect: ((screen: string) => TileStatus) | undefined;
  if (m.detect) {
    req(Array.isArray(m.detect.rules), "detect.rules must be an array");
    req(STATUSES.includes(m.detect.default), `detect.default must be one of ${STATUSES.join(", ")}`);
    try { validateScope(m.detect.scope, "detect.scope"); }
    catch (e) { throw new ManifestError((e as Error).message); }
    m.detect.rules.forEach((r, i) => {
      req(r && typeof r === "object" && r.when, `detect.rules[${i}] needs a \`when\``);
      req(STATUSES.includes(r.then), `detect.rules[${i}].then must be one of ${STATUSES.join(", ")}`);
      try {
        validateExpr(r.when, `detect.rules[${i}].when`);
        validateScope(r.scope, `detect.rules[${i}].scope`);
      } catch (e) { throw new ManifestError((e as Error).message); }
    });
    detect = compileDetect(m.detect);
  }

  const def: AgentProviderDef = {
    id: m.id,
    label: m.label,
    bin: m.bin,
    ...(aliases ? { aliases } : {}),
    ...(m.spawn?.args ? { defaultArgs: m.spawn.args } : {}),
    ...(m.spawn?.titles ? { titles: m.spawn.titles } : {}),
    enabled: m.enabled ?? false,
    caps: m.caps,
    ...(detect ? { detect } : {}),
    icon: m.icon ? iconFromManifest(m.icon) : GENERIC_AGENT_ICON,
    ...(m.note ? { note: m.note } : {}),
    ...(options ? { options } : {}),
    ...(m.install ? { install: m.install } : {}),
    ...(m.session ? { session: validateSession(m.session) } : {}),
    ...(m.assets ? { assets: validateAssets(m.assets) } : {}),
    ...(m.hooks ? { hooks: validateHooks(m.hooks) } : {}),
    ...(m.home ? { home: validateHome(m.home) } : {}),
    ...(m.launch ? { launch: validateLaunch(m.launch) } : {}),
  };

  if (m.spawn) {
    if (m.spawn.label) {
      const { label: tpl, labelMode } = m.spawn;
      def.spawnLabel = (n, { mode }) => {
        let out = tpl.replace(/\{n\}/g, String(n)).replace(/\{label\}/g, m.label);
        if (labelMode && mode && mode !== "default") {
          out += labelMode.replace(/\{mode\}/g, mode);
        }
        return out;
      };
    }
  }
  return def;
}

/**
 * What this agent does that a person has to agree to, in their words.
 *
 * Validation decides what a manifest *may* declare; this decides what may happen without
 * anyone reading it. Every line here is something that runs a command, reaches outside the
 * plugin's own directory, or reaches back into Hivemind — so the review prints them, and
 * auto-install refuses an agent that has any.
 */
export function agentDisclosures(def: AgentProviderDef): string[] {
  const out: string[] = [];
  for (const o of def.options ?? []) {
    if (o.list) out.push(`runs \`${def.bin} ${o.list.args.join(" ")}\` to list ${o.label.toLowerCase()} values`);
  }
  if (def.home) out.push(`links your ${def.home.mirror} into a private copy it points ${def.bin} at`);
  if (def.session?.resume?.find) out.push(`reads ${def.session.resume.find.root} to find a session to resume`);
  if (def.launch?.hcp && (def.hooks || def.assets?.length)) {
    out.push("reports its status and approval prompts to Hivemind through its own hooks, which can also read and type into your other tiles");
  }
  return out;
}
