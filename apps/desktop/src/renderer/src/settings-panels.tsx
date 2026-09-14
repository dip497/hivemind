import { ViewsOverview, ViewPage } from "./settings-views";
import { ToolsOverview, ToolPage } from "./settings-tools";
import { BrowsePlugins, InstalledPlugins } from "./settings-plugins";
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
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { setTheme, useTheme } from "./theme-store";
import {
  AccentPicker, BackgroundControls, GlassControls, OverlayControls, PresetRow, Section, TerminalColors,
} from "./appearance-controls";
import { AgentsOverview, AgentPage } from "./settings-agents";
import { createContext, useContext } from "react";
import { pluginPage } from "./settings-registry";

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
      </Section>

      <Section title="Workspace">
        <BackgroundControls t={t} />
        <GlassControls t={t} />
        <div className="settings-row">
          <div>
            <label htmlFor="plugin-surfaces">Tools in scene views</label>
            <p>How terminals and editors look inside World and community views.</p>
          </div>
          <select
            id="plugin-surfaces"
            value={t.pluginSurfaces}
            onChange={(e) => setTheme({ pluginSurfaces: e.target.value as "theme" | "opaque" })}
          >
            <option value="theme">Use my theme</option>
            <option value="opaque">Opaque</option>
          </select>
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
            <button type="button" className="settings-button" onClick={() => void exportTheme()}>Copy JSON</button>
            <button type="button" className="settings-button" onClick={() => fileRef.current?.click()}>Import…</button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void importTheme(e)} />
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Shortcuts (read-only) ───────────────────────────────────────────────────

const SHORTCUTS: [string, string][] = [
  ["⌘/Ctrl + E", "Cycle views"],
  ["⌘/Ctrl + \\", "New agent"],
  ["⌘/Ctrl + T", "New terminal"],
  ["⌘/Ctrl + B", "File tree"],
  ["⌘/Ctrl + D", "Diff review"],
  ["1 … 7", "Toolbar actions"],
  [".", "Focus the selected tile (Escape leaves focus mode)"],
  ["F2", "Rename the selected frame"],
  ["⇧ Esc", "Undock a tile from a scene view"],
];

function ShortcutPrefs() {
  return (
    <div className="settings-stack">
      <Section title="Keyboard" hint="Single keys apply when no terminal or editor has focus">
        <dl className="settings-shortcuts">
          {SHORTCUTS.map(([k, what]) => (
            <div className="settings-shortcut" key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

/** The lazy half of the Settings dialog — one chunk, loaded when it opens
 *  (App.tsx keeps only the cheap pages, so the entry bundle does not grow). */
const NavigateContext = createContext<(id: string) => void>(() => {});
export const useSettingsNavigate = (): ((id: string) => void) => useContext(NavigateContext);

/** Must match the registry's `chunk: "lazy"` pages (unit tested); plugin pages (`agent:…`) are always lazy. */
export const LAZY_SETTINGS_PAGES = ["appearance", "shortcuts", "agents", "views", "tools", "plugins", "installed"] as const;

export default function SettingsPages({ page, navigate }: { page: string; navigate: (id: string) => void }) {
  return <NavigateContext.Provider value={navigate}>{renderPage(page)}</NavigateContext.Provider>;
}

function renderPage(page: string) {
  if (page === "appearance") return <AppearancePrefs />;
  if (page === "shortcuts") return <ShortcutPrefs />;
  if (page === "agents") return <AgentsOverview />;
  if (page === "views") return <ViewsOverview />;
  if (page === "tools") return <ToolsOverview />;
  if (page === "plugins") return <BrowsePlugins />;
  if (page === "installed") return <InstalledPlugins />;
  const pp = pluginPage(page);
  if (pp?.kind === "agent") return <AgentPage id={pp.pluginId} />;
  if (pp?.kind === "view") return <ViewPage id={pp.pluginId} />;
  if (pp?.kind === "tool") return <ToolPage id={pp.pluginId} />;
  return null;
}
