/** Annotation model for plan review. Mirrors plannotator's three effective
 *  kinds but keeps a flat, serializable shape. */
export type AnnotationKind = "comment" | "deletion" | "global";

export interface Annotation {
  id: string;
  /** The block this anchors to. `null` for a global (whole-plan) comment. */
  blockId: string | null;
  kind: AnnotationKind;
  /** The exact text the user selected (or the block's text for a whole-block
   *  annotation). Quoted back to the agent so it knows what you meant. */
  originalText: string;
  /** Free-text feedback (comment / global). Empty for a bare deletion. */
  comment?: string;
  /** Set when created from a quick-label chip — the chip's label, e.g. "Nit". */
  quickLabel?: string;
  createdAt: number;
}

/** A top-level parsed unit of the plan. We anchor annotations to these. */
export interface PlanBlock {
  id: string;
  /** marked token type: paragraph | heading | list | code | blockquote | table | … */
  type: string;
  /** The raw markdown for this block (re-rendered via MarkdownPreview). */
  raw: string;
  /** Plain text (selection fallback + deletion quoting). */
  text: string;
}

/** Preset one-click feedback chips (plannotator's "Quick Labels"). */
export interface QuickLabel {
  label: string;
  /** Optional instruction appended to the feedback so the agent knows the intent. */
  tip?: string;
}

export const QUICK_LABELS: QuickLabel[] = [
  { label: "Nit", tip: "Minor — address if cheap." },
  { label: "Fix", tip: "This is wrong; correct it." },
  { label: "Question", tip: "Clarify before proceeding." },
  { label: "Out of scope", tip: "Drop this from the plan." },
  { label: "Needs detail", tip: "Expand with concrete steps." },
  { label: "Good", tip: "Keep this as-is." },
];
