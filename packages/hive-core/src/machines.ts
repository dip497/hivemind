/** Saved ssh machines (`$XDG_CONFIG_HOME/hivemind/machines.json`). Holds no secrets: auth stays with OpenSSH. */
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { HiveError } from "./storage.js";

export interface Machine {
  /** Opaque, never derived from label or host. */
  id: string;
  label: string;
  /** `host`, `user@host`, an ssh_config alias, or `ssh://user@host:port`. */
  target: string;
  enabled: boolean;
  /** Absolute, because a non-interactive ssh session has a bare PATH. */
  hivePath?: string;
  platform?: string;
}

interface MachinesFile {
  version: 1;
  machines: Machine[];
}

const VERSION = 1;
export const MACHINE_LIMITS = { fileBytes: 64 * 1024, machines: 64, labelBytes: 128, targetBytes: 1024 } as const;
const FIELDS = new Set(["id", "label", "target", "enabled", "hivePath", "platform"]);
const ID_RE = /^m_[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export function machinesPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "machines.json");
}

export function newMachineId(): string {
  return `m_${randomBytes(6).toString("hex")}`;
}

/** Rejects anything ssh could parse as an option (`-oProxyCommand=…` runs code). */
export function validateTarget(target: string): string {
  const t = target.trim();
  if (!t) throw new HiveError("machine_target_invalid", "ssh target is empty");
  if (Buffer.byteLength(t) > MACHINE_LIMITS.targetBytes) throw new HiveError("machine_target_invalid", `ssh target is longer than ${MACHINE_LIMITS.targetBytes} bytes`);
  if (CONTROL.test(t) || /\s/.test(t)) throw new HiveError("machine_target_invalid", "ssh target must not contain whitespace or control characters");
  if (t.startsWith("-")) throw new HiveError("machine_target_invalid", "ssh target must not start with '-'");
  const authority = t.startsWith("ssh://") ? t.slice("ssh://".length).split("/")[0]! : t;
  const at = authority.lastIndexOf("@");
  if (at >= 0 && authority.slice(0, at).includes(":")) throw new HiveError("machine_target_invalid", "ssh target must not contain a password — use keys or ssh-agent");
  // An ssh:// authority, and the host after `@`, become argv tokens too.
  if (authority.startsWith("-") || authority.slice(at + 1).startsWith("-")) {
    throw new HiveError("machine_target_invalid", "ssh user/host must not start with '-'");
  }
  if (t.startsWith("ssh://")) {
    const m = /^([^@/:]+@)?([^@/:]+)(:(\d{1,5}))?$/.exec(authority);
    if (!m || (m[4] !== undefined && (Number(m[4]) < 1 || Number(m[4]) > 65535))) {
      throw new HiveError("machine_target_invalid", "ssh:// target must look like ssh://[user@]host[:port]");
    }
  }
  return t;
}

export function validateLabel(label: string): string {
  const l = label.trim();
  if (!l) throw new HiveError("machine_label_invalid", "label is empty");
  if (Buffer.byteLength(l) > MACHINE_LIMITS.labelBytes) throw new HiveError("machine_label_invalid", `label is longer than ${MACHINE_LIMITS.labelBytes} bytes`);
  if (CONTROL.test(l)) throw new HiveError("machine_label_invalid", "label must not contain control characters");
  return l;
}

/** `ssh://user@host:2222` → `["-p","2222","user@host"]`; anything else passes through. */
export function sshDestination(target: string): string[] {
  if (!target.startsWith("ssh://")) return [target];
  const m = /^ssh:\/\/([^/]*?)(?::(\d+))?(?:\/.*)?$/.exec(target);
  if (!m) return [target];
  return m[2] ? ["-p", m[2], m[1]!] : [m[1]!];
}

