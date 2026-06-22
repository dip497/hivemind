export type BrowserOpenTarget =
  | { kind: "browser"; url: string }
  | { kind: "editor"; path: string }
  | { kind: "app"; target: string };

const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","bmp","ico","webp","svg","pdf",
  "mp4","mp3","wav","ogg","webm","avi","mkv",
  "zip","tar","gz","bz2","xz","rar","7z",
  "exe","dmg","app","so","dylib","dll","wasm",
  "bin","o","a","lib","pyc","class","jar",
]);

export function isTextFilePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return ext.length > 0 && !BINARY_EXTS.has(ext);
}

export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(stripLineSuffix(path));
}

export function webUrlForInternalBrowser(raw: string): string | null {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

export function htmlFileUrl(repoPath: string, relPath: string): string | null {
  if (!repoPath || /^[a-z][a-z0-9+.-]*:\/\//i.test(repoPath)) return null;
  const rel = stripLineSuffix(relPath).replace(/^file:\/\//i, "");
  if (!isHtmlPath(rel)) return null;
  if (rel.startsWith("/") || rel.split(/[\\/]+/).includes("..")) return null;
  const root = repoPath.replace(/\/+$/, "");
  return localPathToFileUrl(`${root}/${rel.replace(/^\.\/+/, "")}`);
}

export function openTargetForTerminalLink(cwd: string, raw: string): BrowserOpenTarget {
  const web = webUrlForInternalBrowser(raw);
  if (web) return { kind: "browser", url: web };

  const cleaned = stripLineSuffix(raw.trim());

  if (isHtmlPath(cleaned)) {
    const url = htmlUrlFromTerminalPath(cwd, cleaned);
    return url ? { kind: "browser", url } : { kind: "app", target: raw };
  }

  if (isTextFilePath(cleaned)) {
    const path = resolveTerminalPath(cwd, cleaned);
    if (path) return { kind: "editor", path };
  }

  return { kind: "app", target: raw };
}

export function resolveTerminalPath(cwd: string, target: string): string | null {
  if (!cwd || /^[a-z][a-z0-9+.-]*:\/\//i.test(cwd)) return null;
  if (target.startsWith("~/")) return null;
  if (target.split(/[\\/]+/).includes("..")) return null;
  if (target.startsWith("/")) return target;
  return `${cwd.replace(/\/+$/, "")}/${target.replace(/^\.\/+/, "")}`;
}

function htmlUrlFromTerminalPath(cwd: string, target: string): string | null {
  if (!cwd || /^[a-z][a-z0-9+.-]*:\/\//i.test(cwd)) return null;
  let t = target;
  if (t.startsWith("file://")) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
    } catch {
      return null;
    }
  }
  if (t.startsWith("~/")) return null;
  if (t.split(/[\\/]+/).includes("..")) return null;
  const abs = t.startsWith("/")
    ? t
    : `${cwd.replace(/\/+$/, "")}/${t.replace(/^\.\/+/, "")}`;
  return localPathToFileUrl(abs);
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
