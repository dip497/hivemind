// Who a control-plane token belongs to: the install's own token is the person's, and a tile's
// token names that tile and no other. Main and a machine's daemon both decide callers by this.
import { test, expect } from "bun:test";
import { holderOf, tileToken } from "../src/hooks/token.ts";

const INSTALL = "0b5c7d4e-1f2a-4b3c-9d8e-7f6a5b4c3d2e";

test("the install's token is the person's; a tile's names that tile, and is the same each time it is made", () => {
  expect(holderOf(INSTALL, INSTALL)).toEqual({ person: true });
  const given = tileToken(INSTALL, "hm:tile-claude-1");
  expect(holderOf(INSTALL, given)).toEqual({ tile: "hm:tile-claude-1" });
  // Derived, not stored: a session restored after a restart is given the same token again.
  expect(tileToken(INSTALL, "hm:tile-claude-1")).toBe(given);
  // A tile id may hold dots of its own.
  expect(holderOf(INSTALL, tileToken(INSTALL, "tile.a.b"))).toEqual({ tile: "tile.a.b" });
});

test("no tile can speak for another with what it was given, nor another install's tile at all", () => {
  const mac = tileToken(INSTALL, "hm:tile-claude-1").split(".").pop();
  expect(holderOf(INSTALL, `hm:tile-codex-2.${mac}`)).toBeNull();
  expect(holderOf(INSTALL, tileToken("another-install", "hm:tile-claude-1"))).toBeNull();
  expect(holderOf(INSTALL, `${INSTALL}x`)).toBeNull();
  for (const junk of ["", ".", "hm:tile-claude-1", `.${mac}`, undefined, 42]) expect(holderOf(INSTALL, junk)).toBeNull();
  // An install with no token of its own knows nobody.
  expect(holderOf("", "")).toBeNull();
});
