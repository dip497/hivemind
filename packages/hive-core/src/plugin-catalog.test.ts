import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHubIndex, type CatalogEntry } from "@hivemind/hub";
import { appMeetsMinVersion, catalogAgentNeedsUpdate, catalogRepoHolds, fetchCatalog, noteInstall, stageEntry } from "./plugin-catalog.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function registry(files: Record<string, string>, entry: Partial<CatalogEntry> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hm-registry-"));
  mkdirSync(join(root, "views", "orbit"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "views", "orbit", name), body);
  const plugin = {
    id: "@hivemind/orbit", type: "view", name: "Orbit", description: "Tiles orbit their frame.", author: "hivemind", version: "0.1.0",
    path: "views/orbit", files: Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })), ...entry,
  };
  writeFileSync(join(root, "index.json"), JSON.stringify({ version: 1, plugins: [plugin] }));
  return { root, url: pathToFileURL(join(root, "index.json")).href };
}

describe("reading the index", () => {
  test("a well-formed index lists its plugins", async () => {
    const { url } = registry({ "hivemind-view.json": "{}" });
    const [e] = (await fetchCatalog(url)).plugins;
    expect(e).toMatchObject({ id: "@hivemind/orbit", type: "view", version: "0.1.0" });
  });
});

describe("staging a download", () => {
  test("files land in a fresh folder when every hash matches", async () => {
    const { url } = registry({ "hivemind-view.json": '{"id":"orbit"}', "orbit.js": "run()" });
    const [e] = (await fetchCatalog(url)).plugins;
    const dir = await stageEntry(e!, url);
    expect(readFileSync(join(dir, "orbit.js"), "utf8")).toBe("run()");
  });

  test("a file changed after listing fails the install and leaves nothing behind", async () => {
    const { root, url } = registry({ "orbit.js": "run()" });
    const [e] = (await fetchCatalog(url)).plugins;
    writeFileSync(join(root, "views", "orbit", "orbit.js"), "steal()");
    let staged = "";
    await expect(stageEntry(e!, url).then((d) => { staged = d; })).rejects.toThrow(/changed after it was listed/);
    expect(staged).toBe("");
  });

  test("only https and local files are fetched", async () => {
    await expect(fetchCatalog("http://example.com/index.json")).rejects.toThrow(/refusing to download from http:/);
    expect(existsSync("/")).toBe(true);
  });
});

test("a plugin that needs a newer Hivemind is told apart before it is downloaded", () => {
  expect(appMeetsMinVersion("2.4.0", "2.4.0")).toBe(true);
  expect(appMeetsMinVersion("2.4.1", "2.4.0")).toBe(true);
  expect(appMeetsMinVersion("2.10.0", "2.9.9")).toBe(true);
  expect(appMeetsMinVersion("2.3.9", "2.4.0")).toBe(false);
  expect(appMeetsMinVersion("1.17.0", undefined)).toBe(true);
});

describe("telling the registry an install happened", () => {
  const entry = (id: string): CatalogEntry => ({
    id, type: "view", name: "N", description: "d", author: "a", version: "1.0.0",
    path: "views/n", files: [],
  });
  const withFetch = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: URL | string) => {
      seen.push(String(u));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
    return seen;
  };

  test("resolves the plugin against the same registry the index came from", async () => {
    const seen = await withFetch(() =>
      noteInstall(entry("@someone/tasks"), "https://hivehub.example/api/v1/index.json"));
    expect(seen).toEqual(["https://hivehub.example/api/v1/plugins/%40someone/tasks/resolve"]);
  });

  test("an agent is one bare name, and still resolves", async () => {
    const seen = await withFetch(() =>
      noteInstall(entry("gemini"), "https://hivehub.example/api/v1/index.json"));
    expect(seen).toEqual(["https://hivehub.example/api/v1/plugins/gemini/resolve"]);
  });

  // A count is never worth failing an install that already succeeded, and a local
  // file: index (development) is nobody's to count.
  test("a registry that is down or not https changes nothing", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    try {
      await noteInstall(entry("@a/b"), "https://hivehub.example/api/v1/index.json");
    } finally { globalThis.fetch = real; }
    const seen = await withFetch(() => noteInstall(entry("@a/b"), "file:///tmp/index.json"));
    expect(seen).toEqual([]);
  });
});

test("an installed agent follows the catalog only while it is the catalog's own, untouched copy", () => {
  const entry = parseHubIndex({ version: 1, plugins: [{ id: "claude", type: "agent", name: "Claude", description: "d", author: "a",
    version: "1.0.0", path: "agents/claude", minAppVersion: "2026.9.6", files: [{ path: "agent.yaml", sha256: "b".repeat(64) }] }] }).plugins[0]!;
  const old = "a".repeat(64);
  const base = { fromCatalog: true, manifestSha: old, recordedSha: old, appVersion: "2026.9.6" };
  expect(catalogAgentNeedsUpdate(entry, base)).toBe(true);
  expect(catalogAgentNeedsUpdate(entry, { ...base, recordedSha: null })).toBe(true); // installed before this was recorded
  expect(catalogAgentNeedsUpdate(entry, { ...base, recordedSha: "c".repeat(64) })).toBe(false); // edited since
  expect(catalogAgentNeedsUpdate(entry, { ...base, fromCatalog: false })).toBe(false); // the user's own
  // Nothing recorded installing it, but its bytes are a version the catalog published.
  const unrecorded = { ...base, fromCatalog: false, recordedSha: null, published: true };
  expect(catalogAgentNeedsUpdate(entry, unrecorded)).toBe(true);
  expect(catalogAgentNeedsUpdate(entry, { ...unrecorded, published: false })).toBe(false);
  expect(catalogAgentNeedsUpdate(entry, { ...unrecorded, manifestSha: "b".repeat(64) })).toBe(false);
  expect(catalogAgentNeedsUpdate(entry, { ...base, appVersion: "2026.9.5" })).toBe(false); // needs a newer app
  expect(catalogAgentNeedsUpdate(entry, { ...base, manifestSha: "b".repeat(64) })).toBe(false); // already current
});

