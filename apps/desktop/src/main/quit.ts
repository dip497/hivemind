/**
 * Quitting while terminals or agents run on this computer: they keep running in the background
 * process, or it stops with the app (as `hive daemon stop` stops it), as the person answers or
 * chose once in Settings. Only a person's quit asks; `app.quit()` from anywhere else quits as it
 * always did.
 */
import { app, type BrowserWindow } from "electron";
import type { SessionInfo } from "@hivemind/agent-host/pty-protocol";
import type { QuitChoice } from "@hivemind/core/settings-schema";
import type { QuitAnswer, QuitQuestion } from "../shared/ipc.js";
import { handle } from "./app-ipc.js";
import { runningSessions, stopDaemon } from "./daemon-client.js";
import { sessionsKeptElsewhere } from "./remote/pty.js";
import { getSettings, patchSettingsPath } from "./settings-store.js";
import { appWindowOf } from "./windows.js";

let stopOnQuit = false;
let asking: BrowserWindow | null = null;
let isAgent: (s: SessionInfo) => boolean = () => false;
let isAgentTile: (tileId: string) => boolean = () => false;

/** The app is quitting with "Stop everything": the background process stops before it exits. */
export const stopsEverything = (): boolean => stopOnQuit;

/** Quit, stopping every session on this computer first. */
export function quitAndStopEverything(): void {
  stopOnQuit = true;
  app.quit();
}

/** Ends the background process; the app's exit waits for it. */
export function stopEverything(): Promise<void> {
  return stopDaemon().catch((e) => console.warn(`[quit] the background process did not stop: ${(e as Error).message}`));
}

async function question(): Promise<QuitQuestion> {
  const elsewhere = sessionsKeptElsewhere().filter((id) => isAgentTile(id)).length;
  // A background process too busy to answer may still be running agents: ask rather than guess none.
  const running = await runningSessions().catch(() => null);
  if (!running) return { agents: 0, terminals: 0, elsewhere, uncounted: true };
  const agents = running.filter((s) => isAgent(s)).length;
  return { agents, terminals: running.length - agents, elsewhere };
}

/** A person asked to quit: from `win`, by its keys, by closing the last window, or from the app's commands. */
export async function askToQuit(win: BrowserWindow | null): Promise<void> {
  if (asking && !asking.isDestroyed()) return void asking.focus();
  const choice = getSettings().quit.whenRunning;
  if (choice === "keep-running") return void app.quit();
  // Stopping needs no count: a busy background process that answers late still stops.
  if (choice === "stop-everything") return quitAndStopEverything();
  const q = await question();
  if (!q.uncounted && q.agents + q.terminals === 0) return void app.quit();
  // A window that cannot show the question quits as quitting always has.
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) return void app.quit();
  asking = win;
  win.once("closed", () => { if (asking === win) asking = null; });
  win.webContents.send("quit:ask", q);
}

async function answered(raw: unknown): Promise<void> {
  asking = null;
  const a = raw as Partial<QuitAnswer> | null;
  if (a?.choice !== "keep-running" && a?.choice !== "stop-everything") return;
  if (a.remember === true) await patchSettingsPath("quit.whenRunning", a.choice satisfies QuitChoice).catch(() => undefined);
  if (a.choice === "stop-everything") quitAndStopEverything();
  else app.quit();
}

/** The window's answers and commands. `agent` tells an agent's session from a terminal's. */
export function installQuitIpc(o: { agent: (s: SessionInfo) => boolean; agentTile: (tileId: string) => boolean }): void {
  isAgent = o.agent;
  isAgentTile = o.agentTile;
  handle("quit:answer", (_e, a: unknown) => answered(a), { local: true });
  handle("quit:ask", (e) => askToQuit(appWindowOf(e.sender)), { local: true });
  handle("quit:stop-everything", () => quitAndStopEverything(), { local: true });
}
