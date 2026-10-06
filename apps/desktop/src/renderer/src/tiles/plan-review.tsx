import type { TilePlugin, TileBodyArgs } from "./api";

/** The kind an agent's plan hand-off opens. */
export const PLAN_REVIEW = "planReview";

export type PlanReviewTileData = {
  requestId?: string;
  hcpCmdId?: string;
  plan: string;
  cwd: string;
  agentTileId?: string;
  onClose?: () => void;
};

/** An agent's plan, waiting for the person to approve it. */
export const planReviewTile: TilePlugin<PlanReviewTileData> = {
  surface: "planReview",
  name: "Plan review",
  kinds: { [PLAN_REVIEW]: { size: { width: 1280, height: 920 }, label: "Plan review", glyph: "▤", ephemeral: true, unpinnable: true, waitsOnPerson: true } },
  data: (t, s) => {
    // Guard a stale/malformed saved tile so it never crashes the build.
    const r = t.review ?? { plan: "", cwd: "" };
    return {
      requestId: r.requestId, hcpCmdId: r.hcpCmdId, plan: r.plan,
      // A zone rebinds the agent's cwd like any tile's.
      cwd: s.zoneRepo ?? r.cwd, agentTileId: r.agentTileId,
      onClose: s.onClose,
    };
  },
  minSize: { width: 420, height: 300 },
  lazy: true,
  body: () => import("../PlanReviewTile").then((m) => ({ default: ({ data }: TileBodyArgs<PlanReviewTileData>) => <m.PlanReviewTile {...data} /> })),
};
