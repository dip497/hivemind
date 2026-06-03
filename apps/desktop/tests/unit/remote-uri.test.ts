// remote-uri — pure ssh:// URI parse/format. No deps, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  isRemote, parseRemote, formatRemote, withRemotePath, remoteDisplay,
  remoteBasename, posixJoin, hostIdOf,
} = await import("../../src/shared/remote-uri.ts");

test("isRemote distinguishes ssh:// from local paths", () => {
  assert.equal(isRemote("ssh://h/x"), true);
  assert.equal(isRemote("/home/u/proj"), false);
  assert.equal(isRemote(null), false);
  assert.equal(isRemote(undefined), false);
});

test("parse full uri with user + port + path", () => {
  const t = parseRemote("ssh://alice@build.example.com:2222/srv/app");
  assert.equal(t.user, "alice");
  assert.equal(t.host, "build.example.com");
  assert.equal(t.port, 2222);
  assert.equal(t.path, "/srv/app");
  assert.equal(t.hostId, "alice@build.example.com:2222");
});

test("parse defaults: no user, default port, root path", () => {
  const t = parseRemote("ssh://server");
  assert.equal(t.user, null);
  assert.equal(t.host, "server");
  assert.equal(t.port, 22);
  assert.equal(t.path, "/");
  assert.equal(t.hostId, "server:22");
});

test("parse host:port without user", () => {
  const t = parseRemote("ssh://10.0.0.5:22/home/dev/repo");
  assert.equal(t.user, null);
  assert.equal(t.host, "10.0.0.5");
  assert.equal(t.port, 22);
  assert.equal(t.path, "/home/dev/repo");
});

test("a path segment that looks like host:port is not mistaken for a port", () => {
  // colon is only a port when followed by digits AND in the authority
  const t = parseRemote("ssh://h/a/b:notport/c");
  assert.equal(t.host, "h");
  assert.equal(t.port, 22);
  assert.equal(t.path, "/a/b:notport/c");
});

test("format round-trips parse", () => {
  const uri = "ssh://bob@host:2200/var/www";
  assert.equal(formatRemote(parseRemote(uri)), uri);
});

test("format omits default port and empty user", () => {
  assert.equal(formatRemote({ host: "h", path: "/p" }), "ssh://h/p");
  assert.equal(formatRemote({ host: "h", port: 22, user: null, path: "/p" }), "ssh://h/p");
});

test("withRemotePath swaps the path, keeps the authority", () => {
  assert.equal(
    withRemotePath("ssh://u@h:2222/old", "/new/dir"),
    "ssh://u@h:2222/new/dir",
  );
});

test("remoteDisplay + remoteBasename", () => {
  assert.equal(remoteDisplay("ssh://u@h:2222/srv/app"), "u@h:/srv/app");
  assert.equal(remoteBasename("ssh://u@h/srv/app/"), "app");
  assert.equal(remoteBasename("ssh://u@h/"), "/");
});

test("hostIdOf", () => {
  assert.equal(hostIdOf("u", "h", 22), "u@h:22");
  assert.equal(hostIdOf(null, "h", 2222), "h:2222");
});

test("posixJoin handles children, absolute, and parent (..)", () => {
  assert.equal(posixJoin("/a/b", "c"), "/a/b/c");
  assert.equal(posixJoin("/a/b/", "c"), "/a/b/c");
  assert.equal(posixJoin("/a/b", "/x"), "/x");
  assert.equal(posixJoin("/a/b", ".."), "/a");
  assert.equal(posixJoin("/a", ".."), "/");
  assert.equal(posixJoin("/", ".."), "/");
});

test("malformed uris throw", () => {
  assert.throws(() => parseRemote("ssh://"));
  assert.throws(() => parseRemote("/not/remote"));
});
