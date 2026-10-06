import type { TilePlugin } from "./api";

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
  kinds: { planReview: { size: { width: 1280, height: 920 } } },
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
  body: () => import("../PlanReviewTile").then((m) => ({ default: ({ data }) => <m.PlanReviewTile {...data} /> })),
};
