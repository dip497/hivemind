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

  if (l.includes("restart hivemind to finish") || l.includes("upgrade staged") || l.includes("downloaded already")) {
    return at("done", "Downloaded — restart to finish", true);
  }
  if (/^\s*(ok\s+)?installed\b/.test(l) || l.includes("installed launcher")) return at("done", withVersion("Installed", version));
  if (l.includes("extracting") || l.includes("unpacking")) return at("install", "Installing");
  if (l.includes("downloading")) return at("download", withVersion("Downloading", version));
  if (l.includes("resolving latest release")) return at("check", "Looking for the latest release");
  return { ...prev, ...(version ? { version } : {}) };
}
