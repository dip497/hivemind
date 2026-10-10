import type { HiveApi } from "../../shared/ipc";

declare global {
  interface Window {
    hive: HiveApi;
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
