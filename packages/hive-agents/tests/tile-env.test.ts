// What an agent is told at launch about where it is: its tile, its own token, the control plane
// its hooks report on and the drive socket its `hive ctl` drives on; and none of that goes to
// another machine.
import { expect, test } from "bun:test";
import YAML from "yaml";
import { defFromManifest } from "../src/manifest.js";
import { manifestRuntime, withoutControl } from "../src/runtime-manifest.js";
import { AUTHORED, authoredYaml } from "./authored.js";

const codex = defFromManifest(YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "codex")!)));

test("an agent is launched knowing its tile, its own token, and both of this machine's sockets", () => {
  const plan = manifestRuntime(codex, () => undefined)!.launch!({
    tileId: "hm:a", cwd: "/w", args: [], env: {}, phase: "spawn", platform: "linux",
    paths: { private: "/ud/agents/codex", execPath: "/app/hive", tileSessionsDir: "/ud/tile-sessions", home: "/home/u", hooks: {}, hcpSock: "/ud/hcp.sock", driveSock: "/ud/drive.sock", hcpToken: (tile) => `token-of-${tile}` },
  });
  expect(plan.env).toMatchObject({ HIVEMIND_TILE: "hm:a", HCP_TOKEN: "token-of-hm:a", HIVE_HCP_SOCK: "/ud/hcp.sock", HIVE_DRIVE_SOCK: "/ud/drive.sock" });
});

test("this machine's control-plane credentials are taken out of what goes to another machine, and nothing else", () => {
  expect(withoutControl({ HCP_TOKEN: "t", HIVE_HCP_SOCK: "/ud/hcp.sock", HIVE_DRIVE_SOCK: "/ud/drive.sock", HIVEMIND_TILE: "hm:a", X: "1" })).toEqual({ HIVEMIND_TILE: "hm:a", X: "1" });
  expect(withoutControl(undefined)).toBeUndefined();
});
