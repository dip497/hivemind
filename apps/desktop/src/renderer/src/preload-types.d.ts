import type { HiveIpc } from "../../shared/ipc";

declare global {
  interface Window {
    hive: HiveIpc & {
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
