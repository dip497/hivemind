/**
 * The board's boxes on the canvas (docs/design/multiplayer-2026-09-28.md, R15, §4.2 G): widgets
 * placed on the board (sticky notes, text labels and checklists among them), drawn by plain React
 * — no TileHost surface, no session. A click selects one, a double-click writes in it; a selected
 * one shows its resize handles and a small bar (options, duplicate, delete). Node data is the
 * object alone; every edit goes through the board (BoardContext).
 */
import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NodeResizer, type NodeTypes } from "@xyflow/react";
import { shapeOutline, strokePixels, textPixels } from "@hivemind/workspace-doc/drawing";
import { roughPath } from "@hivemind/workspace-doc/rough";
import { dashPattern } from "@hivemind/workspace-doc/stroke-smooth";
import type { AlignHow } from "@hivemind/workspace-doc/align";
import { SHAPE_COLORS, SHAPE_DASHES, SHAPE_TEXT_SIZES, SHAPE_WEIGHTS, isStroke, type ShapeObject } from "@hivemind/workspace-doc/shapes";
import { Copy, Settings2, Trash } from "../components/icons";
import { Button } from "../components/ui/button";
import { BOX_SIZE, type BoardWidget, type BoxObject } from "./board-model";
import { WidgetContent, useWidgetLook } from "./WidgetBody";
import { optionsOf, useShownWidgetPackages } from "./widget-runtime";
import { SettingsForm } from "../plugins/SettingsForm";
import { BoardRefContext, useBoardContext } from "./board-context";
import type { ObjectStyle } from "@hivemind/workspace-doc/board-actions";
import { InkButton } from "./DrawTools";
import { TextArea } from "./TextDraft";
import { inkVar } from "./shape-ink";
import { actionKey } from "../shortcut";
import { holdPicture } from "./board-images";

interface BoxNodeProps<T extends BoxObject> {
  id: string;
  data: { object: T };
  selected?: boolean;
}

const HANDLE = { width: 10, height: 10, borderRadius: 4, border: "2px solid var(--color-bg)" } as const;

/** A selected box's handles and bar: one box's, so none while several are selected. */
function BoxHandles({ id, object, editing }: { id: string; object: BoxObject; editing: boolean }) {
  const board = useBoardContext();
  const size = BOX_SIZE[object.kind];
  const alone = board.selectedIds.length === 1 && !(object.kind === "shape" && object.locked);
  return (
    <>
      <NodeResizer nodeId={id} isVisible={alone && !editing} minWidth={size.minW} minHeight={size.minH}
        keepAspectRatio={object.kind === "shape" && object.form === "image"}
        color="var(--color-select)" handleStyle={HANDLE}
        onResizeEnd={(_e, p) => board.resize(id, p.width, p.height, p.x, p.y)} />
      {board.selectedId === id && !editing && <BoxBar id={id} object={object} />}
    </>
  );
}

function BoxShell({ id, object, selected, children }: { id: string; object: BoxObject; selected: boolean; children: ReactNode }) {
  const board = useBoardContext();
  const editing = board.editingId === id;
  return (
    // nopan: a double-click here writes in the box instead of zooming the canvas.
    <div data-board-object={object.kind} className={`nopan relative h-full w-full${selected ? " hm-board-selected" : ""}`}
      onDoubleClick={() => { if (!editing) board.edit(id); }}>
      {selected && <BoxHandles id={id} object={object} editing={editing} />}
      {children}
    </div>
  );
}

/** A shape's writing, as drawn. */
function ShapeText({ o }: { o: ShapeObject }) {
  if (!o.text) return null;
  return (
    <div data-shape-text className={`absolute inset-0 flex items-center overflow-hidden whitespace-pre-wrap break-words ${o.form === "text" ? "justify-start" : "justify-center p-2 text-center"}`}
      style={{ color: inkVar(o.color), fontSize: textPixels(o.size), lineHeight: 1.35, fontWeight: o.size === "large" ? 600 : undefined }}>
      {o.text}
    </div>
  );
}

/** A selected shape: its writing or the field to write it in, and its handles and bar. */
function SelectedShape({ id, o }: { id: string; o: ShapeObject }) {
  const board = useBoardContext();
  const editing = board.editingId === id;
  return (
    <>
      <BoxHandles id={id} object={o} editing={editing} />
      {editing && !isStroke(o.form)
        ? (
          <TextArea value={o.text ?? ""} of={o} autoFocus aria-label="shape text" placeholder={o.form === "text" ? "Text" : ""}
            className={`absolute inset-0 flex size-full p-2 ${o.form === "text" ? "" : "text-center"}`}
            style={{ color: inkVar(o.color), fontSize: textPixels(o.size), lineHeight: 1.35 }}
            onCommit={(edit) => board.update(id, (x) => (x.kind === "shape" ? { ...x, text: edit(x.text ?? "") } : x))} />
        )
        : <ShapeText o={o} />}
    </>
  );
}

