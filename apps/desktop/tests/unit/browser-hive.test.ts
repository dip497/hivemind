import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket as Socket } from "ws";
import { serveBrowser, type Tab } from "../../src/main/browser-server.ts";
import { connectHive } from "../../src/browser/hive.ts";
import { viewsKey } from "../../src/main/browser-gate.ts";

const TOKEN = "k".repeat(43);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tab-"));
fs.writeFileSync(path.join(root, "browser.html"), "<!doctype html>");

let tab: Tab | null = null;
const opened: unknown[] = [];
const notices: unknown[][] = [];
let settings: Record<string, unknown> = { v: 1, browserApp: { enabled: true } };
const server = await serveBrowser({
  port: 0,
  names: [],
  token: TOKEN,
  root,
  page: "browser.html",
  platform: "linux",
  channels: {
    served: () => ["settings:get", "getAppVersion", "workspace", "workspace:notice"],
    invoke: (ch, from, args) => {
      if (ch === "settings:get") return settings;
      if (ch === "getAppVersion") return "2026.10.1";
      const [method, params] = args as [string, unknown[]];
      if (method !== "terminal.open") return { error: { code: "UNKNOWN_METHOD", message: method } };
      opened.push(params[0]);
      const tile = (params[0] as { tileId: string }).tileId;
      for (const data of ["abc", "defg"]) from.send("workspace:event", { event: "terminal.data", params: [tile, data] });
      return { result: { pid: 7 } };
    },
    send: (_ch, _from, args) => { notices.push(args); },
  },
  schemes: () => undefined,
  onTab: (t) => { tab = t; },
  onError: () => {},
});
after(() => server.close());

// A browser sends the page's cookie and Origin with the upgrade on its own.
const here = `127.0.0.1:${server.port}`;
(globalThis as { WebSocket: unknown }).WebSocket = class extends Socket {
  constructor(url: string) {
    super(url, { headers: { cookie: `hive-${server.port}=${TOKEN}`, origin: `http://${here}` } });
  }
};

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

const hive = await connectHive(`ws://${here}/socket`, TOKEN, () => {});

test("a tab's window.hive has no member for a channel main does not serve it, and calls the rest", { timeout: 10_000 }, async () => {
  assert.equal(hive.pickProjectFolder, undefined);
  assert.equal(hive.relaunchApp, undefined);
  assert.equal(hive.newWindow, undefined);
  assert.equal(await hive.getAppVersion(), "2026.10.1");
  assert.equal(hive.platform, "linux");
});

test("the settings are there before the renderer starts, and follow main's changes", { timeout: 10_000 }, async () => {
  assert.deepEqual(hive.settingsSync(), settings);
  settings = { v: 1, browserApp: { enabled: false } };
  tab!.send("settings:changed", settings);
  await until(() => JSON.stringify(hive.settingsSync()) === JSON.stringify(settings));
  assert.deepEqual(hive.settingsSync(), settings);
});

test("a terminal a tab opens is paced: it asks for acks and acknowledges what it took, all told since it opened", { timeout: 10_000 }, async () => {
  const opts = { tileId: "hm:t1", cwd: "/tmp", cmd: "bash", cols: 80, rows: 24 };
  const acks = () => notices.filter((n) => n[0] === "terminal.ack").map((n) => n[1]);
  await hive.ptySpawn(opts);
  await until(() => acks().length >= 2);
  assert.equal((opened[0] as { acks?: boolean }).acks, true);
  assert.deepEqual(acks(), [["hm:t1", 3], ["hm:t1", 7]]);

  await hive.ptySpawn(opts);
  await until(() => acks().length >= 4);
  assert.deepEqual(acks().slice(2), [["hm:t1", 3], ["hm:t1", 7]]);
});

test("a tab loads the app's schemes from the server's paths, a view's with the views key, and anything else as it is", { timeout: 10_000 }, () => {
  const key = viewsKey(TOKEN);
  assert.equal(hive.resourceUrl("hm-view://windows/__entry.html?js=main.js"), `/hm-view/${key}/windows/__entry.html?js=main.js`);
  assert.equal(hive.resourceUrl("hm-plugin://owner--tool/index.js?g=2"), "/hm-plugin/owner--tool/index.js?g=2");
  assert.equal(hive.resourceUrl("hm-media://v/%2Fhome%2Fwp.mp4"), "/hm-media/v/%2Fhome%2Fwp.mp4");
  assert.equal(hive.resourceUrl("hivemedia://media/background-1.png"), "/hivemedia/media/background-1.png");
  assert.equal(hive.resourceUrl("data:image/svg+xml;base64,AA=="), "data:image/svg+xml;base64,AA==");
  assert.equal(hive.resourceUrl("https://example.com/a.png"), "https://example.com/a.png");
});
