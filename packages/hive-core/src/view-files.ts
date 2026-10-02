/**
 * A community view package's files as they are served: which file a request may read, and what
 * type it is. The app's `hm-view://` handler serves them to the view's sandboxed iframe, and a
 * device serves them to the person's phone (`view.file`, P8), through these same checks.
 */
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export type FileResolution = { status: 200; abs: string } | { status: 403 | 404 };

/** The file a request for `rel` inside package `dir` may read. Containment is
 *  checked on the RESOLVED path (symlinks followed): a link inside a
 *  downloaded package that points outside it is a 403, not a read. */
export function resolvePackageFile(dir: string, rel: string): FileResolution {
  let root: string;
  try { root = realpathSync(dir); } catch { return { status: 404 }; }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { status: 403 };
  if (!existsSync(abs)) return { status: 404 };
  let real: string;
  try { real = realpathSync(abs); } catch { return { status: 404 }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { status: 403 };
  if (!statSync(real).isFile()) return { status: 404 };
  return { status: 200, abs: real };
}
