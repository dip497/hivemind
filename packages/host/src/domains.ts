/**
 * The workspace API a host answers (`spec/workspace-api.md`), domain by domain: git and
 * worktrees, files, issues and review comments. Each domain checks its calls' params and runs
 * them; none depends on Electron, so the app's main process (for its windows) and `hive host`
 * serve this same list.
 */
import { git } from "./git.js";
import { files } from "./files.js";
import { issuesDomain, type NameOf } from "./issues.js";
import { reviews } from "./reviews.js";

/** `nameOf`: what a peer is called in an issue's activity (a guest by the name they joined with). */
export const workspaceDomains = (nameOf?: NameOf) => [git, files, issuesDomain(nameOf), reviews];
