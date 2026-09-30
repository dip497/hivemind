// Where a download link goes.
//
// A link on the site must not carry a version: it would be wrong the moment the next release
// lands, and a page rebuild is not part of cutting one. GitHub resolves
// `releases/latest/download/<name>` for whatever is current, so every route here is a
// redirect to a name the release workflow always publishes — no API call, nothing cached,
// nothing to rate-limit.
const REPO = "https://github.com/dip497/hivemind";
const latest = (asset) => `${REPO}/releases/latest/download/${asset}`;

/** What `/download/<key>` means. The keys are what the download page links to. */
export const DOWNLOADS = {
  // The desktop app.
  "linux": latest("hivemind-linux-x86_64.AppImage"),
  "macos": latest("hivemind-macos-arm64.zip"),
  "windows": latest("hivemind-windows-x64.zip"),
  // The `hive` CLI on its own — a machine you only drive from another desktop.
  "cli-linux-x86_64": latest("hive-linux-x86_64"),
  "cli-linux-arm64": latest("hive-linux-arm64"),
  "cli-macos-arm64": latest("hive-darwin-arm64"),
  "cli-windows-x64": latest("hive-windows-x64.exe"),
  // Everything a release holds, and its notes.
  "notes": `${REPO}/releases/latest`,
};

/** The redirect a request path asks for, or null when it asks for something else. */
export function downloadFor(urlPath) {
  const key = /^\/download\/([\w.-]+)\/?$/.exec((urlPath ?? "").split("?")[0])?.[1];
  return key && Object.prototype.hasOwnProperty.call(DOWNLOADS, key) ? DOWNLOADS[key] : null;
}
