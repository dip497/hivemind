/**
 * Makes paths in terminal output clickable — `/abs/path.html`, `./src/x.ts`, `README.md:12`,
 * `file://…`, and `path:line:col` from stack traces. Ctrl+click (⌘ on a Mac) opens one where the
 * window's opener says (`open-thing.ts`), read from the folder the shell was in when it printed it.
 * (http(s) URLs are the web link finder's.)
 */
import type { Terminal, ILinkProvider, ILink, IBufferRange, IDisposable } from "@xterm/xterm";
import { isRemote } from "@hivemind/core/remote-uri";
import { pathLinksOn, type TermLine } from "./terminal-links";

const MAC = /mac/i.test(navigator.platform);

/** A terminal's links are followed with Ctrl+click (⌘ on a Mac): a plain click focuses it or starts a selection. */
export const followsLink = (e: MouseEvent): boolean => (MAC ? e.metaKey : e.ctrlKey);

/** What a link says while the pointer is on it, on the terminal's element `el`. */
export function linkHint(el: () => HTMLElement | undefined): { hover(): void; leave(): void } {
  const hint = `${MAC ? "⌘" : "Ctrl"}+click to follow`;
  return {
    hover: () => { const at = el(); if (at) at.title = hint; },
    leave: () => { const at = el(); if (at) at.title = ""; },
  };
}

/** Register the file-path link provider; returns the disposable. `folderAt(y)` is the folder the
 *  shell was in when line `y` (1-based, in the buffer) was printed. A path that runs on into the next
 *  line opens whole, or `orElse` (the part on one line) when nothing is there. */
export function registerFileLinks(
  term: Terminal,
  folderAt: (y: number) => string | null,
  open: (thing: string, cwd: string | null, orElse?: string) => void,
): IDisposable {
  const lineAt = (y: number): TermLine | null => {
    const line = y >= 1 ? term.buffer.active.getLine(y - 1) : undefined;
    return line ? { text: line.translateToString(true), wrapped: line.isWrapped } : null;
  };
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const here = lineAt(y);
      if (!here) { callback(undefined); return; }
      // A path on another machine is not checked before it opens, so only a line the terminal wrapped joins there.
      const guess = !isRemote(folderAt(y) ?? "");
      const links: ILink[] = pathLinksOn(here, lineAt(y - 1), lineAt(y + 1), term.cols, guess).map(({ text, from, to, part }) => {
        const range: IBufferRange = { start: { x: from.x + 1, y: y + from.dy }, end: { x: to.x, y: y + to.dy } };
        return {
          text,
          range,
          ...linkHint(() => term.element),
          activate: (e: MouseEvent) => { if (followsLink(e)) open(text, folderAt(y + from.dy), part); },
        };
      });
      callback(links.length ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}
