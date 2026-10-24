/**
 * What a plugin can be set to: the fields its manifest declares (a view's `settings` in
 * hivemind-view.json, a widget's `options`): a boolean, a number (typed, or on a slider), a text, a
 * choice, a colour, several choices, or a list of texts, each in an optional section and shown only
 * when another field has a given value (`showIf`). The
 * app draws every plugin's settings from these the same way and checks every stored value against
 * its field, so a plugin never draws its own settings screen. Pure: the app, the CLI and a
 * plugin's own build share it.
 */

export type SettingValue = string | number | boolean | string[];

/** Show a field only while another one, declared before it, has this value. */
export interface ShowIf { field: string; equals: string | number | boolean }
interface FieldBase {
  id: string;
  label: string;
  description?: string;
  /** The heading it is drawn under; fields of one section are drawn together, in order. */
  section?: string;
  showIf?: ShowIf;
}
/** One thing a plugin can be set to. */
export type SettingField =
  | (FieldBase & { type: "boolean"; default: boolean })
  /** `slider`: drawn as a slider, which needs `min` and `max`; `step`: the values it moves by. */
  | (FieldBase & { type: "number"; default: number; min?: number; max?: number; step?: number; slider?: boolean })
  | (FieldBase & { type: "text"; default: string; maxLength?: number })
  | (FieldBase & { type: "choice"; values: string[]; labels?: string[]; default: string })
  /** `#rrggbb`, or "" for "as the theme has it": the plugin falls back to its own default then. */
  | (FieldBase & { type: "color"; default: string })
  /** Any of `values`, in their declared order. */
  | (FieldBase & { type: "multi"; values: string[]; labels?: string[]; default: string[] })
  /** Texts the person adds, removes and orders, each one line. */
  | (FieldBase & { type: "list"; default: string[]; maxItems: number; maxLength: number });

// No dot: a field is also a step of a dotted settings path (`plugins.state.agent:claude.options.model`).
export const FIELD_ID = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_FIELDS = 30;
export const MAX_TEXT = 2000;
/** The longest a `list` may be, and the longest of its texts by default. */
export const MAX_LIST = 50;
const LIST_TEXT = 200;
const HEX = /^#[0-9a-f]{6}$/;
/** A colour as a `color` field keeps it: `#rrggbb` in lower case, or "" for the theme's. */
const colourOf = (v: unknown): string | undefined => {
  if (v === "") return "";
  if (typeof v !== "string") return undefined;
  const c = v.trim().toLowerCase();
  return HEX.test(c) ? c : /^#[0-9a-f]{3}$/.test(c) ? `#${[...c.slice(1)].map((x) => x + x).join("")}` : undefined;
};
/** Choices a field offers, each 1–60 characters, at most 40, and the labels that go with them. */
const choicesOf = (r: Record<string, unknown>): { values: string[]; labels?: string[] } | null => {
  if (!Array.isArray(r.values)) return null;
  const values = [...new Set(r.values.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 60))].slice(0, 40);
  if (!values.length) return null;
  const labels = Array.isArray(r.labels) && r.labels.length === values.length && r.labels.every((l) => typeof l === "string") ? (r.labels as string[]).map((l) => l.slice(0, 60)) : undefined;
  return { values, ...(labels ? { labels } : {}) };
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** The fields a manifest declares, each checked; a malformed one is left out, not the plugin. */
export function parseSettingFields(raw: unknown): SettingField[] {
  return checkSettingFields(raw).fields;
}

/** The fields kept, and the position of each one left out (malformed, a repeated id, past the
 *  limit), so a manifest check can name it. */
export function checkSettingFields(raw: unknown): { fields: SettingField[]; refused: number[] } {
  const fields: SettingField[] = [];
  const refused: number[] = [];
  if (!Array.isArray(raw)) return { fields, refused };
  const seen = new Set<string>();
  raw.forEach((r: unknown, i) => {
    const base = i < MAX_FIELDS && isObj(r) && typeof r.id === "string" && FIELD_ID.test(r.id) && !seen.has(r.id) ? baseOf(r, fields) : null;
    const field = base ? fieldOf(r as Record<string, unknown>, base) : null;
    if (!field) { refused.push(i); return; }
    seen.add(field.id);
    fields.push(field);
  });
  return { fields, refused };
}

/** What every field has, or null when its `showIf` names no field before it, or a value that
 *  field can never have. */
function baseOf(r: Record<string, unknown>, before: readonly SettingField[]): FieldBase | null {
  const base: FieldBase = { id: r.id as string, label: short(r.label, 80) ?? (r.id as string) };
  const description = short(r.description, 300), section = short(r.section, 60);
  if (description) base.description = description;
  if (section) base.section = section;
  if (r.showIf !== undefined) {
    const c = r.showIf;
    if (!isObj(c) || typeof c.field !== "string" || !["string", "number", "boolean"].includes(typeof c.equals)) return null;
    const on = before.find((f) => f.id === c.field);
    const equals = c.equals as string | number | boolean;
    if (!on || on.type === "multi" || on.type === "list" || fitValue(on, equals) !== equals) return null;
    base.showIf = { field: c.field, equals };
  }
  return base;
}

