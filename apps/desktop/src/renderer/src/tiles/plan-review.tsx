import type { TilePlugin, TileBodyArgs } from "./api";

/** The kind an agent's plan hand-off opens. */
export const PLAN_REVIEW = "planReview";

export type PlanReviewTileData = {
  agentTileId: string;
  since: number;
  plan: string;
  cwd: string;
  onClose?: () => void;
};

/** An agent's plan, waiting for the person to approve it. */
export const planReviewTile: TilePlugin<PlanReviewTileData> = {
  surface: "planReview",
  name: "Plan review",
  kinds: { [PLAN_REVIEW]: { size: { width: 1280, height: 920 }, label: "Plan review", glyph: "▤", ephemeral: true, unpinnable: true, waitsOnPerson: true } },
  data: (t, s) => {
    // Guard a stale/malformed saved tile so it never crashes the build.
    const r = t.review ?? { agentTileId: "", since: 0, plan: "" };
    return { agentTileId: r.agentTileId, since: r.since, plan: r.plan, cwd: s.zoneRepo ?? s.cwd, onClose: s.onClose };
  },
  minSize: { width: 420, height: 300 },
  lazy: true,
  body: () => import("../PlanReviewTile").then((m) => ({ default: ({ data }: TileBodyArgs<PlanReviewTileData>) => <m.PlanReviewTile {...data} /> })),
};
