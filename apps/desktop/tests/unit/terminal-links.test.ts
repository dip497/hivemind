import { test } from "node:test";
import assert from "node:assert/strict";
import { clickedPathElsewhere, findPathLinks, folderFor, namesAnotherComputer, pathLinksOn, shellFolderOf } from "../../src/renderer/src/terminal-links";

const texts = (line: string) => findPathLinks(line).map((l) => l.text);

test("a bare name with a line is a link, as is one with a file type the app opens", () => {
  assert.deepEqual(texts("error in README.md:12 and src/a.ts:4:7"), ["README.md:12", "src/a.ts:4:7"]);
  assert.deepEqual(texts("modified:   package.json"), ["package.json"]);
  assert.deepEqual(findPathLinks("see notes.md."), [{ text: "notes.md", start: 4 }]);
  assert.deepEqual(texts("python setup.py && ./build.sh"), ["setup.py", "./build.sh"], "a script is a link too, though the system is never handed one");
});

test("versions, hosts and words are not links", () => {
  assert.deepEqual(texts("node v1.2.3 on example.com says e.g. done"), []);
});

test("the path part of a web address is left to the web link finder", () => {
  assert.deepEqual(texts("open https://example.com/docs/a.md now"), []);
});

test("the shell's folder, from each way a shell says it", () => {
  assert.equal(shellFolderOf(7, "file://box/home/me/my%20repo"), "/home/me/my repo");
  assert.equal(shellFolderOf(633, "P;Cwd=/home/me/a\\x3bb"), "/home/me/a;b");
  assert.equal(shellFolderOf(633, "A"), null);
  assert.equal(shellFolderOf(1337, "CurrentDir=/srv/app"), "/srv/app");
  assert.equal(shellFolderOf(1337, "SetMark"), null);
  assert.equal(shellFolderOf(7, "not a url"), null);
});

test("a shell on another machine names that machine's folders", () => {
  assert.equal(folderFor("ssh://me@box/home/me/repo", "/home/me/repo/src"), "ssh://me@box/home/me/repo/src");
  assert.equal(folderFor("/home/me/repo", "/tmp"), "/tmp");
});

test("a shell over ssh names another computer; one here, or one naming no host, does not", () => {
  assert.equal(namesAnotherComputer("file://build-box/srv/app", "laptop.local"), true);
  assert.equal(namesAnotherComputer("file://laptop/home/me", "laptop.local"), false);
  assert.equal(namesAnotherComputer("file:///home/me", "laptop"), false);
  assert.equal(namesAnotherComputer("file://localhost/home/me", "laptop"), false);
  assert.equal(namesAnotherComputer("file://web.prod.example.com/etc", "web.dev.example.com"), true, "two full names that differ only after the first part");
  assert.equal(namesAnotherComputer("file://laptop.local/home/me", "laptop"), false, "one side's short name");
});

test("the picker lists what is on screen newest first, each once", async () => {
  const { linksOnScreen } = await import("../../src/renderer/src/terminal-links");
  assert.deepEqual(linksOnScreen([
    { y: 1, text: "see https://example.com/docs, and src/a.ts:3" },
    { y: 2, text: "error in README.md:12 (src/a.ts:3)" },
  ]), [{ text: "src/a.ts:3", y: 2 }, { text: "README.md:12", y: 2 }, { text: "https://example.com/docs", y: 1 }]);
});

const line = (text: string, wrapped = false) => ({ text, wrapped });

test("a path an agent wrapped onto its next line opens whole from either part, its underline over both", () => {
  const upper = line("  Saved /tmp/agents-1000/scratchpad/cos");
  const lower = line("  mos2.png and crop2.png");
  const whole = "/tmp/agents-1000/scratchpad/cosmos2.png";
  const span = { text: whole, from: { dy: 0, x: 8 }, to: { dy: 1, x: 10 }, part: "/tmp/agents-1000/scratchpad/cos" };
  assert.deepEqual(pathLinksOn(upper, null, lower, 42, true), [span]);
  assert.deepEqual(pathLinksOn(lower, upper, null, 42, true), [
    { text: "crop2.png", from: { dy: 0, x: 15 }, to: { dy: 0, x: 24 } },
    { text: whole, from: { dy: -1, x: 8 }, to: { dy: 0, x: 10 }, part: "mos2.png" },
  ]);
});

