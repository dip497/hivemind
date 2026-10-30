/**
 * What changed, from the changelog this build ships (CHANGELOG.md, read in at build): told once
 * after an update, for every version since the one this person last ran, and asked for in About.
 * A newer version's, before it is installed, is read from GitHub.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, net } from "electron";
import CHANGELOG from "../../../../CHANGELOG.md?raw";
import { releaseNotes, versionAfter, type ReleaseNotes } from "../shared/release-notes.js";

const seenFile = (): string => path.join(app.getPath("userData"), "whats-new.json");
let told = false;

/** What changed since the version this person last ran, once a run, when this one is newer. The
 *  first run of all tells nothing: nothing was had before it. */
export function whatsNewSinceLastRun(): ReleaseNotes[] {
  if (told) return [];
  told = true;
  const current = app.getVersion();
  let seen: string | null = null;
  try {
    const v = (JSON.parse(readFileSync(seenFile(), "utf8")) as { seen?: unknown }).seen;
    seen = typeof v === "string" ? v : null;
  } catch { /* never run, or unreadable: as never run */ }
  if (seen !== current) {
    try {
      mkdirSync(path.dirname(seenFile()), { recursive: true });
      writeFileSync(seenFile(), `${JSON.stringify({ seen: current })}\n`);
    } catch { /* told again next run */ }
  }
  return seen && versionAfter(current, seen) ? releaseNotes(CHANGELOG, current, seen) : [];
}

/** What `version` changed: this build's, or an older one's, from the changelog it ships; a newer
 *  one's, with every version between, from GitHub, and none when that cannot be reached. */
export async function notesFor(version: string): Promise<ReleaseNotes[]> {
  const current = app.getVersion();
  if (!versionAfter(version, current)) return releaseNotes(CHANGELOG, version, null);
  if (!/^\d+(\.\d+)*$/.test(version)) return [];
  try {
    const res = await net.fetch(`https://raw.githubusercontent.com/dip497/hivemind/v${version}/CHANGELOG.md`, { signal: AbortSignal.timeout(8000) });
    return res.ok ? releaseNotes(await res.text(), version, current) : [];
  } catch {
    return [];
  }
}
