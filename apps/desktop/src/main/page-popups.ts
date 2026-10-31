/**
 * Which of a Browser tile page's pop-ups (`target=_blank`, `window.open`) open as a tab. A tab's
 * address comes from the app, not the page, so the page must not name one it could not go to
 * itself, and each tab is a process, so a page cannot open them without end.
 */
const MOST_IN_A_WHILE = 5;
const WHILE_MS = 30_000;

/** One page's pop-ups: whether the one for `url` opens. */
export function popupGate(): (url: string) => boolean {
  const opened: number[] = [];
  return (url) => {
    if (!/^https?:\/\//i.test(url) && url !== "about:blank") return false;
    const now = Date.now();
    while (opened.length && now - opened[0]! > WHILE_MS) opened.shift();
    if (opened.length >= MOST_IN_A_WHILE) return false;
    opened.push(now);
    return true;
  };
}
