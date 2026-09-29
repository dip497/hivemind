// A session's status as tiles and `hive ctl list` show it (src/tile-status.ts).
import { expect, test } from "bun:test";
import type { SessionStatus } from "../src/status-store.js";
import { tileStatusOf } from "../src/tile-status.js";

const hosted = (over: Partial<SessionStatus>): SessionStatus =>
  ({ state: "idle", subagents: [], background: 0, compacting: false, source: "hooks", since: 0, ...over });

test("the host's states read as the kinds tiles and views colour by", () => {
  expect(tileStatusOf(hosted({ state: "working" })).status).toBe("working");
  expect(tileStatusOf(hosted({ state: "done", subagents: ["a"] })).status).toBe("working"); // subagents still running
  for (const [kind, status] of [["permission", "permission"], ["question", "question"], ["plan", "plan_review"], ["approval", "awaiting_approval"], ["other", "blocked"]] as const) {
    expect(tileStatusOf(hosted({ state: "waiting", kind })).status).toBe(status);
  }
  expect(tileStatusOf(hosted({ state: "done" }))).toEqual({ status: "idle" });
  expect(tileStatusOf(hosted({ state: "limited" }))).toEqual({ status: "idle", detail: "usage limit reached" });
  expect(tileStatusOf(hosted({ state: "interrupted" }))).toEqual({ status: "idle", detail: "interrupted", synthetic: true });
  expect(tileStatusOf(hosted({ state: "exited" })).status).toBe("exited");
});
