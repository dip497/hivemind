/** What the workspace API says of pages: frames marked as stops on the path a window shows while inside one (`page.*`). */

export interface PageListing {
  id: string;
  title: string;
  /** The nearest page it is inside; null: none. */
  parent: string | null;
  /** How many board objects and tiles are inside it, at any depth. */
  objects: number;
  tiles: number;
}

export interface PageNewAsk {
  title: string;
  /** The page or frame it goes inside; null or left out: the canvas itself. */
  in?: string | null;
  /** Its corner on the canvas; a free spot if left out. */
  at?: { x: number; y: number };
}
