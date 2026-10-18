/**
 * A workspace document's root containers (docs/design/multiplayer-2026-09-28.md §8). Writers and
 * readers take the names from here.
 *
 *   meta    Map          `schema`; `core` once a core layout has been written; whose the workspace
 *                        is: `workspaceId`, `owner` and `workspacePublicKey` (spec/identity.md)
 *   frames  Tree         one node per frame, nested as the frames nest; node data = its fields
 *   tiles   Map          tile id → the tile's fields, plus its `frame`, `name` and `tabs`
 *   order   MovableList  tile ids in the order they were opened (the Windows view's tabs)
 *   views   Map          view id → { v, data }, each view's own layout
 *   objects Map          board object id → its fields; `text` and `label` are texts, and a
 *                        checklist has `items` (item id → { done, text }) and `itemOrder`
 *
 * The §8 container without a writer yet, `machines` (R9), arrives with it: a root container
 * added later needs no migration.
 */
import { LoroDoc, type ContainerID, type Frontiers } from "loro-crdt";

export const META = "meta";
export const FRAMES = "frames";
export const TILES = "tiles";
export const ORDER = "order";
export const VIEWS = "views";
export const OBJECTS = "objects";

/** Bump only with a migration of the documents already on disk. */
export const SCHEMA_VERSION = 1;

/** Record the schema version on a document being written. */
export function stampSchema(doc: LoroDoc): void {
  const meta = doc.getMap(META);
  if (meta.get("schema") !== SCHEMA_VERSION) meta.set("schema", SCHEMA_VERSION);
}

/** Whose a workspace is (R3, spec/identity.md): its id, its owner's person key, and the public
 *  half of its workspace key, which the owner derives from the two. */
export interface Ownership {
  workspaceId: string;
  owner: string;
  workspacePublicKey: string;
}

/** Whose the workspace is, as its document says; null when it does not say. */
export function readOwnership(doc: LoroDoc): Ownership | null {
  const meta = doc.getMap(META);
  const [workspaceId, owner, workspacePublicKey] = [meta.get("workspaceId"), meta.get("owner"), meta.get("workspacePublicKey")];
  if (typeof workspaceId !== "string" || typeof owner !== "string" || typeof workspacePublicKey !== "string") return null;
  return { workspaceId, owner, workspacePublicKey };
}

/** Whose a workspace is, as a document's bytes (a snapshot, or updates) say; null when they do not
 *  say, or are not a document's. */
export function ownershipIn(bytes: Uint8Array): Ownership | null {
  const doc = new LoroDoc();
  try {
    doc.import(bytes);
  } catch {
    return null;
  }
  return readOwnership(doc);
}

/** Record that the workspace is `ownership.owner`'s now: the device that owned it took another
 *  person (spec/pairing.md), and its workspaces went with it. Only the owner's device does this. */
export function replaceOwnership(doc: LoroDoc, ownership: Ownership): void {
  const meta = doc.getMap(META);
  meta.set("workspaceId", ownership.workspaceId);
  meta.set("owner", ownership.owner);
  meta.set("workspacePublicKey", ownership.workspacePublicKey);
}

/** Record whose the workspace is, as `ownership()` says, on a document that does not say yet. One
 *  that does keeps what it says: it is someone's, and stays theirs. */
export function stampOwnership(doc: LoroDoc, ownership: () => Ownership): void {
  const meta = doc.getMap(META);
  if (typeof meta.get("workspaceId") === "string") return;
  const { workspaceId, owner, workspacePublicKey } = ownership();
  meta.set("workspaceId", workspaceId);
  meta.set("owner", owner);
  meta.set("workspacePublicKey", workspacePublicKey);
}

/** The parts of a workspace's layout: the core layout, the board, one view's layout. */
export type LayoutPart = "core" | "board" | `view:${string}`;

/** A part that changed; for the board, the ids of the objects that did, when they are known. */
export interface PartChanged {
  part: LayoutPart;
  objects?: string[];
}

/** The parts that changed in `doc` since `before`, by the root container each change lies under:
 *  read from the changes alone (their operations, not a diff of the states), so it costs what
 *  changed, whatever the document's size. */
export function partsChanged(doc: LoroDoc, before: Frontiers): PartChanged[] {
  const every = (): PartChanged[] => [{ part: "core" }, { part: "board" }, ...[...doc.getMap(VIEWS).keys()].map((viewId) => ({ part: `view:${viewId}` as const }))];
  let changes: ReturnType<LoroDoc["exportJsonUpdates"]>["changes"];
  try {
    // From before the history a shallow document keeps, its changes show only the last one made.
    if (doc.isShallow() && !((doc.frontiersToVV(before).compare(doc.shallowSinceVV()) ?? -1) >= 0)) return every();
    changes = doc.exportJsonUpdates(doc.frontiersToVV(before), doc.oplogVersion(), false).changes;
  } catch (e) {
    if (!doc.isShallow()) throw e;
    return every();
  }
  const parts = new Set<LayoutPart>();
  const objects = new Set<string>();
  const paths = new Map<string, ReturnType<LoroDoc["getPathToContainer"]>>();
  for (const { ops } of changes) {
    for (const { container, content } of ops) {
      if (!paths.has(container)) paths.set(container, doc.getPathToContainer(container as ContainerID));
      // A container taken away since has no path: what was in it shows nowhere.
      const [root, key] = paths.get(container) ?? [];
      if (root === undefined) continue;
      const entry = key ?? (content as { key?: string }).key;
      if (root === OBJECTS) {
        parts.add("board");
        if (entry !== undefined) objects.add(String(entry));
      } else if (root !== VIEWS) parts.add("core");
      else if (entry !== undefined) parts.add(`view:${entry}`);
    }
  }
  return [...parts].map((part) => (part === "board" ? { part, objects: [...objects].sort() } : { part }));
}
