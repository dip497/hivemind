/** Browse and install from the plugin catalog. Every download is hash-verified into a
 *  staging folder, then goes through the same review as a folder the user picked. */
import { rm } from "node:fs/promises";
import path from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import { fetchCatalog, stageEntry, type CatalogEntry } from "@hivemind/core/plugin-catalog";
import { installAgent, readAgentManifest, removeAgent, userAgentsDir, AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { findBin, verifyAgent } from "@hivemind/agents/discover";
import { getSettings, patchSettingsPath } from "./settings-store.js";
import { existsSync } from "node:fs";
import { BUILTIN_CATALOG, isGenericRuntime } from "@hivemind/agents";
import { newNonce } from "./view-package-files.js";
import { reviewViewDir } from "./view-packages.js";
import { applyShellEnvToProcess } from "./shell-env.js";

export interface AgentReview {
  token: string;
  id: string;
  label: string;
  bin: string;
  /** The exact command it launches, and every extra argument its options can add. */
  command: string;
  flags: string[];
  worker: boolean;
  replaces: boolean;
  install?: { url: string; command?: string };
}

export function installPluginCatalogIpc(getWindow: () => BrowserWindow | null): void {
  let catalog: CatalogEntry[] = [];
  let pendingAgent: { token: string; dir: string } | null = null;
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Only the workspace can install plugins");
  };

  ipcMain.handle("plugins:catalog", async (event) => {
    assertSender(event);
    catalog = await fetchCatalog();
    return catalog;
  });

  ipcMain.handle("plugins:review", async (event, type: string, id: string) => {
    assertSender(event);
    const entry = catalog.find((e) => e.type === type && e.id === id);
    if (!entry) throw new Error("That plugin is not in the catalog. Refresh and try again.");
    const dir = await stageEntry(entry);
    if (entry.type === "view") {
      try { return { type: "view", ...(await reviewViewDir(dir, true)) }; }
      catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
    }
    const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), { source: "user", nodeHalf: () => false });
    const builtin = read.def && BUILTIN_CATALOG.find((d) => d.id === read.def!.id);
    if (read.error || !read.def || builtin) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(builtin ? `It uses the id "${builtin.id}", which belongs to the built-in ${builtin.label}.` : read.error ?? "invalid agent manifest");
    }
    const def = read.def;
    const flags = [...new Set((def.options ?? []).flatMap((o) => [
      ...(o.flag ? [`${o.flag} <${o.label.toLowerCase()}>`] : []),
      ...Object.values(o.values ?? {}).map((argv) => argv.join(" ")),
    ]))];
    if (pendingAgent) await rm(pendingAgent.dir, { recursive: true, force: true }).catch(() => {});
    pendingAgent = { token: newNonce(), dir };
    const review: AgentReview = {
      token: pendingAgent.token, id: def.id, label: def.label, bin: def.bin,
      command: [def.bin, ...(def.defaultArgs ?? [])].join(" "), flags,
      worker: def.caps.turnSignal, replaces: existsSync(path.join(userAgentsDir(), def.id)),
      ...(def.install ? { install: def.install } : {}),
    };
    return { type: "agent", ...review };
  });

  // Once per launch, asked for by the workspace once it is up, so the result has a listener.
  let autoInstalled = false;
  ipcMain.handle("agents:auto-install", async (event) => {
    assertSender(event);
    if (autoInstalled) return [];
    autoInstalled = true;
    try {
      await applyShellEnvToProcess();
      return await autoInstallDetectedAgents();
    } catch (e) {
      console.warn("[agents] catalog check skipped:", (e as Error).message);
      return [];
    }
  });

  ipcMain.handle("agents:remove", async (event, id: string) => {
    assertSender(event);
    await removeInstalledAgent(String(id));
  });

  ipcMain.handle("plugins:install-agent", async (event, token: string) => {
    assertSender(event);
    if (!pendingAgent || pendingAgent.token !== token) throw new Error("Review the agent again before installing it.");
    const { dir } = pendingAgent;
    pendingAgent = null;
    try { await installAgent(dir); }
    finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
}

/** Add catalog agents whose CLI this machine has. No prompt — the user chose "just
 *  detect" — but each must pass the same checks as a reviewed install: files match
 *  their hashes, the manifest validates as untrusted, it names the CLI that was found,
 *  that CLI answers `--version` like one, and it cannot take a built-in's id. */
export async function autoInstallDetectedAgents(): Promise<string[]> {
  const settings = getSettings().agents;
  if (!settings.autoInstall) return [];
  const entries = (await fetchCatalog()).filter((e) => e.type === "agent" && e.bin
    && !BUILTIN_CATALOG.some((d) => d.id === e.id)
    && !settings.declined.includes(e.id)
    && !existsSync(path.join(userAgentsDir(), e.id))
    // The index names the command; a runtime that runs anything proves nothing about the agent.
    && !isGenericRuntime(e.bin!)
    && findBin(e.bin));
  const added: string[] = [];
  for (const entry of entries) {
    const probe = await verifyAgent({ id: entry.id, bin: entry.bin! } as Parameters<typeof verifyAgent>[0]);
    if (!probe.version) continue;
    let dir: string | null = null;
    try {
      dir = await stageEntry(entry);
      const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), { source: "user", nodeHalf: () => false });
      if (read.error || !read.def || read.def.bin !== entry.bin || read.def.id !== entry.id) continue;
      await installAgent(dir);
      added.push(read.def.label);
    } catch (e) {
      console.warn(`[agents] could not add ${entry.id} from the catalog:`, (e as Error).message);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return added;
}

/** Remove an agent you installed; a catalog agent removed this way is never re-added. */
export async function removeInstalledAgent(id: string): Promise<void> {
  await removeAgent(id);
  const declined = getSettings().agents.declined;
  if (!declined.includes(id)) await patchSettingsPath("agents.declined", [...declined, id]);
}
