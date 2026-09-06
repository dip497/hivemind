/**
 * Plugin object of the throwaway sixth provider: at daemon start it writes a
 * claude-shaped hooks file (UserPromptSubmit → working, Stop → turn +
 * transcript) built from the SHARED HCP hook scripts; every spawn gets
 * `FAUX_HOOKS` pointing at it plus the HCP env. The stand-in binary
 * (fake-agent.cjs, provider "faux") reads that file and runs the hook commands
 * — the same wire contract a real runtime's hook system honours.
 */
import fs from "node:fs";
import path from "node:path";
import { shq } from "../../shq.js";
import type { AgentPlugin, SpawnSpec } from "../../types.js";
import { faux } from "./index.js";

const isFaux = (spec: SpawnSpec): boolean => (spec.cmd ?? "").split("/").pop() === faux.bin;

export const plugin: AgentPlugin = {
  def: faux,
  prepare: (p) => {
    const hooksFile = path.join(p.userDataDir, "faux-hooks.json");
    const cmd = (hook: string) => `ELECTRON_RUN_AS_NODE=1 ${shq(p.execPath)} ${shq(hook)} ${shq(p.hcpSock)}`;
    fs.writeFileSync(hooksFile, JSON.stringify({
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd(p.userpromptHookPath), timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd(p.stopHookPath), timeout: 10 }] }],
    }, null, 2));
    return { hooksFile };
  },
  resume: (ctx) => ({
    transformSpecOnSpawn: (spec, id) => {
      if (!isFaux(spec)) return spec;
      const hooksFile = ctx.providers?.[faux.id]?.hooksFile;
      if (!hooksFile || !ctx.hcpSock || !ctx.hcpToken) return spec;
      return {
        ...spec,
        env: {
          ...spec.env,
          FAUX_HOOKS: hooksFile,
          HIVE_HCP_SOCK: ctx.hcpSock,
          HCP_TOKEN: ctx.hcpToken,
          HIVEMIND_TILE: id,
          HIVE_AGENT_ID: faux.id,
          HIVE_AGENT_DEPTH: spec.env?.HIVE_AGENT_DEPTH ?? "0",
        },
      };
    },
  }),
};
