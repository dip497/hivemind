/**
 * `machines-migrated`, the empty file that said the saved hosts had been moved into machines.json
 * once, by a build before the ledger. Nothing reads it.
 */
import type { Migration } from "./runner.js";

export const m0004: Migration = {
  id: "0004-remove-machines-marker",
  root: "data",
  backsUp: ["machines-migrated"],
  movesFilesAnOlderAppReads: false,
  async run(ctx) {
    await ctx.remove("machines-migrated");
    return {};
  },
};
