/**
 * A widget's body, drawn from what its code last rendered: a small tree of text, numbers, meters,
 * buttons, images and animated sprites, in rows and stacks, drawn by the app. Anyone who sees the
 * workspace sees it, without the widget's package: its images come from the host when this
 * machine has not got the package. Its buttons work where its code runs.
 */
import { widgetTint as coreWidgetTint, widgetTree as coreWidgetTree } from "@hivemind/core/widget-format";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import type { WidgetObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";
import { optionsOf, pressWidget, useDrawn, useShownWidgetPackages, widgetsRepo, type Drawing } from "./widget-runtime";
import { useBoardContext } from "./board-context";
import { ChecklistFields } from "./fields";
import { TextArea, TextLine } from "./TextDraft";

/** The widget a drawing belongs to, for the fields in it that people write in. */
const FieldsOf = createContext<{ object: WidgetObject; editing: boolean; selected: boolean } | null>(null);

/** A drawing's `text` field: what people write in the widget, merged by character; edited in
 *  place while the widget is being written in. */
function TextField({ n }: { n: Record<string, unknown> }) {
  const f = useContext(FieldsOf);
  const board = useBoardContext();
  if (!f) return null;
  const o = f.object;
  const multiline = n.type === "textarea";
  const size = n.size === "large" ? "text-heading font-semibold leading-tight" : "text-row leading-snug";
  const placeholder = str(n.placeholder);
  const Field = multiline ? TextArea : TextLine;
  return f.editing
    ? <Field value={o.text ?? ""} of={o} autoFocus aria-label={placeholder || "text"} placeholder={placeholder}
        className={`${multiline ? "h-full " : ""}w-full ${size} placeholder:opacity-50`}
        onCommit={(edit) => board.update(o.id, (x) => (x.kind === "widget" ? { ...x, text: edit(x.text ?? "") } : x))} />
    : <div className={`${multiline ? "min-h-0 flex-1 " : "truncate "}w-full overflow-hidden whitespace-pre-wrap break-words ${size}`} data-board-text>
        {o.text || <span className="opacity-50">{placeholder}</span>}
      </div>;
}

/** A drawing's `list` field: its lines, ticked, added, removed and reordered as a checklist's. */
function ListField({ n }: { n: Record<string, unknown> }) {
  const f = useContext(FieldsOf);
  const board = useBoardContext();
  if (!f) return null;
  const o = f.object;
  return <div className="flex min-h-0 flex-1 flex-col gap-1">
    <ChecklistFields id={o.id} object={o} editing={f.editing} selected={f.selected} title={n.title === true} placeholder={str(n.placeholder) || "List"}
      setText={(edit) => board.update(o.id, (x) => (x.kind === "widget" ? { ...x, text: edit(x.text ?? "") } : x))}
      setItems={(change) => board.update(o.id, (x) => (x.kind === "widget" ? { ...x, items: change(x.items ?? []) } : x))} />
  </div>;
}

/** A sprite's frames step along its row; one keyframe rule serves every sprite. */
if (typeof document !== "undefined" && !document.getElementById("hm-widget-sprite")) {
  const style = document.createElement("style");
  style.id = "hm-widget-sprite";
  // A transform, so the GPU steps it: a background-position step repaints the page under it.
  style.textContent = "@keyframes hm-widget-sprite { to { transform: translateX(-100%); } }"
    + " @media (prefers-reduced-motion: reduce) { [data-widget-sprite] > * { animation: none !important; } }";
  document.head.appendChild(style);
}

/** Where a widget package's images come from: this machine's copy, else its host. */
interface Images { repo: string | null; widget: string }
const fetched = new Map<string, Promise<string | null>>();

function useImage(images: Images, name: string): string | null {
  const local = useShownWidgetPackages().find((p) => p.id === images.widget)?.assets[name] ?? null;
  const [remote, setRemote] = useState<string | null>(null);
  useEffect(() => {
    if (local || !images.repo || !name) return;
    const key = `${images.repo}\n${images.widget}\n${name}`;
    let p = fetched.get(key);
    if (!p) fetched.set(key, (p = window.hive.widgetAsset(images.repo, images.widget, name).catch(() => null)));
    let live = true;
    void p.then((url) => { if (live) setRemote(url); });
    return () => { live = false; };
  }, [local, images.repo, images.widget, name]);
  return local ?? remote;
}

function Sprite({ n, images }: { n: Record<string, unknown>; images: Images }) {
  const url = useImage(images, str(n.src));
  const scale = Math.min(Math.max(num(n.scale, 1), 0.25), 8);
  const fw = Math.min(Math.max(num(n.frameW, 32), 1), 1024);
  const fh = Math.min(Math.max(num(n.frameH, 32), 1), 1024);
  const frames = Math.min(Math.max(Math.round(num(n.frames, 1)), 1), 64);
  const fps = Math.min(Math.max(num(n.fps, 8), 1), 60);
  const row = Math.max(Math.round(num(n.row, 0)), 0);
  // The frame is drawn at the sheet's own size, then scaled (and mirrored) as a whole.
  return <div style={{ width: fw * scale, height: fh * scale }}>
    {url && <div data-widget-sprite role="img" aria-label={str(n.label) || "animation"} style={{
      width: fw, height: fh, overflow: "hidden",
      transformOrigin: "0 0", transform: `${n.flip ? `translateX(${fw * scale}px) scaleX(-${scale})` : `scaleX(${scale})`} scaleY(${scale})`,
    }}>
      <div style={{
        width: frames * fw, height: fh, backgroundImage: `url("${url}")`, backgroundRepeat: "no-repeat",
        backgroundPosition: `0 ${-row * fh}px`, imageRendering: n.pixelated === false ? "auto" : "pixelated",
        ...(frames > 1 ? { animation: `hm-widget-sprite ${frames / fps}s steps(${frames}) infinite` } : {}),
      }} />
    </div>}
  </div>;
}

function Picture({ n, images }: { n: Record<string, unknown>; images: Images }) {
  const url = useImage(images, str(n.src));
  const w = Math.min(Math.max(num(n.w, 64), 1), 1024);
  const h = Math.min(Math.max(num(n.h, 64), 1), 1024);
  return url ? <img src={url} alt={str(n.label)} width={w} height={h} style={{ objectFit: "contain" }} draggable={false} /> : <div style={{ width: w, height: h }} />;
}

type Tree = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function draw(node: unknown, id: string, images: Images, key: number | string = 0, depth = 0): ReactNode {
  if (depth > 8 || typeof node !== "object" || node === null) return null;
  const n = node as Tree;
  const kids = Array.isArray(n.children) ? n.children.slice(0, 50).map((c, i) => draw(c, id, images, i, depth + 1)) : null;
  switch (n.type) {
    case "sprite": return <Sprite key={key} n={n} images={images} />;
    case "input": case "textarea": return <TextField key={key} n={n} />;
    case "list": return <ListField key={key} n={n} />;
    case "image": return <Picture key={key} n={n} images={images} />;
    case "stack": return <div key={key} className={`flex min-w-0 flex-col gap-1.5${n.fill ? " h-full" : ""}`}>{kids}</div>;
    case "row": return <div key={key} className="flex min-w-0 items-center gap-2">{kids}</div>;
    case "text": return <span key={key} className={`truncate ${n.size === "large" ? "text-heading font-semibold" : n.muted ? "text-count text-[var(--color-fg3)]" : "text-body"}`}>{str(n.text)}</span>;
    case "number": return <div key={key} className="flex flex-col"><span className="text-heading font-semibold tabular-nums leading-none">{str(n.value)}</span>{n.label != null && <span className="text-count text-[var(--color-fg3)]">{str(n.label)}</span>}</div>;
    case "meter": {
      const max = Math.max(num(n.max, 1), 1e-9);
      const pct = Math.min(100, Math.max(0, (num(n.value) / max) * 100));
      return <div key={key} className="flex flex-col gap-1">
        {n.label != null && <span className="text-count text-[var(--color-fg3)]">{str(n.label)}</span>}
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg3)]" role="meter" aria-valuenow={num(n.value)} aria-valuemax={max}>
          <div className="h-full rounded-full bg-[var(--color-select)]" style={{ width: `${pct}%` }} />
        </div>
      </div>;
    }
    case "button": return <Button key={key} size="sm" variant="outline" className="nodrag nopan self-start"
      onClick={() => pressWidget(id, n.action)}>{str(n.label)}</Button>;
    default: return null;
  }
}

