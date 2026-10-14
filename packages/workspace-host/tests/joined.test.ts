// Where this device is a guest (joined.ts, spec/pairing.md 0.9): the workspaces of someone else's
// it joined and was not let go from, each on its host as it was last reached.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JoinedList, type JoinedWorkspace } from "../src/joined.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "joined-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("this device is a guest of what it joined of someone else's, not of the person's own, nor of one it left or was removed from", () => {
  const joined = new JoinedList(path.join(dir, "joined.json"));
  const one = (workspace: string, role: JoinedWorkspace["role"], ended?: JoinedWorkspace["ended"]): JoinedWorkspace => ({
    workspace, host: `${workspace[0]}`.repeat(64), where: { addrs: ["10.0.0.4:4433"], relay: null }, role,
    names: { workspace: "api", host: "Priya" }, joinedAt: 1, ...(ended ? { ended } : {}),
  });
  for (const j of [one("a".repeat(32), "edit"), one("b".repeat(32), "owner"), one("c".repeat(32), "view", "left"), one("d".repeat(32), "view", "removed"), one("e".repeat(32), "view")]) joined.add(j);
  expect(joined.guestOf().sort((x, y) => x.workspace.localeCompare(y.workspace))).toEqual([
    { workspace: "a".repeat(32), host: "a".repeat(64), addrs: ["10.0.0.4:4433"], relay: null },
    { workspace: "e".repeat(32), host: "e".repeat(64), addrs: ["10.0.0.4:4433"], relay: null },
  ]);
});
