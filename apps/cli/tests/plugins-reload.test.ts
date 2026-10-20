/** `hive plugins install` on a REAL drive socket whose app refuses to load the plugin: it says why
 *  and how to ask again, never that the app is not running; with no app it says that. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-plugins-reload-")) : "";
const sock = path.join(dir, "drive.sock");
const view = path.join(dir, "board");
const TOKEN = "t0k3n";
const env = (s: string) => ({ XDG_CONFIG_HOME: dir, HIVE_SETTINGS: undefined, HIVEMIND_APP_DATA: path.join(dir, "hivemind"), HIVE_HCP_SOCK: path.join(dir, "no-app.sock"), HIVE_DRIVE_SOCK: s, HCP_TOKEN: TOKEN });
let drive: DriveServer;

beforeAll(async () => {
  if (!unix) return;
  fs.mkdirSync(view);
  fs.writeFileSync(path.join(view, "index.html"), "<p>board</p>");
  fs.writeFileSync(path.join(view, "hivemind-view.json"), JSON.stringify({ id: "board", name: "Board", version: "1.0.0", entry: "index.html" }));
  const refuse = () => { throw new Error("the views folder cannot be read"); };
  const server = new WorkspaceServer([{ answers: { "settings.reload": () => null, "tools.rescan": () => null, "widgets.rescan": () => null, "views.rescan": refuse }, effects: {} }], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, { server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [], workspaceOf: () => null, nameOf: () => "" });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive plugins install, telling the app", () => {
  test("an app that fails to load the plugin is named with its error and the command that asks again; no app is 'not running'", async () => {
    const refused = await hive(["plugins", "install", view], { env: env(sock), cwd: dir });
    expect(refused.code).toBe(0);
    expect(refused.stdout).toContain("the views folder cannot be read");
    expect(refused.stdout).toContain("hive plugins reload");
    expect(refused.stdout).not.toContain("not running");

    const reload = await hive(["plugins", "reload", "--json"], { env: env(sock), cwd: dir });
    expect(reload.code).toBe(1);
    expect(reload.json).toMatchObject({ error: { code: "RELOAD_FAILED", message: expect.stringContaining("the views folder cannot be read") } });

    const none = await hive(["plugins", "install", view], { env: env(path.join(dir, "no-drive.sock")), cwd: dir });
    expect(none.stdout).toContain("app not running");
  }, 60_000);
});
