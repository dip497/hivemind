// The page a browser tab opens: a tool plugin's imports of the app's modules reach them (an import
// map, by exact key: a custom scheme matches no prefix), and its policy lets that one inline script
// run by its hash, and frames, media and code load from this server only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { HOST_MODULE_NAMES } from "../../src/shared/plugin-host.ts";
import { tabUrl } from "../../src/shared/browser-socket.ts";

const page = fs.readFileSync(new URL("../../src/renderer/browser.html", import.meta.url), "utf8");
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1] ?? "";
const policy = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

test("each module the app gives a tool plugin is mapped to where the tab loads it", () => {
  const inline = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(inline, "browser.html has an import map");
  const host = Object.fromEntries(HOST_MODULE_NAMES.map((n) => [`hm-plugin://host/${n}.js`, tabUrl(`hm-plugin://host/${n}.js`, "")]));
  assert.deepEqual(JSON.parse(inline[1]!), { imports: host });
  assert.ok(page.indexOf("importmap") < page.indexOf('type="module"'), "the map comes before any module");
  const hash = createHash("sha256").update(inline[1]!).digest("base64");
  assert.ok(policy("script-src").includes(`'sha256-${hash}'`), `script-src allows the map by its hash, sha256-${hash}`);
});

test("the tab's policy loads frames, media and code from this server, and no inline script but the map", () => {
  assert.equal(policy("frame-src"), "frame-src 'self'");
  assert.doesNotMatch(csp, /hm-view:|hm-plugin:|hm-media:|hivemedia:|unsafe-inline'\s*;?\s*$|script-src[^;]*unsafe-inline/);
  assert.match(policy("connect-src"), /'self'/);
});
