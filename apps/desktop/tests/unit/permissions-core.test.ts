// Who may use what a web page can ask for (main/permissions-core.ts): the app's own page, a page in
// a Browser tile, and everything else in the app's windows (a view's frame, a tool's page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, rightsOf, siteOf, SiteAnswers, type Decision } from "../../src/main/permissions-core.ts";

const APP = "file:///opt/hivemind/resources/app.asar/out/renderer/index.html";
const DEV = "http://localhost:5173/";

test("the app's own page gets what the app uses, and nothing else", () => {
  const rows: Array<[string, string, string, Decision]> = [
    // A widget's hive.notify, and the Copy buttons.
    [APP, APP, "notifications", "allow"],
    [`${APP}#/settings`, APP, "clipboard-sanitized-write", "allow"],
    // The dev server is the app's page in a dev run, whatever path it is on.
    [`${DEV}#/x`, DEV, "notifications", "allow"],
    [APP, APP, "media", "deny"],
    [APP, APP, "geolocation", "deny"],
    [APP, APP, "clipboard-read", "deny"],
    [APP, APP, "openExternal", "deny"],
    [APP, APP, "fullscreen", "deny"],
    // Another file, or another local server, is not the app's page.
    ["file:///home/me/page.html", APP, "notifications", "deny"],
    ["http://localhost:5174/", DEV, "notifications", "deny"],
  ];
  for (const [url, appPage, permission, want] of rows) {
    assert.equal(decide({ permission, url, guest: false, appPage }), want, `${permission} from ${url}`);
  }
});

test("a view's frame, a tool's page or any other plugin page in the app's window gets nothing", () => {
  for (const url of ["hm-view://tile-list/index.html", "hm-plugin://tool/page.html", "http://127.0.0.1:4555/", "about:blank", ""]) {
    for (const permission of ["notifications", "clipboard-sanitized-write", "media", "geolocation", "fullscreen", "pointerLock"]) {
      assert.equal(decide({ permission, url, guest: false, appPage: APP }), "deny", `${permission} from ${url}`);
    }
  }
});

test("a page in a Browser tile gets the harmless ones, asks for the rest, and never opens another program", () => {
  const site = "https://maps.example.com/route?to=home";
  const rows: Array<[string, Decision]> = [
    ["fullscreen", "allow"],
    ["clipboard-sanitized-write", "allow"],
    ["pointerLock", "allow"],
    ["media", "ask"],
    ["geolocation", "ask"],
    ["notifications", "ask"],
    ["midi", "ask"],
    ["midiSysex", "ask"],
    ["display-capture", "ask"],
    ["hid", "ask"],
    ["serial", "ask"],
    ["usb", "ask"],
    ["clipboard-read", "ask"],
    ["idle-detection", "ask"],
    ["window-management", "ask"],
    ["a-permission-chromium-adds-later", "ask"],
    ["openExternal", "deny"],
  ];
  for (const [permission, want] of rows) {
    assert.equal(decide({ permission, url: site, guest: true, appPage: APP }), want, permission);
  }
});

test("a Browser tile's page never gets the app's rights at the app's address, and one with no site to name is refused", () => {
  assert.equal(decide({ permission: "notifications", url: DEV, guest: true, appPage: DEV }), "ask");
  // A file, a sandboxed frame, a data: page: the person could not be told who asks.
  for (const url of [APP, "about:blank", "data:text/html,hi", ""]) {
    assert.equal(decide({ permission: "geolocation", url, guest: true, appPage: APP }), "deny", url);
  }
});

test("the site a person is asked about is the origin, never the path", () => {
  assert.equal(siteOf("https://evil.example/accounts.google.com/signin"), "https://evil.example");
  assert.equal(siteOf("http://127.0.0.1:8123/a?b#c"), "http://127.0.0.1:8123");
  assert.equal(siteOf("data:text/html,hi"), null);
  assert.equal(siteOf("not a url"), null);
});

test("a media request is the camera, the microphone or both, each answered on its own", () => {
  assert.deepEqual(rightsOf("media", ["audio"]), ["microphone"]);
  assert.deepEqual(rightsOf("media", ["video"]), ["camera"]);
  assert.deepEqual(rightsOf("media", ["video", "audio"]), ["camera", "microphone"]);
  // A check that does not say which: both.
  assert.deepEqual(rightsOf("media", ["unknown"]), ["camera", "microphone"]);
  assert.deepEqual(rightsOf("media"), ["camera", "microphone"]);
  assert.deepEqual(rightsOf("geolocation"), ["geolocation"]);
});

test("an answer holds for its site and right only; a block holds over an allow; an unanswered right asks again", () => {
  const answers = new SiteAnswers();
  const site = "https://meet.example";
  assert.equal(answers.get(site, ["microphone"]), undefined);
  answers.set(site, ["microphone"], true);
  assert.equal(answers.get(site, ["microphone"]), true);
  assert.equal(answers.get("https://other.example", ["microphone"]), undefined);
  assert.equal(answers.get(site, ["camera"]), undefined);
  // Allowed the microphone, not yet asked about the camera: a call wanting both asks.
  assert.equal(answers.get(site, ["camera", "microphone"]), undefined);
  answers.set(site, ["camera"], false);
  assert.equal(answers.get(site, ["camera", "microphone"]), false);
});

test("the answers kept are bounded: past the cap the oldest is forgotten", () => {
  const answers = new SiteAnswers(2);
  answers.set("https://a.example", ["notifications"], true);
  answers.set("https://b.example", ["notifications"], false);
  answers.set("https://c.example", ["notifications"], true);
  assert.equal(answers.get("https://a.example", ["notifications"]), undefined);
  assert.equal(answers.get("https://b.example", ["notifications"]), false);
  assert.equal(answers.get("https://c.example", ["notifications"]), true);
});
