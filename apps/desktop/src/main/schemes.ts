/**
 * The app's own schemes (`hm-view`, `hm-plugin`, `hm-media`, `hivemedia`), each answered by one
 * handler: for its windows through Electron's protocol, and for a browser tab as paths on the
 * browser server (docs/design/browser-app-2026-10-13.md §11).
 */
import { protocol } from "electron";

export type SchemeHandler = (request: Request) => Response | Promise<Response>;

const handlers = new Map<string, SchemeHandler>();

/** Call after app ready. */
export function serveScheme(scheme: string, handler: SchemeHandler): void {
  protocol.handle(scheme, handler);
  handlers.set(scheme, handler);
}

export const schemeHandler = (scheme: string): SchemeHandler | undefined => handlers.get(scheme);
