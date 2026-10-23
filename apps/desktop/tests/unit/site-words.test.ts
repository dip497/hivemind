// How a Browser tile names a site that asks (renderer/src/site-words.ts): whose site it is stays
// readable however long the site makes its name, and what it wants is said in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteParts, wants } from "../../src/renderer/src/site-words.ts";

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
