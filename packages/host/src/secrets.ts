/**
 * The values of plugins' `secret` settings (an API token, a password): never in settings.json,
 * which keeps only that one is set, never in a plugin's `hm.settings`, never in a log. Each is kept
 * in `secrets.json` beside settings.json, 0600, written to a temp file and renamed: encrypted with
 * the system keychain where the app has one (Electron's safeStorage, handed in as a `Cipher`), as
 * it is under `hive host` and from `hive plugins set` with no app running, in the file alone.
 * Only the tool plugin whose service holds a grant reads its own (`secret.get`). Electron-free.
 */
import fs from "node:fs";
import path from "node:path";
import { settingsPath } from "@hivemind/core/settings";
import { FIELD_ID } from "@hivemind/core/plugin-settings";

/** The system keychain, as the app has it: text to base64 and back. */
export interface Cipher {
  encrypt(text: string): string;
  decrypt(data: string): string;
}

/** How a secret is kept: encrypted by the keychain of the app that set it, or in the 0600 file. */
export type KeptBy = "keychain" | "file";

interface Kept { by: KeptBy; data: string }
interface SecretsFile { v: 1; secrets: Record<string, Record<string, Kept>> }

/** Where the secrets are kept: beside settings.json, whichever process asks. */
export const secretsPath = (): string => path.join(path.dirname(settingsPath()), "secrets.json");

/** What a plugin's secrets are filed under: its settings key (`tool:@owner/name`). */
const KEY = /^(agent|view|widget|tool):[^\s]{1,200}$/;
const MAX_SECRET = 16 * 1024;

export class Secrets {
  /** `cipher`: the keychain; none where there is none (`hive host`, the CLI, a Linux without a
   *  keyring), and each secret is then in the 0600 file alone. */
  constructor(private readonly file: string = secretsPath(), private readonly cipher: Cipher | null = null) {}

  /** How a secret set here is kept. */
  get keptBy(): KeptBy {
    return this.cipher ? "keychain" : "file";
  }

  /** Set `name` of the plugin `key`; null takes it away. Answers how it is kept. */
  set(key: string, name: string, value: string | null): KeptBy | null {
    check(key, name);
    if (value !== null && (typeof value !== "string" || !value || value.length > MAX_SECRET)) throw new Error(`a secret is text, 1 to ${MAX_SECRET} characters`);
    const all = this.read();
    const mine = { ...all.secrets[key] };
    if (value === null) delete mine[name];
    else mine[name] = this.cipher ? { by: "keychain", data: this.cipher.encrypt(value) } : { by: "file", data: value };
    if (Object.keys(mine).length) all.secrets[key] = mine;
    else delete all.secrets[key];
    this.write(all);
    return value === null ? null : this.keptBy;
  }

  /** The secret `name` of the plugin `key`; null when none is set. Throws when it was kept by a
   *  keychain this process cannot reach, saying how to set it again. */
  get(key: string, name: string): string | null {
    check(key, name);
    const kept = this.read().secrets[key]?.[name];
    if (!kept) return null;
    if (kept.by === "file") return kept.data;
    if (!this.cipher) throw new Error(`${name} was set in the app, which keeps it in the system keychain; this process cannot read it there: set it again here (\`hive plugins set ${key.slice(key.indexOf(":") + 1)} ${name}\`, the value on stdin)`);
    try {
      return this.cipher.decrypt(kept.data);
    } catch {
      throw new Error(`${name} cannot be read with this keychain any more (it changed since it was set): set it again`);
    }
  }

  /** The names of the plugin `key`'s secrets that are set. */
  names(key: string): string[] {
    return Object.keys(this.read().secrets[key] ?? {}).sort();
  }

  private read(): SecretsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return { v: 1, secrets: {} };
    }
    const parsed = JSON.parse(raw) as Partial<SecretsFile>;
    if (parsed.v !== 1 || !parsed.secrets || typeof parsed.secrets !== "object") throw new Error(`${this.file}: not a secrets file`);
    return parsed as SecretsFile;
  }

  private write(all: SecretsFile): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function check(key: string, name: string): void {
  if (!KEY.test(key)) throw new Error(`${key} names no plugin`);
  if (!FIELD_ID.test(name)) throw new Error(`${name} is not a setting's name`);
}
