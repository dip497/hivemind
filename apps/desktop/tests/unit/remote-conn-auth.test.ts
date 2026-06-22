// Auth-precedence for the remote connection pool — the restore-after-restart fix.
// The in-memory map is empty on a fresh process, so without the keychain resolver
// a restored remote tile fails with "All configured authentication methods failed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteConnectionManager } from "../../src/main/remote/conn.ts";

test("in-memory auth wins over the resolver", () => {
  const m = new RemoteConnectionManager();
  m.setAuth("h1", { password: "live" });
  m.setAuthResolver(() => ({ password: "saved" }));
  assert.equal(m.resolveAuthFor("h1").password, "live");
});

test("falls back to the keychain resolver when in-memory is empty (restart path)", () => {
  const m = new RemoteConnectionManager();
  m.setAuthResolver((id) => (id === "h1" ? { password: "saved" } : null));
  assert.equal(m.resolveAuthFor("h1").password, "saved");
});

test("resolver returning null (no saved host / decrypt failed) → empty auth", () => {
  const m = new RemoteConnectionManager();
  m.setAuthResolver(() => null);
  assert.deepEqual(m.resolveAuthFor("h1"), {});
});

test("no resolver at all → empty auth (the pre-fix behavior, still safe)", () => {
  const m = new RemoteConnectionManager();
  assert.deepEqual(m.resolveAuthFor("h1"), {});
});
