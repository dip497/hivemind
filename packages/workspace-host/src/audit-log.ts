/**
 * The audit log a host keeps of the intents it carried out (R7): one JSON line each, appended to
 * a file only its user can read (`<userData>/audit.jsonl` in the app). Past 5 MB the file becomes
 * `<file>.1`, replacing the one kept before, and a new one starts. Writing never throws: an intent
 * that cannot be recorded still happens, and the first failure after a success is reported.
 *
 * People and tools read this file: its name and its lines change only with notice.
 */
import fs from "node:fs";
import type { AuditRecord } from "./intents.js";

/** Past this many bytes the log starts a new file. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface AuditLogOptions {
  file: string;
  /** A record could not be written. Said once, until one can be again. */
  onWarn?: (message: string) => void;
}

export class AuditLog {
  private failing = false;

  constructor(private readonly opts: AuditLogOptions) {}

  write(record: AuditRecord): void {
    const { file } = this.opts;
    const line = `${JSON.stringify(record)}\n`;
    try {
      const size = sizeOf(file);
      if (size > 0 && size + Buffer.byteLength(line) > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
      this.failing = false;
    } catch (e) {
      if (!this.failing) this.opts.onWarn?.(`cannot write the audit log ${file} (${e instanceof Error ? e.message : String(e)})`);
      this.failing = true;
    }
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}
