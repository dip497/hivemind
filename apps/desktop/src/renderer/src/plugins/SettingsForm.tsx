import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { fitValue, type SettingField, type SettingValue } from "@hivemind/core/plugin-settings";

/** A plugin's settings, drawn from the fields it declares: the same controls for every kind, on a
 *  widget's box and on its Settings page. Each change is handed on at once, fitted to its field. A
 *  secret (a tool plugin's) is typed into a masked field that is always empty: it is handed to
 *  `onSecret` and never shown again, only whether one is set (`secrets`). */
export function SettingsForm({ fields, values, onChange, compact, secrets, onSecret }: {
  fields: readonly SettingField[]; values: Record<string, unknown>; onChange: (field: string, value: SettingValue) => void; compact?: boolean;
  secrets?: Record<string, boolean>; onSecret?: (field: string, value: string | null) => void;
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
          {f.type === "secret"
            ? <SecretInput set={!!secrets?.[f.id]} compact={compact} onSave={(v) => onSecret?.(f.id, v)} />
            : f.type === "boolean"
            ? <Switch checked={values[f.id] === true} onCheckedChange={(on) => set(f, on)} />
            : f.type === "choice"
            ? <Select value={String(values[f.id] ?? f.default)} onValueChange={(v) => set(f, v)}>
                <SelectTrigger size={compact ? "sm" : "default"}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {f.values.map((v, i) => <SelectItem key={v} value={v}>{f.labels?.[i] ?? v}</SelectItem>)}
                </SelectContent>
              </Select>
            : <Input type={f.type === "number" ? "number" : "text"} size={compact ? "sm" : "default"} className="w-28"
                key={String(values[f.id] ?? "")} defaultValue={String(values[f.id] ?? "")}
                {...(f.type === "number" ? { min: f.min, max: f.max } : { maxLength: f.maxLength })}
                onBlur={(e) => set(f, f.type === "number" ? Number(e.target.value) : e.target.value)} />}
        </label>
      ))}
    </form>
  );
}

/** A secret's field: masked, never filled, saved on Enter or on leaving it; "Clear" takes it away. */
function SecretInput({ set, compact, onSave }: { set: boolean; compact?: boolean; onSave: (value: string | null) => void }) {
  const [typed, setTyped] = useState("");
  const save = () => { if (typed) { onSave(typed); setTyped(""); } };
  return (
    <span className="flex items-center gap-1.5" data-secret={set ? "set" : "not set"}>
      <span className="text-label text-[var(--color-fg3)]">{set ? "set" : "not set"}</span>
      <Input type="password" autoComplete="off" spellCheck={false} size={compact ? "sm" : "default"} className="w-36"
        placeholder={set ? "type to replace" : "type to set"} value={typed} onChange={(e) => setTyped(e.target.value)}
        onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
      {set && <Button type="button" variant="ghost-destructive" size="xs" onClick={() => onSave(null)}>Clear</Button>}
    </span>
  );
}