/** A picture on the board: its bytes fetched by hash once, decoded off the page's thread, and only
 *  when near the screen. Until then, and when it cannot be fetched, its box says what it shows. */
function Picture({ o, repo }: { o: ShapeObject; repo: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const hash = o.image?.hash;
  useEffect(() => {
    if (!repo || !o.image) return undefined;
    let live = true;
    setFailed(false);
    const held = holdPicture(repo, o.image);
    held.url.then((u) => { if (live) setUrl(u); }, () => { if (live) setFailed(true); });
    return () => { live = false; setUrl(null); held.release(); };
  }, [repo, hash]);
  return (
    <div data-board-picture={hash} className="pointer-events-auto absolute inset-0 overflow-hidden bg-[var(--color-bg2)]">
      {url
        ? <img src={url} alt={o.alt ?? ""} width={o.image?.width} height={o.image?.height} loading="lazy" decoding="async" draggable={false} className="size-full object-contain" />
        : <span className="flex size-full items-center justify-center p-2 text-center text-label text-[var(--color-fg3)]">{failed ? `Picture not reachable${o.alt ? `: ${o.alt}` : ""}` : o.alt ?? ""}</span>}
    </div>
  );
}

/**
 * Something drawn on the board. Only what is drawn takes the pointer, so a terminal under a stroke
 * is still a terminal. A board may hold thousands, so one not selected reads nothing that changes
 * with the board: it draws again only when it changes. One kept box of SVG, stretched by its
 * node while a resize runs; the points are scaled when it ends (useBoard).
 */
const ShapeNode = memo(function ShapeNode({ id, data, selected }: BoxNodeProps<ShapeObject>) {
  const o = data.object;
  const board = useContext(BoardRefContext);
  const outline = useMemo(() => (o.rough && o.form !== "text" ? roughPath(o) : shapeOutline(o)), [o.id, o.rough, o.form, o.w, o.h, o.points]);
  const stroke = isStroke(o.form);
  const thick = strokePixels(o.weight) * (o.marker ? 5 : 1);
  const dashes = useMemo(() => dashPattern(o.dash, thick), [o.dash, thick]);
  const ink = inkVar(o.color);
  const head = useRef(`hm-head-${id}`).current;
  return (
    <div data-board-object="shape" data-shape={o.form} data-shape-id={id} data-drawing={o.drawing}
      // nodrag: a locked shape is not carried by a drag that starts on it.
      className={`nopan relative h-full w-full${o.locked ? " nodrag" : ""}${selected ? " hm-board-selected" : ""}`}
      onDoubleClick={() => { if (!stroke && o.form !== "image") board?.current?.edit(id); }}>
      {o.form === "image" && <Picture o={o} repo={board?.current?.repo ?? null} />}
      {outline && o.form !== "image" && (
        <svg className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${Math.max(o.w, 1)} ${Math.max(o.h, 1)}`} preserveAspectRatio="none">
          {o.head && (
            <defs>
              <marker id={head} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: ink }} />
              </marker>
            </defs>
          )}
          <path d={outline} vectorEffect="non-scaling-stroke" strokeWidth={thick} strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray={dashes.length ? dashes.join(" ") : undefined} strokeOpacity={o.marker ? 0.35 : undefined}
            style={{ stroke: ink }} fill={!stroke && o.filled ? ink : "none"} fillOpacity={!stroke && o.filled ? 0.14 : undefined}
            markerEnd={o.head ? `url(#${head})` : undefined} />
          {/* The wider line a click lands on; all of a filled one. */}
          <path d={outline} vectorEffect="non-scaling-stroke" strokeWidth={14} fill="transparent" stroke="transparent" data-shape-hit
            style={{ pointerEvents: !stroke && o.filled ? "all" : "stroke" }} />
        </svg>
      )}
      {selected ? <SelectedShape id={id} o={o} /> : <ShapeText o={o} />}
      {o.locked && <span className="hm-shape-lock" data-shape-locked aria-label="locked"><Glyph d={GLYPHS.lock} /></span>}
    </div>
  );
});

const GLYPHS = {
  lock: "M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2",
  front: "M2.5 2.5h7v7h-7zM9.5 6.5h4v7h-7v-4",
  back: "M6.5 6.5h7v7h-7zM6.5 9.5h-4v-7h7v4",
  rough: "M2 10c1.5-5 3 3 4.5-2s3 3 4.5-2 2 2 3 0",
  left: "M2.5 2v12M5 4.5h8v2.5H5zM5 9h5v2.5H5z",
  centre: "M8 2v12M3.5 4.5h9v2.5h-9zM5.5 9h5v2.5h-5z",
  right: "M13.5 2v12M3 4.5h8v2.5H3zM6 9h5v2.5H6z",
  top: "M2 2.5h12M4.5 5v8h2.5V5zM9 5v5h2.5V5z",
  middle: "M2 8h12M4.5 3.5v9h2.5v-9zM9 5.5v5h2.5v-5z",
  bottom: "M2 13.5h12M4.5 3v8h2.5V3zM9 6v5h2.5V6z",
  "spread-across": "M2 2v12M14 2v12M6.5 4.5h3v7h-3z",
  "spread-down": "M2 2h12M2 14h12M4.5 6.5h7v3h-7z",
} as const;

function Glyph({ d, dash, width = 1.5 }: { d: string; dash?: string; width?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} aria-hidden>
      <path d={d} />
    </svg>
  );
}

const DASH_GLYPH = { solid: undefined, dashed: "3.5 2.5", dotted: "0.5 3" } as const;
const WEIGHT_GLYPH = { thin: 1, medium: 2, thick: 3.5 } as const;
const SIZE_LETTER = { small: "S", medium: "M", large: "L" } as const;
const ALIGNS: ReadonlyArray<{ how: AlignHow; label: string }> = [
  { how: "left", label: "align left" }, { how: "centre", label: "align centre" }, { how: "right", label: "align right" },
  { how: "top", label: "align top" }, { how: "middle", label: "align middle" }, { how: "bottom", label: "align bottom" },
  { how: "spread-across", label: "spread across" }, { how: "spread-down", label: "spread down" },
];

/** The value after `now` in `all`, round again to the first. */
function nextOf<T>(all: readonly T[], now: T): T {
  return all[(all.indexOf(now) + 1) % all.length] as T;
}

/** Lining up and spreading out everything selected. */
function AlignRow() {
  const board = useBoardContext();
  return (
    <div className="flex items-center gap-1" data-board-align>
      {ALIGNS.map(({ how, label }) => (
        <Button key={how} variant="ghost" size="icon-sm" aria-label={label} title={label} data-align={how}
          disabled={how.startsWith("spread") && board.selectedIds.length < 3}
          onClick={() => board.align(board.selectedIds, how)}><Glyph d={GLYPHS[how]} /></Button>
      ))}
    </div>
  );
}

/** The look of a shape, and of every shape selected with it. */
function ShapeBar({ id, o }: { id: string; o: ShapeObject }) {
  const board = useBoardContext();
  const paint = (change: ObjectStyle) => board.setStyle(board.selectedIds, change);
  const dash = o.dash ?? "solid";
  const weight = o.weight ?? "medium";
  const size = o.size ?? "medium";
  const boxed = !isStroke(o.form) && o.form !== "text";
  return (
    <>
      {SHAPE_COLORS.map((c) => <InkButton key={c} color={c} chosen={(o.color ?? "ink") === c} onChoose={(color) => paint({ color })} />)}
      <span className="hm-shape-bar-rule" />
      {boxed && (
        <Button variant={o.filled ? "secondary" : "ghost"} size="xs" aria-pressed={!!o.filled} data-shape-fill onClick={() => paint({ filled: !o.filled })}>Fill</Button>
      )}
      {o.form !== "text" && (
        <>
          <Button variant="ghost" size="icon-sm" aria-label={`line: ${dash}`} title={`Line: ${dash}`} data-shape-dash={dash}
            onClick={() => paint({ dash: nextOf(SHAPE_DASHES, dash) })}><Glyph d="M2 8h12" dash={DASH_GLYPH[dash]} width={2} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`weight: ${weight}`} title={`Weight: ${weight}`} data-shape-weight={weight}
            onClick={() => paint({ weight: nextOf(SHAPE_WEIGHTS, weight) })}><Glyph d="M2 8h12" width={WEIGHT_GLYPH[weight]} /></Button>
          <Button variant={o.rough ? "secondary" : "ghost"} size="icon-sm" aria-label="hand-drawn" title="Hand-drawn" aria-pressed={!!o.rough} data-shape-rough
            onClick={() => paint({ rough: !o.rough })}><Glyph d={GLYPHS.rough} /></Button>
        </>
      )}
      {!isStroke(o.form) && (
        <Button variant="ghost" size="xs" aria-label={`text size: ${size}`} title={`Text size: ${size}`} data-shape-size={size}
          onClick={() => paint({ size: nextOf(SHAPE_TEXT_SIZES, size) })}>{SIZE_LETTER[size]}</Button>
      )}
      <span className="hm-shape-bar-rule" />
      <Button variant="ghost" size="icon-sm" aria-label="bring to front" title="Bring to front  ( ] )" data-shape-front onClick={() => board.toFront(board.selectedIds)}><Glyph d={GLYPHS.front} /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="send to back" title="Send to back  ( [ )" data-shape-back onClick={() => board.toBack(board.selectedIds)}><Glyph d={GLYPHS.back} /></Button>
      <Button variant={o.locked ? "secondary" : "ghost"} size="icon-sm" aria-label={o.locked ? "unlock" : "lock"} title={o.locked ? "Unlock" : "Lock"} aria-pressed={!!o.locked} data-shape-lock
        onClick={() => board.lock(board.selectedIds, !o.locked)}><Glyph d={GLYPHS.lock} /></Button>
      <span className="sr-only" data-shape-bar={id} />
    </>
  );
}

