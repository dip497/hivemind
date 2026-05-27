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
      onMenuPalette: (cb: () => void) => () => void;
      onMenuNewIssue: (cb: () => void) => () => void;
      onMenuOpenFolder: (cb: () => void) => () => void;
      onMenuOpenRecent: (cb: () => void) => () => void;
    };
  }
}

export {};
