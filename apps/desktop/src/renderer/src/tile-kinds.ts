/** The kinds of tile the canvas can host. Shared by Canvas and the extracted
 *  canvas/* presentational modules so they don't depend on Canvas.tsx. */
export type TileKind = "claude" | "shell" | "editor" | "diff" | "issues" | "browser" | "planReview";
