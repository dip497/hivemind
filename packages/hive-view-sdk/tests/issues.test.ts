// The issues feature (protocol 1.9): a view hears the workspace's issues and reads one freely;
// anything that writes needs `workspace:issues`, refused by the client before it is sent, and by
// the host if it is sent anyway.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { ViewIssueSummary } from "../src/protocol.js";

const one: ViewIssueSummary = { id: "HM-1", title: "Ship it", state: "todo", parent: null, labels: [], assignee: null, created: "2026-10-07T00:00:00Z", updated: "2026-10-07T00:00:00Z" };

test("a view hears the issues, reads one, and may not write without the permission", async () => {
  const calls: unknown[] = [];
  const host = fakeHost({ features: ["issues"], answers: { issue: (a) => { calls.push(a); return { ...one, sections: { description: "", acceptanceCriteria: [], activity: [] } }; } } });
  const hm = await host.connect();
  const heard: ViewIssueSummary[][] = [];
  hm.onIssues((list) => heard.push(list));
  await host.settle();
  expect(host.subscribed.issues).toBe(true);
  host.send({ type: "issues", issues: [one] });
  await host.settle();
  expect(heard).toEqual([[one]]);
  expect((await hm.issues.read("HM-1")).id).toBe("HM-1");
  expect(calls).toEqual([{ call: "read", args: ["HM-1"] }]);
  expect(() => hm.issues.setState("HM-1", "done")).toThrow('needs permission "workspace:issues"');
  expect(host.refused).toEqual([]);
});

test("a view with the permission writes; one sending a write without it is refused by the host", async () => {
  const host = fakeHost({ features: ["issues"], capabilities: ["workspace:issues"], answers: { issue: (a) => a } });
  const hm = await host.connect();
  expect(await hm.issues.setState("HM-1", "done", "shipped")).toEqual({ call: "setState", args: ["HM-1", "done", "shipped"] });

  const rude = fakeHost({ features: ["issues"], answers: { issue: () => "written" } });
  const port = await rude.connect();
  (port as unknown as { send(m: unknown): void }).send({ type: "request", requestId: 99, name: "issue", args: [{ call: "delete", args: ["HM-1"] }] });
  await rude.settle();
  expect(rude.refused).toEqual(['issue delete needs permission "workspace:issues"']);
});
