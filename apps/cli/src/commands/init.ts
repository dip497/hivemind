import { defineCommand } from "citty";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  HiveError,
  findRoot,
  registerWorkspace,
  templates,
  writeConfig,
  writeAgentContext,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { installAgenticFiles } from "../agentic-install.js";

export const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Initialize a .hivemind/ tracker in the current directory",
  },
  args: {
    prefix: {
      type: "string",
      description: "Issue ID prefix (e.g. PAY, WEB, INFRA)",
      required: false,
    },
    agentic: {
      type: "boolean",
      default: true,
      description:
        "Install the agentic stack: .mcp.json (hive MCP server) + claude " +
        "SKILL.md + agentic section in CLAUDE.md. ON by default; pass " +
        "--no-agentic to skip. Idempotent.",
    },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cwd = process.cwd();
    const root = path.join(cwd, ".hivemind");

    // Agentic-only (no --prefix): install/refresh the stack into an EXISTING
    // workspace, don't re-init storage. This is also the bare `hive init` path
    // (agentic is on by default) — a no-prefix invocation means "add agentic
    // here". `--no-agentic` without a prefix is a no-op the prefix guard catches.
    if (args.agentic && !args.prefix) {
      const existing = await findRoot(cwd);
      if (!existing) {
        return err(
          ctx,
          "no_workspace",
          "no .hivemind/ found — run `hive init --prefix XX` first (it installs the agentic stack by default)",
        );
      }
      return installAgentic(ctx, cwd, existing);
    }

    if (!args.prefix) {
      return err(ctx, "missing_prefix", "--prefix required (e.g. --prefix PAY)");
    }

    // Refuse to clobber.
    const existing = await findRoot(cwd);
    if (existing && existing === root) {
      return err(ctx, "exists", `.hivemind/ already exists at ${root}`);
    }

    const PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;
    const prefix = String(args.prefix).toUpperCase();
    if (!PREFIX_RE.test(prefix)) {
      return err(
        ctx,
        "bad_prefix",
        `prefix must be UPPERCASE 2-10 chars (got: ${prefix})`
      );
    }

    try {
      await fs.mkdir(path.join(root, "issues"), { recursive: true });
      await writeConfig(root, { prefix, next_id: 1, agents: {} });
      await writeAgentContext(root);
      // Index this workspace so cross-repo move/link can resolve its prefix.
      await registerWorkspace(root).catch(() => {});

      // AGENTS.md — write only if missing.
      const agentsPath = path.join(cwd, "AGENTS.md");
      try {
        await fs.stat(agentsPath);
      } catch {
        await fs.writeFile(agentsPath, templates.AGENTS_MD, "utf8");
      }

      // CLAUDE.md — append our section if file exists; otherwise write fresh.
      const claudePath = path.join(cwd, "CLAUDE.md");
      let claudeAction = "created";
      try {
        const existing = await fs.readFile(claudePath, "utf8");
        if (existing.includes("<!-- hivemind:start -->")) {
          claudeAction = "unchanged (already includes hivemind section)";
        } else {
          await fs.writeFile(claudePath, existing + templates.claudeMdInclude(), "utf8");
          claudeAction = "appended";
        }
      } catch {
        await fs.writeFile(
          claudePath,
          templates.freshClaudeMd(path.basename(cwd)),
          "utf8"
        );
      }

      // .gitignore — append .agent.md line if not present.
      const giPath = path.join(cwd, ".gitignore");
      let gi = "";
      try {
        gi = await fs.readFile(giPath, "utf8");
      } catch {
        /* none */
      }
      if (!gi.split("\n").includes(".hivemind/.agent.md")) {
        gi = (gi.endsWith("\n") || gi.length === 0 ? gi : gi + "\n") + ".hivemind/.agent.md\n";
        await fs.writeFile(giPath, gi, "utf8");
      }

      // Optionally chain the agentic install in one shot.
      if (args.agentic) {
        const ag = await installAgenticFiles(cwd, root);
        return ok(
          ctx,
          {
            root,
            prefix,
            agents_md: agentsPath,
            claude_md: claudePath,
            claudeAction,
            agentic: ag,
          },
          () =>
            [
              `✓ initialised .hivemind/ at ${root}`,
              `  prefix:    ${prefix}`,
              `  next ID:   ${prefix}-1`,
              `  AGENTS.md  written`,
              `  CLAUDE.md  ${claudeAction} + agentic section ${ag.claudeAgentic}`,
              `  .mcp.json  ${ag.mcp}`,
              `  skill      ${ag.skill}`,
              ``,
              `next: hive new "first issue title"`,
            ].join("\n"),
        );
      }

      return ok(
        ctx,
        { root, prefix, agents_md: agentsPath, claude_md: claudePath, claudeAction },
        () =>
          [
            `✓ initialised .hivemind/ at ${root}`,
            `  prefix:    ${prefix}`,
            `  next ID:   ${prefix}-1`,
            `  AGENTS.md  written`,
            `  CLAUDE.md  ${claudeAction}`,
            `  .agent.md  auto-generated`,
            ``,
            `next: hive new "first issue title"`,
            `      hive add mcp / hive add skill   # add the claude MCP + skill (skipped via --no-agentic)`,
          ].join("\n")
      );
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "init_failed";
      return err(ctx, code, msg);
    }
  },
});

// ── agentic install ──────────────────────────────────────────────────────
// The installers live in ../agentic-install.js (shared with `hive add`).

async function installAgentic(
  ctx: { json: boolean },
  cwd: string,
  hiveRoot: string,
): Promise<unknown> {
  try {
    const r = await installAgenticFiles(cwd, hiveRoot);
    return ok(
      ctx,
      r,
      () =>
        [
          `✓ agentic stack installed`,
          `  CLAUDE.md  agentic section ${r.claudeAgentic}`,
          `  .mcp.json  ${r.mcp}`,
          `  skill      ${r.skill}  (.claude/skills/hive-work/SKILL.md)`,
          ``,
          `start claude in this dir — it auto-loads the MCP server + skill.`,
        ].join("\n"),
    );
  } catch (e) {
    return err(ctx, "agentic_install_failed", (e as Error).message);
  }
}
