/**
 * `hive guide <topic>` — the guide an agent reads to work here, as this `hive` ships it: the same
 * text `hive add skill` writes into a folder, so an agent in a tile has it whether or not anyone
 * wrote it there. A tile's `HIVEMIND_GUIDE` names the command.
 */
import { defineCommand } from "citty";
import { SKILLS } from "@hivemind/core";
import { printFailure } from "../exit-codes.js";

/** Each topic, by the skill it prints. */
const TOPICS: Record<string, string> = {
  agents: "hivemind",
  work: "hive-work",
  browser: "hive-browser",
  workflow: "hive-workflow",
};

export const guideCmd = defineCommand({
  meta: { name: "guide", description: `Print a guide for agents working here: ${Object.keys(TOPICS).join(", ")} (agents: driving other agents with hive ctl)` },
  args: { topic: { type: "positional", required: true, description: Object.keys(TOPICS).join(" | ") } },
  run({ args }) {
    const skill = TOPICS[String(args.topic)];
    if (!skill) printFailure(false, { code: "USAGE", message: `no guide ${String(args.topic)}: there are ${Object.keys(TOPICS).join(", ")}`, fix: "hive guide agents" });
    process.stdout.write(SKILLS[skill]!());
  },
});
