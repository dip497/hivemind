/**
 * What a Browser tile's pages have downloaded (main/page-downloads.ts): each file's name, in the
 * Downloads folder, and a way to see it there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { X as XIcon } from "./components/icons";
import type { PageDownload } from "../../shared/ipc";

/** The most recent downloads a tile keeps saying. */
const SHOWN = 3;

/** The downloads of the pages `owns` says are this tile's, newest last. */
export function usePageDownloads(owns: (pageId: number) => boolean): { downloads: PageDownload[]; dismiss: (id: string) => void } {
  const [downloads, setDownloads] = useState<PageDownload[]>([]);
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  useEffect(() => window.hive.onBrowserDownload((d) => {
    if (!ownsRef.current(d.pageId)) return;
    setDownloads((list) => [...list.filter((other) => other.id !== d.id), d].slice(-SHOWN));
  }), []);
  const dismiss = useCallback((id: string) => setDownloads((list) => list.filter((d) => d.id !== id)), []);
  return { downloads, dismiss };
}

const WORDS: Record<PageDownload["state"], string> = { saving: "Saving", saved: "Saved", failed: "Could not save" };

/** A line per download, over the page, which does not move when one shows. The buttons follow the
 *  words, so a wide tile half off screen still shows them. */
export function PageDownloads({ downloads, dismiss }: { downloads: PageDownload[]; dismiss: (id: string) => void }) {
  if (!downloads.length) return null;
  return (
    <div className="absolute left-0 bottom-0 z-10 flex max-w-full flex-col">
      {downloads.map((d) => (
        <div key={d.id} data-page-download={d.state} className="h-7 flex items-center gap-2 px-2 bg-[var(--color-bg4)] border-t border-r border-[var(--color-line)] text-label text-[var(--color-fg2)]">
          <span className="min-w-0 truncate" title={d.name}>{WORDS[d.state]} <span className="font-mono text-[var(--color-fg)]">{d.name}</span></span>
          {d.state === "saved" && <Button variant="ghost" size="xs" className="nodrag shrink-0" onClick={() => void window.hive.browserShowDownload?.(d.id)}>Show in folder</Button>}
          <Button variant="ghost" size="icon-2xs" className="nodrag shrink-0" aria-label={`dismiss ${d.name}`} title="Dismiss" onClick={() => dismiss(d.id)}><XIcon /></Button>
        </div>
      ))}
    </div>
  );
}
