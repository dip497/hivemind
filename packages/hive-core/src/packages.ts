/** Read-only bundle inspection. Execution and installation are deliberately separate APIs. */
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateViewManifest, isSafeRelativePath } from "@hivemind/view-sdk/manifest";
import { PROTOCOL_VERSION } from "@hivemind/view-sdk/protocol";
import { HiveError } from "./storage.js";

export const PACKAGE_MANIFEST = "hivemind-package.json";
export const PACKAGE_LIMITS = { files: 4096, bytes: 128 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, jsonBytes: 64 * 1024, depth: 16 } as const;
// An agent or view a bundle names: built in, or `@owner/name` from HiveHub.
const id = z.string().regex(/^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{1,63}$/);
const label = z.string().min(1).max(120).refine((s) => !/[\x00-\x1f\x7f]/.test(s), "control characters are not allowed");
const relative = z.string().refine((s) => isSafeRelativePath(s) && !/[\x00-\x1f\x7f]/.test(s), "expected a relative path inside the package");
const schema = z.object({
  apiVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}$/),
  name: label,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  views: z.array(z.object({ path: relative }).strict()).max(8).default([]),
  agents: z.array(z.object({
    id, name: label, provider: id, model: label.optional(),
    prompt: z.string().min(1).max(16000).refine((s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s), "invalid prompt control character"),
  }).strict()).max(16).default([]),
  startup: z.object({
    view: id.optional(),
    agents: z.array(id).max(8).default([]),
    maxConcurrent: z.number().int().min(1).max(4).default(1),
  }).strict().optional(),
}).strict();

export type PackageManifest = z.infer<typeof schema>;
export interface PackageProvider { id: string; enabled: boolean; modelFlag: boolean; supervision: string }
const fail = (message: string): never => { throw new HiveError("invalid_package", message); };

export function parsePackageManifest(raw: unknown): PackageManifest {
  const result = schema.safeParse(raw);
  if (!result.success) return fail(result.error.issues.map((e) => `${e.path.join(".") || "manifest"}: ${e.message}`).join("; "));
  const m = result.data;
  if (!m.views.length && !m.agents.length) fail("package must contain a view or agent preset");
  unique(m.agents.map((a) => a.id), "agent preset");
  unique(m.views.map((v) => v.path), "view path");
  if (m.startup) {
    unique(m.startup.agents, "startup agent");
    for (const a of m.startup.agents) if (!m.agents.some((p) => p.id === a)) fail(`unknown startup agent: ${a}`);
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

/** Hash a bounded directory without importing package code or following file symlinks.
 * This is an inspection snapshot, not an authorization token for a future install.
 * An installer must independently verify its private staging directory at commit time. */
async function snapshot(directory: string) {
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
    for await (const entry of await fs.opendir(path.join(root, dir))) {
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
          if (capture) chunks.push(Buffer.from(chunk));
        }
        const after = await handle.stat();
        if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`entry changed during inspection: ${name}`);
        files.push({ path: name, bytes: size, sha256: hash.digest("hex") });
        if (capture) json.set(name, Buffer.concat(chunks).toString("utf8"));
      } finally { await handle.close(); }
    }
  }
  await walk("", 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { files, json, bytes, sha256 };
}

export async function inspectPackage(directory: string, providers: readonly PackageProvider[]) {
  const data = await snapshot(directory);
  const raw = data.json.get(PACKAGE_MANIFEST);
  if (!raw) fail(`missing ${PACKAGE_MANIFEST}`);
  const manifest = parsePackageManifest(parseJson(raw!, PACKAGE_MANIFEST));
  const knownFiles = new Set(data.files.map((f) => f.path));
  const views = manifest.views.map((view) => {
    const name = `${view.path}/hivemind-view.json`;
    const text = data.json.get(name);
    if (!text) return fail(`missing ${name}`);
    const result = validateViewManifest(parseJson(text, name));
    if (!result.ok) return fail(`${name}: ${result.errors.join("; ")}`);
    const v = result.manifest;
    if (["canvas", "windows", "world"].includes(v.id)) fail(`reserved view id: ${v.id}`);
    if (v.protocol > PROTOCOL_VERSION) fail(`unsupported view protocol: ${v.protocol}`);
    if (!knownFiles.has(`${view.path}/${v.entry}`)) fail(`missing view entry: ${view.path}/${v.entry}`);
    return { path: view.path, id: v.id, name: v.name, version: v.version, permissions: v.permissions };
  });
  unique(views.map((v) => v.id), "view id");
  if (manifest.startup?.view && !views.some((v) => v.id === manifest.startup!.view)) fail(`unknown startup view: ${manifest.startup.view}`);
  const agents = manifest.agents.map((a) => {
    const provider = providers.find((p) => p.id === a.provider && p.enabled);
    if (!provider) return fail(`provider is not supported by this host: ${a.provider}`);
    if (a.model && !provider.modelFlag) fail(`provider does not support model selection through Hivemind: ${a.provider}`);
    return { ...a, supervision: provider.supervision };
  });
  return {
    mode: "inspect-only" as const, manifest, digest: { algorithm: "sha256" as const, value: data.sha256 },
    files: data.files, bytes: data.bytes, views, agents,
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
