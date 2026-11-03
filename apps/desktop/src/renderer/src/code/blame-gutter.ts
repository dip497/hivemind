/**
 * Blame beside the editor's lines (docs/design/git-history-2026-11-02.md §5.8): on the first line
 * of each run, who last changed it and how long ago; recent runs in the second text colour, older
 * ones quieter; the commit's summary on hover; a click shows that commit in History. Lines not
 * committed yet are marked so. The runs come from `git.blame` of the editor's text, set with
 * `setBlame`; nothing here asks for them, so typing costs this gutter nothing.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { BlameHunk } from "@hivemind/workspace-api/git";
import { ago } from "./HistoryPanel";

export const setBlame = StateEffect.define<BlameHunk[]>();

const hunks = StateField.define<BlameHunk[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    return value;
  },
});

/** Changed in the last two weeks: drawn in the second text colour; older, in the third. */
const RECENT_S = 14 * 86400;

class BlameMarker extends GutterMarker {
  constructor(readonly hunk: BlameHunk) { super(); }
  eq(other: BlameMarker) { return other.hunk === this.hunk; }
  toDOM() {
    const el = document.createElement("span");
    const h = this.hunk;
    el.className = "cm-blame-mark";
    if (!h.oid) {
      el.textContent = "not committed";
      el.style.color = "var(--color-fg3)";
      el.style.fontStyle = "italic";
      return el;
    }
    el.textContent = `${h.author.split(/\s+/)[0] ?? ""} · ${ago(h.time)}`;
    el.title = `${h.summary}\n${h.author} · ${new Date(h.time * 1000).toLocaleString()} · ${h.oid.slice(0, 10)}\nClick to show this commit`;
    el.dataset.oid = h.oid;
    el.style.color = Date.now() / 1000 - h.time < RECENT_S ? "var(--color-fg2)" : "var(--color-fg3)";
    el.style.cursor = "pointer";
    return el;
  }
}

const spacer = new (class extends GutterMarker { toDOM() { const el = document.createElement("span"); el.textContent = "xxxxxxxxxx · 10mo"; return el; } })();

/** The gutter, calling `onCommit` with a run's commit when its mark is clicked. */
export function blameGutter(onCommit: (oid: string) => void): Extension {
  return [
    hunks,
    gutter({
      class: "cm-blame",
      markers: (view) => {
        const doc = view.state.doc;
        const marks = [];
        for (const h of view.state.field(hunks)) {
          if (h.start < 1 || h.start > doc.lines) continue;
          marks.push(new BlameMarker(h).range(doc.line(h.start).from));
        }
        return RangeSet.of(marks, true);
      },
      initialSpacer: () => spacer,
      domEventHandlers: {
        click: (_view, _line, event) => {
          const oid = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-oid]")?.dataset.oid;
          if (!oid) return false;
          onCommit(oid);
          return true;
        },
      },
    }),
    EditorView.theme({
      ".cm-blame": { fontSize: "var(--text-count)", paddingRight: "6px", borderRight: "1px solid var(--color-line)" },
      ".cm-blame-mark": { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "inline-block", maxWidth: "16ch" },
    }),
  ];
}
