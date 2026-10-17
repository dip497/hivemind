/**
 * What the installer is doing, from the lines it prints.
 *
 * `hivemind upgrade` is a shell script (`install.sh`) whose output is written for a terminal;
 * relaying those lines into the app showed the user "extracting AppImage (no libfuse2
 * needed)". The same lines say plainly which of four things is happening, so the app can name
 * the step and say which version it is getting — and say when a download is only waiting for
 * a restart, which is the one outcome the user has to act on.
 */

export const UPDATE_STEPS = ["check", "download", "install", "done"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

export interface UpdateProgress {
  step: UpdateStep;
  /** One line for the user, in their words rather than the installer's. */
  label: string;
  /** The release being installed, once the installer has resolved it. */
  version?: string;
  /** It is downloaded, and becomes the running version at the next restart. */
  staged?: boolean;
  /** Nothing was installed and the app cannot do it for you: on macOS and Windows a running
   *  app cannot be replaced at all, so the user has to close it and run the upgrade. */
  blocked?: boolean;
}

export const UPDATE_START: UpdateProgress = { step: "check", label: "Looking for the latest release" };

const withVersion = (label: string, version?: string): string => (version ? `${label} ${version}` : label);

/** Fold one installer line into the progress so far. An unknown line changes nothing: the
 *  installer says plenty that is not a step, and the last known step is still true. */
export function updateProgress(line: string, prev: UpdateProgress = UPDATE_START): UpdateProgress {
  const l = line.toLowerCase();
  const version = /target version:\s*v?(\d[\w.-]*)/.exec(l)?.[1] ?? prev.version;
  const at = (step: UpdateStep, label: string, staged?: boolean): UpdateProgress =>
    ({ step, label, ...(version ? { version } : {}), ...(staged ? { staged: true } : {}) });

  if (l.includes("was not upgraded")) {
    return { step: "done", label: "Close hivemind, then run `hivemind upgrade`", blocked: true, ...(version ? { version } : {}) };
  }
  if (l.includes("restart hivemind to finish") || l.includes("upgrade staged") || l.includes("downloaded already")) {
    return at("done", "Downloaded — restart to finish", true);
  }
  if (/^\s*(ok\s+)?installed\b/.test(l) || l.includes("installed launcher")) return at("done", withVersion("Installed", version));
  if (l.includes("extracting") || l.includes("unpacking")) return at("install", "Installing");
  if (l.includes("downloading")) return at("download", withVersion("Downloading", version));
  if (l.includes("resolving latest release")) return at("check", "Looking for the latest release");
  return { ...prev, ...(version ? { version } : {}) };
}

/** The version GitHub's `releases/latest` redirected to — `…/releases/tag/v2026.9.7` → "2026.9.7".
 *  That redirect is not the API, so it has no hourly limit; null when the URL is not a tag. */
export function tagFromReleasesLatest(finalUrl: string): string | null {
  const m = /\/releases\/tag\/v?([0-9][^/?#]*)/.exec(finalUrl);
  return m?.[1] ?? null;
}

/** Nightly tags carry their UTC day and run id; the releases list may contain stable builds too. */
export function newerNightlyTag(latest: string, installed: string | null): boolean {
  const parts = (tag: string | null): RegExpExecArray | null => tag ? /^nightly-([0-9]{8})-([0-9]+)$/.exec(tag) : null;
  const next = parts(latest);
  if (!next) return false;
  const old = parts(installed);
  return !old || next[1]! > old[1]! || (next[1] === old[1] && BigInt(next[2]!) > BigInt(old[2]!));
}

export function latestNightlyTag(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  return releases.reduce<string | null>((latest, item: unknown) => {
    if (!item || typeof item !== "object") return latest;
    const release = item as { prerelease?: unknown; tag_name?: unknown };
    const tag = release.tag_name;
    return release.prerelease === true && typeof tag === "string" && newerNightlyTag(tag, latest) ? tag : latest;
  }, null);
}
