/** Finding in a repo (0.40): a file by its name, a line by its text. fff answers on a host that can
 *  load it, git where it cannot (`engine`). */

export interface FoundFile {
  /** Relative to the repo. */
  path: string;
  /** What git says of it when it is not clean: `modified`, `untracked`, `added`, … */
  git?: string;
}

export interface FindFilesPage { files: FoundFile[]; engine: "fff" | "git" }

export type GrepMode = "plain" | "regex" | "fuzzy";

export interface FoundLine {
  path: string;
  /** 1-based. */
  line: number;
  /** 0-based, in characters. */
  col: number;
  /** The line, cut at 400 characters. */
  text: string;
  /** Where the match is in `text`, as [start, end) pairs. */
  ranges: [number, number][];
}

export interface GrepPage {
  lines: FoundLine[];
  /** Hand back as `cursor` for the next page; null when every file was searched. */
  next: number | null;
  /** Files searched so far, when the engine counts them. */
  files: number | null;
  engine: "fff" | "git";
  /** Why a regex was read as plain text, when it was not one. */
  note?: string;
}