function BoxBar({ id, object }: { id: string; object: BoxObject }) {
  const board = useBoardContext();
  const pkg = useShownWidgetPackages().find((p) => object.kind === "widget" && p.id === object.widget);
  const several = board.selectedIds.length > 1;
  const [setting, setSetting] = useState(false);
  return (
    <div className="nodrag nopan hm-island hm-board-bar absolute bottom-full left-0 mb-2 flex flex-col gap-1 rounded-lg p-1" data-board-bar>
      {several && <AlignRow />}
      <div className="flex items-center gap-1">
      {object.kind === "shape" && <ShapeBar id={id} o={object} />}
      {pkg?.options.filter((o) => o.type === "choice" && o.id === "color").map((o) => o.type === "choice" && o.values.map((c) => (
        <button key={c} type="button" aria-label={`${c} ${pkg.name}`} aria-pressed={optionsOf(pkg, object as BoardWidget).color === c} data-note-color={c}
          className={`size-5 rounded-full border-2 ${optionsOf(pkg, object as BoardWidget).color === c ? "border-[var(--color-fg)]" : "border-transparent"}`}
          style={{ background: `var(--color-note-${c})` }}
          onClick={() => board.update(id, (x) => (x.kind === "widget" ? { ...x, options: { ...x.options, color: c } } : x))} />
      )))}
      {!!pkg?.options.some((o) => o.id !== "color") && (
        <Button variant="ghost" size="icon-sm" aria-label={`${pkg.name} options`} aria-pressed={setting} data-widget-options onClick={() => setSetting((v) => !v)}><Settings2 /></Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="duplicate" title={`Duplicate  (${actionKey("duplicate")})`} onClick={() => (several ? board.duplicateSelected() : board.duplicate(id))}><Copy /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="delete" title={`Delete  (${actionKey("remove-selected")})`} onClick={() => (several ? board.removeSelected() : board.remove(id))}><Trash /></Button>
      </div>
      {setting && pkg && (
        <div className="hm-island absolute left-0 top-full mt-1 w-[240px] rounded-xl p-3">
          <SettingsForm compact fields={pkg.options} values={optionsOf(pkg, object as BoardWidget)}
            onChange={(option, value) => board.update(id, (o) => (o.kind === "widget" ? { ...o, options: { ...o.options, [option]: value } } : o))} />
        </div>
      )}
    </div>
  );
}

/** A widget placed on the board: in a box like a note's, drawn as everywhere else. */
const WidgetBoxNode = memo(function WidgetBoxNode({ id, data, selected }: BoxNodeProps<BoardWidget>) {
  const o = data.object;
  const pkg = useShownWidgetPackages().find((p) => p.id === o.widget);
  // A tinted widget (a sticky note) is its colour, as a note is; any other is a card.
  const { tint } = useWidgetLook(o, pkg);
  const bare = pkg?.chrome === "none";
  return (
    <BoxShell id={id} object={o} selected={!!selected}>
      <div data-widget={o.widget}
        className={`flex h-full w-full flex-col overflow-hidden ${bare ? "px-1 text-[var(--color-fg)]" : tint ? "rounded-md p-3 shadow-[var(--hm-shadow-2)]" : "hm-island rounded-xl p-3"}`}
        style={tint && !bare ? { background: tint, color: "var(--color-note-ink)" } : undefined}>
        <WidgetContent object={o} pkg={pkg} selected={!!selected} />
      </div>
    </BoxShell>
  );
});

/** Node types for the board's boxes; a box's node type is its kind. */
export const boardNodeTypes: NodeTypes = {
  widget: WidgetBoxNode as unknown as NodeTypes[string],
  shape: ShapeNode as unknown as NodeTypes[string],
};
