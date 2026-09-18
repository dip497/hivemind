/**
 * host-chrome — what the workspace runtime draws OVER the active view, for
 * every view: the tool island (spawn shell/agent/explorer/diff/issues, frame,
 * browser, appearance, update pill). The hotkeys
 * these buttons mirror are workspace-level already; the buttons used to be
 * rendered by the canvas only, which left the Windows, World and community
 * views with no visible way to spawn anything.
 *
 * Placement comes from the view's chrome preference (`resolveChrome`): the
 * canvas keeps its top-centre island, everything else gets a compact bottom
 * one; "hidden" leaves a small handle that expands the island, while "off"
 * unmounts both. App-level Settings is independent of this component.
 * The canvas's zen mode suppresses the chrome entirely
 * (its own eye button restores it), through chrome-store.
 */
import { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import { resolveToolbar, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { StandardToolbar } from "./standard-toolbar";
import { useToolEnabled } from "../tool-availability";
import { openAppearanceSettings, useChromeState } from "./chrome-store";
import type { ViewChrome } from "./workspace-view";

export interface HostChromeProps {
  chrome: ViewChrome;
  toolbar?: ToolbarPreferences;
  repoPath: string | null;
  onToggle: (k: "tree" | "shell" | "diff" | "issues") => void;
  agentSel: string;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  updateAvailable: boolean;
  onUpgrade: () => void;
  upgrading: boolean;
}

export function HostChrome({ chrome, toolbar, ...island }: HostChromeProps) {
  const { suppressed } = useChromeState();
  const browserEnabled = useToolEnabled("browser");
  const actions = useMemo(() => resolveToolbar(toolbar).filter((action) => action.id !== "browser" || browserEnabled), [toolbar, browserEnabled]);
  const [expanded, setExpanded] = useState(false);
  const placement = chrome.island === "top" ? "top-3" : "bottom-3";
  const hasActions = actions.length > 0;
  const showIsland = hasActions && !suppressed && chrome.island !== "off" && (chrome.island !== "hidden" || expanded);
  return (
    <>
      {showIsland && (
        <div
          className={`pointer-events-none absolute left-1/2 z-30 w-max max-w-[calc(100vw-24px)] -translate-x-1/2 ${placement}`}
          data-host-island={chrome.island}
        >
          <div className="pointer-events-auto">
            <StandardToolbar {...island} actions={actions} labels={toolbar?.labels ?? false} onTheme={openAppearanceSettings} compact={chrome.island !== "top"} />
          </div>
        </div>
      )}
      {hasActions && !suppressed && chrome.island === "hidden" && (
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? "hide tools" : "show tools"}
          aria-expanded={expanded}
          title={expanded ? "Hide tools" : "Tools (spawn, frame, appearance)"}
          className={`absolute left-1/2 z-30 -translate-x-1/2 ${expanded ? "bottom-[3.75rem]" : "bottom-3"}`}
          data-host-island-handle
        >
          <Wrench />
        </Button>
      )}
    </>
  );
}