/** What the widget `id` (of the package `widget`, in `repo`) drew, drawn by the app; a line
 *  saying so until it has drawn. */
export function WidgetBody({ id, widget, name, repo, drawing }: { id: string; widget: string; name: string; repo: string | null; drawing: Drawing | undefined }) {
  return <>{drawing === undefined || drawing.tree === null
    ? <span className="text-label text-[var(--color-fg3)]">{name}: waiting for it to draw</span>
    : draw(drawing.tree, id, { repo, widget })}</>;
}

/** What a widget shows, its package's `draw` (a widget without code) else what its code drew, and
 *  the note colour that drawing asks its card for (`tint`), if any. */
export function widgetLook(object: WidgetObject, pkg: WidgetPackage | undefined, drawing: Drawing | undefined): { tree: unknown; tint: string | null } {
  const tree = coreWidgetTree(object, pkg, drawing?.tree);
  const tint = coreWidgetTint(tree);
  return { tree, tint: tint ? `var(--color-note-${tint})` : null };
}

/** A widget's look as it is drawn now, wherever it sits: on the board, on the screen. */
export const useWidgetLook = (object: WidgetObject, pkg: WidgetPackage | undefined): { tree: unknown; tint: string | null } => widgetLook(object, pkg, useDrawn(object.id));

/** A widget's content wherever it sits: what it draws, with the fields people write in. */
export function WidgetContent({ object, pkg, selected = false }: { object: WidgetObject; pkg: WidgetPackage | undefined; selected?: boolean }) {
  const { tree } = useWidgetLook(object, pkg);
  const board = useBoardContext();
  const name = pkg?.name ?? object.widget;
  return <FieldsOf.Provider value={{ object, editing: board.editingId === object.id, selected }}>
    {tree === null
      ? <span className="text-label text-[var(--color-fg3)]">{name}: waiting for it to draw</span>
      : draw(tree, object.id, { repo: widgetsRepo(), widget: object.widget })}
  </FieldsOf.Provider>;
}
