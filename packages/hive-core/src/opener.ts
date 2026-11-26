/**
 * Where a link or a path opens, decided once for every surface (a terminal, the editor, markdown,
 * notes, a view, `hive ctl open`): the first rule that matches wins. Pure: it reads no disk, so a
 * caller still checks the file is there, and the main process still confines what it hands the OS.
 */
import type { LinksSettings } from "./settings-schema";

export interface OpenAsk {
  /** A URL, or a path with an optional `:line` or `:line:col` (both from 1). */
  thing: string;
  /** The folder a relative path is read from: a terminal's current folder, else its frame's. */
  cwd?: string | null;
  /** The folders a file may be opened from: the workspace's and its frames'. */
  folders: readonly string[];
  /** The person's own click: an absolute path on this computer outside those folders opens too. */
  person?: boolean;
}

export type Opener =
  | { to: "browser-tile"; url: string }
  | { to: "system-browser"; url: string }
  /** `line` and `col` count from 1. */
  | { to: "code"; path: string; line?: number; col?: number }
  | { to: "image"; path: string }
  | { to: "os"; path: string }
  /** `scheme`: a kind of link the person may allow (once, or always in `links.allowedSchemes`). */
  | { to: "ask"; why: string; url?: string; path?: string; scheme?: string };

/** Kinds of link never handed to the system, even when asked: they run code or name a file. */
export const NEVER_SCHEMES = new Set(["javascript", "vbscript", "data", "blob", "file", "about", "chrome", "view-source", "jar"]);
const SCHEME_NAME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;
/** Whether a person may allow links of `scheme` to go to the system. */
export const allowableScheme = (scheme: string): boolean =>
  SCHEME_NAME_RE.test(scheme) && !NEVER_SCHEMES.has(scheme) && scheme !== "http" && scheme !== "https" && scheme !== "mailto";

/** Scripts a system may run when handed one (Windows runs `.js` and an installed interpreter's kinds). */
const SCRIPT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".py", ".pyw", ".rb", ".php", ".pl", ".sh", ".bash", ".zsh", ".fish", ".lua",
  ".r", ".exs", ".groovy", ".ps1", ".bat", ".cmd", ".vbs",
]);

/** Kinds of file a terminal's bare name links to (`setup.py`, `package.json`). */
export const FILE_NAME_EXT = new Set([
  ".html", ".htm", ".md", ".markdown", ".txt", ".text", ".log", ".rtf", ".pdf", ".csv", ".tsv",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".svg",
  ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".hh", ".cs", ".swift", ".scala",
  ".sql", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".dart", ".ex", ".erl", ".clj", ".hs", ".ml", ".gradle", ".tf", ".proto", ".graphql",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tiff", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
  ...SCRIPT_EXT,
]);

/** Files the system's app may be handed: what can be viewed, never what runs. */
export const OPENABLE_EXT = new Set([...FILE_NAME_EXT].filter((ext) => !SCRIPT_EXT.has(ext)));

/** Pictures the Image tile shows. */
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);

/** Files that are not text: the Code tile never opens them. */
const NOT_TEXT_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".avif", ".tiff", ".pdf",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm", ".avi", ".mkv", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".rar", ".7z",
  ".exe", ".dmg", ".app", ".so", ".dylib", ".dll", ".wasm", ".msi", ".deb", ".rpm",
  ".bin", ".o", ".a", ".lib", ".pyc", ".class", ".jar",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const LINE_RE = /:(\d+)(?::(\d+))?$/;
/** `README.md:12`: a name and a line, not a scheme. */
const NAME_AND_LINE_RE = /^[^:/]+:\d+(?::\d+)?$/;

/** Whether `thing` is an address with a scheme (`https:`, `mailto:`), not a path. */
export const isAddress = (thing: string): boolean =>
  SCHEME_RE.test(thing) && !/^[a-z]:[\\/]/i.test(thing) && !NAME_AND_LINE_RE.test(thing);

/** Where `ask.thing` opens, with the person's link settings. */
export function openerFor(ask: OpenAsk, settings: LinksSettings): Opener {
  const thing = ask.thing.trim();
  const scheme = SCHEME_RE.exec(thing)?.[1]?.toLowerCase();
  if (scheme && isAddress(thing)) {
    if (scheme === "http" || scheme === "https") return webOpener(thing, settings);
    if (scheme === "mailto") return { to: "system-browser", url: thing };
    if (scheme !== "file") {
      if (!allowableScheme(scheme)) return { to: "ask", url: thing, why: `${scheme}: links are never opened` };
      if (!ask.person) return { to: "ask", url: thing, why: `${scheme}: links open only from the person's own click` };
      if (settings.allowedSchemes.includes(scheme)) return { to: "system-browser", url: thing };
      return { to: "ask", url: thing, scheme, why: `${scheme}: links open only once you allow them` };
    }
    const local = fileUrlPath(thing);
    if (!local) return { to: "ask", url: thing, why: "not a file on this computer" };
    return fileOpener(local, ask, settings);
  }
  return fileOpener(thing, ask, settings);
}

