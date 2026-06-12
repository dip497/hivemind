import type { Terminal } from "@xterm/xterm";

/**
 * Make xterm's mouse → cell mapping ZOOM-AWARE so text selection works at ANY
 * canvas zoom — not just at exactly 100%. (Ported from opencove's
 * patchXtermMouseService.)
 *
 * The problem: xterm maps a pointer event to a cell using the element's
 * getBoundingClientRect — which IS scaled by the react-flow viewport's CSS
 * transform — but divides by the UNSCALED css cell size. So under `scale(z)` the
 * result is off by `z`: at zoom > 1 the selection lands on a row below the
 * cursor, at zoom < 1 above it. That's why we had to force terminals to 100%.
 *
 * The fix: divide the relative pixel coords by the element's actual scale factor
 * (`rect.width / offsetWidth`) before dividing by the cell size — overriding the
 * internal `_mouseService.getCoords` (+ `getMouseReportCoords`). With this, the
 * canvas can sit at any zoom (fit-to-screen focus, 80–120%, …) and selection +
 * mouse reporting stay accurate.
 */

type XtermMouseService = {
  getCoords: (
    event: { clientX: number; clientY: number },
    element: HTMLElement,
    colCount: number,
    rowCount: number,
    isSelection?: boolean,
  ) => [number, number] | undefined;
  getMouseReportCoords?: (
    event: { clientX: number; clientY: number },
    element: HTMLElement,
  ) => { col: number; row: number; x: number; y: number } | undefined;
  __hivePatched?: boolean;
};

function resolveElementScale(element: HTMLElement, rect: DOMRect): { scaleX: number; scaleY: number } {
  const w = element.offsetWidth;
  const h = element.offsetHeight;
  const scaleX = w > 0 && rect.width > 0 ? rect.width / w : 1;
  const scaleY = h > 0 && rect.height > 0 ? rect.height / h : 1;
  return {
    scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
    scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
  };
}

function parsePadding(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function scaledPixelsRelativeToElement(
  event: { clientX: number; clientY: number },
  element: HTMLElement,
): [number, number] {
  const rect = element.getBoundingClientRect();
  const { scaleX, scaleY } = resolveElementScale(element, rect);
  const style = window.getComputedStyle(element);
  const padLeft = parsePadding(style.getPropertyValue("padding-left"));
  const padTop = parsePadding(style.getPropertyValue("padding-top"));
  return [
    (event.clientX - rect.left) / scaleX - padLeft,
    (event.clientY - rect.top) / scaleY - padTop,
  ];
}

function scaledTerminalCoords(args: {
  event: { clientX: number; clientY: number };
  element: HTMLElement;
  isSelection: boolean;
  cssCellWidth: number;
  cssCellHeight: number;
  colCount: number;
  rowCount: number;
}): [number, number] | undefined {
  const { event, element, isSelection, cssCellWidth, cssCellHeight, colCount, rowCount } = args;
  if (!Number.isFinite(cssCellWidth) || cssCellWidth <= 0) return undefined;
  if (!Number.isFinite(cssCellHeight) || cssCellHeight <= 0) return undefined;
  const [rx, ry] = scaledPixelsRelativeToElement(event, element);
  const nx = Math.ceil((rx + (isSelection ? cssCellWidth / 2 : 0)) / cssCellWidth);
  const ny = Math.ceil(ry / cssCellHeight);
  return [
    Math.min(Math.max(nx, 1), colCount + (isSelection ? 1 : 0)),
    Math.min(Math.max(ny, 1), rowCount),
  ];
}

/** Patch once. Returns true if patched (or already patched), false if the internal
 *  services aren't ready yet (caller retries). Never throws. */
export function patchTerminalMouse(terminal: Terminal): boolean {
  const core = terminal as unknown as {
    _core?: {
      _mouseService?: XtermMouseService;
      _renderService?: {
        dimensions?: {
          css?: { cell?: { width?: number; height?: number }; canvas?: { width?: number; height?: number } };
        };
      };
      _charSizeService?: { hasValidSize?: boolean };
    };
  };
  try {
    const mouseService = core._core?._mouseService;
    if (!mouseService || typeof mouseService.getCoords !== "function") return false;
    if (mouseService.__hivePatched) return true;
    const charSizeService = core._core?._charSizeService;
    const renderService = core._core?._renderService;
    if (!renderService || !charSizeService) return false;

    mouseService.__hivePatched = true;
    const origGetCoords = mouseService.getCoords.bind(mouseService);
    mouseService.getCoords = (event, element, colCount, rowCount, isSelection = false) => {
      if (!charSizeService.hasValidSize) return undefined;
      const cw = renderService.dimensions?.css?.cell?.width ?? 0;
      const ch = renderService.dimensions?.css?.cell?.height ?? 0;
      return (
        scaledTerminalCoords({ event, element, isSelection, cssCellWidth: cw, cssCellHeight: ch, colCount, rowCount }) ??
        origGetCoords(event, element, colCount, rowCount, isSelection)
      );
    };

    const origReport =
      typeof mouseService.getMouseReportCoords === "function"
        ? mouseService.getMouseReportCoords.bind(mouseService)
        : null;
    if (!origReport) return true;
    mouseService.getMouseReportCoords = (event, element) => {
      if (!charSizeService.hasValidSize) return undefined;
      const cw = renderService.dimensions?.css?.cell?.width ?? 0;
      const ch = renderService.dimensions?.css?.cell?.height ?? 0;
      if (!Number.isFinite(cw) || cw <= 0 || !Number.isFinite(ch) || ch <= 0) return origReport(event, element);
      const [x, y] = scaledPixelsRelativeToElement(event, element);
      const cwid = renderService.dimensions?.css?.canvas?.width ?? 0;
      const chei = renderService.dimensions?.css?.canvas?.height ?? 0;
      const cx = Number.isFinite(cwid) && cwid > 0 ? Math.min(Math.max(x, 0), cwid - 1) : x;
      const cy = Number.isFinite(chei) && chei > 0 ? Math.min(Math.max(y, 0), chei - 1) : y;
      return { col: Math.floor(cx / cw), row: Math.floor(cy / ch), x: Math.floor(cx), y: Math.floor(cy) };
    };
    return true;
  } catch {
    return false; // internal shape drift — leave native behavior
  }
}

/** Patch with a few rAF retries (the mouse/render services aren't ready the frame
 *  open() runs). Returns a canceller. */
export function patchTerminalMouseWithRetry(terminal: Terminal, maxAttempts = 30): () => void {
  if (typeof window === "undefined") {
    patchTerminalMouse(terminal);
    return () => {};
  }
  let cancelled = false;
  let frame: number | null = null;
  const tick = (attempt: number) => {
    if (cancelled) return;
    if (patchTerminalMouse(terminal)) return;
    if (attempt >= maxAttempts) return;
    frame = window.requestAnimationFrame(() => tick(attempt + 1));
  };
  tick(0);
  return () => {
    cancelled = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}
