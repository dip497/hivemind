/** Browse and install from the plugin catalog. Every download is hash-verified into a
 *  staging folder, then goes through the same review as a folder the user picked. */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import { appMeetsMinVersion, catalogAgentNeedsUpdate, fetchCatalog, stageEntry, type CatalogEntry } from "@hivemind/core/plugin-catalog";
import { installAgent, readAgentManifest, removeAgent, userAgentsDir, AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { findBin, verifyAgent } from "@hivemind/agents/discover";
import { getSettings, patchSettingsPath } from "./settings-store.js";
import { existsSync } from "node:fs";
import { agentDisclosures, isGenericRuntime } from "@hivemind/agents";
import { newNonce } from "./view-package-files.js";
import { reviewViewDir } from "./view-packages.js";
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";

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
  /** Everything it does that reaches past its own folder, in the user's words. */
  does: string[];
  /** The directory it would read to find a session to resume, if it resumes. */
  reads?: string;
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

  // Which installed agents are no longer what the catalog lists. Agents carry no version of
  // their own, so "is there an update" was unanswerable for them and the button never
  // appeared — but every file is pinned by hash, which answers it exactly: a manifest whose
  // bytes differ from the listed hash is a copy of something that has since changed.
  ipcMain.handle("plugins:outdated", async (event) => {
    assertSender(event);
    const out: string[] = [];
    for (const entry of catalog) {
      if (entry.type !== "agent") continue;
      const listed = entry.files.find((f) => f.path === AGENT_MANIFEST_FILE);
      if (!listed) continue;
      try {
        const body = await readFile(path.join(userAgentsDir(), entry.id, AGENT_MANIFEST_FILE));
        if (createHash("sha256").update(body).digest("hex") !== listed.sha256) out.push(entry.id);
      } catch { /* not installed, or unreadable: nothing to update */ }
    }
    return out;
  });

  ipcMain.handle("plugins:review", async (event, type: string, id: string) => {
    assertSender(event);
    const entry = catalog.find((e) => e.type === type && e.id === id);
    if (!entry) throw new Error("That plugin is not in the catalog. Refresh and try again.");
    // Refuse before downloading: a plugin that needs a newer Hivemind fails at use, and by
    // then the user has already reviewed and installed it.
    if (!appMeetsMinVersion(app.getVersion(), entry.minAppVersion)) {
      throw new Error(`${entry.name} needs Hivemind ${entry.minAppVersion} or newer; this is ${app.getVersion()}.`);
    }
    const dir = await stageEntry(entry);
    if (entry.type === "view") {
      try { return { type: "view", ...(await reviewViewDir(dir, true)) }; }
      catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
    }
    const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), { source: "user" });
    if (read.error || !read.def) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(read.error ?? "invalid agent manifest");
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
      does: agentDisclosures(def),
      ...(def.session?.resume?.find ? { reads: def.session.resume.find.root } : {}),
      ...(def.install ? { install: def.install } : {}),
    };
    return { type: "agent", ...review };
  });

  // Once per launch, asked for by the workspace once it is up, so the result has a listener.
  // A check that FAILED does not count: the registry is on the other side of someone's
  // network, and latching a socket that closed mid-fetch leaves an agent this version cannot
  // load broken until the app is restarted — which is exactly when nothing works.
  let checkedCatalog = false;
  let checking: Promise<{ added: Array<{ id: string; label: string; does: string[] }>; updated: Array<{ id: string; label: string }> }> | null = null;
  ipcMain.handle("agents:auto-install", async (event) => {
    assertSender(event);
    if (checkedCatalog) return { added: [], updated: [] };
    if (checking) return checking; // a second ask while the first is in flight rides along
    checking = (async () => {
      await applyShellEnvToProcess();
      const listed = await fetchCatalog();
      return { added: await autoInstallDetectedAgents(listed), updated: await autoUpdateCatalogAgents(listed) };
    })();
    try {
      const out = await checking;
      checkedCatalog = true;
      return out;
    } catch (e) {
      console.warn("[agents] catalog check failed, will try again:", (e as Error).message);
      return { added: [], updated: [] };
    } finally {
      checking = null;
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
    try { await noteCatalogAgent((await installAgent(dir)).id); }
    finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
}

/** Add catalog agents whose CLI this machine has. No prompt — the user chose "just
 *  detect". Each still passes the same checks as a reviewed install: files match their
 *  hashes, the manifest validates as untrusted, it names the CLI that was found, and that CLI
 *  answers `--version` like one. Disclosures don't block:
 *  catalog agents are reviewed by pull request before they are listed, and the notice tells the user what each can do. */
export async function autoInstallDetectedAgents(listed?: CatalogEntry[]): Promise<Array<{ id: string; label: string; does: string[] }>> {
  const settings = getSettings().agents;
  if (!settings.autoInstall) return [];
  const entries = (listed ?? await fetchCatalog()).filter((e) => e.type === "agent" && e.bin
    && !settings.declined.includes(e.id)
    && !existsSync(path.join(userAgentsDir(), e.id))
    // The index names the command; a runtime that runs anything proves nothing about the agent.
    && !isGenericRuntime(e.bin!)
    && appMeetsMinVersion(app.getVersion(), e.minAppVersion)
    && findBin(e.bin));
  const added: Array<{ id: string; label: string; does: string[] }> = [];
  for (const entry of entries) {
    let dir: string | null = null;
    try {
      dir = await stageEntry(entry);
      const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), { source: "user" });
      if (read.error || !read.def || read.def.bin !== entry.bin || read.def.id !== entry.id) continue;
      // Last: starting the CLI boots its whole runtime, so only for one that would be added.
      const probe = await verifyAgent({ id: entry.id, bin: entry.bin! } as Parameters<typeof verifyAgent>[0]);
      if (!probe.version) continue;
      await installAgent(dir);
      await noteCatalogAgent(entry.id);
      added.push({ id: entry.id, label: read.def.label, does: agentDisclosures(read.def) });
    } catch (e) {
      console.warn(`[agents] could not add ${entry.id} from the catalog:`, (e as Error).message);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return added;
}

/** Where an agent came from, so its page can say so, and the manifest the catalog put there,
 *  so an update can tell a copy nobody touched from one someone edited. */
async function noteCatalogAgent(id: string): Promise<void> {
  const from = getSettings().agents.fromCatalog;
  if (!from.includes(id)) await patchSettingsPath("agents.fromCatalog", [...from, id]);
  const dir = path.join(userAgentsDir(), id);
  await writeFile(path.join(dir, CATALOG_MARK), sha256(await readFile(path.join(dir, AGENT_MANIFEST_FILE))));
}

const CATALOG_MARK = ".catalog-sha256";
const sha256 = (body: Buffer): string => createHash("sha256").update(body).digest("hex");

/** Catalog agents brought up to what the catalog lists now: a new Hivemind changes what its
 *  agents' manifests must say, and an agent left behind would stop working. A copy the catalog
 *  installed and nobody has edited since, or one this app refuses to load at all — an agent
 *  that does nothing cannot be made worse. The copy it replaces is kept in `agents-previous/`. */
export async function autoUpdateCatalogAgents(listed: CatalogEntry[]): Promise<Array<{ id: string; label: string }>> {
  const settings = getSettings().agents;
  if (!settings.autoInstall) return [];
  const updated: Array<{ id: string; label: string }> = [];
  for (const entry of listed) {
    if (entry.type !== "agent") continue;
    const dir = path.join(userAgentsDir(), entry.id);
    let have: string;
    try { have = sha256(await readFile(path.join(dir, AGENT_MANIFEST_FILE))); } catch { continue; }
    const recorded = await readFile(path.join(dir, CATALOG_MARK), "utf8").then((s) => s.trim(), () => null);
    const installed = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), { source: "user" });
    if (!catalogAgentNeedsUpdate(entry, {
      fromCatalog: settings.fromCatalog.includes(entry.id), manifestSha: have, recordedSha: recorded,
      appVersion: app.getVersion(), broken: !!installed.error,
    })) continue;
    let stage: string | null = null;
    try {
      stage = await stageEntry(entry);
      const read = await readAgentManifest(path.join(stage, AGENT_MANIFEST_FILE), { source: "user" });
      if (read.error || !read.def || read.def.id !== entry.id) continue;
      const kept = path.join(path.dirname(userAgentsDir()), "agents-previous", entry.id);
      await rm(kept, { recursive: true, force: true });
      await mkdir(path.dirname(kept), { recursive: true });
      await cp(dir, kept, { recursive: true });
      await installAgent(stage);
      await noteCatalogAgent(entry.id);
      updated.push({ id: entry.id, label: read.def.label });
    } catch (e) {
      console.warn(`[agents] could not update ${entry.id} from the catalog:`, (e as Error).message);
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  return updated;
}

/** Remove an agent you installed; a catalog agent removed this way is never re-added. */
export async function removeInstalledAgent(id: string): Promise<void> {
  await removeAgent(id);
  const { declined, fromCatalog } = getSettings().agents;
  if (!declined.includes(id)) await patchSettingsPath("agents.declined", [...declined, id]);
  if (fromCatalog.includes(id)) await patchSettingsPath("agents.fromCatalog", fromCatalog.filter((x) => x !== id));
}
