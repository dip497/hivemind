/**
 * host-chrome — what the workspace runtime draws OVER the active view, for
 * every view: the tool island (spawn shell/agent/explorer/diff/issues, frame,
 * browser, appearance, update pill) and the appearance drawer. The hotkeys
 * these buttons mirror are workspace-level already; the buttons used to be
 * rendered by the canvas only, which left the Windows, World and community
 * views with no visible way to spawn anything.
 *
 * Placement comes from the view's chrome preference (`resolveChrome`): the
 * canvas keeps its top-centre island, everything else gets a compact bottom
 * one; "hidden" leaves a small handle that expands the island — a view can
 * never strand the user. The canvas's zen mode suppresses the chrome entirely
 * (its own eye button restores it), through chrome-store.
 */
import { useState } from "react";
import { Wrench } from "lucide-react";
import { ToolIsland } from "../canvas-islands";
import { ThemeCustomizer } from "../ThemeCustomizer";
import { setCustomizerOpen, toggleCustomizer, useChromeState } from "./chrome-store";
import type { ViewChrome } from "./workspace-view";

export interface HostChromeProps {
  chrome: ViewChrome;
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

export function HostChrome({ chrome, ...island }: HostChromeProps) {
  const { customizerOpen, suppressed } = useChromeState();
  const [expanded, setExpanded] = useState(false);
  const placement = chrome.island === "top" ? "top-3" : "bottom-3";
  const showIsland = !suppressed && (chrome.island !== "hidden" || expanded);
  return (
    <>
      {showIsland && (
        <div
          className={`pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 ${placement}`}
          data-host-island={chrome.island}
        >
          <div className="pointer-events-auto">
            <ToolIsland {...island} onTheme={toggleCustomizer} compact={chrome.island !== "top"} />
          </div>
        </div>
      )}
      {!suppressed && chrome.island === "hidden" && (
        <button
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? "hide tools" : "show tools"}
          aria-expanded={expanded}
          title={expanded ? "Hide tools" : "Tools (spawn, frame, appearance)"}
          className={`hm-island absolute left-1/2 z-30 grid size-7 -translate-x-1/2 place-items-center rounded-lg text-[var(--color-fg2)] hover:text-[var(--color-fg)] ${expanded ? "bottom-[3.75rem]" : "bottom-3"}`}
          data-host-island-handle
        >
          <Wrench size={13} />
        </button>
      )}
      <ThemeCustomizer open={customizerOpen} onClose={() => setCustomizerOpen(false)} />
    </>
  );
}
