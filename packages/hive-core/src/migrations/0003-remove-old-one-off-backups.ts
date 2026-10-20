/**
 * Backups that one-off moves before the ledger left in the config root: the agents as they were
 * before agent manifest v2 (`agents-before-v2-0128/`) and settings.json before plugin state
 * (`settings.json.bak`). They move into this migration's backup, where `hive migrations` lists them
 * and the backups kept are pruned.
 */
import type { Migration } from "./runner.js";

const PATHS = ["agents-before-v2-0128", "settings.json.bak"];

export const m0003: Migration = {
  id: "0003-remove-old-one-off-backups",
  root: "config",
  backsUp: PATHS,
  movesFilesAnOlderAppReads: false,
  async run(ctx) {
    for (const rel of PATHS) await ctx.remove(rel);
    return {};
  },
};
