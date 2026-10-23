import { ProfilePrefs } from "./settings-profile";
import { ConnectPrefs } from "./settings-connect";
import { ServersPrefs } from "./settings-network";
import { BrowserPrefs } from "./settings-browser";
import { ApiAccessPrefs } from "./settings-programs";
import { PluginPage } from "./plugins/PluginPage";
import { PluginsHome } from "./plugins/PluginsHome";
/**
 * Settings pages that read and write settings.json (via settings-store /
 * theme-store): Appearance, Views (installed community packages, per-view
 * chrome), Agents and Shortcuts.
 *
 * Presentation rule for this file: plain setting ROWS — a label, a one-line
 * explanation, one control on the right — with rare or bulky choices behind a
 * disclosure. No cards, no marketing copy, no animation. Appearance is the ONE
 * destination for the theme; its controls live in appearance-controls.tsx, so
 * each one has a single implementation over the same `useTheme` / `setTheme`.
 */
import { useRef, useState } from "react";
import { ChevronDown } from "./components/icons";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { getSettings, patchSettings } from "./settings-store";
import { setTheme, useTheme } from "./theme-store";
import {
  AccentPicker, BackgroundControls, GlassControls, OverlayControls, PresetRow, Section, ShapeAndTypeControls, TerminalColors,
} from "./appearance-controls";
import { createContext, Fragment, useContext } from "react";
import { pluginPage } from "./settings-registry";
import { doesWhat, KEYMAP, keysLabel, reachesApp, type KeyOS, type Where } from "../../shared/keymap";
import { keyOS } from "./shortcut";

// ── Appearance ──────────────────────────────────────────────────────────────
// Everyday choices first (theme, accent, background, glass, how tools look in a
// scene), then overlays, then the rarely-touched editors. The disclosures are
// not decoration: they keep twenty colour wells and their listeners out of the
// tree until someone asks for them.

function AppearancePrefs() {
  const t = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);

  const exportTheme = async () => {
    const json = JSON.stringify(getSettings().appearance, null, 2);
    try { await navigator.clipboard.writeText(json); toast.success("Theme copied as JSON."); }
    catch { toast.error("Could not reach the clipboard. Use `hive theme export <file>`."); }
  };
  const importTheme = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const raw: unknown = JSON.parse(await f.text());
      // Accept either a whole settings.json or a bare appearance object.
      const a = raw && typeof raw === "object" && "appearance" in (raw as Record<string, unknown>) ? (raw as { appearance: unknown }).appearance : raw;
      patchSettings("appearance", a); // main + mergeAppearance validate it
      toast.success(`Imported ${f.name}`);
    } catch { toast.error("That file is not a hivemind theme."); }
  };

  return (
    <div className="settings-stack">
      <Section title="Theme">
        <PresetRow t={t} />
        <AccentPicker t={t} />
        <ShapeAndTypeControls t={t} />
      </Section>

      <Section title="Workspace">
        <BackgroundControls t={t} />
        <GlassControls t={t} />
        <div className="settings-row">
          <div>
            <label htmlFor="plugin-surfaces">Tools in scene views</label>
            <p>How terminals and editors look inside a view you installed.</p>
          </div>
          <Select value={t.pluginSurfaces} onValueChange={(v) => setTheme({ pluginSurfaces: v as "theme" | "opaque" })}>
            <SelectTrigger id="plugin-surfaces" className="min-w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="theme">Use my theme</SelectItem>
              <SelectItem value="opaque">Opaque</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <OverlayControls t={t} />
      </Section>

      <Section title="Advanced">
        <details className="settings-disclosure" onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Terminal colours <ChevronDown size={14} /></summary>
          {advanced && <TerminalColors t={t} />}
        </details>
        <div className="settings-row">
          <div><label>Theme file</label></div>
          <div className="settings-inline">
            <Button type="button" variant="outline" onClick={() => void exportTheme()}>Copy JSON</Button>
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>Import…</Button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void importTheme(e)} />
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Shortcuts (read-only) ───────────────────────────────────────────────────

