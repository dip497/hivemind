/**
 * The workspace API a host answers (`spec/workspace-api.md`), domain by domain: git and
 * worktrees, finding code, files, issues and review comments. Each domain checks its calls' params and runs
 * them; none depends on Electron, so the app's main process (for its windows) and `hive host`
 * serve this same list.
 */
import { git } from "./git.js";
import { code } from "./code.js";
import { codeIntel } from "./code-intel.js";
import { files } from "./files.js";
import { fileFacts } from "./file-facts.js";
import { issues } from "./issues.js";
import { reviews } from "./reviews.js";

export const workspaceDomains = [git, code, codeIntel, files, fileFacts, issues, reviews];