function webOpener(url: string, settings: LinksSettings): Opener {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { to: "ask", url, why: "not a web address" }; }
  if (LOCAL_HOSTS.has(host) || settings.web === "tile") return { to: "browser-tile", url };
  return { to: "system-browser", url };
}

/** The path of a `file:` URL on this computer, or null (another host, or not a URL). */
function fileUrlPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname && !LOCAL_HOSTS.has(u.hostname.toLowerCase())) return null;
    return decodeURIComponent(u.pathname);
  } catch { return null; }
}

function fileOpener(raw: string, ask: OpenAsk, settings: LinksSettings): Opener {
  const cleaned = raw.replace(/[)\].,;'"]+$/, "");
  const at = LINE_RE.exec(cleaned);
  const written = at ? cleaned.slice(0, at.index) : cleaned;
  const path = absoluteIn(written, ask.cwd ?? null);
  if (!path) return { to: "ask", path: written, why: "a path outside the workspace" };
  // The person's own click on an absolute path on this computer opens outside the workspace too.
  const outside = !ask.folders.some((f) => inside(path, f));
  const local = /^(?:[a-z]:)?[\\/]/i.test(written) && !(ask.cwd && SCHEME_RE.test(ask.cwd) && !/^[a-z]:[\\/]/i.test(ask.cwd));
  if (outside && !(ask.person && local)) return { to: "ask", path, why: "a path outside the workspace" };
  const remote = SCHEME_RE.test(path) && !/^[a-z]:\//i.test(path);
  if (path.endsWith("/")) return remote ? { to: "ask", path, why: "a folder on another machine" } : { to: "os", path };
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return { to: "image", path };
  if (!remote && /^\.html?$/.test(ext)) return { to: "browser-tile", url: fileUrl(path) };
  const text = !NOT_TEXT_EXT.has(ext);
  const os = !remote && OPENABLE_EXT.has(ext);
  if (os && (settings.files === "system" || !text)) return { to: "os", path };
  if (text) {
    const line = at ? Number(at[1]) : 0;
    const col = at?.[2] ? Number(at[2]) : 0;
    return { to: "code", path, ...(line > 0 ? { line } : {}), ...(line > 0 && col > 0 ? { col } : {}) };
  }
  if (outside) return { to: "ask", path, why: `outside the workspace: ${path}` };
  return { to: "ask", path, why: remote ? "a file on another machine" : `${ext || "this kind of"} files are not opened` };
}

/** `p` as an absolute path (or folder URI) with `.` and `..` worked out; null when it climbs out of
 *  its root, starts at home, or is relative with no folder to read it from. */
function absoluteIn(p: string, cwd: string | null): string | null {
  if (!p || p.includes("\0") || p.startsWith("~")) return null;
  const path = p.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z]:\//i.test(path)) return normal("", path);
  if (!cwd) return null;
  const { root, rest } = splitRoot(cwd.replace(/\\/g, "/"));
  return normal(root, `${rest.replace(/\/+$/, "")}/${path}`);
}

/** A folder URI's scheme and host (`ssh://me@box`), and its path. */
function splitRoot(folder: string): { root: string; rest: string } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(folder);
  return m && !/^[a-z]:\//i.test(folder) ? { root: m[1]!, rest: m[2] || "/" } : { root: "", rest: folder };
}

function normal(root: string, path: string): string | null {
  const drive = /^([a-z]:)\//i.exec(path)?.[1] ?? "";
  const parts: string[] = [];
  for (const part of path.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.pop()) return null; continue; }
    parts.push(part);
  }
  return `${root}${drive}/${parts.join("/")}${path.endsWith("/") && parts.length ? "/" : ""}`;
}

/** Whether `path` is `folder` or inside it, by whole path parts. */
function inside(path: string, folder: string): boolean {
  const { root, rest } = splitRoot(folder.replace(/\\/g, "/"));
  const f = normal(root, rest);
  if (!f) return false;
  const base = f.endsWith("/") ? f : `${f}/`;
  return path === f || path.startsWith(base);
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function fileUrl(path: string): string {
  return `file://${path.split("/").map((s) => encodeURIComponent(s)).join("/")}`;
}
