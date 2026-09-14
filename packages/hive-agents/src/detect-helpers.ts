/** Screen-scrape primitives. Nothing here knows any agent by name. */

export const BRAILLE = /[⠀-⣿]/;

export function hasBrailleSpinner(content: string): boolean {
  return content.split("\n").some((line) => BRAILLE.test(line.trim().charAt(0)));
}

/** "do you want" / "would you like" followed by "yes" or "❯". */
export function hasConfirmationPrompt(lower: string): boolean {
  const pos = (() => {
    const a = lower.indexOf("do you want");
    if (a !== -1) return a;
    return lower.indexOf("would you like");
  })();
  if (pos === -1) return false;
  const after = lower.slice(pos);
  return after.includes("yes") || after.includes("❯");
}

export function hasInterruptPattern(lower: string): boolean {
  return (
    lower.includes("esc to interrupt") ||
    lower.includes("ctrl+c to interrupt") ||
    (lower.includes("esc") && lower.includes("interrupt"))
  );
}

export function cursorWordActive(rest: string): boolean {
  const word = rest.trim().split(/\s+/)[0] ?? "";
  return word.replace(/[^a-z]+$/i, "").toLowerCase().endsWith("ing");
}
