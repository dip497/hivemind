/**
 * Tool plugins' secrets in the app (`@hivemind/host/secrets`): encrypted with the system keychain
 * (Electron's safeStorage), as saved remote hosts' passwords are; in the 0600 file alone where
 * there is no keychain (a Linux with no keyring, where safeStorage would use a fixed key). Set from
 * a plugin's settings page; read by its service alone (`secret.get`).
 */
import { safeStorage } from "electron";
import { pluginKey } from "@hivemind/core/plugin-settings";
import { Secrets, secretsPath, type Cipher } from "@hivemind/host/secrets";
import { handleEffect } from "./app-ipc.js";

function keychain(): Cipher | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return null;
  } catch {
    return null;
  }
  return {
    encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, "base64")),
  };
}

let kept: Secrets | null = null;
/** Made once the app is ready, as safeStorage is only then. */
export const appSecrets = (): Secrets => (kept ??= new Secrets(secretsPath(), keychain()));

/** `changed`: a secret was set or taken away, which the plugin's service is told. */
export function installSecretsIpc(changed: () => void): void {
  // Who set which secret is recorded; its value never is, and never goes back to a window.
  handleEffect("secrets:set", (plugin, field) => ({ target: typeof plugin === "string" && typeof field === "string" ? `${plugin}.${field}` : undefined }),
    (_e, plugin: unknown, field: unknown, value: unknown) => {
      if (typeof plugin !== "string" || typeof field !== "string" || (value !== null && typeof value !== "string")) throw new Error("bad secret");
      const kept = appSecrets().set(pluginKey("tool", plugin), field, value as string | null);
      changed();
      return { kept };
    });
}
