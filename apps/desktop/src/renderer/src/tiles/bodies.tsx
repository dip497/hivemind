/**
 * The bodies the app draws the moment a tile exists: a terminal starts its session, an issue
 * board and a waiting plan show at once. Imported by the TileHost only, so the plugin specs stay
 * loadable without a DOM.
 */
import { IssuesTile } from "../IssuesTile";
import { PlanReviewTile } from "../PlanReviewTile";
import TerminalBody from "./terminal-body";
import { terminalTile } from "./terminal";
import { issuesTile } from "./issues";
import { planReviewTile } from "./plan-review";

Object.assign(terminalTile, { lazy: false, body: TerminalBody });
Object.assign(issuesTile, { lazy: false, body: ({ data, selected }: { data: Parameters<typeof IssuesTile>[0]; selected: boolean }) => <IssuesTile {...data} selected={selected} /> });
Object.assign(planReviewTile, { lazy: false, body: ({ data }: { data: Parameters<typeof PlanReviewTile>[0] }) => <PlanReviewTile {...data} /> });
