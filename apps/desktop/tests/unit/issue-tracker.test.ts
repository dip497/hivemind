/**
 * The Issues tile's reading of mirrored issues (tools/issues/src/tracker.ts, design jira-sync §7.1,
 * §8.1, §13): the assignee filter (Me by default, Unassigned, Anyone, one person) touches only
 * mirrored issues; a card shows the tracker's type, priority, estimate, a sprint that is not the
 * active one, whose it is when it is not mine, and "not in scope"; the tracker's fields are read
 * only. `external` arrives untyped, so what is malformed is ignored, not shown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardFacts, hasMirrored, isTrackerAssignee, matchesTrackerAssignee, trackerAssigneeLabel, trackerOf, trackerOwns, trackerPeople,
  type TrackerAssignee,
} from "../../tools/issues/src/tracker";
import type { IssueSummary } from "../../tools/issues/src/data";

const at = { parent: null, labels: [], assignee: null, state: "todo" as const, created: "2026-10-24T00:00:00.000Z", updated: "2026-10-24T00:00:00.000Z" };
const ME = { accountId: "5b10ac8d82e05b22cc7d4ef5", name: "Ujjwal Solanki", me: true };
const JANE = { accountId: "5b10a2844c20165700ede21g", name: "Jane Doe" };
const BOT = { accountId: "70121:9d2c", name: "Release Bot" };
const mirrored = (key: string, external: Record<string, unknown> = {}): IssueSummary =>
  ({ id: key, title: key, ...at, external: { provider: "jira", source: "jira:acme/PAY", id: key.replace(/\D/g, ""), key, ...external } }) as IssueSummary;
const local = (id: string): IssueSummary => ({ id, title: id, ...at });

const ISSUES = [
  mirrored("PAY-322", { assignee: ME }),
  mirrored("PAY-321", { assignee: JANE }),
  mirrored("PAY-318", { assignee: null }),
  mirrored("PAY-330", { assignee: BOT }),
  mirrored("PAY-325", { assignee: { name: "Jane Doe" } }), // a Data Center user: a name, no accountId
  local("HIVE-1"),
];
const shown = (f: TrackerAssignee) => ISSUES.filter((i) => matchesTrackerAssignee(i, f)).map((i) => i.id);

test("the assignee filter: Me, Unassigned, Anyone or one person, for mirrored issues; hive's own always show", () => {
  assert.deepEqual(shown("me"), ["PAY-322", "HIVE-1"]);
  assert.deepEqual(shown("unassigned"), ["PAY-318", "HIVE-1"]);
  assert.deepEqual(shown("anyone"), ISSUES.map((i) => i.id));
  assert.deepEqual(shown(`person:${JANE.accountId}`), ["PAY-321", "HIVE-1"]);
  assert.deepEqual(shown("person:Jane Doe"), ["PAY-325", "HIVE-1"]);
  // `me` is the tracker's word for whose credentials sync; a name alone is not me.
  assert.equal(matchesTrackerAssignee(mirrored("PAY-1", { assignee: { name: "Ujjwal Solanki" } }), "me"), false);
  assert.equal(matchesTrackerAssignee(mirrored("PAY-1", { assignee: { name: "Ujjwal Solanki", me: "yes" } }), "me"), false);
});

test("the person picker lists everyone else once, by name; the button says who is chosen", () => {
  assert.deepEqual(trackerPeople(ISSUES), [
    { key: `person:${JANE.accountId}`, name: "Jane Doe" },
    { key: "person:Jane Doe", name: "Jane Doe" },
    { key: `person:${BOT.accountId}`, name: "Release Bot" },
  ]);
  assert.deepEqual(["me", "unassigned", "anyone", `person:${BOT.accountId}`, "person:gone"].map((f) => trackerAssigneeLabel(f as TrackerAssignee, ISSUES)),
    ["Me", "Unassigned", "Anyone", "Release Bot", "gone"]);
  // The filter is offered only where something is mirrored; a saved value is checked before use.
  assert.deepEqual([hasMirrored(ISSUES), hasMirrored([local("HIVE-1")])], [true, false]);
  assert.deepEqual(["me", "unassigned", "anyone", "person:x", "person:", "everyone", 3, null].map(isTrackerAssignee),
    [true, true, true, true, false, false, false, false]);
});

test("a card shows the tracker's type, priority, estimate, a sprint not active, whose it is, and not in scope", () => {
  assert.equal(cardFacts(local("HIVE-1")), null);
  assert.deepEqual(cardFacts(mirrored("PAY-322", {
    assignee: ME, type: { id: "10001", name: "Story" }, priority: "Medium", estimate: 3,
    sprint: { id: 87, name: "PAY Sprint 42", state: "active" },
  })), { type: "Story", priority: "Medium", estimate: "3", notInScope: false });
  assert.deepEqual(cardFacts(mirrored("PAY-326", { assignee: JANE, estimate: 0, sprint: { id: 88, name: "PAY Sprint 43", state: "future" } })),
    { estimate: "0", sprint: "PAY Sprint 43", owner: { name: "Jane Doe" }, notInScope: false });
  assert.deepEqual(cardFacts(mirrored("PAY-318", { assignee: null, archived: { reason: "left scope", at: "2026-10-24T00:00:00.000Z" } })),
    { owner: "unassigned", notInScope: true });
  // What a tracker sent malformed is left out, never shown as text.
  assert.deepEqual(cardFacts(mirrored("PAY-2", { assignee: { accountId: 7 }, type: { id: 1 }, estimate: "3", priority: 2, sprint: { name: "S" }, archived: null })),
    { owner: "unassigned", notInScope: false });
});

test("its link and the fields the tracker owns: title, description, labels and parent; a web link only", () => {
  const i = mirrored("PAY-322", { url: "https://acme.atlassian.net/browse/PAY-322" });
  assert.equal(trackerOf(i)?.url, "https://acme.atlassian.net/browse/PAY-322");
  assert.equal(trackerOf(mirrored("PAY-3", { url: "javascript:alert(1)" }))?.url, undefined);
  assert.deepEqual(["title", "description", "labels", "parent"].map((f) => trackerOwns(i, f as "title")), [true, true, true, true]);
  assert.deepEqual(["title", "description"].map((f) => trackerOwns(local("HIVE-1"), f as "title")), [false, false]);
  // No provider or key: not a mirrored issue.
  assert.equal(trackerOf({ external: { provider: "jira" } }), null);
  assert.equal(trackerOf({ external: { key: "PAY-1" } }), null);
});
