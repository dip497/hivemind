import type { SavedScreen } from "@hivemind/workspace-api/terminals";

/** The part of a terminal a saved screen is drawn with. */
export interface Screen {
  resize(cols: number, rows: number): void;
  write(data: string, done: () => void): void;
}

/** Draw `saved` as its terminal last showed it: at the size it was drawn at, so a full-screen agent
 *  keeps every row and its lines end where they did; with no cursor, as nothing runs. */
export function drawSaved(term: Screen, saved: SavedScreen): Promise<void> {
  term.resize(saved.cols, saved.rows);
  return new Promise((done) => term.write(`${saved.replay}\x1b[?25l`, done));
}