test("an agent this app cannot load is repaired from the catalog, however it was installed", () => {
  const entry = parseHubIndex({ version: 1, plugins: [{ id: "claude", type: "agent", name: "Claude", description: "d", author: "a",
    version: "1.0.0", path: "agents/claude", minAppVersion: "2026.9.7", files: [{ path: "agent.yaml", sha256: "b".repeat(64) }] }] }).plugins[0]!;
  // Installed by an older app, so nothing recorded it and it is not in fromCatalog — and its
  // manifest is one this app refuses. It does nothing as it is, so the catalog's copy wins.
  const broken = { fromCatalog: false, manifestSha: "a".repeat(64), recordedSha: null, appVersion: "2026.9.7", broken: true };
  expect(catalogAgentNeedsUpdate(entry, broken)).toBe(true);
  expect(catalogAgentNeedsUpdate(entry, { ...broken, broken: false })).toBe(false);
  // Still never onto an app too old to run what the catalog lists.
  expect(catalogAgentNeedsUpdate(entry, { ...broken, appVersion: "2026.9.6" })).toBe(false);
});

test("a file is the catalog's when its repository on GitHub holds those exact bytes", async () => {
  const entry = parseHubIndex({ version: 1, plugins: [{ id: "codex", type: "agent", name: "Codex", description: "d", author: "a",
    version: "1.0.0", path: "agents/codex", source: `https://raw.githubusercontent.com/dip497/hivemind-plugins/${"1".repeat(40)}/`,
    files: [{ path: "agent.yaml", sha256: "b".repeat(64) }] }] }).plugins[0]!;
  const asked: string[] = [];
  const answering = async (status: number | Error, fn: () => Promise<boolean>): Promise<boolean> => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: URL | string, init?: RequestInit) => {
      asked.push(`${init?.method} ${String(u)}`);
      if (status instanceof Error) throw status;
      return new Response(null, { status });
    }) as typeof fetch;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  const hello = new TextEncoder().encode("hello\n");
  expect(await answering(200, () => catalogRepoHolds(entry, hello))).toBe(true);
  // git's blob id of "hello\n", as `git hash-object` prints it.
  expect(asked).toEqual(["HEAD https://api.github.com/repos/dip497/hivemind-plugins/git/blobs/ce013625030ba8dba906f756967f9e9ca394464a"]);
  expect(await answering(404, () => catalogRepoHolds(entry, hello))).toBe(false);
  expect(await answering(new Error("offline"), () => catalogRepoHolds(entry, hello))).toBe(false);
  asked.length = 0;
  expect(await answering(200, () => catalogRepoHolds({ ...entry, source: "https://example.test/repo/" }, hello))).toBe(false);
  expect(asked).toEqual([]);
});

describe("a hub's index read through the hub kit", () => {
  const typical = (i: number) => ({
    id: `@acme/plugin-${i}`, type: "widget", name: `Plugin ${i}`, author: "acme", version: "1.0.0", path: `widgets/plugin-${i}`,
    // About the size of a real entry: HiveHub's average is 1,693 bytes as served.
    description: "A widget that shows something useful on the board. ".repeat(7),
    source: `https://raw.githubusercontent.com/acme/hivemind-plugins/${"1".repeat(40)}/`,
    files: Array.from({ length: 6 }, (_, j) => ({ path: `file-${j}.js`, sha256: sha(`${i}-${j}`) })),
  });
  const served = (plugins: unknown[]) => {
    const root = mkdtempSync(join(tmpdir(), "hm-hub-"));
    writeFileSync(join(root, "index.json"), JSON.stringify({ version: 1, plugins }, null, 2));
    return pathToFileURL(join(root, "index.json")).href;
  };

  test("one entry this app cannot read is skipped and named, and the rest are still listed", async () => {
    const url = served([typical(1), { ...typical(2), id: "not a widget id" }, typical(3)]);
    const read = await fetchCatalog(url);
    expect(read.plugins.map((e) => e.id)).toEqual(["@acme/plugin-1", "@acme/plugin-3"]);
    expect(read.skipped).toEqual([{ position: 1, id: "not a widget id", reason: "its id is not a widget id — it must be @owner/name" }]);
  });

  test("an index past 500 typical entries comes through whole, up to 2,000, and says what it left out", async () => {
    const url = served(Array.from({ length: 2001 }, (_, i) => typical(i)));
    const read = await fetchCatalog(url);
    expect(read.plugins).toHaveLength(2000);
    expect(read.plugins.at(-1)!.id).toBe("@acme/plugin-1999");
    expect(read.skipped).toEqual([{ position: 2000, id: null, reason: "the index lists 2001 plugins; Hivemind reads the first 2000" }]);
  });
});
