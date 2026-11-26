/**
 * A picture of the workspace, or one outside it the person clicked: fitted to the tile, zoomed in
 * fixed steps, its pixels square once each is bigger than 3 screen pixels, a checkerboard behind
 * what is see-through, and its size.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "./components/icons";
import { Button } from "./components/ui/button";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { fitScale, nextZoom, sharpPixels, sizeText } from "./image-zoom";

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
};

const CHECKERBOARD = {
  backgroundImage: "conic-gradient(var(--color-bg3) 25%, var(--color-bg4) 0 50%, var(--color-bg3) 0 75%, var(--color-bg4) 0)",
  backgroundSize: "16px 16px",
};

export function ImageTile({ path, folder, onClose, pinned, onTogglePin }: {
  path: string;
  /** The folder it is read from: the frame's. */
  folder: string | null;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}) {
  const [picture, setPicture] = useState<{ url: string; bytes: number } | { error: string } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const name = path.split("/").pop() ?? path;

  useEffect(() => {
    const base = folder?.replace(/\/+$/, "");
    const inside = !!base && path.startsWith(`${base}/`);
    const read = inside ? window.hive.fileBytes(base, path.slice(base.length + 1))
      : window.hive.outsidePicture ? window.hive.outsidePicture(path) : null;
    if (!read) { setPicture({ error: "This picture is outside the workspace: click its path in a terminal to show it." }); return; }
    let url: string | null = null;
    let live = true;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    read.then(({ base64, size }) => {
      if (!live) return;
      const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([raw], { type: TYPES[ext] ?? "application/octet-stream" }));
      setPicture({ url, bytes: size });
    }, (e: unknown) => { if (live) setPicture({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path, folder, name]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const seen = new ResizeObserver(([e]) => { if (e) setBox({ w: e.contentRect.width, h: e.contentRect.height }); });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const scale = zoom === "fit" ? fitScale(natural?.w ?? 0, natural?.h ?? 0, box.w, box.h) : zoom;
  const step = (dir: 1 | -1) => setZoom(nextZoom(scale, dir));

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]" data-image-tile>
      <header className="tile-drag-handle h-8 shrink-0 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <span className="font-semibold text-[var(--color-fg)] truncate" title={path}>{name}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="micro" className="nodrag" aria-label="zoom out" onClick={() => step(-1)}>−</Button>
          <span className="tabular-nums min-w-10 text-center" data-image-zoom>{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="micro" className="nodrag" aria-label="zoom in" onClick={() => step(1)}>+</Button>
          <Button variant="ghost" size="micro" className="nodrag" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>Fit</Button>
          <Button variant="ghost" size="micro" className="nodrag" onClick={() => setZoom(1)}>100%</Button>
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <Button variant="ghost" size="icon-micro" className="nodrag" aria-label="close tile" title="close" onClick={onClose}><X /></Button>
        </span>
      </header>
      <div ref={boxRef} className="nodrag nowheel relative flex-1 min-h-0 overflow-auto"
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); } }}>
        {picture && "error" in picture ? <p className="p-4 text-label text-[var(--color-fg2)]" role="alert">{picture.error}</p>
          : picture ? (
            <div className="grid min-h-full min-w-full place-items-center">
              <img src={picture.url} alt={name} draggable={false} data-image-sharp={sharpPixels(scale) || undefined}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                style={{ ...CHECKERBOARD, width: natural ? natural.w * scale : undefined, height: natural ? natural.h * scale : undefined, imageRendering: sharpPixels(scale) ? "pixelated" : "auto", maxWidth: "none" }} />
            </div>
          ) : <p className="p-4 text-label text-[var(--color-fg3)]">Loading {name}…</p>}
      </div>
      <footer className="h-6 shrink-0 flex items-center px-2.5 border-t border-[var(--color-line)] text-count font-mono text-[var(--color-fg3)]" data-image-size>
        {natural && picture && !("error" in picture) ? `${natural.w} × ${natural.h} · ${sizeText(picture.bytes)}` : " "}
      </footer>
    </div>
  );
}
