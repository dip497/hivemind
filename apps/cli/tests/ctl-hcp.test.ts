/** Integration: `hive ctl` subprocesses against a REAL HCP server (the desktop's
 *  startHcpServer + OutputRecorder) with a scripted dispatch. Proves the wire
 *  contract: token auth, --json shapes, exit codes, read's short-poll loop,
 *  --poll, and stream --lines/--since replay + offsets. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startHcpServer, type HcpServer } from "../../desktop/src/main/hcp/hcp-server.js";
import { OutputRecorder } from "../../desktop/src/main/hcp/output-recorder.js";
import { HcpError } from "../../desktop/src/main/hcp/protocol.js";
import { hiveAsync as hive } from "./helpers.js";

let dir: string;
let sock: string;
let server: HcpServer;
const TOKEN = "t0k3n";
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const rec = new OutputRecorder();
/** After this many agent.read calls, the "turn" completes. */
let turnAfterReads = 0;
let reads = 0;

const env = () => ({ HIVE_HCP_SOCK: sock, HCP_TOKEN: TOKEN, HIVEMIND_TILE: "me-1" });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ctl-hcp-"));
  sock = path.join(dir, "hcp.sock");
  server = startHcpServer(sock, {
    token: TOKEN,
    rendererUp: () => true,
    onEvent: () => {},
    replay: (tileId, o) => (typeof o.lines === "number" ? rec.tail(tileId, o.lines) : rec.since(tileId, o.since ?? 0)),
    offsetOf: (tileId) => rec.mark(tileId),
    dispatch: async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p });
      switch (method) {
        case "tile.list": return { frames: [{ id: "f1", tiles: [{ tileId: "w-1", status: "idle" }] }] };
        case "tile.spawn_agent": return { tileId: "w-2" };
        case "agent.report": return { delivered: true, parent: "p-1" };
        case "agent.read": {
          reads++;
          const t = Number(p.timeoutMs);
          if (reads > turnAfterReads) return { text: "reply " + reads, finalStatus: "turn", truncated: false };
          await new Promise((r) => setTimeout(r, Math.min(t, 50)));
          return { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" };
        }
        case "tile.close": throw new HcpError("TILE_NOT_FOUND", `no tile ${String(p.tileId)}`);
        case "agent.send": if (!p.text) throw new HcpError("BAD_REQUEST", "text required"); return { ok: true };
        case "workflow.run": return { shape: p.shape, items: (p.items as string[]).map((item) => ({ item, tileId: "w-x", status: "ok", text: "did " + item })) };
        default: throw new HcpError("UNKNOWN_METHOD", method);
      }
    },
  });
});
afterAll(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("hive ctl over a real HCP socket", () => {
  test("list --json prints the raw result on one line", async () => {
    const r = await hive(["ctl", "list", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.json).toEqual({ frames: [{ id: "f1", tiles: [{ tileId: "w-1", status: "idle" }] }] });
  });

  test("spawn forwards MCP-named params + callerTile from $HIVEMIND_TILE", async () => {
    const r = await hive(["ctl", "spawn", "--agent", "codex", "--name", "w", "--frame", "repo", "--model", "m", "--no-report", "--prompt", "go", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ tileId: "w-2" });
    const c = calls.findLast((c) => c.method === "tile.spawn_agent")!;
    expect(c.params).toMatchObject({ agent: "codex", name: "w", frame: "repo", model: "m", report: false, prompt: "go", callerTile: "me-1" });
  });

  test("report uses the caller tile; --tile overrides", async () => {
    expect((await hive(["ctl", "report", "done", "--json"], { env: env() })).json).toEqual({ delivered: true, parent: "p-1" });
    expect(calls.findLast((c) => c.method === "agent.report")!.params).toEqual({ callerTile: "me-1", message: "done" });
    await hive(["ctl", "report", "done", "--tile", "other", "--json"], { env: env() });
    expect(calls.findLast((c) => c.method === "agent.report")!.params.callerTile).toBe("other");
  });

  test("bad token → exit 6 UNAUTHORIZED; unknown tile → exit 5; bad request → exit 2", async () => {
    const bad = await hive(["ctl", "list", "--json"], { env: { ...env(), HCP_TOKEN: "wrong" } });
    expect(bad.code).toBe(6);
    expect(bad.json).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    const nf = await hive(["ctl", "close", "ghost", "--json"], { env: env() });
    expect(nf.code).toBe(5);
    expect(nf.json).toMatchObject({ ok: false, code: "TILE_NOT_FOUND" });
    const br = await hive(["ctl", "send", "w-1", "", "--json"], { env: env() });
    expect(br.code).toBe(2);
    expect((br.json as { code: string }).code).toBe("BAD_REQUEST");
  });

  test("read --timeout is honoured as a loop of short polls, exit 4 when it runs out", async () => {
    calls.length = 0; reads = 0; turnAfterReads = 1000;
    const r = await hive(["ctl", "read", "w-1", "--timeout", "25000", "--json"], { env: env() });
    expect(r.code).toBe(4);
    expect(r.json).toMatchObject({ text: null, finalStatus: "timeout" });
    const slices = calls.filter((c) => c.method === "agent.read").map((c) => c.params.timeoutMs);
    expect(slices).toEqual([10000, 10000, 5000]); // never one 25 s request
  });

  test("read returns as soon as a turn lands, exit 0", async () => {
    calls.length = 0; reads = 0; turnAfterReads = 1;
    const r = await hive(["ctl", "read", "w-1", "--timeout", "30000", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ text: "reply 2", finalStatus: "turn", truncated: false });
    expect(calls.filter((c) => c.method === "agent.read")).toHaveLength(2);
  });

  test("read --poll returns immediately with the turn state and exit 0", async () => {
    calls.length = 0; reads = 0; turnAfterReads = 1000;
    const r = await hive(["ctl", "read", "w-1", "--poll", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ finalStatus: "timeout" });
    expect(calls.map((c) => c.params.timeoutMs)).toEqual([0]);
  });

  test("workflow builds the workflow.run params and prints the fanout shape", async () => {
    const r = await hive(["ctl", "workflow", "--shape", "fanout", "--items", "a || b", "--prompt", "do {item}", "--close", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ shape: "fanout", items: [{ item: "a", tileId: "w-x", status: "ok", text: "did a" }, { item: "b", tileId: "w-x", status: "ok", text: "did b" }] });
    expect(calls.findLast((c) => c.method === "workflow.run")!.params).toMatchObject({ items: ["a", "b"], close_when_done: true, callerTile: "me-1" });
  });

  test("stream --lines replays the recorded tail; --since resumes from an offset; --json carries offsets", async () => {
    const tile = "w-1";
    rec.record(tile, "line one\n\x1b[31mline two\x1b[0m\nline three\n");
    const snap = await hive(["ctl", "stream", tile, "--lines", "2", "--snapshot"], { env: env() });
    expect(snap.code).toBe(0);
    expect(snap.stdout).toBe("line two\nline three\n");

    const j = await hive(["ctl", "stream", tile, "--lines", "1", "--snapshot", "--json"], { env: env() });
    const lines = j.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ seq: 0, chunk: "line three\n", replay: true });
    const offset = (lines.at(-1) as { end: boolean; offset: number });
    expect(offset.end).toBe(true);
    expect(offset.offset).toBe(rec.mark(tile));

    rec.record(tile, "line four\n");
    const since = await hive(["ctl", "stream", tile, "--since", String(offset.offset), "--snapshot"], { env: env() });
    expect(since.stdout).toBe("line four\n");
  });

  test("stream forwards live chunks until --timeout", async () => {
    const tile = "w-live";
    // The subprocess takes a moment to boot; keep broadcasting until it's done.
    let n = 0;
    const t = setInterval(() => server.broadcast(tile, `live ${n++}\n`), 100);
    const r = await hive(["ctl", "stream", tile, "--timeout", "1500"], { env: env() });
    clearInterval(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^live \d+\n(live \d+\n)*$/);
  });
});
