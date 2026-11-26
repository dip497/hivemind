/** Which agent is editing which file, so two do not edit the same one. One holder per absolute path. */

export interface FileClaim {
  path: string;
  by: string;
  since: number;
  note?: string;
}

export interface ClaimResult {
  claimed: string[];
  held: FileClaim[];
}

export class FileClaims {
  private held = new Map<string, FileClaim>();

  constructor(private readonly now: () => number = Date.now) {}

  /** All of `paths` or none: any held by another agent refuses the lot. */
  claim(by: string, paths: string[], note?: string): ClaimResult {
    const held = paths.map((p) => this.held.get(p)).filter((c): c is FileClaim => !!c && c.by !== by);
    if (held.length) return { claimed: [], held };
    for (const path of paths) this.held.set(path, { path, by, since: this.now(), ...(note ? { note } : {}) });
    return { claimed: paths, held: [] };
  }

  /** Release `paths` of `by`'s, or every one it holds when none are named. */
  release(by: string, paths: string[]): string[] {
    const mine = paths.length ? paths : this.list().filter((c) => c.by === by).map((c) => c.path);
    return mine.filter((p) => this.held.get(p)?.by === by && this.held.delete(p));
  }

  list(): FileClaim[] {
    return [...this.held.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  forget(tile: string): void {
    this.release(tile, []);
  }
}
