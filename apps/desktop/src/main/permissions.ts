/**
 * The permission handlers of the app's two sessions, deciding as permissions-core.ts says. The
 * default session holds the app's windows and the frames in them (views, tools' pages); the browser
 * session holds every Browser tile's page. A page that must ask is asked about on its tile: main
 * tells the window showing it, the tile asks the person, and the answer is kept per site and right
 * until the app quits. An ask nobody answers in a minute, or whose page or window goes, is a no.
 */
import { session, type WebContents } from "electron";
import type { BrowserPermissionEvent } from "../shared/ipc.js";
import { on } from "./app-ipc.js";
import { appWindowOf } from "./windows.js";
import { decide, rightsOf, siteOf, SiteAnswers } from "./permissions-core.js";

/** How long a page waits for the person before it is told no. */
const ASK_FOR_MS = 60_000;
/** Asks waiting at once, across every window: one more is told no at once. */
const MAX_WAITING = 32;

interface Waiting {
  /** The app window whose tile shows the page. */
  window: WebContents;
  pageId: number;
  site: string;
  rights: string[];
  /** Every request waiting on this answer: a page asking again while it waits joins the first. */
  replies: Array<(allowed: boolean) => void>;
  stop(): void;
}

const answers = new SiteAnswers();
const waiting = new Map<number, Waiting>();
let lastAsk = 0;

/** Put the handlers on the app's sessions. Call at app ready, before any window or page loads. */
export function installPermissions(appPage: string): void {
  const sessions = [[session.defaultSession, false], [session.fromPartition("persist:browser"), true]] as const;
  for (const [ses, guest] of sessions) {
    ses.setPermissionRequestHandler((page, permission, reply, details) => {
      const url = details.requestingUrl;
      const decision = decide({ permission, url, guest, appPage });
      if (decision !== "ask") return reply(decision === "allow");
      const site = siteOf(url)!;
      const rights = rightsOf(permission, "mediaTypes" in details ? details.mediaTypes : undefined);
      const known = answers.get(site, rights);
      if (known !== undefined) return reply(known);
      askPerson(page, site, rights, reply);
    });
    // Checks (Notification.permission, permissions.query) are answered from what the person said:
    // no until they allowed it.
    ses.setPermissionCheckHandler((_page, permission, origin, details) => {
      const url = details.requestingUrl || origin;
      const decision = decide({ permission, url, guest, appPage });
      if (decision !== "ask") return decision === "allow";
      return answers.get(siteOf(url)!, rightsOf(permission, details.mediaType ? [details.mediaType] : undefined)) === true;
    });
    // A device is only ever reached through a chooser, and the app has none.
    ses.setDevicePermissionHandler(() => false);
  }
  on("browser:permission-answer", (e, askId: unknown, allowed: unknown) => {
    const ask = typeof askId === "number" ? waiting.get(askId) : undefined;
    if (!ask || ask.window.id !== e.sender.id || typeof allowed !== "boolean") return;
    settle(askId as number, allowed, true);
  }, { local: true });
}

/** Ask the person, on the tile showing `page`, whether `site` may have `rights`. */
function askPerson(page: WebContents, site: string, rights: string[], reply: (allowed: boolean) => void): void {
  const window = page.hostWebContents;
  if (!window || !appWindowOf(window)) return reply(false);
  const same = [...waiting.values()].find((w) => w.pageId === page.id && w.site === site && w.rights.join() === rights.join());
  if (same) return void same.replies.push(reply);
  if (waiting.size >= MAX_WAITING) return reply(false);
  const askId = ++lastAsk;
  const no = () => settle(askId, false);
  const timer = setTimeout(no, ASK_FOR_MS);
  // The page that asked is gone once its tab closes or it starts leaving for another document (not
  // `did-navigate`, which can arrive after the new page has already asked); the tile once its
  // window closes.
  const leaves = (e: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (e.isMainFrame && !e.isSameDocument) no(); };
  page.once("destroyed", no);
  page.on("did-start-navigation", leaves);
  window.once("destroyed", no);
  waiting.set(askId, {
    window, pageId: page.id, site, rights, replies: [reply],
    stop: () => {
      clearTimeout(timer);
      page.off("destroyed", no);
      page.off("did-start-navigation", leaves);
      window.off("destroyed", no);
    },
  });
  tell(window, { askId, pageId: page.id, site, permissions: rights });
}

/** End ask `askId`: every request waiting on it gets `allowed`, kept for its site when the person said it. */
function settle(askId: number, allowed: boolean, answered = false): void {
  const ask = waiting.get(askId);
  if (!ask) return;
  waiting.delete(askId);
  ask.stop();
  for (const reply of ask.replies) reply(allowed);
  tell(ask.window, { askId, done: true });
  if (!answered) return;
  answers.set(ask.site, ask.rights, allowed);
  // Other pages of the site waiting on the same thing have their answer too.
  for (const [id, other] of waiting) {
    const known = answers.get(other.site, other.rights);
    if (known !== undefined) settle(id, known);
  }
}

function tell(window: WebContents, event: BrowserPermissionEvent): void {
  if (!window.isDestroyed()) window.send("browser:permission", event);
}
