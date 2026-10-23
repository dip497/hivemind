/**
 * The permission handlers of the app's two sessions, deciding as permissions-core.ts says. The
 * default session holds the app's windows and the frames in them (views, tools' pages); the browser
 * session holds every Browser tile's page. A page that must ask is asked about on its tile: main
 * tells the window showing it, the tile asks the person, and the answer is kept per site and right
 * until the app quits. An ask nobody answers in a minute, or whose page or window goes, is a no.
 * The person can also answer for a site before it asks, or change an answer, from the tile's site
 * panel: the same answers, kept here.
 */
import { session, type WebContents } from "electron";
import type { BrowserPermissionEvent, SiteRight } from "../shared/ipc.js";
import { handle, on } from "./app-ipc.js";
import { appWindowOf } from "./windows.js";
import { siteOf } from "../shared/site.js";
import { answerable, COMMON_RIGHTS, decide, rightsOf, SiteAnswers } from "./permissions-core.js";

/** How long a page waits for the person before it is told no. */
const ASK_FOR_MS = 60_000;
/** Asks waiting at once from one page, and across every window: one more is told no at once. */
const MAX_PER_PAGE = 4;
const MAX_WAITING = 32;

interface Waiting {
  /** The app window whose tile shows the page. */
  window: WebContents;
  /** The page's id and the window's, kept: a destroyed one cannot be asked. */
  ids: [page: number, window: number];
  site: string;
  rights: string[];
  /** Every request waiting on this answer: a page asking again while it waits joins the first. */
  replies: Array<(allowed: boolean) => void>;
  timer: ReturnType<typeof setTimeout>;
}

const answers = new SiteAnswers();
const waiting = new Map<number, Waiting>();
/** One set of listeners on each page and window that has an ask waiting, by id, taken off with its
 *  last ask. */
const watched = new Map<number, () => void>();
let lastAsk = 0;

/** Put the handlers on the app's sessions. Call at app ready, before any window or page loads. */
export function installPermissions(appPage: string): void {
  const sessions = [[session.defaultSession, false], [session.fromPartition("persist:browser"), true]] as const;
  for (const [ses, guest] of sessions) {
    ses.setPermissionRequestHandler((page, permission, reply, details) => {
      const url = details.requestingUrl;
      const externalUrl = "externalURL" in details ? details.externalURL : undefined;
      const decision = decide({ permission, url, guest, appPage, externalUrl });
      if (decision !== "ask") return reply(decision === "allow");
      const site = siteOf(url)!;
      const rights = rightsOf(permission, { mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined, externalUrl });
      const known = answers.get(site, rights);
      if (known !== undefined) return reply(known);
      askPerson(page, site, rights, reply);
    });
    // Checks (Notification.permission, permissions.query) are answered from what the person said:
    // no until they allowed it, here or in the site's panel.
    ses.setPermissionCheckHandler((_page, permission, origin, details) => {
      const url = details.requestingUrl || origin;
      const decision = decide({ permission, url, guest, appPage });
      if (decision !== "ask") return decision === "allow";
      return answers.get(siteOf(url)!, rightsOf(permission, { mediaTypes: details.mediaType ? [details.mediaType] : undefined })) === true;
    });
    // A device is only ever reached through a chooser, and the app has none.
    ses.setDevicePermissionHandler(() => false);
  }
  on("browser:permission-answer", (e, askId: unknown, allowed: unknown) => {
    const ask = typeof askId === "number" ? waiting.get(askId) : undefined;
    if (!ask || ask.ids[1] !== e.sender.id || typeof allowed !== "boolean") return;
    answer(ask.site, ask.rights, allowed);
  }, { local: true });
  // The site panel: what was answered for a site, and the person's change to one right.
  handle("browser:site-rights", (_e, site: unknown): SiteRight[] => {
    if (typeof site !== "string" || siteOf(site) !== site) return [];
    const kept = new Map(answers.of(site));
    const rights = [...new Set([...COMMON_RIGHTS, ...kept.keys()])].filter((right) => answerable(site, right, appPage));
    return rights.map((right) => ({ right, answer: kept.has(right) ? (kept.get(right) ? "allow" : "block") : "ask" }));
  }, { local: true });
  handle("browser:set-site-right", (_e, site: unknown, right: unknown, to: unknown) => {
    if (typeof site !== "string" || typeof right !== "string" || !answerable(site, right, appPage)) return;
    if (to === "allow" || to === "block") answer(site, [right], to === "allow");
    else if (to === "ask") answers.set(site, [right], undefined);
  }, { local: true });
}

/** Ask the person, on the tile showing `page`, whether `site` may have `rights`. */
function askPerson(page: WebContents, site: string, rights: string[], reply: (allowed: boolean) => void): void {
  const window = page.hostWebContents;
  if (!window || !appWindowOf(window)) return reply(false);
  const asks = [...waiting.values()];
  const same = asks.find((w) => w.ids[0] === page.id && w.site === site && w.rights.join() === rights.join());
  if (same) return void same.replies.push(reply);
  if (asks.length >= MAX_WAITING || asks.filter((w) => w.ids[0] === page.id).length >= MAX_PER_PAGE) return reply(false);
  const askId = ++lastAsk;
  const timer = setTimeout(() => settle(askId, false), ASK_FOR_MS);
  waiting.set(askId, { window, ids: [page.id, window.id], site, rights, replies: [reply], timer });
  watch(page);
  watch(window);
  tell(window, { askId, pageId: page.id, site, permissions: rights });
}

/** Settle every ask of `contents`, a page or the window showing it, with a no once it closes or
 *  starts leaving for another document (not `did-navigate`, which can arrive after the new page
 *  has already asked). */
function watch(contents: WebContents): void {
  const id = contents.id;
  if (watched.has(id)) return;
  const gone = () => { for (const [askId, w] of waiting) if (w.ids.includes(id)) settle(askId, false); };
  const leaves = (e: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (e.isMainFrame && !e.isSameDocument) gone(); };
  contents.once("destroyed", gone);
  contents.on("did-start-navigation", leaves);
  watched.set(id, () => {
    contents.off("destroyed", gone);
    contents.off("did-start-navigation", leaves);
  });
}

/** The person's answer for `site`: kept, and given to every ask it settles. */
function answer(site: string, rights: string[], allowed: boolean): void {
  answers.set(site, rights, allowed);
  for (const [id, ask] of waiting) {
    const known = answers.get(ask.site, ask.rights);
    if (known !== undefined) settle(id, known);
  }
}

/** End ask `askId`: every request waiting on it gets `allowed`. */
function settle(askId: number, allowed: boolean): void {
  const ask = waiting.get(askId);
  if (!ask) return;
  waiting.delete(askId);
  clearTimeout(ask.timer);
  for (const id of ask.ids) {
    if ([...waiting.values()].some((w) => w.ids.includes(id))) continue;
    watched.get(id)?.();
    watched.delete(id);
  }
  for (const reply of ask.replies) reply(allowed);
  tell(ask.window, { askId, done: true });
}

function tell(window: WebContents, event: BrowserPermissionEvent): void {
  if (!window.isDestroyed()) window.send("browser:permission", event);
}
