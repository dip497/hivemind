// What a diff (Pierre, inside shadow roots) draws, beside what the app's tokens say it should, each
// resolved in the diff's own place (a probe span next to its host, so a tile's or a fullscreen
// panel's scope applies). Colours as the browser paints them, `[r, g, b, a]`, so two spellings of
// one colour compare equal.
import type { Locator } from "@playwright/test";

export interface DiffDrawn {
  /** The page under the code (the host's background), and the palette's bg2. */
  page: number[]; bg2: number[];
  /** An added row's background, and the page mixed with the added tint as Pierre is told to. */
  addedRow: number[] | null; addedRowWant: number[];
  /** A comment's colour, and --color-syntax-comment; null when the diff has no comment. */
  comment: number[] | null; commentWant: number[];
  /** A removed line's hatched bar: its dark stripe as Pierre resolves it inside the diff
   *  (`--diffs-bg-deletion`), and as Pierre's own (the page with a fifth of the removed colour, an
   *  eighth when light). */
  darkStripe: number[]; darkStripeWant: number[];
}

/** Read the first diff inside `within` that has an added row. Null until it is drawn. */
export function readDiff(within: Locator): Promise<DiffDrawn | null> {
  return within.evaluate((el) => {
    const host = [...el.querySelectorAll("diffs-container")].find((n) => n.shadowRoot?.querySelector('[data-line][data-line-type="change-addition"]'));
    const root = host?.shadowRoot;
    if (!host || !root) return null;
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const paint = (colour: string) => { c.clearRect(0, 0, 1, 1); c.fillStyle = colour; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; };
    const probe = host.parentElement!.appendChild(document.createElement("span"));
    const want = (colour: string) => { probe.style.color = colour; return paint(getComputedStyle(probe).color); };
    // Pierre keeps 80% of the page under a changed row's tint on a dark page, 88% on a light one.
    const keep = document.documentElement.dataset.themeMode === "light" ? 88 : 80;
    const row = root.querySelector('[data-line][data-line-type="change-addition"]');
    const comment = [...root.querySelectorAll("[data-line] span")].find((s) => s.textContent?.trim().startsWith("//") && s.children.length === 0);
    const inside = root.appendChild(document.createElement("span"));
    inside.style.color = "var(--diffs-bg-deletion)";
    const darkStripe = paint(getComputedStyle(inside).color);
    inside.remove();
    const out = {
      darkStripe, darkStripeWant: want(`color-mix(in lab, var(--color-bg2) ${keep}%, var(--color-diff-removed))`),
      page: paint(getComputedStyle(host).backgroundColor), bg2: want("var(--color-bg2)"),
      addedRow: row && paint(getComputedStyle(row).backgroundColor), addedRowWant: want(`color-mix(in lab, var(--color-bg2) ${keep}%, var(--color-diff-added-tint))`),
      comment: comment ? paint(getComputedStyle(comment).color) : null, commentWant: want("var(--color-syntax-comment)"),
    };
    probe.remove();
    return out;
  });
}

/** Two painted colours within a step of each other (Lab mixing rounds). */
export const near = (a: number[] | null, b: number[], step = 2) => !!a && a.every((v, i) => Math.abs(v - b[i]!) <= step);
