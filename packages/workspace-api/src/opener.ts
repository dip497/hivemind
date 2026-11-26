/** Opening anything (0.43): a URL or a path, where the person's link settings say (`opener.open`),
 *  and what a file is before it is opened (`file.stat`, `file.bytes`). */
import type { Opener } from "@hivemind/core/opener";

/** Where it opened: `tile` is the tile that shows it, when one does. */
export type OpenedThing = Exclude<Opener, { to: "ask" }> & { tile?: string };

export interface FileStat { kind: "file" | "folder"; size: number }

/** The most `file.bytes` reads. */
export const FILE_BYTES_MAX = 32 * 1024 * 1024;
