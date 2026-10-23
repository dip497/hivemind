/**
 * Who may use what a web page can ask for (the camera, the microphone, the location,
 * notifications…), decided without Electron. The app's own page gets what the app uses. A page in
 * a Browser tile gets the harmless ones and asks the person for the rest. Anything else in the
 * app's windows, a view's frame or a tool's page, gets nothing. permissions.ts puts it on the
 * sessions.
 */
import { isAppPage } from "../shared/app-page.js";

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
}

/** What the app's page uses: notifications (a widget's `hive.notify`) and copying (the Copy
 *  buttons, a terminal's selection). */
const APP_USES = new Set(["notifications", "clipboard-sanitized-write"]);
/** What any site gets: full screen in its tile's window, copying what it was given, and holding
 *  the pointer (a game, a 3D view), which Esc gives back. */
const SITE_MAY = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);
/** What no site gets: starting another program from a link. Its links open as tabs already. */
const SITE_NEVER = new Set(["openExternal"]);

export function decide(r: PermissionRequest): Decision {
  if (r.guest) {
    if (SITE_MAY.has(r.permission)) return "allow";
    return SITE_NEVER.has(r.permission) || siteOf(r.url) === null ? "deny" : "ask";
  }
  return isAppPage(r.url, r.appPage) && APP_USES.has(r.permission) ? "allow" : "deny";
}

/** The site a URL belongs to, as the person is asked about it and as answers are kept: its
 *  origin, or null when it has none to name (a sandboxed frame, a data: page). */
export function siteOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** What a request asks for, each right answered on its own: a media request is the camera, the
 *  microphone or both (both when it does not say). */
export function rightsOf(permission: string, mediaTypes: readonly string[] = []): string[] {
  if (permission !== "media") return [permission];
  const rights = [
    ...(mediaTypes.includes("video") ? ["camera"] : []),
    ...(mediaTypes.includes("audio") ? ["microphone"] : []),
  ];
  return rights.length ? rights : ["camera", "microphone"];
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

  set(site: string, rights: readonly string[], allowed: boolean): void {
    for (const right of rights) {
      const key = `${site} ${right}`;
      this.kept.delete(key);
      this.kept.set(key, allowed);
    }
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= this.cap) break;
      this.kept.delete(oldest);
    }
  }
}
