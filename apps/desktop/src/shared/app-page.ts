/**
 * The app's own page: the only document a window may show and the only one given the `hive`
 * bridge. A page framed in it (a tool's local server) must not take the window's place.
 */

/** The argument main passes each window's preload, naming the app's page. */
export const APP_PAGE_ARG = "--hive-app-page=";

/** Whether `url` is the app's page at `appPage`: the dev server's origin, or the same file. */
export function isAppPage(url: string, appPage: string): boolean {
  let at: URL, app: URL;
  try { at = new URL(url); app = new URL(appPage); } catch { return false; }
  if (app.protocol === "file:") return at.protocol === "file:" && at.pathname === app.pathname;
  return at.origin === app.origin;
}
