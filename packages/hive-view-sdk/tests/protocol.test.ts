import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_MAX_TILES, CUSTOM_DATA_MAX_BYTES, LAYOUT_MAX_BYTES, MAX_SURFACE_RECTS, NAME_MAX, PROMPT_MAX, SHARE_MAX_BYTES,
  customDataProblem, customNameMatches, isCustomEventName, isDay, parseHostMessage, parsePluginMessage, promptProblem, refusal,
  type HostScope, type PluginMessage,
} from "../src/protocol.js";
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

describe("protocol 1.3", () => {
  test("accepts the new plugin messages", () => {
    const ok = [
      { type: "subscribeEvents", kinds: ["turn", "custom"], custom: ["ci.build", "git.*"], replaySince: 0 },
      { type: "subscribeEvents", kinds: [] },
      { type: "unsubscribeEvents" },
      { type: "watchActivity", tileIds: ["t1", "t2"] },
      { type: "watchActivity", tileIds: [] },
      { type: "subscribePresence" },
      { type: "unsubscribePresence" },
      { type: "request", requestId: 1, name: "history", args: [{ day: "2026-09-23" }] },
      { type: "request", requestId: 2, name: "share", args: [{ png: new ArrayBuffer(8), suggestedName: "review-card" }] },
    ];
    for (const m of ok) expect(parsePluginMessage(m).ok, JSON.stringify(m)).toBe(true);
  });

  test("refuses malformed 1.3 messages", () => {
    const bad: unknown[] = [
      { type: "subscribeEvents", kinds: ["status"] },
      { type: "subscribeEvents", kinds: ["custom"], custom: ["Bad Name"] },
      { type: "subscribeEvents", kinds: ["custom"], custom: Array.from({ length: 33 }, (_, i) => `n${i}`) },
      { type: "subscribeEvents", kinds: ["turn"], replaySince: "yesterday" },
      { type: "watchActivity", tileIds: Array.from({ length: ACTIVITY_MAX_TILES + 1 }, (_, i) => `t${i}`) },
      { type: "watchActivity", tileIds: [""] },
      { type: "request", requestId: 1, name: "history", args: [{ day: "2026-02-30" }] },
      { type: "request", requestId: 1, name: "history", args: [] },
      { type: "request", requestId: 1, name: "agentRead", args: [{}] },
      { type: "request", requestId: 1, name: "share", args: [{ png: "data:image/png;base64,AAAA" }] },
      { type: "request", requestId: 1, name: "share", args: [{ png: new ArrayBuffer(SHARE_MAX_BYTES + 1) }] },
      { type: "request", requestId: 1, name: "share", args: [{ png: new ArrayBuffer(8), suggestedName: "../../x" }] },
    ];
    for (const m of bad) expect(parsePluginMessage(m).ok, JSON.stringify(m)?.slice(0, 80)).toBe(false);
  });

  test("de-duplicates subscription lists", () => {
    const r = parsePluginMessage({ type: "subscribeEvents", kinds: ["turn", "turn"], custom: ["a", "a"] });
    expect(r.ok && r.msg).toEqual({ type: "subscribeEvents", kinds: ["turn"], custom: ["a"] });
  });

  test("host messages: status carries since, and the new streams validate their shape", () => {
    expect(parseHostMessage({ type: "status", tileId: "t", status: "blocked", since: 5, exact: false }).ok).toBe(true);
    expect(parseHostMessage({ type: "status", tileId: "t", status: "blocked", since: "5" }).ok).toBe(false);
    expect(parseHostMessage({ type: "events", events: [{ kind: "turn", seq: 1, at: 1, tileId: "t" }] }).ok).toBe(true);
    expect(parseHostMessage({ type: "events", events: [{ kind: "stdout", at: 1 }] }).ok).toBe(false);
    expect(parseHostMessage({ type: "activity", levels: { t: 3 } }).ok).toBe(true);
    expect(parseHostMessage({ type: "activity", levels: { t: 1024 } }).ok).toBe(false);
    expect(parseHostMessage({ type: "presence", presence: { state: "away", since: 1, focused: false } }).ok).toBe(true);
    expect(parseHostMessage({ type: "response", requestId: 1, ok: false, error: { code: "BUSY", message: "" } }).ok).toBe(true);
    expect(parseHostMessage({ type: "response", requestId: 1, ok: false }).ok).toBe(false);
  });

  test("custom event names, patterns and payloads", () => {
    for (const n of ["ci", "ci.build", "deploy-prod.done", "a1.b2"]) expect(isCustomEventName(n), n).toBe(true);
    for (const n of ["", "CI", "ci.", ".ci", "ci..b", "1ci", "hive.x", "hm.x", "x".repeat(65), 5]) expect(isCustomEventName(n), String(n)).toBe(false);
    expect(customNameMatches(["ci.*"], "ci.build")).toBe(true);
    expect(customNameMatches(["ci.*"], "cix.build")).toBe(false);
    expect(customNameMatches(["ci"], "ci.build")).toBe(false);
    expect(customDataProblem({ state: "failed", n: [1, 2] })).toBeNull();
    expect(customDataProblem(null)).toBeNull();
    expect(customDataProblem({ n: Infinity })).toMatch(/plain JSON/);
    expect(customDataProblem({ d: new Date() })).toMatch(/plain JSON/);
    expect(customDataProblem("x".repeat(CUSTOM_DATA_MAX_BYTES))).toMatch(/exceeds/);
    let deep: unknown = 1;
    for (let i = 0; i < 9; i++) deep = [deep];
    expect(customDataProblem(deep)).toMatch(/deeper/);
  });

  test("isDay is a real calendar date", () => {
    expect(isDay("2026-09-23")).toBe(true);
    expect(isDay("2024-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-9-23")).toBe(false);
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

describe("protocol 1.4", () => {
  test("a prompt a view wrote: text only, no keystrokes, nothing hidden", () => {
    expect(promptProblem("run the tests\n\tthen report")).toBeNull();
    for (const bad of ["", "   ", "ok\r", "a\u001b[2Jb", "x\u0085", "safe\u202eevil", "zero\u200bwidth", "x".repeat(PROMPT_MAX + 1), 42]) {
      expect(promptProblem(bad)).not.toBeNull();
    }
  });

  test("requests: agents, sessions, prompt; spawnAgent carries a checked resume and prompt", () => {
    expect(parsePluginMessage({ type: "request", requestId: 1, name: "agents", args: [{}] }).ok).toBe(true);
    expect(parsePluginMessage({ type: "request", requestId: 2, name: "sessions", args: [{ agent: "claude", frameId: "f1" }] }).ok).toBe(true);
    expect(parsePluginMessage({ type: "request", requestId: 3, name: "sessions", args: [{ agent: "claude" }] }).ok).toBe(false);
    expect(parsePluginMessage({ type: "request", requestId: 4, name: "prompt", args: [{ tileId: "t1", text: "go" }] }).ok).toBe(true);
    expect(parsePluginMessage({ type: "request", requestId: 5, name: "prompt", args: [{ tileId: "t1", text: "go\r" }] }).ok).toBe(false);
    const spawn = (o: unknown) => parsePluginMessage({ type: "command", name: "spawnAgent", args: ["claude", "f1", o] }).ok;
    expect(spawn({ resume: "0d3c2a10-1111-4222-8333-444455556666" })).toBe(true);
    expect(spawn({ resume: "../etc" })).toBe(false);
    expect(spawn({ resume: "--help" })).toBe(false);
    expect(spawn({ prompt: "a\u001bb" })).toBe(false);
  });

  test("a status may carry the agent's own; a malformed one is refused", () => {
    const agent = { state: "waiting", waitingFor: "question", subagents: 2, background: 0, compacting: false, source: "hooks" };
    expect(parseHostMessage({ type: "status", tileId: "t1", status: "blocked", agent }).ok).toBe(true);
    expect(parseHostMessage({ type: "status", tileId: "t1", status: "blocked", agent: { state: "thinking", subagents: 0 } }).ok).toBe(false);
  });

  test("manifests may ask for the 1.4 permissions", () => {
    const m = { id: "board", name: "Board", version: "1.0.0", entry: "main.js", protocol: 1, permissions: ["workspace:prompt", "workspace:sessions"] };
    expect(validateViewManifest(m).ok).toBe(true);
  });
});

describe("protocol 1.5", () => {
  // A host that has tile t1 and frame f1, and announced t1 and "closed" (which has gone since).
  const host = (more: Partial<HostScope> = {}): HostScope => ({
    capabilities: [], features: [], hasTile: (id) => id === "t1", hasFrame: (id) => id === "f1", announced: (id) => id === "t1" || id === "closed", ...more,
  });
  const command = (name: string, ...args: unknown[]) => ({ type: "command", name, args }) as PluginMessage;
  const rect = (tileId: string) => ({ tileId, x: 0, y: 0, w: 10, h: 10 });

  const why = (m: PluginMessage, scope: HostScope) => refusal(m, scope)?.why ?? null;

  test("a host refuses a command without its permission, and one naming a tile or frame that is not there", () => {
    const refused = (m: PluginMessage, caps: HostScope["capabilities"] = []) => why(m, host({ capabilities: caps }));
    expect(refused(command("selectTile", "t1"))).toBeNull();
    expect(refused(command("selectTile", null))).toBeNull();
    expect(refused(command("selectTile", "t9"))).toBe("selectTile: unknown tile t9");
    expect(refused(command("focusTile", "t9"))).toBe("focusTile: unknown tile t9");
    expect(refused(command("selectFrame", "f9"))).toBe("selectFrame: unknown frame f9");
    expect(refused(command("closeTile", "t1"))).toBe('closeTile needs permission "workspace:close"');
    expect(refused(command("closeTile", "t9"), ["workspace:close"])).toBe("closeTile: unknown tile t9");
    expect(refused(command("spawnTile", "shell", "f9"), ["workspace:spawn"])).toBe("spawnTile: unknown frame f9");
    expect(refused(command("spawnAgent", null, "f9"), ["workspace:spawn"])).toBe("spawnAgent: unknown frame f9");
    expect(refused(command("spawnAgent", null, "f1", { prompt: "go" }), ["workspace:spawn"])).toBe('spawnAgent with a prompt needs permission "workspace:prompt"');
    expect(refused(command("spawnAgent", null, "f1", { resume: "s1" }), ["workspace:spawn"])).toBe('spawnAgent with resume needs permission "workspace:sessions"');
    expect(refused(command("renameTile", "t9", "x"), ["workspace:edit"])).toBe("renameTile: unknown tile t9");
    expect(refused(command("openFolder", "f9"), ["workspace:edit"])).toBe("openFolder: unknown frame f9");
  });

  test("a host refuses a subscription to what it did not wire, a status or watch of no tile, and a rect for a tile it never announced, taking the rest of those", () => {
    for (const [type, feature] of [["subscribeEvents", "events"], ["subscribePresence", "presence"], ["subscribeParticipants", "participants"]] as const) {
      const m = (type === "subscribeEvents" ? { type, kinds: ["turn"] } : { type }) as PluginMessage;
      expect(refusal(m, host())).toEqual({ why: `${type}: not supported`, partly: false });
      expect(refusal(m, host({ features: [feature] }))).toBeNull();
    }
    expect(refusal({ type: "watchActivity", tileIds: ["t1"] }, host())).toEqual({ why: "watchActivity: not supported", partly: false });
    expect(refusal({ type: "watchActivity", tileIds: ["t1", "t9"] }, host({ features: ["activity"] }))).toEqual({ why: "watchActivity: unknown tile", partly: true });
    expect(refusal({ type: "subscribeStatus", tileId: "t9" }, host())).toEqual({ why: "subscribeStatus: unknown tile t9", partly: false });
    // A rect for a tile closed since the view last heard is the view not having heard yet.
    expect(refusal({ type: "surfaceRects", rects: [rect("t1"), rect("closed")] }, host())).toBeNull();
    expect(refusal({ type: "surfaceRects", rects: [rect("t1"), rect("never")] }, host())).toEqual({ why: "surfaceRects: unknown tile", partly: true });
  });

  test("participants: what a view is told of them parses, and what is not a participant is refused", () => {
    const priya = { id: "c1", person: "p1", name: "Priya", color: "#ec4899", cursor: { tileId: "t1" }, selection: ["t1", "f1"] };
    expect(parseHostMessage({ type: "participants", participants: [priya, { ...priya, id: "c2", cursor: null, selection: [] }] }).ok).toBe(true);
    for (const bad of [{ ...priya, id: "" }, { ...priya, cursor: { x: 1, y: 2 } }, { ...priya, selection: [7] }, { ...priya, name: undefined }]) {
      expect(parseHostMessage({ type: "participants", participants: [bad] }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseHostMessage({ type: "participants" }).ok).toBe(false);
    for (const type of ["subscribeParticipants", "unsubscribeParticipants"]) expect(parsePluginMessage({ type }).ok).toBe(true);
  });
});
