// The issues feature (protocol 1.9): reading and writing the workspace's issues both need
// `workspace:issues`, refused by the client before anything is sent, and by the host if it is
// sent anyway.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { ViewIssueSummary } from "../src/protocol.js";

const one: ViewIssueSummary = { id: "HM-1", title: "Ship it", state: "todo", parent: null, labels: [], assignee: null, created: "2026-10-07T00:00:00Z", updated: "2026-10-07T00:00:00Z" };

test("a view with the permission hears the issues, reads one and writes", async () => {
  const calls: unknown[] = [];
  const host = fakeHost({ features: ["issues"], capabilities: ["workspace:issues"], answers: { issue: (a) => { calls.push(a); return a; } } });
  const hm = await host.connect();
  const heard: ViewIssueSummary[][] = [];
  hm.onIssues((list) => heard.push(list));
  await host.settle();
  expect(host.subscribed.issues).toBe(true);
  host.send({ type: "issues", issues: [one] });
  await host.settle();
  expect(heard).toEqual([[one]]);
  await hm.issues.read("HM-1");
  await hm.issues.setState("HM-1", "done", "shipped");
  expect(calls).toEqual([{ call: "read", args: ["HM-1"] }, { call: "setState", args: ["HM-1", "done", "shipped"] }]);
  expect(host.refused).toEqual([]);
});

test("a view without it can neither read nor hear the issues, and the host refuses one that tries", async () => {
  const host = fakeHost({ features: ["issues"], answers: { issue: () => one } });
  const hm = await host.connect();
  expect(() => hm.onIssues(() => {})).toThrow('needs permission "workspace:issues"');
  expect(() => hm.issues.read("HM-1")).toThrow('needs permission "workspace:issues"');
  expect(() => hm.issues.delete("HM-1")).toThrow('needs permission "workspace:issues"');

  const port = hm as unknown as { send(m: unknown): void };
  port.send({ type: "subscribeIssues" });
  port.send({ type: "request", requestId: 99, name: "issue", args: [{ call: "read", args: ["HM-1"] }] });
  await host.settle();
  expect(host.subscribed.issues).toBeFalsy();
  expect(host.refused).toEqual(['subscribeIssues needs permission "workspace:issues"', 'issue read needs permission "workspace:issues"']);
});