function fieldOf(r: Record<string, unknown>, base: FieldBase): SettingField | null {
  switch (r.type) {
    case "boolean":
      return r.default === undefined || typeof r.default === "boolean" ? { ...base, type: "boolean", default: (r.default as boolean | undefined) ?? false } : null;
    case "number": {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const min = n(r.min), max = n(r.max);
      if (r.default !== undefined && n(r.default) === undefined) return null;
      if (min !== undefined && max !== undefined && min > max) return null;
      const step = n(r.step);
      if (step !== undefined && step <= 0) return null;
      // A slider needs both ends to slide between.
      if (r.slider === true && (min === undefined || max === undefined)) return null;
      const def = clampNumber(n(r.default) ?? min ?? 0, min, max);
      return { ...base, type: "number", default: def, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}), ...(r.slider === true ? { slider: true } : {}) };
    }
    case "text": {
      if (r.default !== undefined && typeof r.default !== "string") return null;
      const maxLength = typeof r.maxLength === "number" && r.maxLength > 0 ? Math.min(Math.floor(r.maxLength), MAX_TEXT) : MAX_TEXT;
      return { ...base, type: "text", default: ((r.default as string | undefined) ?? "").slice(0, maxLength), maxLength };
    }
    case "choice": {
      const c = choicesOf(r);
      if (!c) return null;
      const def = typeof r.default === "string" && c.values.includes(r.default) ? r.default : c.values[0]!;
      return { ...base, type: "choice", ...c, default: def };
    }
    case "color": {
      const def = r.default === undefined ? "" : colourOf(r.default);
      return def === undefined ? null : { ...base, type: "color", default: def };
    }
    case "multi": {
      const c = choicesOf(r);
      if (!c) return null;
      if (r.default !== undefined && !Array.isArray(r.default)) return null;
      const def = c.values.filter((v) => (r.default as unknown[] | undefined)?.includes(v));
      return { ...base, type: "multi", ...c, default: def };
    }
    case "list": {
      const size = (v: unknown, most: number) => (typeof v === "number" && v >= 1 ? Math.min(Math.floor(v), most) : most);
      const maxItems = size(r.maxItems, MAX_LIST), maxLength = size(r.maxLength, LIST_TEXT);
      if (r.default !== undefined && !Array.isArray(r.default)) return null;
      const def = listOf(r.default ?? [], maxItems, maxLength);
      return def === undefined ? null : { ...base, type: "list", default: def, maxItems, maxLength };
    }
    default:
      return null;
  }
}

const clampNumber = (v: number, min?: number, max?: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
/** Texts as a `list` keeps them: one line each, cut to `maxLength`, blanks dropped, at most
 *  `maxItems`; undefined when it is not a list of texts. */
function listOf(v: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
  return (v as string[]).map((x) => x.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}

/** `value` as `field` takes it, or undefined when it does not fit. */
export function fitValue(field: SettingField, value: unknown): SettingValue | undefined {
  switch (field.type) {
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) ? clampNumber(value, field.min, field.max) : undefined;
    case "text": return typeof value === "string" ? value.slice(0, field.maxLength ?? MAX_TEXT) : undefined;
    case "choice": return typeof value === "string" && field.values.includes(value) ? value : undefined;
    case "color": return colourOf(value);
    // A choice an older version had is dropped, the rest kept, in the order the field declares.
    case "multi": return Array.isArray(value) && value.every((v) => typeof v === "string") ? field.values.filter((v) => value.includes(v)) : undefined;
    case "list": return listOf(value, field.maxItems, field.maxLength);
  }
}

/** Whether `field` is shown, given every field's value now: its `showIf` holds, and so does the
 *  `showIf` of the field that one names. */
export function isFieldShown(field: SettingField, fields: readonly SettingField[], values: Record<string, unknown>): boolean {
  for (let f: SettingField | undefined = field, n = 0; f?.showIf && n < MAX_FIELDS; n++) {
    const c: ShowIf = f.showIf;
    const on = fields.find((x) => x.id === c.field);
    if (!on || (fitValue(on, values[on.id]) ?? on.default) !== c.equals) return false;
    f = on;
  }
  return true;
}

/** Every declared field's value: what is stored when it fits, else the field's default. */
export function resolveSettings(fields: readonly SettingField[], stored: Record<string, unknown> | undefined): Record<string, SettingValue> {
  return Object.fromEntries(fields.map((f) => [f.id, fitValue(f, stored?.[f.id]) ?? f.default]));
}

/** A value typed at a command line (`true`, `25`, `opus`, `#1d4ed8`, `a,b`, or a JSON list
 *  `["one", "two, with a comma"]`) as `field` takes it; throws why not. */
export function parseSettingValue(field: SettingField, text: string): SettingValue {
  const several = (t: string): unknown => {
    if (t.trim().startsWith("[")) { try { return JSON.parse(t); } catch { return t; } }
    return t.trim() ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  };
  const raw = field.type === "boolean" ? (text === "true" ? true : text === "false" ? false : text)
    : field.type === "number" ? Number(text)
    : field.type === "color" ? (text === "theme" ? "" : text)
    : field.type === "multi" || field.type === "list" ? several(text) : text;
  // Typed, a choice that is not one is a mistake to name, not one to drop.
  const unknown = field.type === "multi" && Array.isArray(raw) && raw.some((x) => !field.values.includes(x as string));
  const v = unknown ? undefined : fitValue(field, raw);
  if (v === undefined) {
    throw new Error(field.type === "choice" ? `${field.id} is one of: ${field.values.join(", ")}`
      : field.type === "multi" ? `${field.id} is any of: ${field.values.join(", ")}, separated by commas`
      : field.type === "boolean" ? `${field.id} is true or false`
      : field.type === "color" ? `${field.id} is a colour like #1d4ed8, or theme for the theme's own`
      : field.type === "list" ? `${field.id} is texts separated by commas, or a JSON list of texts`
      : `${field.id} is a ${field.type}`);
  }
  return v;
}
