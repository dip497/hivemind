import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { fitValue, type SettingField, type SettingValue } from "@hivemind/core/plugin-settings";
import { isFieldShown } from "@hivemind/view-sdk/settings";
import { cssColorToHexString } from "../workspace/css-color";

/** A plugin's settings, drawn from the fields it declares: the same controls for every kind, on a
 *  widget's box and on its Settings page. Fields are drawn in their sections, in the order they are
 *  declared; one whose `showIf` does not hold is left out. Each change is handed on at once,
 *  fitted to its field. */
export function SettingsForm({ fields, values, onChange, compact }: {
  fields: readonly SettingField[]; values: Record<string, unknown>; onChange: (field: string, value: SettingValue) => void; compact?: boolean;
}) {
  const set = (f: SettingField, raw: unknown) => {
    const v = fitValue(f, raw);
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(values[f.id])) onChange(f.id, v);
  };
  const shown = fields.filter((f) => isFieldShown(f, fields, values));
  // Each section once, where its first field is; fields without one come first, under no heading.
  const sections = [...new Set(shown.map((f) => f.section ?? ""))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
  return (
    <form className={`flex flex-col ${compact ? "gap-2 pr-12 text-label" : "gap-3 text-body"}`} onSubmit={(e) => e.preventDefault()} data-settings-form>
      {sections.map((section) => (
        <fieldset key={section || "-"} className={`flex flex-col ${compact ? "gap-2" : "gap-3"}`} data-settings-section={section || undefined}>
          {section && <legend className={`${compact ? "mb-1" : "mb-1.5"} text-count font-medium uppercase tracking-wide text-[var(--color-fg3)]`}>{section}</legend>}
          {shown.filter((f) => (f.section ?? "") === section).map((f) => (
            <Row key={f.id} field={f} compact={compact} wide={f.type === "list" || f.type === "multi"}>
              <Control field={f} value={values[f.id]} compact={compact} set={(v) => set(f, v)} />
            </Row>
          ))}
        </fieldset>
      ))}
    </form>
  );
}

function Row({ field, compact, wide, children }: { field: SettingField; compact?: boolean; wide?: boolean; children: React.ReactNode }) {
  // A row of choice buttons is not a label's: a click on the name would press the first choice.
  const Box = field.type === "multi" ? "div" : "label";
  return (
    <Box className={`flex gap-2 ${wide ? "flex-col" : "items-center justify-between"}`} title={field.description} data-setting={field.id}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[var(--color-fg2)]">{field.label}</span>
        {!compact && field.description && <span className="text-label text-[var(--color-fg3)]">{field.description}</span>}
      </span>
      {children}
    </Box>
  );
}

function Control({ field: f, value, compact, set }: { field: SettingField; value: unknown; compact?: boolean; set: (v: unknown) => void }) {
  const size = compact ? "sm" : "default";
  switch (f.type) {
    case "boolean":
      return <Switch checked={value === true} onCheckedChange={(on) => set(on)} />;
    case "choice":
      return (
        <Select value={String(value ?? f.default)} onValueChange={(v) => set(v)}>
          <SelectTrigger size={size}><SelectValue /></SelectTrigger>
          <SelectContent>
            {f.values.map((v, i) => <SelectItem key={v} value={v}>{f.labels?.[i] ?? v}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    case "number":
      return f.slider
        ? <span className="flex items-center gap-2">
            <input type="range" className="w-32 accent-[var(--color-accent)]" min={f.min} max={f.max} step={f.step ?? "any"}
              value={Number(value ?? f.default)} onChange={(e) => set(Number(e.target.value))} aria-label={f.label} data-slider />
            <span className="w-10 text-right tabular-nums text-[var(--color-fg2)]">{String(value ?? f.default)}</span>
          </span>
        : <Input type="number" size={size} className="w-28" key={String(value ?? "")} defaultValue={String(value ?? "")}
            min={f.min} max={f.max} step={f.step}
            onBlur={(e) => set(Number(e.target.value))} />;
    case "text":
      return <Input type="text" size={size} className="w-28" key={String(value ?? "")} defaultValue={String(value ?? "")}
        maxLength={f.maxLength} onBlur={(e) => set(e.target.value)} />;
    case "color": {
      // "" is "as the theme has it": the picker starts from the theme's text colour, the box says
      // "theme", and Theme puts it back.
      const hex = typeof value === "string" ? value : f.default;
      const start = hex || cssColorToHexString(getComputedStyle(document.documentElement).getPropertyValue("--color-fg").trim());
      return (
        <span className="flex items-center gap-1.5">
          <input type="color" className="size-7 cursor-pointer rounded-md border border-[var(--color-line)] bg-transparent p-0.5"
            value={start} onChange={(e) => set(e.target.value)} aria-label={f.label} data-color />
          <Input type="text" size={size} className="w-24 font-mono" key={hex} defaultValue={hex} placeholder="theme"
            onBlur={(e) => set(e.target.value.trim())} />
          {hex !== "" && <Button type="button" variant="ghost" size="sm" onClick={() => set("")} title="Use the theme's own colour">Theme</Button>}
        </span>
      );
    }
    case "multi": {
      const on = Array.isArray(value) ? (value as string[]) : f.default;
      return (
        <span className="flex flex-wrap gap-1" role="group" aria-label={f.label}>
          {f.values.map((v, i) => {
            const pressed = on.includes(v);
            return (
              <Button key={v} type="button" size="sm" variant={pressed ? "secondary" : "ghost"} aria-pressed={pressed} data-choice={v}
                onClick={() => set(pressed ? on.filter((x) => x !== v) : [...on, v])}>
                {f.labels?.[i] ?? v}
              </Button>
            );
          })}
        </span>
      );
    }
    case "list": {
      const items = Array.isArray(value) ? (value as string[]) : f.default;
      return (
        <Textarea key={items.join("\n")} defaultValue={items.join("\n")} rows={Math.min(Math.max(items.length + 1, 2), 8)}
          placeholder="One on each line" aria-label={f.label} data-list
          onBlur={(e) => set(e.target.value.split("\n"))} />
      );
    }
  }
}
