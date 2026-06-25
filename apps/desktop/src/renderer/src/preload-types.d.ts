import type { HiveIpc, PlanReviewOpen, HcpCommand, HcpPipeEvent, HcpWaitEvent, HcpSubagentEvent, HcpNotifyEvent, HcpTurnStateEvent } from "../../shared/ipc";

declare global {
  interface Window {
    hive: HiveIpc & {
      /** An agent handed off a plan (PreToolUse/ExitPlanMode) → open the review. */
      onPlanReviewOpen: (cb: (p: PlanReviewOpen) => void) => () => void;
      /** The agent/hook went away before a decision → close the review tile. */
      onPlanReviewAbort: (cb: (requestId: string) => void) => () => void;
      /** Main asks the renderer to run a control-plane canvas verb (HCP). */
      onHcpCommand: (cb: (cmd: HcpCommand) => void) => () => void;
      /** An agent pipe was created/removed → draw/erase the data-flow edge. */
      onHcpPipe: (cb: (e: HcpPipeEvent) => void) => () => void;
      /** A tile entered/left a control-plane "wait" state (e.g. awaiting approval). */
      onHcpWait: (cb: (e: HcpWaitEvent) => void) => () => void;
      /** A tile gained/lost in-flight Task subagents → keep it reading "working". */
      onHcpSubagent: (cb: (e: HcpSubagentEvent) => void) => () => void;
      /** claude's Notification hook fired → a deterministic "needs you" status. */
      onHcpNotify: (cb: (e: HcpNotifyEvent) => void) => () => void;
      /** claude's hook-driven turn state (UserPromptSubmit → working, Stop → idle). */
      onHcpTurnState: (cb: (e: HcpTurnStateEvent) => void) => () => void;
      onPtyData: (tileId: string, cb: (data: string) => void) => () => void;
      onPtyExit: (
        tileId: string,
        cb: (info: { code: number; signal?: number }) => void
      ) => () => void;
      onFsChanged: (
        repoPath: string,
        cb: (info: { paths: string[] }) => void
      ) => () => void;
      /** Path passed on the CLI (`hivemind .` / `hivemind /repo`), or null. */
      getLaunchTarget: () => Promise<string | null>;
      /** A second `hivemind <path>` invocation asks the running window to switch. */
      onOpenProject: (cb: (path: string) => void) => () => void;
      onMenuNewIssue: (cb: () => void) => () => void;
      onMenuToggleLayers?: (cb: () => void) => () => void;
      /** Resolve a picked File's absolute path (persistent video wallpaper). */
      getPathForFile?: (file: File) => string;
      /** A BrowserTile guest requested a popup/new window (target=_blank,
       *  window.open) — the owning tile opens it as a new tab. */
      onBrowserPopup: (cb: (p: { fromId: number; url: string }) => void) => () => void;
    };
  }
}

// Electron's <webview> tag (enabled via webPreferences.webviewTag in main).
// React/TS doesn't know this intrinsic element, so declare the subset of
// attributes BrowserTile uses. The runtime element is an Electron.WebviewTag.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          useragent?: string;
        },
        HTMLElement
      >;
    }
  }
}

export {};
