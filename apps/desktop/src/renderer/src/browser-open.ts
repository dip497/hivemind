/** A workspace page (`.html`) as a `file:` URL the Browser tile opens. */
import { withoutTrailingSlashes } from "@hivemind/core/remote-uri";

export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(stripLineSuffix(path));
}

export function htmlFileUrl(repoPath: string, relPath: string): string | null {
  if (!repoPath || /^[a-z][a-z0-9+.-]*:\/\//i.test(repoPath)) return null;
  const rel = stripLineSuffix(relPath).replace(/^file:\/\//i, "");
  if (!isHtmlPath(rel)) return null;
  if (rel.startsWith("/") || rel.split(/[\\/]+/).includes("..")) return null;
  const root = withoutTrailingSlashes(repoPath);
  return localPathToFileUrl(`${root}/${rel.replace(/^\.\/+/, "")}`);
}

function stripLineSuffix(path: string): string {
  return path.replace(/:\d+(?::\d+)?$/, "").replace(/[)\].,;:'"]+$/, "");
}

function localPathToFileUrl(absPath: string): string | null {
  if (!absPath.startsWith("/")) return null;
  const normalized = absPath.replace(/\/+/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encoded}`;
}
