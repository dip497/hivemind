import { fitValue, type SettingField, type SettingValue } from "@hivemind/core/plugin-settings";

/** A plugin's settings, drawn from the fields it declares: the same controls for every kind, on a
 *  widget's box and on its Settings page. Each change is handed on at once, fitted to its field. */
export function SettingsForm({ fields, values, onChange, compact }: {
  fields: readonly SettingField[]; values: Record<string, unknown>; onChange: (field: string, value: SettingValue) => void; compact?: boolean;
}) {
  const set = (f: SettingField, raw: unknown) => {
    const v = fitValue(f, raw);
    if (v !== undefined && v !== values[f.id]) onChange(f.id, v);
  };
  return (
    <form className={`flex flex-col ${compact ? "gap-2 pr-12 text-label" : "gap-3 text-body"}`} onSubmit={(e) => e.preventDefault()} data-settings-form>
      {fields.map((f) => (
        <label key={f.id} className="flex items-center justify-between gap-2" title={f.description} data-setting={f.id}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[var(--color-fg2)]">{f.label}</span>
            {!compact && f.description && <span className="text-label text-[var(--color-fg3)]">{f.description}</span>}
          </span>
          {f.type === "boolean"
            ? <input type="checkbox" checked={values[f.id] === true} onChange={(e) => set(f, e.target.checked)} />
            : f.type === "choice"
            ? <select className="rounded border border-[var(--color-line)] bg-[var(--color-bg2)] px-1 py-0.5" value={String(values[f.id] ?? f.default)}
                onChange={(e) => set(f, e.target.value)}>
                {f.values.map((v, i) => <option key={v} value={v}>{f.labels?.[i] ?? v}</option>)}
              </select>
            : <input type={f.type === "number" ? "number" : "text"} className="w-28 rounded border border-[var(--color-line)] bg-transparent px-1.5 py-0.5"
                key={String(values[f.id] ?? "")} defaultValue={String(values[f.id] ?? "")}
                {...(f.type === "number" ? { min: f.min, max: f.max } : { maxLength: f.maxLength })}
                onBlur={(e) => set(f, f.type === "number" ? Number(e.target.value) : e.target.value)} />}
        </label>
      ))}
    </form>
  );
}
