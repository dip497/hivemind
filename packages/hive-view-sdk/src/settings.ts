/**
 * What a plugin can be set to: the fields its manifest declares (a view's `settings` in
 * hivemind-view.json, a widget's `options`), each a boolean, a number, a text or a choice. The
 * app draws every plugin's settings from these the same way and checks every stored value against
 * its field, so a plugin never draws its own settings screen. Pure: the app, the CLI and a
 * plugin's own build share it.
 */

export type SettingValue = string | number | boolean;

interface FieldBase {
  id: string;
  label: string;
  description?: string;
}
/** One thing a plugin can be set to. */
export type SettingField =
  | (FieldBase & { type: "boolean"; default: boolean })
  | (FieldBase & { type: "number"; default: number; min?: number; max?: number })
  | (FieldBase & { type: "text"; default: string; maxLength?: number })
  | (FieldBase & { type: "choice"; values: string[]; labels?: string[]; default: string });

// No dot: a field is also a step of a dotted settings path (`plugins.state.agent:claude.options.model`).
export const FIELD_ID = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_FIELDS = 30;
export const MAX_TEXT = 2000;
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
    const field = i < MAX_FIELDS && isObj(r) && typeof r.id === "string" && FIELD_ID.test(r.id) && !seen.has(r.id)
      ? fieldOf(r, { id: r.id, label: short(r.label, 80) ?? r.id, ...(short(r.description, 300) ? { description: short(r.description, 300)! } : {}) })
      : null;
    if (!field) { refused.push(i); return; }
    seen.add(field.id);
    fields.push(field);
  });
  return { fields, refused };
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
      const def = clampNumber(n(r.default) ?? min ?? 0, min, max);
      return { ...base, type: "number", default: def, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }
    case "text": {
      if (r.default !== undefined && typeof r.default !== "string") return null;
      const maxLength = typeof r.maxLength === "number" && r.maxLength > 0 ? Math.min(Math.floor(r.maxLength), MAX_TEXT) : MAX_TEXT;
      return { ...base, type: "text", default: ((r.default as string | undefined) ?? "").slice(0, maxLength), maxLength };
    }
    case "choice": {
      if (!Array.isArray(r.values)) return null;
      const values = r.values.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 60).slice(0, 40);
      if (!values.length) return null;
      const labels = Array.isArray(r.labels) && r.labels.length === values.length && r.labels.every((l) => typeof l === "string") ? (r.labels as string[]).map((l) => l.slice(0, 60)) : undefined;
      const def = typeof r.default === "string" && values.includes(r.default) ? r.default : values[0]!;
      return { ...base, type: "choice", values, ...(labels ? { labels } : {}), default: def };
    }
    default:
      return null;
  }
}

const clampNumber = (v: number, min?: number, max?: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** `value` as `field` takes it, or undefined when it does not fit. */
export function fitValue(field: SettingField, value: unknown): SettingValue | undefined {
  switch (field.type) {
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) ? clampNumber(value, field.min, field.max) : undefined;
    case "text": return typeof value === "string" ? value.slice(0, field.maxLength ?? MAX_TEXT) : undefined;
    case "choice": return typeof value === "string" && field.values.includes(value) ? value : undefined;
  }
}

/** Every declared field's value: what is stored when it fits, else the field's default. */
export function resolveSettings(fields: readonly SettingField[], stored: Record<string, unknown> | undefined): Record<string, SettingValue> {
  return Object.fromEntries(fields.map((f) => [f.id, fitValue(f, stored?.[f.id]) ?? f.default]));
}

/** A value typed at a command line (`true`, `25`, `opus`) as `field` takes it; throws why not. */
export function parseSettingValue(field: SettingField, text: string): SettingValue {
  const raw = field.type === "boolean" ? (text === "true" ? true : text === "false" ? false : text)
    : field.type === "number" ? Number(text) : text;
  const v = fitValue(field, raw);
  if (v === undefined) {
    throw new Error(field.type === "choice" ? `${field.id} is one of: ${field.values.join(", ")}`
      : field.type === "boolean" ? `${field.id} is true or false` : `${field.id} is a ${field.type}`);
  }
  return v;
}
