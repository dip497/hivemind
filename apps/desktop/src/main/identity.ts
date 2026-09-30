/**
 * This machine's identity (R3, spec/identity.md): its device key, the person key it holds and its
 * device certificate, kept in `<userData>/identity` (`keyring.ts`) and made the first time
 * something asks for them; and what the window's Settings → Profile shows of them.
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { machineKeys, type MachineKeys } from "@hivemind/workspace-host/keyring";
import { handle } from "./app-ipc.js";

let keys: MachineKeys | null = null;

/** This machine's keys, made on first use. */
export function machineIdentity(): MachineKeys {
  keys ??= machineKeys(path.join(app.getPath("userData"), "identity"), (m) => console.warn(`[identity] ${m}`));
  return keys;
}

/** The name to offer while the profile has none: git's global `user.name`, else this machine's
 *  account name. */
function suggestedName(): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["config", "--global", "--get", "user.name"], { timeout: 5_000 }, (err, stdout) => {
      const name = err ? "" : stdout.trim();
      if (name) return resolve(name);
      try { resolve(os.userInfo().username); } catch { resolve(""); }
    });
  });
}

export function installIdentityIpc(): void {
  handle("identity:get", async () => {
    const { deviceId, personId } = machineIdentity();
    return { deviceId, personId, suggestedName: await suggestedName() };
  });
}
