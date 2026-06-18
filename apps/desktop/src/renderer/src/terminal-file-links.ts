/**
 * Makes FILE PATHS in terminal output clickable — `/abs/path.html`, `./src/x.ts`,
 * `~/notes.md`, `file://…`, and `path:line:col` from stack traces. Clicking opens
 * the file in the OS default app (`shell.openPath` via the openPathInApp IPC):
 * `.html` → browser, source → editor, image → viewer, dir → file manager.
 *
 * (http(s) URLs are handled separately by WebLinksAddon. The match regex is
 * permissive on purpose — main is the gatekeeper: it requires the path to EXIST,
 * resolves relatives against the tile's cwd, and refuses `.desktop` + remote.)
 */
import type { Terminal, ILinkProvider, ILink, IBufferRange, IDisposable } from "@xterm/xterm";

// A path-like token that contains at least one "/", optional file:// scheme,
// optional trailing :line[:col].
const PATH_RE = /(?:file:\/\/)?[\w.+@~/-]*\/[\w.+@~/-]+(?::\d+(?::\d+)?)?/g;

/** Register the file-path link provider; returns the disposable. */
export function registerFileLinks(term: Terminal, getCwd: () => string): IDisposable {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      for (const m of text.matchAll(PATH_RE)) {
        const raw = m[0];
        const idx = m.index ?? 0;
        // Don't hijack the path part of an http(s) URL — WebLinksAddon owns those.
        if (raw.includes("://") && !raw.startsWith("file://")) continue;
        if (idx > 0 && text[idx - 1] === ":") continue; // "//host/x" inside a URL
        const range: IBufferRange = {
          start: { x: idx + 1, y },
          end: { x: idx + raw.length, y },
        };
        links.push({
          text: raw,
          range,
          activate: () => { void window.hive.openPathInApp(getCwd(), raw); },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}
