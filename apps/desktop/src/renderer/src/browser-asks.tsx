/**
 * A Browser tile's page asking for the camera, the microphone, the location or notifications
 * (main/permissions.ts decides when it must): the tile names the site and what it wants, and the
 * person allows or blocks it. Main keeps the answer for the site until the app quits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { siteParts, wants } from "./site-words";

interface Ask { askId: number; site: string; permissions: string[] }

/** How long a question is on screen before its buttons take a click: a click meant for the page,
 *  landing where the question has just appeared, answers nothing (Chrome waits as long). */
const ARMED_AFTER_MS = 500;

/** The asks of the pages `owns` says are this tile's, oldest first, and how to answer one. */
export function useBrowserAsks(owns: (pageId: number) => boolean): { ask: Ask | undefined; answer: (askId: number, allowed: boolean) => void } {
  const [asks, setAsks] = useState<Ask[]>([]);
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  useEffect(() => window.hive.onBrowserPermission((e) => {
    if ("done" in e) setAsks((list) => list.filter((a) => a.askId !== e.askId));
    else if (ownsRef.current(e.pageId)) setAsks((list) => [...list, { askId: e.askId, site: e.site, permissions: e.permissions }]);
  }), []);
  const answer = useCallback((askId: number, allowed: boolean) => {
    window.hive.answerBrowserPermission?.(askId, allowed);
    setAsks((list) => list.filter((a) => a.askId !== askId));
  }, []);
  return { ask: asks[0], answer };
}

/** The question, over the top of the page: the page does not move when it shows. */
export function BrowserAsk({ ask, answer }: { ask: Ask; answer: (askId: number, allowed: boolean) => void }) {
  // The ask whose buttons take clicks: none until it has been shown a moment, again for each ask.
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(ask.askId), ARMED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ask.askId]);
  const ready = armed === ask.askId;
  const does = wants(ask.permissions);
  return (
    <div role="alertdialog" aria-label={`${ask.site} wants to ${does}`} data-permission-ask className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-2 py-1 bg-[var(--color-bg4)] border-b border-[var(--color-line)] shadow-[var(--hm-shadow-float)] text-label text-[var(--color-fg)]">
      {/* What it wants stays whole, on a line of its own when the tile is narrow. The buttons
          follow the words, so a wide tile half off screen still shows them. */}
      <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1">
        <SiteName site={ask.site} />
        <span>wants to {does}.</span>
      </p>
      <Button variant="ghost" size="xs" className="nodrag" disabled={!ready} onClick={() => answer(ask.askId, false)}>Block</Button>
      <Button variant="secondary" size="xs" className="nodrag" disabled={!ready} onClick={() => answer(ask.askId, true)}>Allow</Button>
    </div>
  );
}

/** A site's name, its end never cut: a long one loses its start. The whole origin is its title. */
export function SiteName({ site }: { site: string }) {
  const { head, tail } = siteParts(site);
  return (
    <span className="flex min-w-0 max-w-full font-mono" title={site}>
      <span className="truncate [direction:rtl]"><bdi>{head}</bdi></span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
}
