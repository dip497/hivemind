/**
 * A QR code of `text`, as large as its box allows: an SVG whose every module is the same whole
 * number of device pixels (a code drawn at 2.4 pixels a module reads as an uneven grid), with the
 * four-module white margin a reader needs. Pressed, it opens as large as the window allows, for a
 * phone across a desk; Esc closes it.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { encode } from "uqr";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

/** Never drawn smaller than this, in CSS pixels, so a phone can read it. */
const LEAST = 200;

/** The side, in CSS pixels, that gives each module a whole number of device pixels: as near `room`
 *  as that allows, and never under LEAST. */
function sideFor(room: number, modules: number, ratio: number): number {
  const per = Math.max(Math.ceil((LEAST * ratio) / modules), Math.floor((Math.max(room, LEAST) * ratio) / modules));
  return (per * modules) / ratio;
}

function QrSvg({ text, label }: { text: string; label: string }) {
  const { data, size } = useMemo(() => encode(text, { border: 4 }), [text]);
  const svg = useRef<SVGSVGElement>(null);
  const [side, setSide] = useState(LEAST);
  useLayoutEffect(() => {
    const box = svg.current!.parentElement!;
    const fit = () => setSide(sideFor(Math.min(box.clientWidth, box.clientHeight), size, window.devicePixelRatio || 1));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(box);
    return () => watch.disconnect();
  }, [size]);
  const cells: string[] = [];
  data.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(`M${x} ${y}h1v1h-1z`); }));
  return (
    <svg ref={svg} viewBox={`0 0 ${size} ${size}`} width={side} height={side} shapeRendering="crispEdges" role="img" aria-label={label} data-qr-modules={size}>
      <rect width={size} height={size} fill="#fff" />
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

export function QrCode({ text, label, ...rest }: { text: string; label: string } & Omit<ComponentProps<"button">, "children" | "onClick">) {
  const [large, setLarge] = useState(false);
  return <>
    <button type="button" className="qr-code" title="Show it larger" onClick={() => setLarge(true)} {...rest}>
      <QrSvg text={text} label={label} />
    </button>
    <Dialog open={large} onOpenChange={setLarge}>
      {/* Above Settings, which a code is shown from. */}
      <DialogContent padding="none" closeButton={false} className="qr-large" data-qr-large>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">Point the phone's camera at it. Esc closes it.</DialogDescription>
        <QrSvg text={text} label={label} />
      </DialogContent>
    </Dialog>
  </>;
}
