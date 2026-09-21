/** Appearance beside the workspace, not over it: every change shows live on the real app. */
import { useEffect, useRef, useState } from "react";
import { Palette, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { AccentPicker, BackgroundControls, GlassControls, OverlayControls, PresetRow, Section } from "./appearance-controls";
import { useTheme } from "./theme-store";

export const THEME_PANEL_EVENT = "hivemind:theme-panel";

export function ThemePanel() {
  const [open, setOpen] = useState(false);
  const t = useTheme();
  const ref = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const toggle = () => setOpen((o) => {
      if (!o) returnFocus.current = document.activeElement as HTMLElement | null;
      return !o;
    });
    window.addEventListener(THEME_PANEL_EVENT, toggle);
    return () => window.removeEventListener(THEME_PANEL_EVENT, toggle);
  }, []);
  useEffect(() => {
    if (open) ref.current?.focus();
    else { returnFocus.current?.focus(); returnFocus.current = null; }
  }, [open]);
  if (!open) return null;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Appearance"
      data-theme-panel
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}
      className="theme-panel fixed right-0 top-0 bottom-0 z-[60] w-[380px] max-w-[92vw] flex flex-col border-l border-[var(--color-line)] shadow-2xl outline-none"
    >
      <header className="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-[var(--color-line)]">
        <Palette size={15} className="text-[var(--color-fg3)]" />
        <h2 className="text-[13.5px] font-semibold text-[var(--color-fg)]">Appearance</h2>
        <span className="text-[11px] text-[var(--color-fg3)]">changes apply live</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => setOpen(false)} aria-label="close appearance"><X /></Button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4 settings-stack">
        <Section title="Theme">
          <PresetRow t={t} />
          <AccentPicker t={t} />
        </Section>
        <Section title="Workspace">
          <BackgroundControls t={t} />
          <GlassControls t={t} />
        </Section>
        <OverlayControls t={t} />
      </div>
      <footer className="shrink-0 px-4 py-2.5 border-t border-[var(--color-line)]">
        <Button
          variant="link"
          size="xs"
          onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "appearance" } })); }}
        >All appearance settings…</Button>
      </footer>
    </aside>
  );
}
