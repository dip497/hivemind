/** The tiles drawn by the app itself; the tool plugins that come with it register theirs as any
 *  plugin does (tool-plugins.tsx). */
import { registerTile } from "./api";
import { terminalTile } from "./terminal";
import { changesTile, codeTile, filesTile } from "./code";
import { browserTile } from "./browser";
import { planReviewTile } from "./plan-review";
import { missingTile } from "./missing";

registerTile(terminalTile);
registerTile(codeTile);
registerTile(filesTile);
registerTile(changesTile);
registerTile(browserTile);
registerTile(planReviewTile);
registerTile(missingTile);

export * from "./api";
