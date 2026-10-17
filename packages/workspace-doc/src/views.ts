/**
 * Each view's own layout in a workspace document: `views` maps a view id to { v, data }. The
 * data merges two levels deep (the canvas's `positions` per tile), so two people moving
 * different tiles both keep their move; deeper values are stored whole.
 */
import type { LoroDoc } from "loro-crdt";
import { isMap, writeFields } from "./fields.js";
import { rebaseView } from "./rebase.js";
import { VIEWS, stampSchema } from "./schema.js";
import { isViewLayout, type ViewLayout } from "./shapes.js";

const MAX_VIEW_ID = 256;
/** How deep a view's data merges: its fields, then theirs (the canvas's places, tile by tile). */
const DATA_DEPTH = 2;

/**
 * Make `doc` hold `layout` as the view `viewId`'s layout. A bad id or layout is refused. Given
 * `base`, the layout `layout` was made from (null: none was read), only what changed from it is
 * written, and the rest stays as `doc` has it now.
 */
export function writeView(doc: LoroDoc, viewId: string, layout: ViewLayout, base?: unknown): void {
  if (!isViewId(viewId)) throw new TypeError(`workspace doc: a view id is a non-empty string of at most ${MAX_VIEW_ID} characters`);
  if (!isViewLayout(layout) || (base !== undefined && base !== null && !isViewLayout(base))) throw new TypeError("workspace doc: a view layout is { v: number, data }");
  const next = base === undefined ? layout : rebaseView(base, layout, readView(doc, viewId), DATA_DEPTH);
  stampSchema(doc);
  const views = doc.getMap(VIEWS);
  if (views.get(viewId) !== undefined && !isMap(views.get(viewId))) views.delete(viewId);
  writeFields(views.ensureMergeableMap(viewId), { v: next.v, data: next.data }, DATA_DEPTH);
}

/** The view `viewId`'s layout in `doc`, or null. */
export function readView(doc: LoroDoc, viewId: string): ViewLayout | null {
  if (!isViewId(viewId)) return null;
  const view = doc.getMap(VIEWS).get(viewId);
  if (!isMap(view)) return null;
  const layout: unknown = view.toJSON();
  return isViewLayout(layout) ? layout : null;
}

/** Every view's layout in `doc`, by view id. */
export function readViews(doc: LoroDoc): Record<string, ViewLayout> {
  const views: Record<string, ViewLayout> = {};
  for (const viewId of doc.getMap(VIEWS).keys()) {
    const layout = readView(doc, viewId);
    if (layout) views[viewId] = layout;
  }
  return views;
}

function isViewId(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= MAX_VIEW_ID;
}
