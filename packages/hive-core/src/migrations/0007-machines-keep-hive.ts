/**
 * A saved machine now says whether this app puts its own `hive` there (`installHive`), and a new
 * one does not unless asked. Every machine saved before was added when the app always put it
 * there, and its terminals may be running under it now: each keeps it. Run again after being cut
 * off, it sets the same.
 */
import path from "node:path";
import { readMachines, writeMachines } from "../machines.js";
import type { Migration } from "./runner.js";

const FILE = "machines.json";

export const m0007: Migration = {
  id: "0007-machines-keep-hive",
  root: "config",
  backsUp: [FILE],
  // An older app refuses a machines file with a field it does not know.
  movesFilesAnOlderAppReads: true,
  async changesHere(ctx) {
    const list = await readMachines(path.join(ctx.root, FILE)).catch(() => []);
    return list.some((m) => !m.installHive);
  },
  async run(ctx) {
    const file = path.join(ctx.root, FILE);
    const list = await readMachines(file);
    if (!list.length) return { kept: 0 };
    await writeMachines(list.map((m) => ({ ...m, installHive: true })), file);
    return { kept: list.length };
  },
};
