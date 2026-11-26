// What a tile asks of the person: the one rule the Windows view, the canvas, Layers and the dock
// badge share, and its agreement with Layers' own "unread".
import { describe, expect, test } from "bun:test";
import { attentionOf, attentionStateOf, type AttentionFacts } from "./attention.ts";
import { isUnread, newestWaiting } from "./layers.ts";

const at = (state: AttentionFacts["state"], since: number | null, seenAt: number | null, outputAt: number | null = null): AttentionFacts =>
  ({ state, since, seenAt, outputAt });

describe("attentionStateOf", () => {
  test("a blocked status needs the person whatever the agent reports; else the agent's state, else the status", () => {
    expect(attentionOf(at(attentionStateOf("blocked", "working"), 10, 50))).toBe("needs-you");
    expect(attentionStateOf("idle", "done")).toBe("done");
    expect(attentionStateOf("working")).toBe("working");
    expect(attentionStateOf("idle", "something-new")).toBe("idle");
    expect(attentionStateOf("whatever")).toBe("unknown");
  });
});

describe("attentionOf", () => {
  test("waiting on the person shows however recently they looked", () => {
    expect(attentionOf(at("waiting", 10, 50))).toBe("needs-you");
    expect(attentionOf(at("blocked", 10, 50))).toBe("needs-you");
  });

  test("a failure and a finished turn show until the person looks, then go quiet", () => {
    expect(attentionOf(at("failed", 60, 50))).toBe("failed");
    expect(attentionOf(at("failed", 40, 50))).toBe("quiet");
    for (const s of ["done", "idle", "interrupted", "limited", "exited"] as const) {
      expect(attentionOf(at(s, 60, 50))).toBe("done");
      expect(attentionOf(at(s, 40, 50))).toBe("quiet");
    }
  });

  test("output since the person looked shows on a tile that has not changed state", () => {
    expect(attentionOf(at("idle", 40, 50, 70))).toBe("new-output");
    expect(attentionOf(at("idle", 40, 50, 45))).toBe("quiet");
    expect(attentionOf(at("unknown", null, 50, 70))).toBe("new-output");
  });

  test("a tile the person has never seen opens unmarked, as Layers has it", () => {
    expect(attentionOf(at("idle", 60, null, 70))).toBe("quiet");
    expect(attentionOf(at("failed", 60, null))).toBe("quiet");
  });

  test("work under way shows as working, not as new output", () => {
    expect(attentionOf(at("working", 60, 50, 70))).toBe("working");
  });

  test("finished-unseen agrees with Layers' unread for every status it knows", () => {
    for (const status of ["idle", "exited", "working"] as const) {
      for (const [activity, seen] of [[60, 50], [40, 50], [60, null], [null, 50]] as const) {
        const done = attentionOf(at(status, activity, seen)) === "done";
        expect(done).toBe(isUnread({ status, activity, seen }));
      }
    }
  });
});

test("the key for what needs you goes to the tile that started waiting last, and to none when none waits", () => {
  const t = (id: string, needsYou: boolean, activity: number | null) => ({ id, needsYou, activity });
  expect(newestWaiting([t("a", true, 10), t("b", false, 99), t("c", true, 30), t("d", true, null)])?.id).toBe("c");
  expect(newestWaiting([t("a", false, 10)])).toBeNull();
});
