import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchCatalog, parseCatalog, stageEntry, type CatalogEntry } from "./plugin-catalog.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function registry(files: Record<string, string>, entry: Partial<CatalogEntry> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hm-registry-"));
  mkdirSync(join(root, "views", "orbit"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "views", "orbit", name), body);
  const plugin = {
    id: "orbit", type: "view", name: "Orbit", description: "Tiles orbit their frame.", author: "hivemind", version: "0.1.0",
    path: "views/orbit", files: Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })), ...entry,
  };
  writeFileSync(join(root, "index.json"), JSON.stringify({ version: 1, plugins: [plugin] }));
  return { root, url: pathToFileURL(join(root, "index.json")).href };
}

describe("reading the index", () => {
  test("a well-formed index lists its plugins", async () => {
    const { url } = registry({ "hivemind-view.json": "{}" });
    const [e] = await fetchCatalog(url);
    expect(e).toMatchObject({ id: "orbit", type: "view", version: "0.1.0" });
  });

  test("entries that could reach outside their folder or skip integrity are refused", () => {
    const base = { id: "x", type: "view", name: "X", description: "d", author: "a", version: "1", path: "views/x", files: [{ path: "a.js", sha256: "0".repeat(64) }] };
    const bad = (patch: object) => () => parseCatalog({ version: 1, plugins: [{ ...base, ...patch }] });
    expect(bad({ path: "../etc" })).toThrow(/relative folder/);
    expect(bad({ path: "/abs" })).toThrow(/relative folder/);
    expect(bad({ files: [{ path: "../../x", sha256: "0".repeat(64) }] })).toThrow(/relative path/);
    expect(bad({ files: [{ path: "a.js" }] })).toThrow(/sha256/);
    expect(bad({ files: [{ path: "NUL.js", sha256: "0".repeat(64) }] })).toThrow(/relative path/);
    expect(bad({ type: "tool" })).toThrow(/agent or view/);
    expect(bad({ bin: "x" })).toThrow(/bare name of an agent/); // views have no CLI
    expect(bad({ type: "agent", bin: "../bin/sh" })).toThrow(/bare name/);
    expect(bad({ id: "Bad Id" })).toThrow(/plugin id/);
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
