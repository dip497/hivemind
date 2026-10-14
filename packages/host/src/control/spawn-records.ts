/**
 * Who started each tile the control plane spawned, and on what terms, kept in a file: an app
 * restart keeps a worker's parent (its reports and approvals go there, and the Layers panel nests
 * it there), its spawn depth (the limit on agents spawning agents), and its supervision (put in
 * its environment when its session starts again).
 */
import fs from "node:fs";
import path from "node:path";

export interface SpawnRecord {
  /** Who hears its reports and answers its approvals: a tile's bare id, or a program
   *  (`client:<grant id>`). */
  parent?: string;
  /** The agent tile that spawned it, drawn wired to it. */
  spawner?: string;
  /** Whether what it says goes to its spawner as it says it. */
  reports: boolean;
  /** How many spawns deep it is: a tile the person opened is 0. */
  depth: number;
  /** The agent it runs. */
  agent: string;
  /** Its supervision policy: "all", or the tools that ask first. */
  supervise?: string;
}

export class SpawnRecords {
  private readonly records = new Map<string, SpawnRecord>();

  constructor(private readonly file: string) {
    let saved: unknown;
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    if (!saved || typeof saved !== "object") return;
    for (const [tile, r] of Object.entries(saved as Record<string, Partial<SpawnRecord>>)) {
      if (r && typeof r.agent === "string" && typeof r.depth === "number") {
        this.records.set(tile, {
          agent: r.agent, depth: r.depth, reports: r.reports === true,
          ...(typeof r.parent === "string" ? { parent: r.parent } : {}),
          ...(typeof r.spawner === "string" ? { spawner: r.spawner } : {}),
          ...(typeof r.supervise === "string" ? { supervise: r.supervise } : {}),
        });
      }
    }
  }

  get(tile: string): SpawnRecord | undefined {
    return this.records.get(tile);
  }

  entries(): IterableIterator<[string, SpawnRecord]> {
    return this.records.entries();
  }

  add(tile: string, record: SpawnRecord): void {
    this.records.set(tile, record);
    this.save();
  }

  /** `tile` is gone: its own record, and every tie to it as a parent or a spawner. */
  forget(tile: string): void {
    let changed = this.records.delete(tile);
    for (const r of this.records.values()) {
      if (r.parent === tile) { delete r.parent; changed = true; }
      if (r.spawner === tile) { delete r.spawner; r.reports = false; changed = true; }
    }
    if (changed) this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.records)));
    } catch { /* a folder it cannot write keeps them for this run only */ }
  }
}
