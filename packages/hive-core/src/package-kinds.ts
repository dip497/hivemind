/**
 * The kinds of member a package can hold: each kind's data (the hub kit's `package-format.ts`) with how a
 * member of it is read and checked on this machine. Reading, installing, removing and switching
 * packages read this table and never name a kind.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { MANIFEST_FILE as VIEW_MANIFEST } from "@hivemind/view-sdk/manifest";
import { PROTOCOL_VERSION } from "@hivemind/view-sdk/protocol";
import { memberFormat, PACKAGE_MANIFEST, type AgentPreset, type FolderEntry, type MemberFormat } from "@hivemind/hub";
import { readToolPackage } from "./tool-packages.js";
import { widgetToInstall } from "./widgets.js";
import { viewToInstall } from "./views.js";
import { readThemeFolder } from "./theme-folder.js";
import { readWallpaperFolder } from "./wallpaper-folder.js";
import { HiveError } from "./storage.js";

/** A member as its kind read it. */
export interface CheckedMember {
  id: string;
  name: string;
  version?: string;
  /** What it asks to be allowed, in the view protocol's words. */
  permissions: string[];
  /** The SHA-256 of what it is, for a member that is no folder of its own (a preset's entry);
   *  a folder member's is its files'. */
  digest?: string;
}


export interface MemberGiven { id?: string; folder: string; package?: string }

export interface MemberKind extends MemberFormat {
  /** Read and check one entry of its list, in the package at `root`: the member, and its path
   *  inside the package. `id`, when given, is the id it must have (a HiveHub listing); `folder` is
   *  the name of the folder a package of one came from; `package` is the id of the package it is
   *  in, which a theme's id is made from. */
  check(root: string, entry: unknown, given: MemberGiven): Promise<CheckedMember & { path: string }>;
}

/** A kind whose members are folders: its entry is `{ path }`, checked by `read`. */
function inFolders(kind: MemberFormat["kind"], read: (dir: string, given: MemberGiven) => Promise<CheckedMember>): MemberKind {
  return {
    ...memberFormat(kind)!,
    check: async (root, entry, given) => {
      const at = (entry as FolderEntry).path;
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
  inFolders("tool", async (dir, { id }) => {
    const t = await readToolPackage(dir, id ?? null);
    if (t.problem) throw new Error(t.problem);
    return { id: t.id, name: t.name, ...(t.version ? { version: t.version } : {}), permissions: t.permissions };
  }),
  inFolders("widget", async (dir, given) => {
    const w = await widgetToInstall(dir, given);
    return { id: w.id, name: w.name, ...(w.version ? { version: w.version } : {}), permissions: w.permissions };
  }),
  inFolders("view", async (dir, { id }) => {
    const v = await viewToInstall(dir);
    if (id && v.id !== id) throw new Error(`its ${VIEW_MANIFEST} says it is "${v.id}", not ${id}`);
    if ((v.manifest?.protocol ?? 1) > PROTOCOL_VERSION) throw new Error(`it needs view protocol ${v.manifest!.protocol}; this app has ${PROTOCOL_VERSION}`);
    return { id: v.id, name: v.manifest?.name ?? v.id, ...(v.manifest?.version ? { version: v.manifest.version } : {}), permissions: v.manifest?.permissions ?? [] };
  }),
  inFolders("theme", async (dir, given) => {
    const { id, theme } = await readThemeFolder(dir, given.package);
    return { id, name: theme.name, permissions: [] };
  }),
  // Sandboxed, as a view is, and told less: it asks for nothing.
  inFolders("wallpaper", async (dir, given) => {
    const { id, manifest } = await readWallpaperFolder(dir, given.package);
    return { id, name: manifest.name, permissions: [] };
  }),
  {
    ...memberFormat("agent-preset")!,
    check: async (_root, entry) => {
      const p = entry as AgentPreset;
      const digest = createHash("sha256").update(JSON.stringify([p.provider, p.model ?? null, p.prompt])).digest("hex");
      return { id: p.id, name: p.name, permissions: [], path: PACKAGE_MANIFEST, digest };
    },
  },
];

export const memberKind = (kind: string): MemberKind | undefined => MEMBER_KINDS.find((k) => k.kind === kind);
