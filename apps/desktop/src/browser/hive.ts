/// <reference lib="dom" />
/**
 * `window.hive` in a browser tab (docs/design/browser-app-2026-10-13.md): the window's own, made over
 * the browser server's socket to main. A socket has no synchronous calls, so the store's layouts
 * are a replica (spec/workspace-api.md, "A client that holds the layouts") and the settings are
 * read before the renderer starts and kept as main changes them. A terminal's output is paced by
 * acknowledging what arrived, as a phone does, so a slow link is sent its screen, not a backlog.
 */
import { StoreReplica } from "@hivemind/workspace-api/store-replica";
import type { Settings } from "@hivemind/core/settings-schema";
import type { HiveApi } from "../shared/ipc";
import { hiveOverIpc, workspaceOver, type IpcPort } from "../shared/hive-ipc";
import type { MainFrame, TabFrame } from "../shared/browser-socket";

export async function connectHive(url: string, token: string, onClose: (code: number) => void): Promise<HiveApi> {
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let next = 1;
  const put = (frame: TabFrame): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const hello = new Promise<Extract<MainFrame, { t: "hello" }>>((resolve, reject) => {
    ws.addEventListener("open", () => put({ t: "auth", token }));
    ws.addEventListener("message", (ev) => {
      const frame = JSON.parse(String(ev.data)) as MainFrame;
      if (frame.t === "hello") resolve(frame);
      else if (frame.t === "result") {
        const call = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error !== undefined) call?.reject(new Error(frame.error));
        else call?.resolve(frame.value);
      } else {
        for (const l of listeners.get(frame.ch) ?? []) {
          try { l(...frame.args); } catch (e) { console.error(`[hive] a listener for ${frame.ch} failed:`, e); }
        }
      }
    });
    ws.addEventListener("close", (ev) => {
      reject(new Error(`the app closed the connection (${ev.code})`));
      for (const call of pending.values()) call.reject(new Error("the app closed the connection"));
      pending.clear();
      onClose(ev.code);
    });
  });
  const { channels, platform } = await hello;
  const served = new Set(channels);

  const port: IpcPort = {
    invoke: (ch, ...args) => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error("the app closed the connection"));
      const id = next++;
      pending.set(id, { resolve, reject });
      put({ t: "invoke", id, ch, args });
    }),
    send: (ch, ...args) => put({ t: "send", ch, args }),
    sendSync: (ch) => { throw new Error(`${ch}: a browser has no synchronous calls to the app`); },
    on: (ch, listener) => {
      let set = listeners.get(ch);
      if (!set) listeners.set(ch, (set = new Set()));
      set.add(listener);
      return () => { set!.delete(listener); };
    },
    serves: (ch) => served.has(ch),
  };

  const workspace = workspaceOver(port);
  const store = new StoreReplica(workspace);
  let settings = (await port.invoke("settings:get")) as Settings;
  port.on("settings:changed", (s: Settings) => { settings = s; });

  // What each terminal took, all told since it was last opened: an open starts its count again.
  const taken = new Map<string, number>();
  workspace.on("terminal.data", (tile, data) => {
    const all = (taken.get(tile) ?? 0) + data.length;
    taken.set(tile, all);
    workspace.notice("terminal.ack", tile, all);
  });

  const hive = hiveOverIpc(port, workspace);
  return {
    ...hive,
    platform: platform as NodeJS.Platform,
    ptySpawn: (opts) => {
      taken.set(opts.tileId, 0);
      return hive.ptySpawn({ ...opts, acks: true });
    },
    resolveProject: async (hint) => {
      const project = await hive.resolveProject(hint);
      const key = project.repoPath ?? project.cwd;
      if (key) await store.open(key);
      return project;
    },
    settingsSync: () => settings,
    workspaceCoreSync: (repo) => store.core(repo),
    workspaceViewSync: (repo, viewId) => store.view(repo, viewId),
    workspaceSetCoreSync: (repo, core, base) => store.setCore(repo, core, base),
    workspaceSetViewSync: (repo, viewId, layout, base) => store.setView(repo, viewId, layout, base),
    workspaceImportSync: (repo, legacy) => store.import(repo, legacy),
    workspaceObjectsSync: (repo) => store.objects(repo),
    workspaceSetObjectsSync: (repo, objects, base) => store.setObjects(repo, objects, base),
    workspaceUndoSync: (repo) => store.undo(repo),
    workspaceRedoSync: (repo) => store.redo(repo),
    onWorkspaceChanged: (cb) => store.onChange(cb),
  };
}
