import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appMeetsMinVersion, fetchCatalog, noteInstall, parseCatalog, stageEntry, type CatalogEntry } from "./plugin-catalog.js";

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
    const [e] = await fetchCatalog(url);
    expect(e).toMatchObject({ id: "@hivemind/orbit", type: "view", version: "0.1.0" });
  });

  test("entries that could reach outside their folder or skip integrity are refused", () => {
    const base = { id: "@a/x", type: "view", name: "X", description: "d", author: "a", version: "1", path: "views/x", files: [{ path: "a.js", sha256: "0".repeat(64) }] };
    const bad = (patch: object) => () => parseCatalog({ version: 1, plugins: [{ ...base, ...patch }] });
    // A view carries its publisher's scope; an agent is one name, never scoped.
    expect(bad({ id: "x" })).toThrow(/must be @owner\/name/);
    expect(bad({ id: "a/x" })).toThrow(/must be @owner\/name/);
    expect(bad({ id: "@a/x--y" })).toThrow(/must be @owner\/name/);
    expect(bad({ type: "agent", id: "@a/x" })).toThrow(/must be one name/);
    expect(() => parseCatalog({ version: 1, plugins: [{ ...base, type: "agent", id: "gemini" }] })).not.toThrow();
    expect(bad({ path: "../etc" })).toThrow(/relative folder/);
    expect(bad({ path: "/abs" })).toThrow(/relative folder/);
    expect(bad({ files: [{ path: "../../x", sha256: "0".repeat(64) }] })).toThrow(/relative path/);
    expect(bad({ files: [{ path: "a.js" }] })).toThrow(/sha256/);
    expect(bad({ files: [{ path: "NUL.js", sha256: "0".repeat(64) }] })).toThrow(/relative path/);
    expect(bad({ type: "tool" })).toThrow(/agent or view/);
    expect(bad({ bin: "x" })).toThrow(/bare name of an agent/); // views have no CLI
    expect(bad({ type: "agent", id: "x", bin: "../bin/sh" })).toThrow(/bare name/);
    expect(bad({ id: "Bad Id" })).toThrow(/view id/);
    expect(() => parseCatalog({ version: 2, plugins: [] })).toThrow(/version 1/);
  });
});

describe("staging a download", () => {
  test("files land in a fresh folder when every hash matches", async () => {
    const { url } = registry({ "hivemind-view.json": '{"id":"orbit"}', "orbit.js": "run()" });
    const [e] = await fetchCatalog(url);
    const dir = await stageEntry(e!, url);
    expect(readFileSync(join(dir, "orbit.js"), "utf8")).toBe("run()");
  });

  test("a file changed after listing fails the install and leaves nothing behind", async () => {
    const { root, url } = registry({ "orbit.js": "run()" });
    const [e] = await fetchCatalog(url);
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

test("a plugin may live in its own repository, and a source that is not an https base is refused", async () => {
  const entry = { id: "far", type: "agent", name: "Far", description: "d", author: "a", version: "1.0.0",
    path: "agents/far", source: "https://example.test/repo/", files: [{ path: "agent.yaml", sha256: "0".repeat(64) }] };
  const [parsed] = parseCatalog({ version: 1, plugins: [entry] });
  expect(parsed!.source).toBe("https://example.test/repo/");
  for (const bad of ["http://example.test/", "https://example.test/../etc", "file:///etc", 7]) {
    expect(() => parseCatalog({ version: 1, plugins: [{ ...entry, source: bad }] })).toThrow(/source must be an https base URL/);
  }
  // Absent is the normal case: the files sit beside the index.
  expect(parseCatalog({ version: 1, plugins: [{ ...entry, source: undefined }] })[0]!.source).toBeUndefined();
});

test("a plugin can name the oldest Hivemind it runs on", () => {
  const base = { id: "@a/new", type: "view", name: "N", description: "d", author: "a", version: "1.0.0",
    path: "views/new", files: [{ path: "index.html", sha256: "0".repeat(64) }] };
  expect(parseCatalog({ version: 1, plugins: [{ ...base, minAppVersion: "2.4.0" }] })[0]!.minAppVersion).toBe("2.4.0");
  expect(() => parseCatalog({ version: 1, plugins: [{ ...base, minAppVersion: "next" }] })).toThrow(/minAppVersion/);
  expect(appMeetsMinVersion("2.4.0", "2.4.0")).toBe(true);
  expect(appMeetsMinVersion("2.4.1", "2.4.0")).toBe(true);
  expect(appMeetsMinVersion("2.10.0", "2.9.9")).toBe(true);
  expect(appMeetsMinVersion("2.3.9", "2.4.0")).toBe(false);
  expect(appMeetsMinVersion("1.17.0", undefined)).toBe(true);
});

test("an agent may carry its own mark, bounded but not understood here", () => {
  const base = { id: "acme", type: "agent", name: "Acme", description: "d", author: "a", version: "1.0.0",
    path: "agents/acme", files: [{ path: "agent.yaml", sha256: "0".repeat(64) }] };
  const icon = { viewBox: "0 0 16 16", shapes: [{ rect: { x: "2", y: "2", width: "12", height: "12" } }] };
  // Carried through as written: what an icon may contain is decided where it is drawn.
  expect(parseCatalog({ version: 1, plugins: [{ ...base, icon }] })[0]!.icon).toEqual(icon);
  expect(parseCatalog({ version: 1, plugins: [{ ...base }] })[0]!.icon).toBeUndefined();
  for (const bad of ["<svg/>", 7, { shapes: Array.from({ length: 400 }, () => ({ rect: { x: "1" } })) }]) {
    expect(() => parseCatalog({ version: 1, plugins: [{ ...base, icon: bad }] })).toThrow(/icon must be a small object/);
  }
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
      noteInstall(entry("@dip497/queue"), "https://hivehub.example/api/v1/index.json"));
    expect(seen).toEqual(["https://hivehub.example/api/v1/plugins/%40dip497/queue/resolve"]);
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
