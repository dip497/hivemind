/**
 * A Browser tile's page asking for the camera, the microphone, the location or notifications
 * (main/permissions.ts decides when it must): the tile names the site and what it wants, and the
 * person allows or blocks it. Main keeps the answer for the site until the app quits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";

interface Ask { askId: number; site: string; permissions: string[] }

/** What a right lets a site do, in the words the prompt uses. */
const DOES: Record<string, string> = {
  geolocation: "know your location",
  notifications: "show notifications",
  "display-capture": "see your screen",
  "clipboard-read": "see what you copied",
  "idle-detection": "know when you are away",
  "window-management": "place windows on your screens",
  midi: "use your MIDI devices",
  midiSysex: "control your MIDI devices",
  hid: "use your input devices",
  serial: "use your serial ports",
  usb: "use your USB devices",
};

function wants(permissions: string[]): string {
  const media = permissions.filter((p) => p === "camera" || p === "microphone");
  if (media.length) return `use your ${media.join(" and ")}`;
  return permissions.map((p) => DOES[p] ?? `use ${p}`).join(" and ");
}

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

export function BrowserAsk({ ask, answer }: { ask: Ask; answer: (askId: number, allowed: boolean) => void }) {
  return (
    <div role="alertdialog" aria-label="Site permission" data-permission-ask className="flex items-center gap-2 px-2 py-1 bg-[var(--color-bg4)] border-b border-[var(--color-line)] text-label text-[var(--color-fg)]">
      {/* The buttons follow the words, so a wide tile half off screen still shows them. */}
      <span className="min-w-0 truncate"><span className="font-mono">{ask.site}</span> wants to {wants(ask.permissions)}.</span>
      <Button variant="ghost" size="xs" className="nodrag" onClick={() => answer(ask.askId, false)}>Block</Button>
      <Button variant="secondary" size="xs" className="nodrag" onClick={() => answer(ask.askId, true)}>Allow</Button>
    </div>
  );
}
