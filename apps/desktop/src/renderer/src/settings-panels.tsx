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
import { exportAppearance, importAppearance } from "@hivemind/core/settings-schema";
import { setTheme, useTheme } from "./theme-store";
import {
  AccentPicker, BackgroundControls, GlassControls, OverlayControls, PresetRow, Section, ShapeAndTypeControls, TerminalColors,
} from "./appearance-controls";
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
    const { theme, note } = exportAppearance(getSettings().appearance);
    try { await navigator.clipboard.writeText(JSON.stringify(theme, null, 2)); toast.success("Theme copied as JSON.", note ? { description: note } : undefined); }
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
      // Checked, and the wallpaper media and overlays a theme file leaves out stay yours.
      patchSettings("appearance", importAppearance(a, getSettings().appearance));
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

// The keymap's rows (shared/keymap.ts), split by where they work.
const SHORTCUTS_ANYWHERE: [string, string][] = [
  ["⌘/Ctrl + ⇧ + `", "New terminal"],
  ["⌘/Ctrl + ⇧ + A", "New agent"],
  ["⌘/Ctrl + ⇧ + E", "File tree"],
  ["⌘/Ctrl + ⇧ + N", "New frame"],
  ["⌘/Ctrl + 1 … 9", "Go to tile 1 … 9"],
  ["⌘/Ctrl + Tab", "Next tile (⇧ for previous)"],
  ["⌘/Ctrl + ,", "Settings"],
  ["⌘/Ctrl + .", "Focus the selected tile"],
  ["⌘/Ctrl + ⇧ + F", "Fit the selected terminal to the screen, and back"],
  ["⌘/Ctrl + ⇧ + 0", "Size the selected terminal's text to the screen"],
  ["F11", "Full screen"],
  ["⌘/Ctrl + Q", "Quit, asking first while agents or terminals run"],
];
const SHORTCUTS_CANVAS: [string, string][] = [
  ["⌘/Ctrl + B", "Show or hide Layers (⌘B in a terminal too)"],
  ["⌘/Ctrl + E", "Switch views, in any view"],
  ["1", "New terminal"],
  ["2", "New agent"],
  ["3", "File tree"],
  ["6", "New frame"],
  ["7", "New browser"],
  ["⌫", "Delete the selected widget or arrow on the board"],
  ["⌘/Ctrl + D", "Duplicate the selected widget"],
  ["⌘/Ctrl + Z / ⇧Z", "Undo / redo on the board"],
  ["⌘/Ctrl + = / −", "Zoom in / out"],
  ["⌘/Ctrl + 0", "Zoom to 100%"],
  ["Esc", "Leave full screen, or fit everything in view"],
  ["⌘/Ctrl + O", "Open a folder as the project"],
  ["⌘/Ctrl + R", "Open a recent project"],
  [".", "Focus the selected tile"],
  ["⌘/Ctrl + W", "Close the selected tile"],
  ["F2", "Rename the selected frame"],
  ["⇧ Esc", "Undock a tile from a scene view"],
];

const SHORTCUTS_TERMINAL: [string, string][] = [
  ["⇧ + Enter", "A new line in an agent's prompt"],
  ["⌘/Ctrl + C", "Copy the selection; with none, the program's Ctrl+C"],
  ["⌘/Ctrl + = / − / 0", "Text size"],
  ["⌘/Ctrl + ⇧ + K", "Take back the keyboard from a guest"],
];

function ShortcutList({ items }: { items: [string, string][] }) {
  return (
    <dl className="settings-shortcuts">
      {items.map(([k, what]) => (
        <div className="settings-shortcut" key={k}>
          <dt><kbd>{k}</kbd></dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

function ShortcutPrefs() {
  return (
    <div className="settings-stack">
      <Section title="Anywhere" hint="Work even while a terminal has focus — everything else goes to the terminal">
        <ShortcutList items={SHORTCUTS_ANYWHERE} />
      </Section>
      <Section title="On the canvas" hint="When no terminal or field has focus">
        <ShortcutList items={SHORTCUTS_CANVAS} />
      </Section>
      <Section title="In a terminal" hint="Every other key goes to the program">
        <ShortcutList items={SHORTCUTS_TERMINAL} />
      </Section>
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
