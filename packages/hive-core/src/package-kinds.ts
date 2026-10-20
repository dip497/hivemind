/**
 * The kinds of member a package can hold, each as data: the list in `hivemind-package.json` that
 * names them, how an entry of that list is written, the file that makes a folder one (what a
 * package of one is found by), how one is read and checked, and whether it is on when first
 * installed. Reading, installing, removing and switching packages read this table and never name
 * a kind.
 */
import path from "node:path";
import { z } from "zod";
import { isSafeRelativePath, MANIFEST_FILE as VIEW_MANIFEST } from "@hivemind/view-sdk/manifest";
import { PROTOCOL_VERSION } from "@hivemind/view-sdk/protocol";
import { readToolPackage, TOOL_MANIFEST } from "./tool-packages.js";
import { widgetToInstall } from "./widgets.js";
import { viewToInstall } from "./views.js";
import { HiveError } from "./storage.js";

/** A member as its kind read it. */
export interface CheckedMember {
  id: string;
  name: string;
  version?: string;
  /** What it asks to be allowed, in the view protocol's words. */
  permissions: string[];
}

/** The file holding a package's own manifest. */
export const PACKAGE_MANIFEST = "hivemind-package.json";

export const label = z.string().min(1).max(120).refine((s) => !/[\x00-\x1f\x7f]/.test(s), "control characters are not allowed");
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

export interface MemberKind {
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
  /** On when first installed; off until the person switches it on, for one that runs code in the
   *  app or instructs an agent. */
  onByDefault: boolean;
  /** Read and check one entry of its list, in the package at `root`: the member, and its path
   *  inside the package. `id`, when given, is the id it must have (a HiveHub listing); `folder` is
   *  the name of the folder a package of one came from. */
  check(root: string, entry: unknown, given: { id?: string; folder: string }): Promise<CheckedMember & { path: string }>;
}

/** A kind whose members are folders: its entry is `{ path }`, checked by `read`. */
function inFolders(k: Omit<MemberKind, "entry" | "check"> & { manifest: string; read(dir: string, given: { id?: string; folder: string }): Promise<CheckedMember> }): MemberKind {
  const { read, ...rest } = k;
  return {
    ...rest, entry: folderEntry,
    check: async (root, entry, given) => {
      const at = (entry as z.infer<typeof folderEntry>).path;
      try { return { ...(await read(path.join(root, at), given)), path: at }; }
      catch (e) {
        if (at === ".") throw e;
        // Which member it is, said first; the code the kind gave it kept.
        const message = `${at}: ${e instanceof Error ? e.message : String(e)}`;
        throw e instanceof HiveError ? new HiveError(e.code, message) : new Error(message);
      }
    },
  };
}

export const MEMBER_KINDS: readonly MemberKind[] = [
  inFolders({
    kind: "tool", noun: "tool plugin", list: "tools", most: 16, manifest: TOOL_MANIFEST, onByDefault: false,
    read: async (dir, { id }) => {
      const t = await readToolPackage(dir, id ?? null);
      if (t.problem) throw new Error(t.problem);
      return { id: t.id, name: t.name, ...(t.version ? { version: t.version } : {}), permissions: t.permissions };
    },
  }),
  inFolders({
    kind: "widget", noun: "widget", list: "widgets", most: 16, manifest: "widget.json", onByDefault: true,
    read: async (dir, given) => {
      const w = await widgetToInstall(dir, given);
      return { id: w.id, name: w.name, ...(w.version ? { version: w.version } : {}), permissions: w.permissions };
    },
  }),
  inFolders({
    kind: "view", noun: "view", list: "views", most: 8, manifest: VIEW_MANIFEST, onByDefault: true,
    read: async (dir, { id }) => {
      const v = await viewToInstall(dir);
      if (id && v.id !== id) throw new Error(`its ${VIEW_MANIFEST} says it is "${v.id}", not ${id}`);
      if ((v.manifest?.protocol ?? 1) > PROTOCOL_VERSION) throw new Error(`it needs view protocol ${v.manifest!.protocol}; this app has ${PROTOCOL_VERSION}`);
      return { id: v.id, name: v.manifest?.name ?? v.id, ...(v.manifest?.version ? { version: v.manifest.version } : {}), permissions: v.manifest?.permissions ?? [] };
    },
  }),
  {
    kind: "agent-preset", noun: "agent preset", list: "agents", most: 16, entry: presetEntry, onByDefault: false,
    check: async (_root, entry) => {
      const p = entry as AgentPreset;
      return { id: p.id, name: p.name, permissions: [], path: PACKAGE_MANIFEST };
    },
  },
];

export const memberKind = (kind: string): MemberKind | undefined => MEMBER_KINDS.find((k) => k.kind === kind);
