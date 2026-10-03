/** `hive share`, `hive people` and `hive join` on a machine where the app, not `hive host`, runs:
 *  with nothing on the host's socket they go to the app's control plane (a REAL HCP server and
 *  dispatcher), answer in the shapes the host path gives, and with neither running say so. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startHcpServer, type HcpServer } from "@hivemind/host/control/hcp-server";
import { makeDispatch, type MethodDeps } from "@hivemind/host/control/methods";
import type { Actor } from "@hivemind/workspace-host/intents";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.mkdtempSync("/tmp/hive-share-app-") : "";
const sock = path.join(dir, "hcp.sock");
const repo = path.join(dir, "team");
const TOKEN = "t0k3n";
const asked: Array<{ method: string; params: unknown[]; actor: Actor }> = [];
const env = (s = sock) => ({ XDG_CONFIG_HOME: dir, HIVEMIND_APP_DATA: path.join(dir, "hivemind"), HIVE_HCP_SOCK: s, HCP_TOKEN: TOKEN, HIVEMIND_TILE: "" });
let server: HcpServer;

beforeAll(() => {
  const { dispatch } = makeDispatch({
    workspaces: { repos: () => [repo], ownership: () => ({ workspaceId: "ws-1234", owner: "me", workspacePublicKey: "k" }) },
    workspaceApi: async (method, params, actor) => {
      asked.push({ method, params, actor });
      return method === "people.list" ? [{ person: "p-guest", name: "Guest", role: "edit", present: true }] : null;
    },
    join: async (link) => ({ ok: link === "hivemind://join/x", role: "edit" }),
  } as unknown as MethodDeps);
  server = startHcpServer(sock, {
    authenticate: (t) => (t === TOKEN ? { kind: "person" } : null),
    rendererUp: () => true,
    onEvent: () => {},
    dispatch,
  });
});
afterAll(() => {
  server?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive share/people/join with the app running", () => {
  test("people are listed and allowed by the app, as the person, with the host's JSON", async () => {
    const list = await hive(["people", "list", "--json"], { env: env(), cwd: dir });
    expect(list.json).toEqual({ ok: true, data: [{ person: "p-guest", name: "Guest", role: "edit", present: true }] });
    const allow = await hive(["people", "allow", "3", "-w", "team", "--json"], { env: env() });
    expect(allow.code).toBe(1); // the app answered null: not waiting
    expect(asked.at(-1)).toEqual({ method: "people.answer", params: [repo, 3, true], actor: { kind: "person" } });
  });

  test("join goes to the app", async () => {
    const r = await hive(["join", "hivemind://join/x", "--json"], { env: env() });
    expect(r.json).toEqual({ ok: true, data: { ok: true, role: "edit" } });
  });

  test("with neither running, the error names both", async () => {
    const r = await hive(["people", "list", "--json"], { env: env(path.join(dir, "none.sock")) });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: "host_not_running" });
    expect(String((r.json as { error: string }).error)).toMatch(/hive host is not running.*nor is the hivemind app/);
  });
});
