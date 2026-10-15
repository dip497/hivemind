// What the person chose to see on Home, kept phone-wide in one record
// (docs/design/phone-home-layers-2026-10-15.md, 5): the View menu's choices, what they folded, and
// when they last opened each tile. The core keeps none of it: it is given with every call.

import { get, put } from "./store.js";

/** The View menu's groups and choices, in the desktop's words. */
export const VIEW_CHOICES = {
  status: [["all", "All"], ["needs-you", "Needs you"], ["unread", "Unread"], ["working", "Working"], ["idle", "Idle"], ["exited", "Exited"]],
  activity: [["all", "All"], ["hour", "Past hour"], ["today", "Today"], ["week", "This week"]],
  groupBy: [["group", "Project"], ["machine", "Machine"], ["date", "Date"], ["status", "Status"], ["agent", "Agent"], ["none", "None"]],
  sortBy: [["canvas", "Canvas order"], ["activity", "Last activity"], ["name", "Name"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

export const VIEW_GROUPS: Array<[ViewGroup, string]> = [["status", "Status"], ["activity", "Last activity"], ["groupBy", "Group by"], ["sortBy", "Sort by"]];

export type ViewGroup = keyof typeof VIEW_CHOICES;
type Prefs = Record<ViewGroup, string>;
const DEFAULTS: Prefs = { status: "all", activity: "all", groupBy: "group", sortBy: "canvas" };
const KEPT = "home-choices";
/** Tiles whose last opening is kept; the oldest go past it. */
const SEEN_KEPT = 1000;

interface Kept {
  prefs: Prefs;
  folded: string[];
  seen: Record<string, number>;
}

export class HomeChoices {
  prefs: Prefs = { ...DEFAULTS };
  private folded = new Set<string>();
  private seen: Record<string, number> = {};
  /** Something was chosen before what was kept was read: that stays. */
  private touched = false;

  /** Take what this browser kept, when nothing was chosen meanwhile. */
  async load(): Promise<void> {
    const kept = await get<Kept>(KEPT).catch(() => undefined);
    if (!kept || this.touched) return;
    for (const [group] of VIEW_GROUPS) {
      const id = kept.prefs?.[group];
      if (VIEW_CHOICES[group].some(([c]) => c === id)) this.prefs[group] = id!;
    }
    this.folded = new Set(kept.folded ?? []);
    this.seen = { ...kept.seen };
  }

  choose(group: ViewGroup, id: string): void {
    this.prefs[group] = id;
    this.keep();
  }

  /** Fold what is under `key`, or unfold it. */
  fold(key: string): void {
    if (!this.folded.delete(key)) this.folded.add(key);
    this.keep();
  }

  /** The person opened the tile keyed `key`: what it did until now is read. */
  saw(key: string): void {
    this.seen[key] = Date.now();
    const keys = Object.keys(this.seen);
    if (keys.length > SEEN_KEPT) {
      keys.sort((a, b) => this.seen[a]! - this.seen[b]!);
      for (const k of keys.slice(0, keys.length - SEEN_KEPT)) delete this.seen[k];
    }
    this.keep();
  }

  /** Every View menu choice back to its first; what is folded and seen stays. */
  reset(): void {
    this.prefs = { ...DEFAULTS };
    this.keep();
  }

  /** Any of the View menu's choices is not its first. */
  chosen(): boolean {
    return VIEW_GROUPS.some(([g]) => this.prefs[g] !== DEFAULTS[g]);
  }

  /** As the core takes it (hive-phone's `home::HomeView`, less the clock). */
  view(): Kept {
    return { prefs: this.prefs, folded: [...this.folded], seen: this.seen };
  }

  private keep(): void {
    this.touched = true;
    void put(KEPT, this.view()).catch(() => {});
  }
}