const SHORTCUT_PLACES: Array<[Where, string, string]> = [
  ["anywhere", "Anywhere", "Work even while a terminal has focus — everything else goes to the terminal"],
  ["canvas", "On the canvas", "When no terminal or field has focus"],
  ["terminal", "In a terminal", "Every other key goes to the program"],
];

/** The keymap's rows for one place as this platform writes them (shared/keymap.ts), one row per
 *  action: `tile:1` … `tile:9` are one, and actions on the same keys are one, in the order tried.
 *  A key the system takes here (Super on Windows and Linux) is left out. */
function shortcutRows(where: Where, os: KeyOS): Array<{ keys: string[]; does: string }> {
  const byAction = new Map<string, { keys: string[]; does: string }>();
  for (const b of KEYMAP) {
    if (b.where !== where || !reachesApp(b.keys, os)) continue;
    const id = b.action.startsWith("tile:") ? "tile" : b.action;
    const row = byAction.get(id) ?? { keys: [], does: doesWhat(b.action) };
    byAction.set(id, row);
    const label = keysLabel(b.keys, os);
    if (!row.keys.includes(label)) row.keys.push(label);
  }
  const rows: Array<{ keys: string[]; does: string }> = [];
  for (const [id, row] of byAction) {
    if (id === "tile") row.keys = [`${row.keys[0]} … ${row.keys.at(-1)}`];
    const same = rows.find((r) => r.keys.join("\n") === row.keys.join("\n"));
    if (same) same.does += `, or ${row.does[0]!.toLowerCase()}${row.does.slice(1)}`;
    else rows.push(row);
  }
  return rows;
}

function ShortcutPrefs() {
  const os = keyOS();
  return (
    <div className="settings-stack">
      {SHORTCUT_PLACES.map(([where, title, hint]) => (
        <Section key={where} title={title} hint={hint}>
          <dl className="settings-shortcuts">
            {shortcutRows(where, os).map((r) => (
              <div className="settings-shortcut" key={r.keys.join(" ")}>
                <dt>{r.keys.map((k, i) => <Fragment key={k}>{i > 0 && " "}<kbd>{k}</kbd></Fragment>)}</dt>
                <dd>{r.does}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}
    </div>
  );
}

/** The lazy half of the Settings dialog — one chunk, loaded when it opens
 *  (App.tsx keeps only the cheap pages, so the entry bundle does not grow). */
const NavigateContext = createContext<(id: string) => void>(() => {});
export const useSettingsNavigate = (): ((id: string) => void) => useContext(NavigateContext);

/** Must match the registry's `chunk: "lazy"` pages (unit tested); plugin pages (`agent:…`) are always lazy. */
export const LAZY_SETTINGS_PAGES = ["profile", "appearance", "shortcuts", "connect", "api", "plugins", "browser", "servers"] as const;

export default function SettingsPages({ page, navigate }: { page: string; navigate: (id: string) => void }) {
  return <NavigateContext.Provider value={navigate}>{renderPage(page)}</NavigateContext.Provider>;
}

function renderPage(page: string) {
  if (page === "profile") return <ProfilePrefs />;
  if (page === "connect") return <ConnectPrefs />;
  if (page === "browser") return <BrowserPrefs />;
  if (page === "api") return <ApiAccessPrefs />;
  if (page === "servers") return <ServersPrefs />;
  if (page === "appearance") return <AppearancePrefs />;
  if (page === "shortcuts") return <ShortcutPrefs />;
  if (page === "plugins") return <PluginsHome />;
  // Every kind's page is one component: pp?.kind === "agent" | "view" | "widget" | "tool".
  const pp = pluginPage(page);
  if (pp) return <PluginPage key={page} kind={pp.kind} id={pp.pluginId} />;
  return null;
}
