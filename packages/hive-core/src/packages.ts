/**
 * A package's folder, read: its own `hivemind-package.json` and every member it names, each checked
 * by its kind (`./package-kinds.ts`), or a folder of one plugin, which is a package of one. Also
 * the bounded walk that hashes a package (and copies it, for an install), and the read-only
 * inspection `hive packages inspect` prints. Installing is `./package-install.ts`.
 */
import { promises as fs, constants, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isSafeRelativePath } from "@hivemind/view-sdk/manifest";
import { HiveError } from "./storage.js";
import { label, MEMBER_ID, MEMBER_KINDS, PACKAGE_MANIFEST, type AgentPreset, type CheckedMember } from "./package-kinds.js";

export { PACKAGE_MANIFEST } from "./package-kinds.js";
export const PACKAGE_LIMITS = { files: 4096, bytes: 128 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, jsonBytes: 64 * 1024, depth: 16 } as const;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const schema = z.strictObject({
  apiVersion: z.literal(2),
  id: z.string().regex(MEMBER_ID, "is @owner/name"),
  name: label,
  version: z.string().regex(VERSION),
  ...Object.fromEntries(MEMBER_KINDS.map((k) => [k.list, z.array(k.entry).max(k.most).default([])])),
  startup: z.strictObject({
    view: z.string().optional(),
    agents: z.array(z.string()).max(8).default([]),
    maxConcurrent: z.number().int().min(1).max(4).default(1),
  }).optional(),
});

export interface PackageManifest {
  apiVersion: 2;
  id: string;
  name: string;
  version: string;
  startup?: { view?: string; agents: string[]; maxConcurrent: number };
  /** The members, by the list each kind is named in (`tools`, `widgets`, `views`, `agents`). */
  [list: string]: unknown;
}
export interface PackageProvider { id: string; enabled: boolean; modelFlag: boolean; supervision: string }
const fail = (message: string): never => { throw new HiveError("invalid_package", message); };
const listOf = (m: PackageManifest, list: string): unknown[] => (m[list] as unknown[] | undefined) ?? [];

export function parsePackageManifest(raw: unknown): PackageManifest {
  const result = schema.safeParse(raw);
  if (!result.success) return fail(result.error.issues.map((e) => `${e.path.join(".") || "manifest"}: ${e.message}`).join("; "));
  const m = result.data as unknown as PackageManifest;
  if (MEMBER_KINDS.every((k) => !listOf(m, k.list).length)) fail(`package must hold a ${MEMBER_KINDS.map((k) => k.noun).join(", ")}`);
  for (const k of MEMBER_KINDS) unique(listOf(m, k.list).map((e) => { const x = e as { path?: string; id?: string }; return x.path ?? x.id ?? ""; }), `${k.noun} in ${k.list}`);
  if (m.startup) {
    unique(m.startup.agents, "startup agent");
    const presets = listOf(m, "agents") as AgentPreset[];
    for (const a of m.startup.agents) if (!presets.some((p) => p.id === a)) fail(`unknown startup agent: ${a}`);
    if (!m.startup.view && !m.startup.agents.length) fail("startup must select a view or start an agent");
  }
  return m;
}
function unique(values: string[], what: string) {
  if (new Set(values).size !== values.length) fail(`duplicate ${what}`);
}
function parseJson(text: string, name: string): unknown {
  try { return JSON.parse(text); } catch { return fail(`invalid JSON in ${name}`); }
}

/** A member of a package as read from its folder. */
export interface PackageMemberRead extends CheckedMember { kind: string; path: string }

export interface PackageRead {
  id: string;
  name: string;
  version: string;
  members: PackageMemberRead[];
  /** Its `hivemind-package.json`; null for a package of one. */
  manifest: PackageManifest | null;
}

/**
 * The package in `dir`: its own manifest and every member it names, each checked by its kind, or
 * the one plugin the folder holds. Every member id has the package's owner. `id`, when given, is
 * the id it must have (a HiveHub listing); `folder` is the name of the folder it came from.
 */
export async function readPackage(dir: string, given: { id?: string; folder: string }): Promise<PackageRead> {
  const own = path.join(dir, PACKAGE_MANIFEST);
  if (existsSync(own)) {
    const m = parsePackageManifest(parseJson(await fs.readFile(own, "utf8"), PACKAGE_MANIFEST));
    if (given.id && m.id !== given.id) fail(`its ${PACKAGE_MANIFEST} says it is ${m.id}, not ${given.id}`);
    const owner = m.id.slice(0, m.id.indexOf("/"));
    const members: PackageMemberRead[] = [];
    for (const k of MEMBER_KINDS) {
      for (const entry of listOf(m, k.list)) {
        const c = await k.check(dir, entry, { folder: path.basename(dir) });
        if (!c.id.startsWith(`${owner}/`)) fail(`${k.noun} ${c.id} is not ${owner}'s: every member of ${m.id} is ${owner}/<name>`);
        members.push({ ...c, kind: k.kind });
      }
    }
    unique(members.map((x) => `${x.kind}:${x.id}`), "member id");
    return { id: m.id, name: m.name, version: m.version, members, manifest: m };
  }
  const k = MEMBER_KINDS.find((x) => x.manifest && existsSync(path.join(dir, x.manifest)));
  if (!k) return fail(`it holds no ${[PACKAGE_MANIFEST, ...MEMBER_KINDS.flatMap((x) => x.manifest ?? [])].join(", ")}`);
  const c = await k.check(dir, { path: "." }, given);
  return { id: c.id, name: c.name, version: c.version && VERSION.test(c.version) ? c.version : "0.0.0", members: [{ ...c, kind: k.kind }], manifest: null };
}

