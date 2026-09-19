/** Golden for the CLI's view of agent providers.
 *
 *  Nothing is compiled in any more, so before the catalog loads no id resolves as an
 *  agent; after installing the published fixtures into the temp XDG (what a machine
 *  that auto-installed from HiveHub has) the same ids resolve — and `hive agent detect`
 *  probes exactly the installed agents' CLIs. */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssignee } from "../src/parse.js";
import { setCatalog } from "@hivemind/agents";
import { hive } from "./helpers.js";

const IDS = ["claude", "codex", "droid", "kiro", "kiro-cli", "pi", "opencode", "gemini", "sarah"];

describe("agents golden", () => {
  test("parseAssignee: which ids resolve as agents", () => {
    // Before anything is loaded the catalog is empty — nothing is compiled in — so
    // every id is a person's name until this machine has the agent installed. Every
    // command that takes an assignee loads the machine's agents first (`ensureAgentCatalog`).
    // Reset explicitly: other suites in this run may have seeded the catalog already.
    setCatalog([]);
    expect(Object.fromEntries(IDS.map((id) => [id, parseAssignee(id)?.type]))).toEqual({
      claude: "member", codex: "member", droid: "member", kiro: "member", "kiro-cli": "member", pi: "member", opencode: "member", gemini: "member", sarah: "member",
    });
  });

  test("after installing the published agents, the same ids resolve as agents and detect probes their CLIs", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agents-ws-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agents-bin-"));
    fs.mkdirSync(path.join(ws, ".hivemind", "issues"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".hivemind", "config.yaml"), "prefix: AG\nnext_id: 1\nagents: {}\n");
    // The agents a machine that found their CLIs would have installed from the catalog —
    // so this proves an installed agent is probed exactly like the old built-ins were.
    const examples = path.join(__dirname, "..", "..", "..", "packages", "hive-agents", "tests", "fixtures", "published-agents");
    for (const id of ["claude", "codex", "droid", "gemini", "hermes", "kiro", "opencode", "amp", "pi", "cursor"]) {
      const dest = path.join(ws, "xdg", "hivemind", "agents", id);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(examples, id, "agent.yaml"), path.join(dest, "agent.yaml"));
    }
    for (const b of ["claude", "codex", "droid", "kiro-cli", "kiro", "pi", "opencode", "gemini", "amp", "cursor-agent", "cursor", "hermes", "openclaw", "vim"]) {
      fs.writeFileSync(path.join(bin, b), "#!/bin/sh\n"); fs.chmodSync(path.join(bin, b), 0o755);
    }
    const r = hive(["agent", "detect", "--json"], { cwd: ws, env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(ws, "xdg") } });
    expect(r.code).toBe(0);
    const found = Object.keys((r.json as { data: Record<string, unknown> }).data);
    // Every stand-in binary that an installed agent names is probed and found …
    expect(found).toEqual(expect.arrayContaining(["amp", "claude", "codex", "cursor-agent", "droid", "gemini", "hermes", "kiro-cli", "opencode", "pi"]));
    // … and nothing that is not an installed agent's binary (`kiro` and `cursor` are
    // the IDEs, whose agents are `kiro-cli` and `cursor-agent`; `openclaw` and `vim`
    // are not installed here).
    expect(found).not.toContain("kiro");
    expect(found).not.toContain("cursor");
    expect(found).not.toContain("openclaw");
    expect(found).not.toContain("vim");
    fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true });
  });
});
