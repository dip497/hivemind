/** A provider's browser-safe half as data. Takes parsed YAML; never sees YAML,
 *  so this package stays browser-safe. What a manifest cannot express (resume,
 *  hooks) needs a compiled node half, and claiming it without one is refused. */
import type { AgentCapabilities, AgentIcon, AgentInstall, AgentOption, AgentProviderDef, TileStatus } from "./types.js";
import { compileDetect, usesRegex, validateExpr, validateScope, type DetectRules } from "./detect-rules.js";
import { GENERIC_AGENT_ICON } from "./icon.js";

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
}

export class ManifestError extends Error {}

/** Later sources shadow earlier ones. */
export type AgentSource = "builtin" | "user" | "repo";

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
  builtins: readonly AgentProviderDef[],
): AgentProviderDef[] {
  const compiled = new Map(builtins.map((d) => [d.id, d]));
  const byId = new Map<string, AgentProviderDef>();
  for (const e of entries) {
    if (e.disabled) { byId.delete(e.id); continue; }
    if (e.error) continue; // a broken later entry does not remove a working earlier one
    const def = e.source === "builtin" ? compiled.get(e.id) : safeDef(e.manifest);
    if (def) byId.set(e.id, def);
  }
  return [...byId.values()];
}

function safeDef(manifest: unknown): AgentProviderDef | undefined {
  // Main already validated; if the sides disagree, drop one provider, not the catalog.
  try { return defFromManifest(manifest); } catch { return undefined; }
}

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STATUSES: readonly TileStatus[] = ["idle", "working", "blocked", "permission", "question"];
const CAP_KEYS = [
  "promptDelivery", "turnSignal", "resume", "supervise",
  "blockedDetection",
] as const;

function esc(v: string | number): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A manifest supplies only escaped values on whitelisted shapes, never markup. */
function iconFromManifest(icon: ManifestIcon): AgentIcon {
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

function validateOptions(raw: unknown, trusted: boolean): AgentOption[] {
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
      req(trusted, `${at} may not use \`list\`: it runs a command; plugins get values from --help`);
      const l = o.list as Record<string, unknown>;
      req(l && strArray(l.args), `${at}.list.args must be a string array`);
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
  /** Shipped in the app, so it may use `re` rules. */
  trusted?: boolean;
  reserved?: readonly string[];
  /** A compiled node half (node.ts `PLUGINS`) backs resume, turn signal and broker. */
  nodeHalf?: boolean;
}

export function defFromManifest(data: unknown, opts: ManifestLoadOptions = {}): AgentProviderDef {
  req(data && typeof data === "object", "manifest must be an object");
  const m = data as AgentManifest;

  req(m.manifestVersion === AGENT_MANIFEST_VERSION,
    `manifestVersion must be ${AGENT_MANIFEST_VERSION} (got ${String(m.manifestVersion)})`);
  req(typeof m.id === "string" && AGENT_ID_RE.test(m.id), `id must match ${AGENT_ID_RE} (got ${String(m.id)})`);
  req(typeof m.label === "string" && m.label.length > 0, "label is required");
  req(typeof m.bin === "string" && m.bin.length > 0, "bin is required");
  // A path would put the agent's label on an arbitrary executable.
  req(!/[\\/]/.test(m.bin), `bin must be a bare basename, not a path (got ${m.bin})`);
  req(!opts.reserved?.includes(m.id), `id "${m.id}" is reserved: it would replace an agent you already have`);

  req(m.caps && typeof m.caps === "object", "caps is required");
  for (const k of CAP_KEYS) {
    req(m.caps[k] !== undefined, `caps.${k} is required — an absence must be a decision`);
  }

  // A claimed signal nothing sends would leave the control plane waiting forever.
  if (!opts.nodeHalf) {
    req(m.caps.turnSignal === false,
      "caps.turnSignal must be false: a manifest cannot inject the hooks a turn signal needs");
    req(m.caps.supervise !== "broker",
      'caps.supervise cannot be "broker": brokering needs a pre-tool hook, which a manifest cannot inject');
    req(m.caps.resume === "none",
      'caps.resume must be "none": resuming needs the agent\'s session store read, which is code');
  }

  if (m.spawn) {
    const sp = m.spawn as Record<string, unknown>;
    req(sp.args === undefined || strArray(sp.args), "spawn.args must be a string array");
    req(sp.label === undefined || typeof sp.label === "string", "spawn.label must be a string");
    req(sp.labelMode === undefined || typeof sp.labelMode === "string", "spawn.labelMode must be a string");
  }

  const aliases = m.aliases;
  req(aliases === undefined || (Array.isArray(aliases) && aliases.every((a) => typeof a === "string")),
    "aliases must be a string array");

  const options = m.options === undefined ? undefined : validateOptions(m.options, !!opts.trusted);
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
      // Shape first: usesRegex uses `in`, which throws on a non-object.
      try {
        validateExpr(r.when, `detect.rules[${i}].when`);
        validateScope(r.scope, `detect.rules[${i}].scope`);
      } catch (e) { throw new ManifestError((e as Error).message); }
      req(opts.trusted || !usesRegex(r.when),
        `detect.rules[${i}] may not use \`re\`: a plugin-supplied regex can hang the UI thread`);
    });
    detect = compileDetect(m.detect);
  }

  const def: AgentProviderDef = {
    id: m.id,
    label: m.label,
    bin: m.bin,
    ...(aliases ? { aliases } : {}),
    ...(m.spawn?.args ? { defaultArgs: m.spawn.args } : {}),
    enabled: m.enabled ?? false,
    caps: m.caps,
    ...(detect ? { detect } : {}),
    icon: m.icon ? iconFromManifest(m.icon) : GENERIC_AGENT_ICON,
    ...(m.note ? { note: m.note } : {}),
    ...(options ? { options } : {}),
    ...(m.install ? { install: m.install } : {}),
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
