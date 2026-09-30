/**
 * The workspace API a host answers (`spec/workspace-api.md`), domain by domain: git and
 * worktrees, files, issues and review comments. Each domain checks its calls' params and runs
 * them; none depends on Electron, so the app's main process (for its windows) and the dev-bridge
 * (for its page) serve this same list.
 */
import { git } from "./git.js";
import { files } from "./files.js";
import { issues } from "./issues.js";
import { reviews } from "./reviews.js";

export const workspaceDomains = [git, files, issues, reviews];
