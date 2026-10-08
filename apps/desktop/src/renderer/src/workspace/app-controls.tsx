/**
 * The right end of the tool island, as in a call's control bar: Settings, which holds Share too.
 * Where the island is not drawn (off, collapsed, zen mode) it sits in the window's corner instead,
 * so Settings is never out of reach.
 */
import { Settings2 } from "lucide-react";
import { Button } from "../components/ui/button";

export function AppControls({ corner = false }: { corner?: boolean }) {
  return <div className={corner ? "pointer-events-auto flex items-center" : "ml-1 flex items-center border-l border-[var(--color-border)] pl-1"}>
    <Button variant={corner ? "secondary" : "ghost"} size={corner ? "icon" : "icon-lg"} aria-label="settings" title="Settings  (⌘,)" data-settings
      onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: {} }))}>
      <Settings2 />
    </Button>
  </div>;
}
