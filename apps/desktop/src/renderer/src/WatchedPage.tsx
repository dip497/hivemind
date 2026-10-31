import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X as XIcon, GripVertical, ExternalLink } from "./components/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import type { PageFrame, PageInput } from "../../shared/page-input";
import { usePageAnnotate } from "./browser-notes";
import { AgentAccessMenu, DrivingBar, PersonAskBar } from "./browser-agents";

/** The modifier bits a page's input names: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;

/** A browser tile's page where there is no web view (a browser tab the app serves): the page the
 *  app window holds, the same one its agent drives, shown as it changes and used from here. */
export function WatchedPage({ tileId, url, repoPath, onClose }: { tileId: string; url?: string; repoPath: string; onClose?: () => void }) {
  const [frame, setFrame] = useState<PageFrame | null>(null);
  const [shown, setShown] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [address, setAddress] = useState(url ?? "");
  const editing = useRef(false);
  const picture = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const lastSrc = useRef("");

  useEffect(() => {
    let live = true;
    const offFrame = window.hive.onBrowserFrame((id, f) => { if (id === tileId) setFrame(f); });
    const offShown = window.hive.onBrowserPageShown((id, s) => { if (id === tileId) setShown(s); });
    const offGone = window.hive.onBrowserPageGone((id) => { if (id === tileId) setProblem("The page was closed in the app."); });
    // The app window's page is there once it has loaded: until then, asked again.
    let again: ReturnType<typeof setTimeout> | undefined;
    const watch = () => window.hive.browserWatch(tileId).then((r) => {
      if (!live) return;
      setProblem(null);
      setShown(r.shown);
    }, () => {
      if (!live) return;
      setProblem("The page shows here while the app window has it open.");
      again = setTimeout(watch, 1000);
    });
    void watch();
    return () => { live = false; clearTimeout(again); offFrame(); offShown(); offGone(); window.hive.browserUnwatch(tileId); };
  }, [tileId]);

  const src = frame ? `data:image/jpeg;base64,${frame.data}` : "";
  // The next picture is asked for once this one is drawn; one the same as the last never loads again.
  useEffect(() => {
    if (!src) return;
    if (src === lastSrc.current) window.hive.browserFrameShown(tileId);
    lastSrc.current = src;
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (frame && !editing.current) setAddress(frame.url); }, [frame?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notes on the page, made here as in the app window: the layer lies over the picture as drawn.
  const [loads, setLoads] = useState(0);
  useEffect(() => { setLoads((n) => n + 1); }, [frame?.url]);
  const notes = usePageAnnotate({ tileId, repoPath, url: frame?.url, loads });
  // Measured when the box changes size or a picture of another size arrives, not per picture.
  const area = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const box = area.current;
    if (!box) return;
    const seen = new ResizeObserver(() => setRoom({ width: box.clientWidth, height: box.clientHeight }));
    seen.observe(box);
    return () => seen.disconnect();
  }, []);
  const scale = natural && room ? Math.min(room.width / natural.width, room.height / natural.height) : 0;
  const drawn = scale ? { width: natural!.width * scale, height: natural!.height * scale } : null;

  const send = (input: PageInput) => { void window.hive.browserInput(tileId, input).catch(() => {}); };
  // Where on the page: the picture is drawn whole in its box, from the top left, at one scale.
  const at = (e: { clientX: number; clientY: number }) => {
    const img = picture.current!;
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / (img.naturalWidth || r.width), r.height / (img.naturalHeight || r.height));
    const width = (img.naturalWidth || r.width) * scale, height = (img.naturalHeight || r.height) * scale;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((e.clientX - r.left) / width), y: clamp((e.clientY - r.top) / height) };
  };
  const moving = useRef<number | null>(null);
  const mouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved", e: React.MouseEvent) => {
    if (!picture.current) return;
    send({ kind: "mouse", type, ...at(e), button: type === "mouseMoved" ? "none" : BUTTONS[e.button] ?? "left", clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, e.detail)), modifiers: modifiersOf(e) });
  };
  const key = (type: "keyDown" | "keyUp", e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Process" || e.key === "Dead") return;
    e.preventDefault();
    e.stopPropagation();
    const types = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = type === "keyDown" ? (types ? e.key : e.key === "Enter" ? "\r" : "") : "";
    send({ kind: "key", type, key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers: modifiersOf(e) });
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]" data-watched-page>
      <div className="tile-drag-handle h-8 flex items-center gap-1 px-1.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] cursor-grab active:cursor-grabbing">
        <GripVertical size={13} className="text-[var(--color-fg3)] shrink-0" />
        <Button variant="ghost" size="icon-2xs" className="nodrag" onClick={() => send({ kind: "go", to: "back" })} disabled={!frame?.canBack} aria-label="back" title="Back"><ArrowLeft /></Button>
        <Button variant="ghost" size="icon-2xs" className="nodrag" onClick={() => send({ kind: "go", to: "forward" })} disabled={!frame?.canForward} aria-label="forward" title="Forward"><ArrowRight /></Button>
        <Button variant="ghost" size="icon-2xs" className="nodrag" onClick={() => send({ kind: "go", to: "reload" })} aria-label="reload" title="Reload"><RotateCw /></Button>
        <Input font="mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={() => { editing.current = true; }}
          onBlur={() => { editing.current = false; if (frame) setAddress(frame.url); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const to = /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`;
              send({ kind: "open", url: to });
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          spellCheck={false}
          className="nodrag flex-1 min-w-0"
          title={frame?.title}
          data-watched-page-address
        />
        <a className="nodrag inline-flex" href={frame?.url ?? url} target="_blank" rel="noopener noreferrer" title="Open in a tab of this browser" aria-label="open in a tab of this browser">
          <Button variant="ghost" size="icon-2xs" tabIndex={-1}><ExternalLink /></Button>
        </a>
        {notes.button}
        <AgentAccessMenu tileId={tileId} />
        {onClose && <Button variant="ghost" size="icon-2xs" className="nodrag" onClick={onClose} aria-label="close tile" title="Close tile"><XIcon /></Button>}
      </div>
      {notes.bar}
      <DrivingBar tileId={tileId} />
      <div
        className="nodrag nowheel nopan relative flex-1 min-h-0 bg-[var(--color-bg)] overflow-hidden"
        onMouseDown={(e) => { keys.current?.focus({ preventScroll: true }); e.preventDefault(); mouse("mousePressed", e); }}
        onMouseUp={(e) => mouse("mouseReleased", e)}
        onMouseMove={(e) => {
          if (moving.current !== null) return;
          const at = { clientX: e.clientX, clientY: e.clientY, button: e.button, detail: e.detail, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey } as React.MouseEvent;
          moving.current = requestAnimationFrame(() => { moving.current = null; mouse("mouseMoved", at); });
        }}
        onWheel={(e) => {
          if (!picture.current) return;
          const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
          send({ kind: "wheel", ...at(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiersOf(e) });
        }}
        onContextMenu={(e) => e.preventDefault()}
        data-watched-page-picture
        ref={area}
      >
        <PersonAskBar tileId={tileId} />
        {notes.layer && drawn && <div className="absolute left-0 top-0" style={drawn}>{notes.layer}</div>}
        {src && (
          <img
            ref={picture}
            src={src}
            alt={frame?.title ?? ""}
            draggable={false}
            onLoad={(e) => {
              window.hive.browserFrameShown(tileId);
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
              setNatural((n) => (n && n.width === width && n.height === height ? n : { width, height }));
            }}
            className="absolute inset-0 h-full w-full object-contain object-left-top select-none"
          />
        )}
        <textarea
          ref={keys}
          aria-label="Type into the page"
          className="absolute left-0 top-0 h-px w-px opacity-0"
          onKeyDown={(e) => key("keyDown", e)}
          onKeyUp={(e) => key("keyUp", e)}
          onCompositionEnd={(e) => { send({ kind: "text", text: e.data }); e.currentTarget.value = ""; }}
          onPaste={(e) => { e.preventDefault(); send({ kind: "text", text: e.clipboardData.getData("text") }); }}
          data-watched-page-keys
        />
        {(problem || !src) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-label text-[var(--color-fg2)]" data-watched-page-state>
            {problem ?? "Waiting for the page from the app…"}
          </div>
        )}
        {src && !shown && !problem && (
          <div className="absolute inset-x-0 bottom-0 bg-[var(--color-bg3)] px-3 py-1.5 text-chip text-[var(--color-fg2)]" data-watched-page-paused>
            The app's window is minimized or hidden, so this page is paused. You see its last picture.
          </div>
        )}
      </div>
    </div>
  );
}
