// Every hook a published agent's events name must reach the daemon's hook map, or the event is
// silently dropped when its config is rendered — kiro's approval hook was, for a while.
import { expect, test } from "bun:test";
import { hookPathsFor } from "../src/node.js";
import { defFromManifest } from "../src/manifest.js";
import { AUTHORED, authoredYaml } from "./authored.js";
import YAML from "yaml";

const ctx = {
  tileSessionsDir: "/ud/tile-sessions", trackerPath: "/ud/t.cjs", stopHookPath: "/ud/s.cjs", approvalHookPath: "/ud/a.cjs",
  subagentHookPath: "/ud/sa.cjs", notificationHookPath: "/ud/n.cjs", userpromptHookPath: "/ud/u.cjs",
  planHookPath: "/ud/p.cjs", planBridgeSock: "/ud/plan.sock", hcpSock: "/ud/hcp.sock", execPath: "/bin/hive",
} as Parameters<typeof hookPathsFor>[1];

for (const agent of AUTHORED) {
  const def = defFromManifest(YAML.parse(authoredYaml(agent)));
  if (!def.hooks) continue;
  test(`${agent.id}: every hook its events name is wired`, () => {
    const wired = hookPathsFor(def, ctx);
    const named = Object.values(def.hooks!.events).flatMap((e) => (Array.isArray(e) ? e : [e]).map((x) => x.hook));
    expect(named.filter((h) => !wired[h])).toEqual([]);
  });
}

test("an agent's own hook script runs from its folder, with the control-plane socket", () => {
  const kiro = AUTHORED.find((a) => a.id === "kiro")!;
  const wired = hookPathsFor(defFromManifest(YAML.parse(authoredYaml(kiro))), ctx);
  expect(wired.kiroApproval).toEqual({ path: "/ud/agents/kiro/hcp-kiro-approval-hook.cjs", arg: "/ud/hcp.sock" });
});
