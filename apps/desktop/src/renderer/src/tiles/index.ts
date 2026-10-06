/** The tiles that ship in the box. */
import { registerTile } from "./api";
import { terminalTile } from "./terminal";
import { codeTile } from "./code";
import { issuesTile } from "./issues";
import { browserTile } from "./browser";
import { planReviewTile } from "./plan-review";

registerTile(terminalTile);
registerTile(codeTile);
registerTile(issuesTile);
registerTile(browserTile);
registerTile(planReviewTile);

export * from "./api";