function validateMachine(v: unknown, i: number): Machine {
  const where = `machines[${i}]`;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HiveError("machines_invalid", `${where} is not an object`);
  for (const k of Object.keys(v)) if (!FIELDS.has(k)) throw new HiveError("machines_invalid", `${where} has unknown field '${k}'`);
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new HiveError("machines_invalid", `${where}.id is not a machine id`);
  if (typeof m.label !== "string") throw new HiveError("machines_invalid", `${where}.label is missing`);
  if (typeof m.target !== "string") throw new HiveError("machines_invalid", `${where}.target is missing`);
  if (typeof m.enabled !== "boolean") throw new HiveError("machines_invalid", `${where}.enabled must be a boolean`);
  for (const k of ["hivePath", "platform"] as const) {
    if (m[k] !== undefined && (typeof m[k] !== "string" || CONTROL.test(m[k] as string))) throw new HiveError("machines_invalid", `${where}.${k} is invalid`);
  }
  if (typeof m.hivePath === "string" && !m.hivePath.startsWith("/")) throw new HiveError("machines_invalid", `${where}.hivePath must be absolute`);
  const out: Machine = { id: m.id, label: validateLabel(m.label), target: validateTarget(m.target), enabled: m.enabled };
  if (m.hivePath !== undefined) out.hivePath = m.hivePath as string;
  if (m.platform !== undefined) out.platform = m.platform as string;
  return out;
}

/** Strict, so a catalog we don't fully understand is never half-applied. */
export function parseMachines(raw: string): Machine[] {
  if (Buffer.byteLength(raw) > MACHINE_LIMITS.fileBytes) throw new HiveError("machines_invalid", `machines.json is larger than ${MACHINE_LIMITS.fileBytes} bytes`);
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch (e) { throw new HiveError("machines_invalid", `machines.json is not valid JSON: ${(e as Error).message}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new HiveError("machines_invalid", "machines.json is not an object");
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) if (k !== "version" && k !== "machines") throw new HiveError("machines_invalid", `machines.json has unknown field '${k}'`);
  if (d.version !== VERSION) throw new HiveError("machines_invalid", `machines.json version ${String(d.version)} is not supported (expected ${VERSION})`);
  if (!Array.isArray(d.machines)) throw new HiveError("machines_invalid", "machines.json 'machines' is not an array");
  if (d.machines.length > MACHINE_LIMITS.machines) throw new HiveError("machines_invalid", `more than ${MACHINE_LIMITS.machines} machines`);
  const list = d.machines.map(validateMachine);
  const ids = new Set<string>();
  for (const m of list) {
    if (ids.has(m.id)) throw new HiveError("machines_invalid", `duplicate machine id ${m.id}`);
    ids.add(m.id);
  }
  return list;
}

export async function readMachines(file = machinesPath()): Promise<Machine[]> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HiveError("machines_unreadable", `cannot read ${file}: ${(e as Error).message}`);
  }
  return parseMachines(raw);
}

/** Atomic and owner-only; never writes through a symlink. */
export async function writeMachines(list: Machine[], file = machinesPath()): Promise<void> {
  const doc: MachinesFile = { version: VERSION, machines: list };
  const body = JSON.stringify(doc, null, 2) + "\n";
  parseMachines(body); // never persist what we would refuse to read back
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const st = await fs.lstat(file).catch(() => null);
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new HiveError("machines_unwritable", `refusing to replace ${file}: not a regular file`);
  const tmp = path.join(dir, `.machines-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fh = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  const dh = await fs.open(dir, "r").catch(() => null);
  if (dh) { await dh.sync().catch(() => {}); await dh.close(); }
}

/** Id first, then exact label; an ambiguous label is an error, never a silent first match. */
export function resolveMachine(list: Machine[], ref: string): Machine {
  const byId = list.find((m) => m.id === ref);
  if (byId) return byId;
  const byLabel = list.filter((m) => m.label === ref);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) throw new HiveError("machine_ambiguous", `label '${ref}' matches ${byLabel.map((m) => m.id).join(", ")} — use the id`);
  throw new HiveError("machine_not_found", `no machine '${ref}' — see \`hive machine list\``);
}
