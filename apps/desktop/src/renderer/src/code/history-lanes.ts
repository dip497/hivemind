/**
 * The commit graph's lanes (docs/design/git-history-2026-11-02.md §5.8), worked out from what the
 * log already has, each commit's parents, as OpenIDEA and IntelliJ draw them: commits newest first,
 * children before parents. One pass, O(rows × lanes), kept per page so a new page goes on from the
 * last one's lanes and nothing drawn before moves.
 */

/** A line in a row: from a lane to a lane, in the row's top half (into the node) or bottom half. */
export interface LaneLine { from: number; to: number }

export interface LaneRow {
  /** The lane the commit's node is in. */
  lane: number;
  /** Lines from the row above down to this row's middle. */
  up: LaneLine[];
  /** Lines from this row's middle down to the row below. */
  down: LaneLine[];
  /** Lanes in use across the row, to size it. */
  width: number;
}

/** What the lanes expect next: the commit each lane goes on to, or null where a lane is free. */
export type LaneState = (string | null)[];

export function laneRows(commits: readonly { oid: string; parents: readonly string[] }[], start: LaneState = []): { rows: LaneRow[]; state: LaneState } {
  const lanes: LaneState = [...start];
  const rows: LaneRow[] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.oid);
    if (lane < 0) {
      // A branch tip no lane expected: the first free lane, or a new one.
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.push(null) - 1;
    }
    const up: LaneLine[] = [];
    lanes.forEach((want, i) => {
      if (want === null) return;
      // Every lane that expected this commit comes into its node; the others go straight on.
      up.push({ from: i, to: want === c.oid ? lane : i });
    });
    // The lanes that came in end here, but the node's own.
    lanes.forEach((want, i) => { if (want === c.oid && i !== lane) lanes[i] = null; });
    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    const down: LaneLine[] = [];
    const goTo: number[] = [];
    for (const p of rest) {
      // A merge's other parents: the lane already going to it, else a free one, else a new one.
      let to = lanes.indexOf(p);
      if (to < 0) {
        to = lanes.indexOf(null);
        if (to < 0) to = lanes.push(null) - 1;
        lanes[to] = p;
      }
      goTo.push(to);
    }
    lanes.forEach((want, i) => {
      if (want === null) return;
      if (i === lane && first) down.push({ from: lane, to: lane });
      else if (i !== lane && !goTo.includes(i)) down.push({ from: i, to: i });
    });
    for (const to of goTo) down.push({ from: lane, to });
    // Free lanes at the right go, so the graph narrows again.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, ...up.flatMap((l) => [l.from + 1, l.to + 1]), ...down.flatMap((l) => [l.from + 1, l.to + 1]));
    rows.push({ lane, up, down, width });
  }
  return { rows, state: lanes };
}
