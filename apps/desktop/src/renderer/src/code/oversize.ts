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
