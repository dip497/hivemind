// Every hook a published agent's events name must reach the daemon's hook map, or the event is
// silently dropped when its config is rendered — kiro's approval hook was, for a while.
import { expect, test } from "bun:test";
import { hookPathsFor } from "../src/node.js";
import { defFromManifest } from "../src/manifest.js";
import { AUTHORED, authoredYaml } from "./authored.js";
import YAML from "yaml";

const ctx = {
  tileSessionsDir: "/ud/tile-sessions", trackerPath: "/ud/t.cjs", planBridgeSock: "/ud/plan.sock", hcpSock: "/ud/hcp.sock",
  execPath: "/bin/hive", eventHookPath: "/ud/e.cjs", sdkPath: "/ud/hive-sdk.cjs",
} as Parameters<typeof hookPathsFor>[1];

for (const agent of AUTHORED) {
  const def = defFromManifest(YAML.parse(authoredYaml(agent)));
  if (!def.hooks) continue;
  test(`${agent.id}: every hook its events name is wired`, () => {
    const wired = hookPathsFor(def, ctx);
    const named = Object.values(def.hooks!.events).flatMap((e) => (Array.isArray(e) ? e : [e]).map((x) => (x.emit ? "event" : x.hook!)));
    expect(named.filter((h) => !wired[h])).toEqual([]);
  });
}

test("an agent's own hook script runs from its folder, told where the SDK and sockets are", () => {
  const kiro = AUTHORED.find((a) => a.id === "kiro")!;
  const wired = hookPathsFor(defFromManifest(YAML.parse(authoredYaml(kiro))), ctx);
  expect(wired.kiroApproval).toEqual({
    path: "/ud/agents/kiro/hcp-kiro-approval-hook.cjs",
    env: { HIVE_SDK: "/ud/hive-sdk.cjs", HIVE_HOOK_SOCK: "/ud/hcp.sock", HIVE_PLAN_SOCK: "/ud/plan.sock" },
  });
});

test("without the SDK an agent's own scripts are not wired, so its events drop rather than fail", () => {
  const kiro = AUTHORED.find((a) => a.id === "kiro")!;
  const { sdkPath: _, ...noSdk } = ctx;
  expect(hookPathsFor(defFromManifest(YAML.parse(authoredYaml(kiro))), noSdk).kiroApproval).toBeUndefined();
});

test("claude's whole hooks document survives plan validation on every platform, supervised", async () => {
  const { renderHookDocument } = await import("../src/hooks.js");
  const { validatePlan, MAX_ARG } = await import("../src/runtime.js");
  const claude = defFromManifest(YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "claude")!)));
  for (const platform of ["linux", "win32"] as const) {
    const doc = renderHookDocument(claude, {
      tileId: "hm:0123456789abcdef", cwd: "/w", args: [], env: {}, phase: "spawn", platform, supervise: "all",
      paths: { private: "/ud/agents/claude", execPath: "/opt/hivemind/hivemind", tileSessionsDir: "/ud/tile-sessions", home: "/home/u", hooks: hookPathsFor(claude, ctx) },
    })!;
    expect(doc.length).toBeLessThan(MAX_ARG / 2);
    expect(validatePlan({ argsBefore: ["--settings", doc] }).argsBefore).toEqual(["--settings", doc]);
  }
});
