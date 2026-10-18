import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** A socket of this machine's: `file` in the data folder `dir`, unless the path is too long for a
 *  socket (then `hivemind-<tag>` in the temporary folder); a named pipe on Windows. */
export function socketIn(dir: string, file: string, tag: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\hivemind-${tag}-${hash}`;
  const inData = path.join(dir, file);
  return inData.length < 100 ? inData : path.join(os.tmpdir(), `hivemind-${tag}-${hash}.sock`);
}
