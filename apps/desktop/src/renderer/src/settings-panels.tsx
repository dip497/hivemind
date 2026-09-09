import { ViewSettings, ExtensionSettings } from "./settings-views";
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
import { defaultAgent } from "@hivemind/agents";
import { AGENTS, agentById } from "./agents";

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

// ── Agents ──────────────────────────────────────────────────────────────────
// The catalog decides what can be picked and what each provider supports; this
// page only stores the choice (`settings.agents.*`), exactly as before.

const MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const MODELS = ["default", "sonnet", "opus", "haiku"];

function AgentPrefs() {
  const s = useSettings();
  const sel = agentById(s.agents.defaultAgent) ?? agentById(defaultAgent().id);
  const caps = sel?.def.caps;
  return (
    <div className="settings-stack">
      <Section title="Agents">
        <div className="settings-row">
          <div><label htmlFor="default-agent">Default agent</label><p>Used when you create a new agent.</p></div>
          <select
            id="default-agent"
            value={sel?.id ?? ""}
            onChange={(e) => patchSettings("agents.defaultAgent", e.target.value)}
          >
            {AGENTS.filter((a) => a.enabled).map((a) => (
              <option key={a.id} value={a.id} data-agent-option={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <div><label htmlFor="agent-model">Model</label>{!caps?.modelFlag && <p>{sel?.label} chooses its own model.</p>}</div>
          <select id="agent-model" aria-label="Model" disabled={!caps?.modelFlag} value={s.agents.model} onChange={(e) => patchSettings("agents.model", e.target.value)}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <div><label htmlFor="agent-permission">Permission mode</label>{!caps?.permissionModes && <p>{sel?.label} has no permission modes; this applies to agents that do.</p>}</div>
          <select id="agent-permission" aria-label="Permission mode" disabled={!caps?.permissionModes} value={s.agents.permissionMode} onChange={(e) => patchSettings("agents.permissionMode", e.target.value)}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
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
export default function SettingsPages({ page, onExtensions }: { page: string; onExtensions: () => void }) {
  if (page === "appearance") return <AppearancePrefs />;
  if (page === "views") return <ViewSettings onExtensions={onExtensions} />;
  if (page === "extensions") return <ExtensionSettings />;
  if (page === "agents") return <AgentPrefs />;
  if (page === "shortcuts") return <ShortcutPrefs />;
  return null;
}