/** Folders a package never carries: what a build or a checkout leaves beside the plugin. */
const LEFT_OUT = new Set(["node_modules", ".git"]);

/** Hash a bounded directory without importing package code or following file symlinks, and
 * copy each file into `copyTo` as it is read when one is given. The digest is of what was read,
 * so a copy is exactly what its digest names. Without `copyTo` this is an inspection snapshot,
 * not an authorization token for a future install. */
async function snapshot(directory: string, copyTo?: string) {
  const root = path.resolve(directory);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("package root must be a directory, not a symlink");
  const realRoot = await fs.realpath(root);
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const json = new Map<string, string>();
  let bytes = 0;
  let entries = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > PACKAGE_LIMITS.depth) fail("package directory is too deep");
    if (copyTo) await fs.mkdir(path.join(copyTo, dir), { recursive: true });
    for await (const entry of await fs.opendir(path.join(root, dir))) {
      if (entry.isDirectory() && LEFT_OUT.has(entry.name)) continue;
      if (++entries > PACKAGE_LIMITS.files) fail("package has too many entries");
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (!isSafeRelativePath(name) || /[\x00-\x1f\x7f]/.test(name)) fail("invalid package entry path");
      const target = path.join(root, name);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) fail(`symlink is not allowed: ${name}`);
      const resolved = await fs.realpath(target);
      if (!resolved.startsWith(`${realRoot}${path.sep}`)) fail(`entry leaves the package: ${name}`);
      if (info.isDirectory()) { await walk(name, depth + 1); continue; }
      if (!info.isFile() || info.nlink !== 1) fail(`entry must be a regular, non-linked file: ${name}`);
      const capture = name === PACKAGE_MANIFEST || name.endsWith("/hivemind-view.json");
      // O_NONBLOCK prevents a substituted FIFO from blocking before fstat can reject it.
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // A service the package runs keeps its executable bit; nothing else of the mode is kept.
      const out = copyTo ? await fs.open(path.join(copyTo, name), "wx", (info.mode & 0o755) | 0o600) : null;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.ino !== info.ino || before.dev !== info.dev) fail(`entry changed during inspection: ${name}`);
        const limit = capture ? PACKAGE_LIMITS.jsonBytes : PACKAGE_LIMITS.fileBytes;
        if (before.size > limit) fail(`file too large: ${name}`);
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead; bytes += bytesRead;
          if (size > limit || bytes > PACKAGE_LIMITS.bytes) fail("package exceeds size limits");
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (out) await out.write(chunk);
          if (capture) chunks.push(Buffer.from(chunk));
        }
        const after = await handle.stat();
        if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`entry changed during inspection: ${name}`);
        files.push({ path: name, bytes: size, sha256: hash.digest("hex") });
        if (capture) json.set(name, Buffer.concat(chunks).toString("utf8"));
      } finally { await handle.close(); await out?.close(); }
    }
  }
  await walk("", 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { files, json, bytes, sha256 };
}

/** Copy the package in `directory` into `dest` (which must not be there), checked as an
 *  inspection checks it, and give the digest of what was copied. */
export async function copyPackage(directory: string, dest: string): Promise<{ digest: string; bytes: number }> {
  await fs.mkdir(dest);
  const copied = await snapshot(directory, dest);
  return { digest: copied.sha256, bytes: copied.bytes };
}

export async function inspectPackage(directory: string, providers: readonly PackageProvider[]) {
  const data = await snapshot(directory);
  if (!data.json.get(PACKAGE_MANIFEST)) fail(`missing ${PACKAGE_MANIFEST}`);
  const read = await readPackage(directory, { folder: path.basename(path.resolve(directory)) });
  const manifest = read.manifest!;
  const presets = listOf(manifest, "agents") as AgentPreset[];
  if (manifest.startup?.view && !read.members.some((v) => v.kind === "view" && v.id === manifest.startup!.view)) fail(`unknown startup view: ${manifest.startup.view}`);
  const agents = presets.map((a) => {
    const provider = providers.find((p) => p.id === a.provider && p.enabled);
    if (!provider) return fail(`provider is not supported by this host: ${a.provider}`);
    if (a.model && !provider.modelFlag) fail(`provider does not support model selection through Hivemind: ${a.provider}`);
    return { ...a, supervision: provider.supervision };
  });
  return {
    mode: "inspect-only" as const, manifest, digest: { algorithm: "sha256" as const, value: data.sha256 },
    files: data.files, bytes: data.bytes, members: read.members, agents,
    startup: manifest.startup ? {
      view: manifest.startup.view ?? null,
      agents: manifest.startup.agents.map((id) => agents.find((a) => a.id === id)!),
      maxConcurrent: manifest.startup.maxConcurrent,
      requiresWorkspaceSelection: true, requiresExplicitStart: true,
    } : null,
    notices: [
      "Nothing was installed or started. Provider binaries were not probed.",
      "Agent prompts are untrusted instructions. Agents run with their CLI permissions, not the view sandbox.",
      "This digest identifies the inspected files; it does not verify publisher identity or code safety.",
    ],
  };
}
