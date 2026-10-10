/** Integration: the `hive ctl` verbs still on the control plane against a REAL HCP server (the
 *  desktop's startHcpServer) with a scripted dispatch: report and workflow. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startHcpServer, type HcpServer } from "@hivemind/host/control/hcp-server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { hiveAsync as hive } from "./helpers.js";
import { fixtureXDG } from "./agents-fixtures.js";

let dir: string;
let sock: string;
let server: HcpServer;
const TOKEN = "t0k3n";
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

// The CLI validates --agent against installed manifests; give the subprocess a machine
// that has the fixture agents installed.
let xdg: string;
const env = () => ({ HIVE_HCP_SOCK: sock, HCP_TOKEN: TOKEN, HIVEMIND_TILE: "me-1", XDG_CONFIG_HOME: xdg });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ctl-hcp-"));
  xdg = fixtureXDG(["claude", "codex"]);
  sock = path.join(dir, "hcp.sock");
  server = startHcpServer(sock, {
    authenticate: (t) => (t === TOKEN ? { kind: "person" } : null),
    rendererUp: () => true,
    onEvent: () => {},
    dispatch: async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p });
      switch (method) {
        case "agent.report": return { delivered: true, parent: "p-1" };
        case "workflow.run": return { shape: p.shape, items: (p.items as string[]).map((item) => ({ item, tileId: "w-x", status: "ok", text: "did " + item })) };
        default: throw new ApiError("UNKNOWN_METHOD", method);
      }
    },
  });
});
afterAll(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("hive ctl over a real HCP socket", () => {
  test("report uses the caller tile; --tile overrides", async () => {
    expect((await hive(["ctl", "report", "done", "--json"], { env: env() })).json).toEqual({ delivered: true, parent: "p-1" });
    expect(calls.findLast((c) => c.method === "agent.report")!.params).toEqual({ callerTile: "me-1", message: "done" });
    await hive(["ctl", "report", "done", "--tile", "other", "--json"], { env: env() });
    expect(calls.findLast((c) => c.method === "agent.report")!.params.callerTile).toBe("other");
  });

  test("workflow builds the workflow.run params and prints the fanout shape", async () => {
    const r = await hive(["ctl", "workflow", "--shape", "fanout", "--items", "a || b", "--prompt", "do {item}", "--close", "--json"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ shape: "fanout", items: [{ item: "a", tileId: "w-x", status: "ok", text: "did a" }, { item: "b", tileId: "w-x", status: "ok", text: "did b" }] });
    expect(calls.findLast((c) => c.method === "workflow.run")!.params).toMatchObject({ items: ["a", "b"], close_when_done: true, callerTile: "me-1" });
  });
});
