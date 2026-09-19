/**
 * The standard toolbar's action catalog — metadata only.
 *
 * This is HOST PRESENTATION, not tool registration: an entry here says "the
 * toolbar can offer this action, under this label, with this hotkey hint", and
 * nothing else. It grants no capability, gates no tile kind and decides no
 * availability — whether an action can actually run is the renderer's question
 * (and, for a managed tile kind, `tool-plugins.tileKindAvailability`'s answer).
 * Keeping the two apart is the point: a user reordering their toolbar must not
 * be able to enable a tool, and enabling a tool must not silently rearrange
 * anyone's toolbar.
 *
 * No I/O, no renderer imports, no dependency on settings-schema (which imports
 * THIS module for its validation, so the edge stays one-way).
 */

export type ToolbarActionId =
  | "terminal" | "agent" | "explorer" | "diff" | "issues" | "frame" | "browser" | "theme";

export interface ToolbarAction {
  readonly id: ToolbarActionId;
  readonly label: string;
  /** The hotkey hint the toolbar prints on the button (the number-row keys). */
  readonly hint: string;
}

/** The catalog, in the order a toolbar shows them when the user has no
 *  preference. Frozen: callers hand this straight to a renderer. */
export const BUILTIN_TOOLBAR_ACTIONS: readonly ToolbarAction[] = Object.freeze([
  Object.freeze({ id: "terminal", label: "Terminal", hint: "1" }),
  Object.freeze({ id: "agent", label: "Agent", hint: "2" }),
  Object.freeze({ id: "explorer", label: "Explorer", hint: "3" }),
  Object.freeze({ id: "diff", label: "Diff", hint: "4" }),
  Object.freeze({ id: "issues", label: "Issues", hint: "5" }),
  Object.freeze({ id: "frame", label: "Frame", hint: "6" }),
  Object.freeze({ id: "browser", label: "Browser", hint: "7" }),
  Object.freeze({ id: "theme", label: "Theme", hint: "8" }),
] as const);

/** The default order as bare ids. */
export const DEFAULT_TOOLBAR_ORDER: readonly ToolbarActionId[] =
  Object.freeze(BUILTIN_TOOLBAR_ACTIONS.map((a) => a.id));

const BY_ID: ReadonlyMap<ToolbarActionId, ToolbarAction> =
  new Map(BUILTIN_TOOLBAR_ACTIONS.map((a) => [a.id, a]));

export function isToolbarActionId(value: unknown): value is ToolbarActionId {
  return typeof value === "string" && BY_ID.has(value as ToolbarActionId);
}

export function toolbarAction(id: ToolbarActionId): ToolbarAction | undefined {
  return BY_ID.get(id);
}

/** One view's toolbar preferences — the canonical stored shape, one entry per
 *  view under the single settings key `views.toolbars`. */
export interface ToolbarPreferences {
  /** Which actions, in which order. UNDEFINED = the catalog defaults; an EMPTY
   *  array is a deliberate "no actions", not a missing value. */
  actions?: ToolbarActionId[];
  /** Show text labels beside the icons. UNDEFINED = the host default, which is
   *  FALSE: the toolbar has always been icon-only, and a stored preference is
   *  the only thing that turns labels on. Callers read `prefs?.labels ?? false`. */
  labels?: boolean;
}

/**
 * The ordered metadata a toolbar should render — `resolveToolbar(p).map(...)`.
 *
 * - no preferences, or `actions` undefined → the catalog in its default order
 *   (`BUILTIN_TOOLBAR_ACTIONS` itself, so the common case allocates nothing).
 * - `actions: []` → empty. Deliberately empty is a valid toolbar; the keyboard
 *   shortcuts and the island's other affordances are unaffected.
 * - `actions: [...]` → exactly those, in the given order, duplicates collapsed
 *   and unknown ids dropped. A list that names ONLY unknown ids resolves to
 *   empty, never to the defaults: the user did express a preference, and
 *   silently restoring eight buttons would be a worse answer than none.
 *
 * `labels` is not part of this result — it is a render flag the caller reads
 * from the same preferences object (`prefs?.labels ?? false`, the icon-only
 * default the toolbar has always had), so this stays one value: ordered
 * metadata, granting nothing.
 */
export function resolveToolbar(preferences?: ToolbarPreferences | null): readonly ToolbarAction[] {
  const ids = preferences?.actions;
  if (!Array.isArray(ids)) return BUILTIN_TOOLBAR_ACTIONS;
  const seen = new Set<ToolbarActionId>();
  const actions: ToolbarAction[] = [];
  for (const id of ids) {
    if (!isToolbarActionId(id) || seen.has(id)) continue;
    seen.add(id);
    actions.push(BY_ID.get(id)!);
  }
  return Object.freeze(actions);
}
