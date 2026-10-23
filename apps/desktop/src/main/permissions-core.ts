/**
 * Who may use what a web page can ask for (the camera, the microphone, the location,
 * notifications…), decided without Electron. The app's own page gets what the app uses. A page in
 * a Browser tile gets the harmless ones and asks the person for the rest. Anything else in the
 * app's windows, a view's frame or a tool's page, gets nothing. permissions.ts puts it on the
 * sessions.
 */
import { isAppPage } from "../shared/app-page.js";
import { siteOf } from "../shared/site.js";

/** What becomes of a request: granted, refused, or put to the person. */
export type Decision = "allow" | "deny" | "ask";

/** A request, as Electron hands it over. */
export interface PermissionRequest {
  /** Electron's name for it: "media", "notifications", "geolocation"… */
  permission: string;
  /** The URL of the frame that asked (Electron's `requestingUrl`), else its origin. Never the top
   *  frame's: a frame inside a page asks for itself. */
  url: string;
  /** Asked from a page in a Browser tile (the `persist:browser` session). */
  guest: boolean;
  /** The app's own page: the built file's URL, or the dev server's. */
  appPage: string;
  /** For "openExternal": the link another program would open. */
  externalUrl?: string;
}

/** What the app's page uses: notifications (a widget's `hive.notify`) and copying (the Copy
 *  buttons, a terminal's selection). */
const APP_USES = new Set(["notifications", "clipboard-sanitized-write"]);
/** What any site gets, as Chrome gives it without asking: full screen in its tile's window,
 *  copying what it was given, holding the pointer (a game, a 3D view) and, in full screen, the keys,
 *  until Esc (held, for the keys), keeping its data when the disk runs short, playing protected
 *  video, keeping the screen on while it shows, the motion sensors, and finishing a send once the
 *  network is back. */
const SITE_MAY = new Set([
  "fullscreen", "clipboard-sanitized-write", "pointerLock", "keyboardLock", "persistent-storage",
  "mediaKeySystem", "screen-wake-lock", "sensors", "background-sync",
]);
/** What no site gets. */
const SITE_NEVER = new Set([
  // A device or a speaker is picked in a chooser, and a screen in a picker (then steered), and the
  // app has neither.
  "hid", "serial", "usb", "speaker-selection", "display-capture", "captured-surface-control",
  // What the app does not drive: a headset, NFC (a phone's), a payment sheet, a download running in
  // the background.
  "ar", "vr", "hand-tracking", "nfc", "payment-handler", "background-fetch",
  // What Chrome gives only to a web app installed on the computer, or to no site; the app installs
  // no web app.
  "web-app-installation", "web-printing", "smart-card", "system-wake-lock", "periodic-background-sync", "automatic-fullscreen",
  // Another site's cookies inside this one: about a pair of sites, and an answer here is per site.
  "storage-access", "top-level-storage-access",
  // Reading the clipboard without asking (Electron refuses it too when no handler is set), and a
  // right the person could not be told the name of.
  "deprecated-sync-clipboard-read", "unknown",
]);
/** Links a site never opens in another program: they run code or open files on this computer
 *  rather than start an app (Chromium's own refusals, and Windows' search-ms and ms-msdt). */
const NEVER_OPENS = new Set([
  "afp", "data", "disk", "disks", "file", "hcp", "ie.http", "javascript", "mk", "ms-help", "ms-msdt",
  "ms-officecmd", "nntp", "res", "search", "search-ms", "shell", "vbscript", "view-source", "vnd.ms.radio",
]);

export function decide(r: PermissionRequest): Decision {
  if (r.guest) {
    if (SITE_MAY.has(r.permission)) return "allow";
    if (SITE_NEVER.has(r.permission) || siteOf(r.url) === null) return "deny";
    if (r.permission === "openExternal") {
      const scheme = schemeOf(r.externalUrl);
      return scheme === null || NEVER_OPENS.has(scheme) ? "deny" : "ask";
    }
    return "ask";
  }
  return isAppPage(r.url, r.appPage) && APP_USES.has(r.permission) ? "allow" : "deny";
}

/** A link's scheme, lower case and without the colon, or null when it is no link. */
function schemeOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? "").protocol.slice(0, -1) || null;
  } catch {
    return null;
  }
}

/** What a request asks for, each right answered on its own: a media request is the camera, the
 *  microphone or both (both when it does not say); opening a link in another program is a right
 *  per scheme ("openExternal:mailto"). */
export function rightsOf(permission: string, details: { mediaTypes?: readonly string[]; externalUrl?: string } = {}): string[] {
  if (permission === "openExternal") return [`openExternal:${schemeOf(details.externalUrl) ?? ""}`];
  if (permission !== "media") return [permission];
  const mediaTypes = details.mediaTypes ?? [];
  const rights = [
    ...(mediaTypes.includes("video") ? ["camera"] : []),
    ...(mediaTypes.includes("audio") ? ["microphone"] : []),
  ];
  return rights.length ? rights : ["camera", "microphone"];
}

/** The rights a site's panel always lists, answered or not. */
export const COMMON_RIGHTS = ["notifications", "camera", "microphone", "geolocation"] as const;

/** Whether the person may answer `right` for `site` before it asks: a site's own origin, and a
 *  right a page there would be asked about. */
export function answerable(site: string, right: string, appPage: string): boolean {
  if (siteOf(site) !== site || !/^[\w.:+-]{1,64}$/.test(right)) return false;
  const external = right.startsWith("openExternal:") ? `${right.slice("openExternal:".length)}:` : undefined;
  const permission = right === "camera" || right === "microphone" ? "media" : external ? "openExternal" : right;
  return decide({ permission, url: site, guest: true, appPage, externalUrl: external }) === "ask";
}

/** What the person answered, per site and right, for this run of the app. It keeps at most `cap`
 *  answers and forgets the oldest first. */
export class SiteAnswers {
  private readonly kept = new Map<string, boolean>();
  constructor(private readonly cap = 500) {}

  /** False when one of `rights` was blocked, true when all were allowed, undefined while one is
   *  unanswered. */
  get(site: string, rights: readonly string[]): boolean | undefined {
    let open = false;
    for (const right of rights) {
      const answer = this.kept.get(`${site} ${right}`);
      if (answer === false) return false;
      if (answer === undefined) open = true;
    }
    return open ? undefined : true;
  }

  /** Keep `allowed` for each of `rights`, or forget them (undefined): the site is asked again. */
  set(site: string, rights: readonly string[], allowed: boolean | undefined): void {
    for (const right of rights) {
      const key = `${site} ${right}`;
      // Answered again, it is the newest: the cap forgets it last.
      this.kept.delete(key);
      if (allowed !== undefined) this.kept.set(key, allowed);
    }
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= this.cap) break;
      this.kept.delete(oldest);
    }
  }

  /** Each right answered for `site`, and the answer. */
  of(site: string): Array<[right: string, allowed: boolean]> {
    const prefix = `${site} `;
    return [...this.kept].filter(([key]) => key.startsWith(prefix)).map(([key, allowed]) => [key.slice(prefix.length), allowed]);
  }
}
