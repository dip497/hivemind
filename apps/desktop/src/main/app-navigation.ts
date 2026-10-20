import type { WebContents } from "electron";
import { isAppPage } from "../shared/app-page.js";

/** Keep a window on the app's page: a framed page cannot send it elsewhere, nor a redirect. */
export function keepOnAppPage(wc: WebContents, appPage: string): void {
  const stay = (e: { preventDefault(): void }, url: string, mainFrame: boolean) => {
    if (mainFrame && !isAppPage(url, appPage)) e.preventDefault();
  };
  wc.on("will-navigate", (e) => stay(e, e.url, e.isMainFrame));
  wc.on("will-frame-navigate", (e) => stay(e, e.url, e.isMainFrame));
  wc.on("will-redirect", (e) => stay(e, e.url, e.isMainFrame));
}
