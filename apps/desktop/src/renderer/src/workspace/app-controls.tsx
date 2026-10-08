/**
 * The right end of the tool island, as in a call's control bar: Share for the workspace's owner,
 * then Settings. Where the island is not drawn (off, collapsed, zen mode) they sit in the window's
 * corner instead, so Settings is never out of reach.
 */
import { Settings2, UserPlus } from "lucide-react";
import { Button } from "../components/ui/button";
import { useCanShare } from "../multiplayer/workspace-actions";

export function AppControls({ corner = false }: { corner?: boolean }) {
  const share = useCanShare();
  return <div className={corner ? "pointer-events-auto flex items-center gap-2" : "ml-1 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5"}>
    {share && <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-share"))}
      title="Invite people to this workspace" data-share>
      <UserPlus /><span>Share</span>
    </Button>}
    <Button variant={corner ? "secondary" : "ghost"} size={corner ? "icon" : "icon-lg"} aria-label="settings" title="Settings  (⌘,)" data-settings
      onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: {} }))}>
      <Settings2 />
    </Button>
  </div>;
}
