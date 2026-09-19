/** The kinds of tile the canvas can host. Shared by Canvas and the extracted
 *  canvas/* presentational modules so they don't depend on Canvas.tsx. */
/** The tile kind every AGENT tile has, whatever provider runs in it. The value
 *  is the historical kind id (kept for persisted layouts + tests); the
 *  provider is derived from the tile's command (agentForCmd). This is the ONLY
 *  place a provider's name appears as a literal outside its own def. */
export const AGENT_TILE_KIND = "claude" as const;
export type TileKind = typeof AGENT_TILE_KIND | "shell" | "editor" | "diff" | "issues" | "browser" | "planReview" | "workbench";
