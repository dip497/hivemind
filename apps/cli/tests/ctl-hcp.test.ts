/** Integration: the `hive ctl` verbs still on the control plane against a REAL HCP server (the
 *  desktop's startHcpServer) with a scripted dispatch: report. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startHcpServer, type HcpServer } from "@hivemind/host/control/hcp-server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { hiveAsync as hive } from "./helpers.js";

let dir: string;
let sock: string;
let server: HcpServer;
const TOKEN = "t0k3n";
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

const env = () => ({ HIVE_HCP_SOCK: sock, HCP_TOKEN: TOKEN, HIVEMIND_TILE: "me-1" });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ctl-hcp-"));
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
});
