/**
 * The hue a label chip or a person's disc is drawn in, from the name: the same name has the same
 * hue on every card.
 *
 * Never amber, which is for what waits on the person (apps/desktop/DESIGN.md, The One Voice Rule).
 * Every preset draws its warn between hue 57 (Clean Light's, as a screen draws it) and 113
 * (Dracula's pale yellow). A name keeps at least 32° from all of them, which is as near as a preset
 * puts its own red or green to its warn (Clean Light's red, Solarized Dark's green). The hues from
 * 25 to 145 are skipped (145 itself would just clear Dracula's, by 32.02°: it is left out as a
 * margin), and a name takes one of the 239 others, from 146 round to 24.
 */
const FIRST = 146;
const HUES = 239;

export function nameHue(name: string): number {
  const sum = Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0);
  return (FIRST + (sum % HUES)) % 360;
}
