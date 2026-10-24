/**
 * Settings ▸ Appearance: the themes installed packages hold, next to the presets. Each shows five
 * colours, as a preset does, and Apply; the theme in use says so, with Revert to previous look, a
 * newer version installed ("Harbour 1.2 is installed; you have 1.1 applied. Apply 1.2"), or that
 * its package was removed (the look stays). Applying and reverting are main's (`themes-ipc.ts`,
 * through `@hivemind/core/theme-apply`, as `hive theme` does); the result comes back in the
 * settings broadcast, so this only asks and lists.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import { useSettings } from "./settings-store";
import type { ThemesInfo } from "../../shared/ipc";

export function ThemeList() {
  const record = useSettings().appearanceExtra.theme;
  const [info, setInfo] = useState<ThemesInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const api = window.hive?.themes;
  const load = useCallback(() => { void api?.list().then(setInfo, () => setInfo({ themes: [], status: null })); }, [api]);
  // Again when the applied theme changes: whether an update is pending is read against it.
  useEffect(load, [load, record?.id, record?.version]);
  if (!api) return null;

  const run = async (what: Promise<void>, failed: string) => {
    setBusy(true);
    try { await what; } catch (e) { toast.error(`${failed}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); load(); }
  };
  const apply = (id: string) => run(api.apply(id), "Could not apply the theme");
  const status = info?.status ?? null;
  const update = record && status?.update ? info!.themes.find((x) => x.id === record.id) : undefined;

  return (
    <div className="settings-row" data-themes>
      <div>
        <label>Themes</label>
        <p>{info && !info.themes.length && !record ? "None installed. A package from HiveHub can hold themes." : "From the packages you installed."}</p>
      </div>
      <div className="settings-stack">
        {record && (
          <div className="settings-inline" data-theme-applied={record.id}>
            <span className="settings-note">
              Using {record.name} {record.version}{status?.removed ? " (its package was removed)" : ""}
            </span>
            <Button variant="outline" disabled={busy} onClick={() => void run(api.revert(), "Could not go back")} data-theme-revert>Revert to previous look</Button>
          </div>
        )}
        {update && (
          <p className="settings-note" data-theme-update>
            {record!.name} {status!.update} is installed; you have {record!.version} applied.{" "}
            <Button variant="link" size="xs" disabled={busy} onClick={() => void apply(update.id)}>Apply {status!.update}</Button>
          </p>
        )}
        {info?.themes.map((t) => {
          const using = record?.id === t.id;
          return (
            <div key={t.id} className="settings-inline" data-theme-option={t.id}>
              <span className="settings-swatches" aria-hidden>
                {t.swatches.map((c, i) => <span key={i} className="settings-swatch" style={{ background: c }} />)}
              </span>
              <span className="min-w-32">{t.name}<span className="settings-note"> · {t.package.name} {t.package.version}{t.mode === "light" ? " · light" : ""}</span></span>
              <Button variant={using ? "secondary" : "outline"} disabled={busy || (using && !status?.update)} onClick={() => void apply(t.id)} aria-label={`Apply ${t.name}`}>
                {using ? (status?.update ? `Apply ${t.package.version}` : "In use") : "Apply"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
