/** The tiles the Layers panel lists, in the order it lists them, while it is shown: what
 *  Ctrl/⌘+1…9 count. Empty when no panel is shown; the keys then count tiles in the order opened. */
let order: readonly string[] = [];

export function setPanelOrder(ids: readonly string[]): void { order = ids; }
export function panelOrder(): readonly string[] { return order; }
