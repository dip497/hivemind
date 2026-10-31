/**
 * Which agents may drive a Browser tile, and who is driving it now. The tile keeps the person's own
 * pages to themselves: by default only the agents in its frame reach it.
 */
import { useEffect, useState } from "react";
import { Bot } from "./components/icons";
import { Button } from "./components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { useSettings } from "./settings-store";
import type { AgentAccess } from "@hivemind/core/settings-schema";

const setAccess = (tileId: string, tiles: Record<string, AgentAccess>, to: AgentAccess) => {
  const { [tileId]: _was, ...others } = tiles;
  return window.hive.settingsSet("agentBrowser.tiles", to === "frame" ? others : { ...others, [tileId]: to });
};

/** The tile's choice of who may drive it. */
export function AgentAccessMenu({ tileId }: { tileId: string }) {
  const { agentBrowser } = useSettings();
  const access = agentBrowser.tiles[tileId] ?? "frame";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-2xs" className="nodrag" aria-label="agents" title="Which agents can use this tile" data-agent-access={access}>
          <Bot className={access === "none" ? "opacity-40" : undefined} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Agents that can use this tile</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={access} onValueChange={(to) => void setAccess(tileId, agentBrowser.tiles, to as AgentAccess)}>
          <DropdownMenuRadioItem value="frame">Agents in this frame</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all">Every agent</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="none">No agents</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Says who is changing the page while they are, with a way to stop them. */
export function DrivingBar({ tileId }: { tileId: string }) {
  const { agentBrowser } = useSettings();
  const [driver, setDriver] = useState<{ by: string | null } | null>(null);
  useEffect(() => window.hive.onBrowserDriving((e) => {
    if (e.tileId === tileId) setDriver(e.driving ? { by: e.by } : null);
  }), [tileId]);
  if (!driver) return null;
  return (
    <div data-agent-driving className="flex h-7 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg4)] px-2 text-chip text-[var(--color-fg2)]">
      <Bot size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{driver.by ?? "An agent"} is using this page</span>
      <Button variant="ghost" size="xs" className="nodrag" onClick={() => { setDriver(null); void setAccess(tileId, agentBrowser.tiles, "none"); }}>Stop</Button>
    </div>
  );
}
