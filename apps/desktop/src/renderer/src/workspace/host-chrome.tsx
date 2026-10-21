/**
 * host-chrome — what the workspace runtime draws OVER the active view, for
 * every view: the tool island (agent, frame, browser, Add, appearance, update
 * pill, Share, Settings). The hotkeys
 * these buttons mirror are workspace-level already; the buttons used to be
 * rendered by the canvas only, which left the Windows, World and community
 * views with no visible way to spawn anything.
 *
 * Placement comes from the view's chrome preference (`resolveChrome`): the
 * canvas keeps its top-centre island, everything else gets a compact bottom
 * one; "hidden" leaves a small handle that expands the island, while "off"
 * unmounts both; Share and Settings then sit in the window corner (App).
 * The canvas's zen mode suppresses the chrome entirely
 * (its own eye button restores it), through chrome-store.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Wrench } from "../components/icons";
import { resolveToolbar, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { StandardToolbar, ViewMenuAt } from "./standard-toolbar";
import { AddDialog } from "./add-dialog";
import { useToolEnabled } from "../tool-availability";
import { openAppearanceSettings, setBottomInset, setIslandShown, useChromeState } from "./chrome-store";
import type { ViewChrome } from "./workspace-view";
import type { BoardChoice } from "../board-objects/board-model";

export interface HostChromeProps {
  chrome: ViewChrome;
  toolbar?: ToolbarPreferences;
  repoPath: string | null;
  agentSel: string | undefined;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  /** Add something: widgets in every view, board items where the board is drawn. */
  onBoard?: (kind: BoardChoice) => void;
  boardItems?: boolean;
  /** Open a tool's tile from the Add menu. */
  onTile?: (kind: string, frameId?: string) => void;
  updateAvailable: boolean;
  updateStaged: boolean;
  onUpgrade: () => void;
  onRestart: () => void;
  upgrading: boolean;
}

export function HostChrome({ chrome, toolbar, ...island }: HostChromeProps) {
  const { suppressed } = useChromeState();
  const browserEnabled = useToolEnabled("browser");
  const hasBoard = !!island.onBoard;
  const actions = useMemo(() => resolveToolbar(toolbar).filter((action) =>
    (action.id !== "browser" || browserEnabled) && (action.id !== "board" || hasBoard)), [toolbar, browserEnabled, hasBoard]);
  const [expanded, setExpanded] = useState(false);
  const placement = chrome.island === "top" ? "top-3" : "bottom-3";
  const hasActions = actions.length > 0;
  const showIsland = hasActions && !suppressed && chrome.island !== "off" && (chrome.island !== "hidden" || expanded);
  useEffect(() => { setIslandShown(showIsland); }, [showIsland]);
  useEffect(() => () => { setIslandShown(false); setBottomInset(0); }, []);
  // A bottom island says how much it covers, island and gap above it, as its size changes.
  const islandRef = useRef<HTMLDivElement>(null);
  const bottom = showIsland && chrome.island !== "top";
  useEffect(() => {
    const el = islandRef.current;
    if (!bottom || !el) { setBottomInset(0); return; }
    const measure = () => setBottomInset(Math.ceil(window.innerHeight - el.getBoundingClientRect().top) + 8);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [bottom]);
  return (
    <>
      {/* Wherever it is asked for, with or without a toolbar. */}
      <ViewMenuAt />
      {island.onBoard && <AddDialog repoPath={island.repoPath} onBoard={island.onBoard} onTile={island.onTile} boardItems={!!island.boardItems} />}
      {showIsland && (
        <div
          className={`pointer-events-none absolute left-1/2 z-(--layer-panels) w-max max-w-[calc(100vw-24px)] -translate-x-1/2 ${placement}`}
          data-host-island={chrome.island}
          ref={islandRef}
        >
          <div className="pointer-events-auto">
            <StandardToolbar {...island} canAdd={hasBoard} actions={actions} labels={toolbar?.labels ?? false} onTheme={openAppearanceSettings} compact={chrome.island !== "top"} />
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
          className={`absolute left-1/2 z-(--layer-panels) -translate-x-1/2 ${expanded ? "bottom-[3.75rem]" : "bottom-3"}`}
          data-host-island-handle
        >
          <Wrench />
        </Button>
      )}
    </>
  );
}
