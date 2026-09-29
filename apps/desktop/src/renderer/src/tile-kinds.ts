/** The kinds of tile the canvas can host. Shared by Canvas and the extracted
 *  canvas/* presentational modules so they don't depend on Canvas.tsx. */
// Defined with the layout they are saved in (@hivemind/workspace-doc/shapes), where main reads them too.
export { AGENT_TILE_KIND, isTerminalKind, type TileKind } from "@hivemind/workspace-doc/shapes";
