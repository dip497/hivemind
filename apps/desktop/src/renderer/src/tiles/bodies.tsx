/**
 * The bodies the app draws the moment a tile exists: a terminal starts its session, a waiting
 * plan shows at once. Imported by the TileHost only, so the plugin specs stay
 * loadable without a DOM.
 */
import { PlanReviewTile } from "../PlanReviewTile";
import TerminalBody from "./terminal-body";
import { terminalTile } from "./terminal";
import { planReviewTile } from "./plan-review";

Object.assign(terminalTile, { lazy: false, body: TerminalBody });
Object.assign(planReviewTile, { lazy: false, body: ({ data }: { data: Parameters<typeof PlanReviewTile>[0] }) => <PlanReviewTile {...data} /> });
