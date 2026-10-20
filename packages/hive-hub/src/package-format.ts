/**
 * What a package is, as data: the kinds of member it can hold, how `hivemind-package.json` is
 * written, and the check of that file on its own. Reads no file and runs anywhere, so HiveHub
 * checks a package with the same rules an install does. Reading each member's own folder is
 * `./package-kinds.ts`.
 */
import { z } from "zod";
import { isSafeRelativePath, MANIFEST_FILE as VIEW_MANIFEST } from "@hivemind/view-sdk/manifest";
import { TOOL_MANIFEST } from "@hivemind/core/tool-format";
import { UNSAFE_TEXT_RE } from "./index-format.js";

/** The file holding a package's own manifest. */
export const PACKAGE_MANIFEST = "hivemind-package.json";

export const label = z.string().min(1).max(120).refine((s) => !UNSAFE_TEXT_RE.test(s), "control characters are not allowed");
const relative = z.string().refine((s) => isSafeRelativePath(s) && !/[\x00-\x1f\x7f]/.test(s), "expected a relative path inside the package");
/** An agent a preset names: built in, or `@owner/name` from HiveHub. */
const agentId = z.string().regex(/^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{1,63}$/);
/** A member's id: `@owner/name`, the owner being the package's. */
export const MEMBER_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

const folderEntry = z.strictObject({ path: relative });
const presetEntry = z.strictObject({
  id: z.string().regex(MEMBER_ID, "is @owner/name"), name: label, provider: agentId, model: label.optional(),
  prompt: z.string().min(1).max(16000).refine((s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s), "invalid prompt control character"),
});
export type AgentPreset = z.infer<typeof presetEntry>;
export type FolderEntry = z.infer<typeof folderEntry>;

/** Where a member's code runs, which decides how much trust it needs. `sandboxed`: in a sandbox
 *  that holds it to the permissions it asks for. Any other: in the app with the app's access, or
 *  as an agent's instructions. */
export type MemberRuns = "sandboxed" | "in the app" | "as an agent's instructions";

export interface MemberFormat {
  kind: "tool" | "widget" | "view" | "agent-preset";
  /** What it is called in a sentence. */
  noun: string;
  /** The list in `hivemind-package.json` that names members of this kind. */
  list: "tools" | "widgets" | "views" | "agents";
  /** How one entry of that list is written. */
  entry: z.ZodType;
  /** The most one package may hold. */
  most: number;
  /** The file that makes a folder one of these; none for a member written in the package's
   *  manifest itself. */
  manifest?: string;
  runs: MemberRuns;
}

export const MEMBER_FORMATS: readonly MemberFormat[] = [
  { kind: "tool", noun: "tool plugin", list: "tools", most: 16, manifest: TOOL_MANIFEST, runs: "in the app", entry: folderEntry },
  { kind: "widget", noun: "widget", list: "widgets", most: 16, manifest: "widget.json", runs: "sandboxed", entry: folderEntry },
  { kind: "view", noun: "view", list: "views", most: 8, manifest: VIEW_MANIFEST, runs: "sandboxed", entry: folderEntry },
  { kind: "agent-preset", noun: "agent preset", list: "agents", most: 16, runs: "as an agent's instructions", entry: presetEntry },
];

export const memberFormat = (kind: string): MemberFormat | undefined => MEMBER_FORMATS.find((k) => k.kind === kind);

export const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const schema = z.strictObject({
  apiVersion: z.literal(2),
  id: z.string().regex(MEMBER_ID, "is @owner/name"),
  name: label,
  version: z.string().regex(PACKAGE_VERSION),
  /** Plugins of its owner installed on their own, which it takes over with their settings. */
  replaces: z.array(z.string().regex(MEMBER_ID, "is @owner/name")).max(16).default([]),
  ...Object.fromEntries(MEMBER_FORMATS.map((k) => [k.list, z.array(k.entry).max(k.most).default([])])),
  startup: z.strictObject({
    view: z.string().max(200).optional(),
    agents: z.array(z.string()).max(8).default([]),
    maxConcurrent: z.number().int().min(1).max(4).default(1),
  }).optional(),
});

export interface PackageManifest {
  apiVersion: 2;
  id: string;
  name: string;
  version: string;
  replaces: string[];
  startup?: { view?: string; agents: string[]; maxConcurrent: number };
  /** The members, by the list each kind is named in (`tools`, `widgets`, `views`, `agents`). */
  [list: string]: unknown;
}

/** The entries of `m` in the list of `format`. */
export const entriesOf = (m: PackageManifest, format: MemberFormat): unknown[] => (m[format.list] as unknown[] | undefined) ?? [];

/** Check a `hivemind-package.json` on its own: its shape, its owner's `replaces`, no member named
 *  twice. Its members' folders are checked by their kinds, apart from this. */
export function checkPackageManifest(raw: unknown): { manifest: PackageManifest } | { problem: string } {
  const result = schema.safeParse(raw);
  if (!result.success) return { problem: result.error.issues.map((e) => `${e.path.join(".") || "manifest"}: ${e.message}`).join("; ") };
  const m = result.data as unknown as PackageManifest;
  const owner = m.id.slice(0, m.id.indexOf("/"));
  const twice = (values: string[], what: string) => (new Set(values).size !== values.length ? `duplicate ${what}` : null);
  for (const r of m.replaces) if (!r.startsWith(`${owner}/`)) return { problem: `replaces: ${r} is not ${owner}'s; a package takes over only its own owner's plugins` };
  const problem = twice(m.replaces, "replaces")
    ?? (MEMBER_FORMATS.every((k) => !entriesOf(m, k).length) ? `package must hold a ${MEMBER_FORMATS.map((k) => k.noun).join(", ")}` : null)
    ?? MEMBER_FORMATS.map((k) => twice(entriesOf(m, k).map((e) => { const x = e as { path?: string; id?: string }; return x.path ?? x.id ?? ""; }), `${k.noun} in ${k.list}`)).find(Boolean)
    ?? null;
  if (problem) return { problem };
  if (m.startup) {
    const presets = entriesOf(m, memberFormat("agent-preset")!) as AgentPreset[];
    const p = twice(m.startup.agents, "startup agent")
      ?? m.startup.agents.filter((a) => !presets.some((x) => x.id === a)).map((a) => `unknown startup agent: ${a}`)[0]
      ?? (!m.startup.view && !m.startup.agents.length ? "startup must select a view or start an agent" : null);
    if (p) return { problem: p };
  }
  return { manifest: m };
}

/** Whether member `id` is the package owner's, as every member of a package must be. */
export const ownedBy = (packageId: string, id: string): boolean => id.startsWith(`${packageId.slice(0, packageId.indexOf("/"))}/`);
