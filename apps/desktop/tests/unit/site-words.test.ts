// How a Browser tile names a site that asks (renderer/src/site-words.ts): whose site it is stays
// readable however long the site makes its name, and what it wants is said in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { rightName, siteParts, wants } from "../../src/renderer/src/site-words.ts";
import { decide, rightsOf } from "../../src/main/permissions-core.ts";

test("a site's registrable end is kept whole; the scheme and subdomains are what a narrow tile may cut", () => {
  const rows: Array<[string, string, string]> = [
    // https is the default and goes unsaid.
    ["https://example.com", "", "example.com"],
    ["https://accounts.google.com.evil.example", "accounts.google.com.", "evil.example"],
    ["https://a.b.c.example.co.uk", "a.b.c.", "example.co.uk"],
    ["https://meet.example.com:8443", "meet.", "example.com:8443"],
    // Another scheme is said, and an address or a one-word name is all end.
    ["http://127.0.0.1:8123", "http://", "127.0.0.1:8123"],
    ["http://localhost:5173", "http://", "localhost:5173"],
    ["http://[::1]:8080", "http://", "[::1]:8080"],
    // A name ending in a dot is the same name: its dot stays on the end and is not a name.
    ["https://example.com.", "", "example.com."],
    ["https://accounts.google.com.evil.example.", "accounts.google.com.", "evil.example."],
    ["https://www.example.co.uk.:8443", "www.", "example.co.uk.:8443"],
    ["http://localhost.:5173", "http://", "localhost.:5173"],
    // On a host shared by many owners, the owner's name is part of the end.
    ["https://alice.github.io", "", "alice.github.io"],
    ["https://accounts.google.com.mallory.github.io", "accounts.google.com.", "mallory.github.io"],
    ["https://preview-42.shop.vercel.app", "preview-42.", "shop.vercel.app"],
    ["https://shop.netlify.app", "", "shop.netlify.app"],
    ["https://main.shop.pages.dev", "main.", "shop.pages.dev"],
    ["https://shop.herokuapp.com", "", "shop.herokuapp.com"],
    ["https://shop.web.app", "", "shop.web.app"],
    ["https://v2.shop.appspot.com", "v2.", "shop.appspot.com"],
    ["https://shop.firebaseapp.com", "", "shop.firebaseapp.com"],
    ["https://github.io", "", "github.io"],
  ];
  for (const [site, head, tail] of rows) {
    assert.deepEqual(siteParts(site), { head, tail }, site);
    assert.equal(head + tail, site.replace(/^https:\/\//, ""), `${site} reads as itself`);
  }
});

test("what a page wants is said in words, the program a link opens in by its scheme", () => {
  assert.equal(wants(["camera", "microphone"]), "use your camera and microphone");
  assert.equal(wants(["microphone"]), "use your microphone");
  assert.equal(wants(["notifications"]), "show notifications");
  assert.equal(wants(["geolocation"]), "know your location");
  assert.equal(wants(["openExternal:mailto"]), "open mailto: links in another program");
  // A right with no words of its own is still named.
  assert.equal(wants(["a-permission-chromium-adds-later"]), "use a-permission-chromium-adds-later");
});

test("each right a site can be asked about is said in words, in the question and in the site's panel", () => {
  const rows: Array<[string, string, string]> = [
    ["notifications", "show notifications", "Notifications"],
    ["camera", "use your camera", "Camera"],
    ["microphone", "use your microphone", "Microphone"],
    ["geolocation", "know your location", "Location"],
    ["geolocation-approximate", "know roughly where you are", "Rough location"],
    ["clipboard-read", "see what you copied", "Read what you copied"],
    ["idle-detection", "know when you are away", "Know when you are away"],
    ["window-management", "place windows on your screens", "Place windows"],
    ["midi", "use your MIDI devices", "MIDI devices"],
    ["midiSysex", "control your MIDI devices", "Control MIDI devices"],
    ["fileSystem", "use the files and folders you give it", "Files you give it"],
    ["local-fonts", "use the fonts on your computer", "Fonts on your computer"],
    ["local-network-access", "connect to devices on your network", "Devices on your network"],
    ["local-network", "connect to devices on your network", "Devices on your network"],
    ["loopback-network", "connect to programs on this computer", "Programs on this computer"],
    ["openExternal:mailto", "open mailto: links in another program", "Open mailto: links"],
  ];
  for (const [right, does, name] of rows) {
    assert.equal(wants([right]), does, right);
    assert.equal(rightName(right), name, right);
  }
});

test("no right Electron can hand over reaches the person by its bare name", () => {
  // Every permission name in the Electron this app ships with, from its request handler's type.
  const types = readFileSync(createRequire(import.meta.url).resolve("electron/electron.d.ts"), "utf8");
  const union = /setPermissionRequestHandler\(handler: \(\(webContents: WebContents, permission: ([^,]+),/.exec(types)?.[1] ?? "";
  const permissions = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(permissions.length > 40 && permissions.includes("notifications"), `read ${permissions.length} names from electron.d.ts`);
  const site = "https://meet.example";
  for (const permission of permissions) {
    if (decide({ permission, url: site, guest: true, appPage: "file:///app/index.html", externalUrl: "mailto:me@example.com" }) !== "ask") continue;
    for (const right of rightsOf(permission, { externalUrl: "mailto:me@example.com" })) {
      // What a right with no words reads as.
      assert.notEqual(wants([right]), `use ${right}`, `${permission}: the question`);
      assert.notEqual(rightName(right), right, `${permission}: its row in the site's panel`);
    }
  }
});
