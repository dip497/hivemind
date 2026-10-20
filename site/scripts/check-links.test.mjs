// The link check, run as CI runs it, on a small built site with one good and one bad of each
// kind of link: it must name exactly the bad ones and fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-links.mjs");
const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const refresh = (to) => `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=${to}"></head></html>`;

function site(files) {
  const root = mkdtempSync(join(tmpdir(), "check-links-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function check(root) {
  const run = spawnSync(process.execPath, [script, "--dist", root, "--site", "https://site.test"], { encoding: "utf8" });
  const problems = run.stdout.split("\n").filter((line) => line && !line.startsWith("links: ")).sort();
  return { status: run.status, problems };
}

test("every kind of broken link is named, and the good ones are not", (t) => {
  const root = site({
    "index.html": page(`
      <a href="/good/">good page</a>
      <a href="/missing/">missing page</a>
      <a href="/good/#here">good heading</a>
      <a href="/good/#nowhere">missing heading</a>
      <a href="/good.md">good Markdown copy</a>
      <a href="/guide/guide/good.md">Markdown copy with the base path twice</a>
      <img src="/shot.png" alt="">
      <video poster="/missing.jpg"></video>
      <a href="https://chatgpt.com/?prompt=Read+https://site.test/good.md">good Open in ChatGPT</a>
      <a href="https://claude.ai/new?q=Read%20https%3A%2F%2Fsite.test%2Fgone.md">bad Open in Claude</a>
      <a href="/old/">redirect, one hop</a>
      <a href="/chain/">redirect, two hops</a>
      <a href="/loop-a/">redirect loop</a>`),
    "good/index.html": page(`<h2 id="here">Here</h2>`),
    "shot.png": "png",
    "good.md": "# Good\n\n[home](https://site.test/) and [gone](https://site.test/nope.md)\n",
    "llms.txt": "- [Good](https://site.test/good.md): fine\n- [Gone](https://site.test/gone2.md): moved\n",
    "old/index.html": refresh("/good/"),
    "chain/index.html": refresh("/old/"),
    "loop-a/index.html": refresh("/loop-b/"),
    "loop-b/index.html": refresh("/loop-a/"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { status, problems } = check(root);

  assert.deepEqual(problems, [
    "/: /chain/: redirect chain of 2 hops: /chain/ → refresh /old/ → refresh /good/",
    "/: /good/#nowhere: no #nowhere on /good/",
    "/: /guide/guide/good.md: no such page or file (404)",
    "/: /loop-a/: redirect loop: /loop-a/ → refresh /loop-b/ → refresh /loop-a/",
    "/: /missing.jpg: no such page or file (404)",
    "/: /missing/: no such page or file (404)",
    "/: https://site.test/gone.md (inside the claude.ai link): no such page or file (404)",
    "/good.md: https://site.test/nope.md: no such page or file (404)",
    "/llms.txt: https://site.test/gone2.md: no such page or file (404)",
  ]);
  assert.equal(status, 1);
});

test("a site whose links all lead somewhere passes", (t) => {
  const root = site({
    "index.html": page(`<a href="/good/#here">good</a> <a href="/good">no slash, one hop</a>`),
    "good/index.html": page(`<h2 id="here">Here</h2>`),
    "llms.txt": "- [Home](https://site.test/)\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { status, problems } = check(root);

  assert.deepEqual(problems, []);
  assert.equal(status, 0);
});
