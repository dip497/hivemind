/**
 * DOM focus-target predicates for canvas keyboard handling — pure (no React) so
 * the "should this key act on the canvas, or type into a field?" decision is
 * unit-testable in isolation.
 */

/** Any editable element — INPUT, TEXTAREA, or contentEditable. This INCLUDES the
 *  terminal/editor (their textareas are editable), which are canvas content you
 *  navigate FROM — so use it only where that's the intended behavior. */
export function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** A REAL text field (tile rename, palette search, issue forms) where every key
 *  — including "." and Escape — must type/act normally. EXCLUDES xterm's hidden
 *  helper textarea (`.xterm-helper-textarea`), which is canvas content you
 *  navigate FROM, not a field you type into. */
export function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "INPUT") return true;
  if (el.tagName === "TEXTAREA") return !el.classList.contains("xterm-helper-textarea");
  return false;
}
