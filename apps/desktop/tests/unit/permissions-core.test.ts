// Who may use what a web page can ask for (main/permissions-core.ts): the app's own page, a page in
// a Browser tile, and everything else in the app's windows (a view's frame, a tool's page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerable, decide, rightsOf, SiteAnswers, type Decision } from "../../src/main/permissions-core.ts";
import { siteOf } from "../../src/shared/site.ts";

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

test("a page in a Browser tile gets the harmless ones, is refused what the app cannot give, and asks for the rest", () => {
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
    ["clipboard-read", "ask"],
    ["idle-detection", "ask"],
    ["window-management", "ask"],
    ["a-permission-chromium-adds-later", "ask"],
    // A device needs a chooser and a screen a picker, and the app has neither: asking would
    // promise what the person's Allow could not give.
    ["display-capture", "deny"],
    ["hid", "deny"],
    ["serial", "deny"],
    ["usb", "deny"],
  ];
  for (const [permission, want] of rows) {
    assert.equal(decide({ permission, url: site, guest: true, appPage: APP }), want, permission);
  }
});

test("a Browser tile's page asks before a link opens in another program, and never for links that run code or open files", () => {
  const site = "https://meet.example.com/call";
  const rows: Array<[string | undefined, Decision]> = [
    ["mailto:me@example.com", "ask"],
    ["zoommtg://zoom.us/join?confno=1", "ask"],
    ["slack://open", "ask"],
    ["vscode://file/x", "ask"],
    ["file:///etc/passwd", "deny"],
    ["javascript:alert(1)", "deny"],
    ["search-ms:query=x", "deny"],
    ["ms-msdt:/id", "deny"],
    ["not a link", "deny"],
    [undefined, "deny"],
  ];
  for (const [externalUrl, want] of rows) {
    assert.equal(decide({ permission: "openExternal", url: site, guest: true, appPage: APP, externalUrl }), want, String(externalUrl));
  }
  // Never from the app's page or a view.
  assert.equal(decide({ permission: "openExternal", url: APP, guest: false, appPage: APP, externalUrl: "mailto:me@example.com" }), "deny");
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

test("a media request is the camera, the microphone or both, and a link each scheme, each answered on its own", () => {
  assert.deepEqual(rightsOf("media", { mediaTypes: ["audio"] }), ["microphone"]);
  assert.deepEqual(rightsOf("media", { mediaTypes: ["video"] }), ["camera"]);
  assert.deepEqual(rightsOf("media", { mediaTypes: ["video", "audio"] }), ["camera", "microphone"]);
  // A check that does not say which: both.
  assert.deepEqual(rightsOf("media", { mediaTypes: ["unknown"] }), ["camera", "microphone"]);
  assert.deepEqual(rightsOf("media"), ["camera", "microphone"]);
  assert.deepEqual(rightsOf("geolocation"), ["geolocation"]);
  // Allowing mailto: links is not allowing zoommtg: ones.
  assert.deepEqual(rightsOf("openExternal", { externalUrl: "MAILTO:me@example.com" }), ["openExternal:mailto"]);
  assert.deepEqual(rightsOf("openExternal", { externalUrl: "zoommtg://zoom.us/join" }), ["openExternal:zoommtg"]);
});

test("the person answers ahead only for a site's own origin and a right a page there would be asked about", () => {
  const rows: Array<[string, string, boolean]> = [
    ["https://meet.example", "notifications", true],
    ["https://meet.example", "camera", true],
    ["https://meet.example", "microphone", true],
    ["https://meet.example", "geolocation", true],
    ["https://meet.example", "openExternal:mailto", true],
    ["http://127.0.0.1:8123", "notifications", true],
    // What a site gets anyway, never gets, or is not a right.
    ["https://meet.example", "fullscreen", false],
    ["https://meet.example", "usb", false],
    ["https://meet.example", "openExternal:file", false],
    ["https://meet.example", "notifications and more", false],
    ["https://meet.example", "", false],
    // Not an origin: a path, nothing, or no site.
    ["https://meet.example/call", "notifications", false],
    ["https://meet.example/", "notifications", false],
    ["data:text/html,hi", "notifications", false],
    ["", "notifications", false],
  ];
  for (const [site, right, want] of rows) assert.equal(answerable(site, right, APP), want, `${right} for ${site}`);
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

test("an answer taken back is asked again, and the site lists only what is answered", () => {
  const answers = new SiteAnswers();
  const site = "https://meet.example";
  answers.set(site, ["camera", "microphone"], false);
  answers.set("https://other.example", ["camera"], true);
  answers.set(site, ["microphone"], undefined);
  assert.equal(answers.get(site, ["microphone"]), undefined);
  assert.equal(answers.get(site, ["camera"]), false);
  assert.deepEqual(answers.of(site), [["camera", false]]);
  assert.deepEqual(answers.of("https://meet.example:8443"), []);
});

test("the answers kept are bounded: past the cap the one answered longest ago is forgotten", () => {
  const answers = new SiteAnswers(2);
  answers.set("https://a.example", ["notifications"], true);
  answers.set("https://b.example", ["notifications"], false);
  answers.set("https://c.example", ["notifications"], true);
  assert.equal(answers.get("https://a.example", ["notifications"]), undefined);
  assert.equal(answers.get("https://b.example", ["notifications"]), false);
  assert.equal(answers.get("https://c.example", ["notifications"]), true);
  // Answered again, b is the newest: c goes first.
  answers.set("https://b.example", ["notifications"], true);
  answers.set("https://d.example", ["notifications"], true);
  assert.equal(answers.get("https://b.example", ["notifications"]), true);
  assert.equal(answers.get("https://c.example", ["notifications"]), undefined);
});
