// The phone page's hash, worked out by the desktop from what a server serves, is the one
// crates/hive-web/build.sh gave the page it built: Pair a phone says "the page this release made"
// only for that page, and not once one file of it differs. And the link a phone's browser is given
// carries what a browser uses, and no more.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "uqr";
import { formatPairLink, newCode, parsePairLink, type PairLink } from "@hivemind/workspace-host/pairing";
import { pageHash, pageLink } from "../../src/main/phone-page.js";

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

test("the link in the page's address leaves out the computer's addresses, which a browser cannot use, and keeps all it does use: its QR code is smaller", () => {
  const hex = (c: string, n: number) => c.repeat(n);
  // As a machine with docker bridges and IPv6 lists itself: 14 addresses.
  const addrs = [
    "192.168.1.23:41641", "172.17.0.1:41641", "172.18.0.1:41641", "172.19.0.1:41641", "172.20.0.1:41641",
    "172.21.0.1:41641", "10.88.0.1:41641", "100.101.102.103:41641", "[fd7a:115c:a1e0::1]:41641",
    "[2001:db8:85a3::8a2e:370:7334]:41641", "[2001:db8:85a3::8a2e:370:7335]:41641", "[fe80::1c2d:3e4f:5a6b:7c8d]:41641",
    "[fe80::42:acff:fe11:1]:41641", "[fe80::42:acff:fe12:1]:41641",
  ];
  const link: PairLink = {
    device: hex("a", 64), addrs, relay: "https://hive.example.org", code: newCode(), name: "Priya's desktop", kind: "app",
    admission: { access: "https://hive.example.org/access", voucher: { v: 1, kind: "visit", by: hex("b", 64), device: null, nonce: hex("c", 32), expires: 1_792_000_000, uses: 1, signature: hex("d", 128) } },
  };
  const page = "https://hive.example.org/phone/";
  const slim = pageLink(page, link);
  const full = `${page}#pair=${formatPairLink(link)}`;
  assert.deepEqual(parsePairLink(slim), { ...link, addrs: [] });
  const [before, after] = [encode(full), encode(slim)];
  console.log(`page link: ${full.length} chars, QR ${before.size}×${before.size} (version ${before.version}) with the addresses; ${slim.length} chars, QR ${after.size}×${after.size} (version ${after.version}) without`);
  assert.ok(after.version < before.version);
});
