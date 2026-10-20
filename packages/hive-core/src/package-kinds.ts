/**
 * The kinds of plugin a package can hold, each as data: the file that makes a folder one, how one
 * is read and checked, and whether it is on when first installed. Installing, removing and
 * switching packages (`./package-install.ts`) reads this table and never names a kind.
 */
import { readToolPackage, TOOL_MANIFEST } from "./tool-packages.js";
import { widgetToInstall } from "./widgets.js";
import { viewToInstall } from "./views.js";
import { MANIFEST_FILE as VIEW_MANIFEST } from "@hivemind/view-sdk/manifest";

/** A member as its kind read it from its folder. */
export interface CheckedMember {
  id: string;
  name: string;
  version?: string;
  /** What it asks to be allowed, in the view protocol's words. */
  permissions: string[];
}

export interface MemberKind {
  kind: "tool" | "widget" | "view";
  /** What it is called in a sentence. */
  noun: string;
  /** The file that makes a folder one of these. */
  manifest: string;
  /** On when first installed; off until the person switches it on, for code that runs in the app. */
  onByDefault: boolean;
  /** Read and check the one in `dir`. `id`, when given, is the id it must have (a HiveHub
   *  listing); `folder` is the name of the folder it came from. */
  check(dir: string, given: { id?: string; folder: string }): Promise<CheckedMember>;
}

export const MEMBER_KINDS: readonly MemberKind[] = [
  {
    kind: "tool", noun: "tool plugin", manifest: TOOL_MANIFEST, onByDefault: false,
    check: async (dir, { id }) => {
      const t = await readToolPackage(dir, id ?? null);
      if (t.problem) throw new Error(t.problem);
      return { id: t.id, name: t.name, ...(t.version ? { version: t.version } : {}), permissions: t.permissions };
    },
  },
  {
    kind: "widget", noun: "widget", manifest: "widget.json", onByDefault: true,
    check: async (dir, given) => {
      const w = await widgetToInstall(dir, given);
      return { id: w.id, name: w.name, ...(w.version ? { version: w.version } : {}), permissions: w.permissions };
    },
  },
  {
    kind: "view", noun: "view", manifest: VIEW_MANIFEST, onByDefault: true,
    check: async (dir, { id }) => {
      const v = await viewToInstall(dir);
      if (id && v.id !== id) throw new Error(`its ${VIEW_MANIFEST} says it is "${v.id}", not ${id}`);
      return { id: v.id, name: v.manifest?.name ?? v.id, ...(v.manifest?.version ? { version: v.manifest.version } : {}), permissions: v.manifest?.permissions ?? [] };
    },
  },
];

export const memberKind = (kind: string): MemberKind | undefined => MEMBER_KINDS.find((k) => k.kind === kind);
