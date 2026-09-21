import { describe, expect, test } from "bun:test";
import { LAYOUT_MAX_BYTES, MAX_SURFACE_RECTS, NAME_MAX, PROMPT_MAX, parseHostMessage, parsePluginMessage } from "../src/protocol.js";
import { validateViewManifest, viewHost } from "../src/manifest.js";

describe("parsePluginMessage", () => {
  test("accepts every well-formed message", () => {
    const ok = [
      { type: "ready", v: 1 },
      { type: "command", name: "selectTile", args: ["t1"] },
      { type: "command", name: "selectTile", args: [null] },
      { type: "command", name: "focusTile", args: ["t1", { exact: true }] },
      { type: "command", name: "spawnTile", args: ["shell", null] },
      { type: "command", name: "spawnVis", args: ["diff"] },
      { type: "command", name: "addFrame" },
      { type: "command", name: "spawnAgent", args: [null, null] },
      { type: "command", name: "spawnAgent", args: ["codex", "f1", { prompt: "fix the build", name: "fixer" }] },
      { type: "command", name: "renameTile", args: ["t1", ""] },
      { type: "command", name: "openFolder", args: ["f1"] },
      { type: "subscribeStatus", tileId: "t1" },
      { type: "unsubscribeStatus", tileId: "t1" },
      { type: "surfaceRects", rects: [{ tileId: "t1", x: 1, y: 2, w: 3, h: 4 }] },
      { type: "surfaceRects", rects: [] },
      { type: "surfaceRects", rects: [{ tileId: "t1", x: 1, y: 2, w: 3, h: 4, chrome: "none" }] },
      { type: "revealed", requestId: 3, rect: null },
      { type: "revealed", requestId: 3, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { type: "framesDrawn", count: 0 },
      { type: "layout", data: { camera: [1, 2] } },
      { type: "error", message: "boom" },
    ];
    for (const m of ok) expect(parsePluginMessage(m).ok, JSON.stringify(m)).toBe(true);
  });

  test("refuses malformed messages with a reason", () => {
    const bad: unknown[] = [
      null, 42, "ready", [], {}, { type: 7 }, { type: "nope" },
      { type: "ready" },
      { type: "command", name: "evaluate", args: [] },
      { type: "command", name: "selectTile", args: [7] },
      { type: "command", name: "selectTile", args: ["a", "b"] },
      { type: "command", name: "spawnTile", args: ["shell"] },
      { type: "command", name: "spawnVis", args: ["browser"] },
      { type: "command", name: "spawnAgent", args: [null] },
      { type: "command", name: "spawnAgent", args: [null, null, null] },
      { type: "command", name: "spawnAgent", args: [null, null, { prompt: 5 }] },
      { type: "command", name: "spawnAgent", args: [null, null, { prompt: "x".repeat(PROMPT_MAX + 1) }] },
      { type: "command", name: "renameTile", args: [null, "x"] },
      { type: "command", name: "renameTile", args: ["t1", "x".repeat(NAME_MAX + 1)] },
      { type: "command", name: "openFolder", args: [null] },
      { type: "command", name: "__proto__", args: [] },
      { type: "command", name: "constructor", args: [] },
      { type: "subscribeStatus" },
      { type: "subscribeStatus", tileId: "x".repeat(300) },
      { type: "surfaceRects", rects: [{ tileId: "t", x: NaN, y: 0, w: 1, h: 1 }] },
      { type: "surfaceRects", rects: [{ tileId: "t", x: 0, y: 0, w: 1, h: 1 }, { tileId: "t", x: 0, y: 0, w: 1, h: 1 }] },
      { type: "surfaceRects", rects: Array.from({ length: MAX_SURFACE_RECTS + 1 }, (_, i) => ({ tileId: `t${i}`, x: 0, y: 0, w: 1, h: 1 })) },
      { type: "surfaceRects", rects: [{ tileId: "t1", x: 1, y: 2, w: 3, h: 4, chrome: "sidebar" }] },
      { type: "revealed", requestId: "3", rect: null },
      { type: "framesDrawn", count: -1 },
      { type: "layout", data: "x".repeat(LAYOUT_MAX_BYTES + 1) },
      { type: "error", message: 5 },
    ];
    for (const m of bad) {
      const r = parsePluginMessage(m);
      expect(r.ok, JSON.stringify(m)?.slice(0, 80)).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test("normalises: drops extra rect fields, truncates long error text", () => {
    const r = parsePluginMessage({ type: "surfaceRects", rects: [{ tileId: "t", x: 1, y: 2, w: 3, h: 4, evil: "x" }] });
    expect(r.ok && r.msg).toEqual({ type: "surfaceRects", rects: [{ tileId: "t", x: 1, y: 2, w: 3, h: 4 }] });
    const e = parsePluginMessage({ type: "error", message: "y".repeat(5000) });
    expect(e.ok && e.msg.type === "error" && e.msg.message.length).toBe(2000);
  });
});

describe("parseHostMessage", () => {
  test("accepts host messages and rejects junk", () => {
    expect(parseHostMessage({ type: "hello", v: 1, pluginId: "p", capabilities: [], theme: { colors: {} }, layout: null, viewport: { w: 1, h: 1 }, visible: true }).ok).toBe(true);
    expect(parseHostMessage({ type: "status", tileId: "t", status: "working" }).ok).toBe(true);
    expect(parseHostMessage({ type: "status", tileId: "t", status: "purple" }).ok).toBe(false);
    expect(parseHostMessage({ type: "selection", tileId: null, frameId: null, fresh: false }).ok).toBe(true);
    expect(parseHostMessage({ type: "selection", tileId: null, frameId: null }).ok).toBe(false);
    expect(parseHostMessage({ type: "undock", tileId: "t1" }).ok).toBe(true);
    expect(parseHostMessage({ type: "undock" }).ok).toBe(false);
    expect(parseHostMessage({ type: "bogus" }).ok).toBe(false);
  });
});

describe("validateViewManifest", () => {
  const good = { id: "orbit", name: "Orbit", version: "0.1.0", entry: "index.html", permissions: [] };
  test("accepts a minimal manifest and fills defaults", () => {
    const r = validateViewManifest(good);
    expect(r.ok && r.manifest).toEqual({ id: "orbit", name: "Orbit", version: "0.1.0", entry: "index.html", protocol: 1, permissions: [] });
  });
  test("an id is a name, or @owner/name from the registry, and never passes for one it is not", () => {
    const ok = (id: string) => validateViewManifest({ ...good, id }).ok;
    expect(ok("board")).toBe(true);
    expect(ok("@dip497/board")).toBe(true);
    // `--` is what a scoped id becomes as a hostname, so a bare one may not contain it.
    expect(ok("dip497--board")).toBe(false);
    expect(ok("@dip497/bo--ard")).toBe(false);
    for (const bad of ["dip497/board", "@/board", "@Dip/board", "@a/b/c", "@a/../b", "@dip497/"]) expect(ok(bad)).toBe(false);
    // The hostname label is at most 63 characters.
    expect(ok(`@${"a".repeat(39)}/${"b".repeat(22)}`)).toBe(true);
    expect(ok(`@${"a".repeat(39)}/${"b".repeat(23)}`)).toBe(false);
  });
  test("a view's sandbox host is its id, or owner--name for a scoped one", () => {
    expect(viewHost("board")).toBe("board");
    expect(viewHost("@dip497/board")).toBe("dip497--board");
    expect(new URL(`http://${viewHost("@dip497/board")}/x`).host).toBe("dip497--board");
  });
  test("reports every problem", () => {
    const r = validateViewManifest({ id: "Bad Id", name: "", version: "one", entry: "../x.js", permissions: ["fs:read", "workspace:spawn"], protocol: 0, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toMatch(/"id" must be a name or @owner\/name/);
      expect(r.errors.join("\n")).toMatch(/"name" must be a non-empty/);
      expect(r.errors.join("\n")).toMatch(/"version" must look like/);
      expect(r.errors.join("\n")).toMatch(/"entry" must be a relative path/);
      expect(r.errors.join("\n")).toMatch(/unknown permission "fs:read"/);
      expect(r.errors.join("\n")).toMatch(/"protocol" must be a positive integer/);
      expect(r.errors.join("\n")).toMatch(/unknown field "extra"/);
      expect(r.errors).toHaveLength(7);
    }
  });
  test("entry must be .html or .js inside the package", () => {
    expect(validateViewManifest({ ...good, entry: "dist/view.js" }).ok).toBe(true);
    expect(validateViewManifest({ ...good, entry: "/abs/view.js" }).ok).toBe(false);
    expect(validateViewManifest({ ...good, entry: "view.wasm" }).ok).toBe(false);
    expect(validateViewManifest({ ...good, entry: "a/../../view.js" }).ok).toBe(false);
  });
  test("known permissions are kept, de-duplicated", () => {
    const r = validateViewManifest({ ...good, permissions: ["workspace:close", "workspace:close"] });
    expect(r.ok && r.manifest.permissions).toEqual(["workspace:close"]);
  });
});
