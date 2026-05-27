import { defineCommand } from "citty";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  HiveError,
  findRoot,
  templates,
  writeConfig,
  writeAgentContext,
} from "@hivemind/core";
import { err, ok } from "../format.js";

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
      description:
        "Also install the agentic stack: .mcp.json + claude SKILL.md + " +
        "agentic section appended to CLAUDE.md. Idempotent.",
    },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cwd = process.cwd();
    const root = path.join(cwd, ".hivemind");

    // --agentic alone (no --prefix): just install templates into an
    // existing workspace. Don't re-init storage.
    if (args.agentic && !args.prefix) {
      const existing = await findRoot(cwd);
      if (!existing) {
        return err(
          ctx,
          "no_workspace",
          "no .hivemind/ found — run `hive init --prefix XX` first, then `hive init --agentic`",
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
            `      hive init --agentic     # install claude MCP + skill`,
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

interface AgenticReport {
  claudeAgentic: "appended" | "unchanged" | "replaced" | "created";
  mcp: "created" | "merged" | "unchanged";
  skill: "created" | "unchanged";
}

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

/** Idempotent installer for the agentic templates. Safe to re-run.
 *  - CLAUDE.md: appends a section wrapped in `<!-- hivemind:agentic:* -->`.
 *    On re-run, replaces just that section (rest of CLAUDE.md preserved).
 *  - .mcp.json: if absent → write fresh; if present → merge mcpServers.hive
 *    (overwrite our key, keep theirs).
 *  - .claude/skills/hive-work/SKILL.md: write only if missing. */
async function installAgenticFiles(cwd: string, hiveRoot: string): Promise<AgenticReport> {
  // Locate the hive CLI binary if installed; fall back to running this
  // process's argv[1] (the script path) so the user's local dev source works.
  const hiveCliPath = await resolveHiveCli();

  // 1. CLAUDE.md agentic section
  const claudePath = path.join(cwd, "CLAUDE.md");
  let claudeAgentic: AgenticReport["claudeAgentic"] = "created";
  const AGENTIC_MARKER_RE = /<!--\s*hivemind:agentic:start\s*-->[\s\S]*?<!--\s*hivemind:agentic:end\s*-->\n?/;
  try {
    const existing = await fs.readFile(claudePath, "utf8");
    if (AGENTIC_MARKER_RE.test(existing)) {
      const replaced = existing.replace(AGENTIC_MARKER_RE, templates.agenticClaudeAppend().trim() + "\n");
      if (replaced !== existing) {
        await fs.writeFile(claudePath, replaced, "utf8");
        claudeAgentic = "replaced";
      } else {
        claudeAgentic = "unchanged";
      }
    } else {
      await fs.writeFile(claudePath, existing + templates.agenticClaudeAppend(), "utf8");
      claudeAgentic = "appended";
    }
  } catch {
    await fs.writeFile(
      claudePath,
      `# CLAUDE.md\n\n(Project rules go here.)\n${templates.agenticClaudeAppend()}`,
      "utf8",
    );
    claudeAgentic = "created";
  }

  // 2. .mcp.json
  const mcpPath = path.join(cwd, ".mcp.json");
  const ourMcpJson = templates.mcpJson(hiveCliPath, hiveRoot);
  const ourMcp = JSON.parse(ourMcpJson) as { mcpServers: Record<string, unknown> };
  let mcp: AgenticReport["mcp"] = "created";
  try {
    const existing = await fs.readFile(mcpPath, "utf8");
    let merged: { mcpServers?: Record<string, unknown> };
    try {
      merged = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    } catch {
      merged = {};
    }
    const before = JSON.stringify(merged);
    merged.mcpServers = { ...(merged.mcpServers ?? {}), ...ourMcp.mcpServers };
    const after = JSON.stringify(merged);
    if (after !== before) {
      await fs.writeFile(mcpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
      mcp = "merged";
    } else {
      mcp = "unchanged";
    }
  } catch {
    await fs.writeFile(mcpPath, ourMcpJson + "\n", "utf8");
    mcp = "created";
  }

  // 3. .claude/skills/hive-work/SKILL.md
  const skillDir = path.join(cwd, ".claude", "skills", "hive-work");
  const skillPath = path.join(skillDir, "SKILL.md");
  let skill: AgenticReport["skill"] = "created";
  try {
    await fs.stat(skillPath);
    skill = "unchanged";
  } catch {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, templates.HIVE_WORK_SKILL, "utf8");
  }

  return { claudeAgentic, mcp, skill };
}

/** Best-effort find the `hive` binary on PATH; fall back to argv[1] (this
 *  process's entry script) so dev-source invocations work. */
async function resolveHiveCli(): Promise<string> {
  // 1. PATH lookup
  const PATH = process.env.PATH ?? "";
  for (const dir of PATH.split(":").filter(Boolean)) {
    try {
      const p = path.join(dir, "hive");
      const st = await fs.stat(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      /* not here */
    }
  }
  // 2. argv[1] = this script's path. If we're running from `bun run
  //    .../cli/src/index.ts mcp-stdio`, argv[1] is the .ts source.
  //    If we're running from the compiled binary, argv[1] is the binary.
  const argv1 = process.argv[1];
  if (argv1) return path.resolve(argv1);
  return "hive"; // last resort — bare name; user fixes PATH
}
