/**
 * DevTools commands for a Browser tile's page that Electron has to do itself. Keyboard input: see
 * page-keys.ts. A page inside a window has no `Page.printToPDF`, and Chromium takes `Page.reload`
 * on one as a reload of the window around it: the whole app.
 */
import type { PrintToPDFOptions, WebContents } from "electron";
import { keyboardCommand } from "./page-keys.js";

export const PAGE_COMMANDS = new Set(["Input.insertText", "Input.dispatchKeyEvent", "Page.reload", "Page.printToPDF"]);

/** DevTools' options for a printed page, as Electron names them. */
function printOptions(p: Record<string, unknown>): PrintToPDFOptions {
  if (p.transferMode === "ReturnAsStream") throw new Error("this page prints only with transferMode ReturnAsBase64");
  const options: Record<string, unknown> = {};
  for (const same of ["landscape", "displayHeaderFooter", "printBackground", "scale", "pageRanges", "headerTemplate", "footerTemplate", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline"]) {
    if (p[same] !== undefined) options[same] = p[same];
  }
  if (p.paperWidth !== undefined || p.paperHeight !== undefined) options.pageSize = { width: p.paperWidth ?? 8.5, height: p.paperHeight ?? 11 };
  const margins = Object.fromEntries((["Top", "Bottom", "Left", "Right"] as const).filter((side) => p[`margin${side}`] !== undefined).map((side) => [side.toLowerCase(), p[`margin${side}`]]));
  if (Object.keys(margins).length) options.margins = margins;
  return options as PrintToPDFOptions;
}

/** An answer to a page's dialog over DevTools reaches the page, but leaves the box the app put up
 *  for the person on screen: this is the event with which Electron takes it down on navigating. */
export function closeDialogBox(page: WebContents): void {
  page.emit("-cancel-dialogs");
}

/** Do DevTools command `method` with `params` in `page`, one of `PAGE_COMMANDS`: its answer. */
export async function pageCommand(page: WebContents, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (method === "Page.reload") {
    if (params.scriptToEvaluateOnLoad !== undefined) throw new Error("this page reloads without scriptToEvaluateOnLoad");
    if (params.ignoreCache) page.reloadIgnoringCache();
    else page.reload();
    return {};
  }
  if (method === "Page.printToPDF") return { data: (await page.printToPDF(printOptions(params))).toString("base64") };
  await keyboardCommand(page, method, params);
  return {};
}