test("a path the terminal wrapped joins at any width, its next line read from the first column", () => {
  const upper = line("see /home/me/repo/src/compo");
  const lower = line("nents/a.ts:12 there", true);
  assert.deepEqual(pathLinksOn(lower, upper, null, 200, true).map((l) => [l.text, l.part]), [["/home/me/repo/src/components/a.ts:12", "nents/a.ts:12"]]);
});

test("a path that ends well short of the width stays on its line, whatever follows", () => {
  const upper = line("  wrote /tmp/out/shot.png");
  const lower = line("  notes.md is next");
  assert.deepEqual(pathLinksOn(upper, null, lower, 120, true).map((l) => l.text), ["/tmp/out/shot.png"]);
  assert.deepEqual(pathLinksOn(lower, upper, null, 120, true).map((l) => l.text), ["notes.md"]);
});

test("a path that ends at the width with an unrelated next line keeps its own path to open when the joined one is not there", () => {
  const upper = line("  wrote /tmp/out/shot.png");
  assert.deepEqual(pathLinksOn(upper, null, line("  Done."), 26, true).map((l) => [l.text, l.part]), [["/tmp/out/shot.pngDone", "/tmp/out/shot.png"]]);
  assert.deepEqual(pathLinksOn(upper, null, line("  - next step"), 26, true).map((l) => [l.text, l.part]), [["/tmp/out/shot.png", undefined]]);
  assert.deepEqual(pathLinksOn(line("  when it is done, then see"), null, line("  src/a.ts for the rest"), 27, true).map((l) => l.text), []);
  assert.deepEqual(pathLinksOn(line("  src/a.ts for the rest"), line("  when it is done, then see"), null, 27, true).map((l) => l.text), ["src/a.ts"]);
});

test("on another machine only a line the terminal wrapped joins: a guessed join could not be checked before it opens", () => {
  const upper = line("  Saved /tmp/agents-1000/scratchpad/cos");
  assert.deepEqual(pathLinksOn(upper, null, line("  mos2.png and crop2.png"), 42, false).map((l) => [l.text, l.part]), [["/tmp/agents-1000/scratchpad/cos", undefined]]);
  assert.deepEqual(pathLinksOn(line("nents/a.ts:12 there", true), line("see /home/me/repo/src/compo"), null, 200, false).map((l) => l.text), ["/home/me/repo/src/components/a.ts:12"]);
});

test("a path clicked in a terminal over ssh is that computer's when it is absolute and outside the tile's folder", () => {
  for (const title of ["ssh web", "mosh me@web", "me@web.prod.example.com: ~"]) {
    assert.equal(clickedPathElsewhere("/etc/nginx/nginx.conf", title, "laptop.local", "/home/me/repo"), true, title);
    assert.equal(clickedPathElsewhere("~/notes.md", title, "laptop.local", "/home/me/repo"), true, title);
    assert.equal(clickedPathElsewhere("file:///etc/hosts", title, "laptop.local", "/home/me/repo"), true, title);
    assert.equal(clickedPathElsewhere("/home/me/repo/src/a.ts:3", title, "laptop.local", "/home/me/repo"), false, title);
    assert.equal(clickedPathElsewhere("src/a.ts", title, "laptop.local", "/home/me/repo"), false, title);
  }
  for (const title of ["me@laptop: ~/repo", "me@laptop.local:~", "vim notes.md", "", "ssh-keygen"]) {
    assert.equal(clickedPathElsewhere("/etc/nginx/nginx.conf", title, "laptop.local", "/home/me/repo"), false, title);
  }
});
