/** A file too big to diff: main sends a sentinel instead of contents. */
import { OVERSIZE_SENTINEL } from "../../../shared/ipc";

/** main returns `${OVERSIZE_SENTINEL}${bytes}` for a file too big to diff. */
export function oversizeBytes(s: string | undefined): number | null {
  if (!s || !s.startsWith(OVERSIZE_SENTINEL)) return null;
  const n = Number(s.slice(OVERSIZE_SENTINEL.length));
  return Number.isFinite(n) ? n : 0;
}
export function oversizePlaceholder(bytes: number): string {
  return `⚠ file too large to diff (${(bytes / 1_000_000).toFixed(1)} MB) — open it directly to view\n`;
}
/** Git's own test: a NUL in the first 8000 bytes makes a file binary. */
export function isBinaryText(s: string | undefined): boolean {
  return !!s && oversizeBytes(s) == null && s.slice(0, 8000).includes("\0");
}
export const BINARY_PLACEHOLDER = "binary file changed — open it directly to view\n";
