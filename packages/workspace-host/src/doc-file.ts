/**
 * One workspace's document on disk: `<dir>/<first 32 hex of sha256(repo)>.loro`, holding a header
 * line `{"format":"hivemind-workspace","v":1,"repo":…}` and then the document as a Loro shallow
 * snapshot (its state, without the history). The repo path lives in the header, not in the
 * document, which will be shared with other devices and people. Writes are atomic and private;
 * a file that cannot be read as this repo's document is renamed aside, never overwritten.
 *
 * Changes made since the snapshot are appended beside it, to `<same name>.updates`, as Loro
 * updates, each after its length (4 bytes, big-endian), so a change costs what it changed. Loading
 * takes the snapshot, then the updates in order; a last one cut short by a crash is dropped. A new
 * snapshot is renamed into place before the updates it holds are removed: a crash between leaves
 * updates that are taken again, which changes nothing.
 *
 * The name and the format are a contract with files already on users' disks: change either
 * only with a migration.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LoroDoc, type Frontiers, type VersionVector } from "loro-crdt";

const FORMAT = "hivemind-workspace";
const VERSION = 1;
const NEWLINE = 0x0a;

/** Any repo path (a local path, an ssh uri, `../..`) is a safe name inside `dir`. */
function workspaceFile(dir: string, repo: string): string {
  return path.join(dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 32)}.loro`);
}

const updatesFile = (file: string): string => `${file}.updates`;
const LENGTH = 4;

/** A document as read from disk, and what is stored of it: its version as written and the bytes of
 *  its snapshot and of the updates after it, or null when nothing of it is stored. */
export interface StoredDoc {
  doc: LoroDoc;
  stored: { version: VersionVector; snapshotBytes: number; updatesBytes: number } | null;
}

/** The document stored for `repo`, or an empty one when there is none. */
export function readDoc(dir: string, repo: string, warn: (message: string) => void): LoroDoc {
  return readStoredDoc(dir, repo, warn).doc;
}

/**
 * The document stored for `repo`, with the updates written after its snapshot, or an empty one
 * when there is none. A file that cannot be read as this repo's document is set aside and
 * reported, and an empty document stands in for it; so are updates that do not load, after the
 * ones before them are taken.
 */
export function readStoredDoc(dir: string, repo: string, warn: (message: string) => void): StoredDoc {
  const file = workspaceFile(dir, repo);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Updates without the snapshot they follow cannot load.
      if (code === "ENOENT" && fs.existsSync(updatesFile(file))) setAside(updatesFile(file), repo, new Error("its snapshot is missing"), warn);
      return { doc: new LoroDoc(), stored: null };
    }
    return { doc: setAside(file, repo, e, warn), stored: null };
  }
  let doc: LoroDoc;
  try {
    doc = parse(bytes, repo);
  } catch (e) {
    if (fs.existsSync(updatesFile(file))) setAside(updatesFile(file), repo, e, warn);
    return { doc: setAside(file, repo, e, warn), stored: null };
  }
  const updatesBytes = readUpdates(updatesFile(file), doc, repo, warn);
  return { doc, stored: updatesBytes === null ? null : { version: doc.oplogVersion(), snapshotBytes: bytes.length, updatesBytes } };
}

/** Take the updates in `file` into `doc`, in order: their bytes, the last one cut short taken
 *  away. Null when one did not load: the file is set aside, and the document holds those before. */
function readUpdates(file: string, doc: LoroDoc, repo: string, warn: (message: string) => void): number | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return 0;
  }
  let at = 0;
  while (at + LENGTH <= bytes.length) {
    const end = at + LENGTH + bytes.readUInt32BE(at);
    if (end > bytes.length) break;
    try {
      doc.import(bytes.subarray(at + LENGTH, end));
    } catch (e) {
      setAside(file, repo, e, warn, "with the changes before it");
      return null;
    }
    at = end;
  }
  // A crash cut the last one short: what follows it is appended where it ends.
  if (at < bytes.length) fs.truncateSync(file, at);
  return at;
}

function parse(bytes: Buffer, repo: string): LoroDoc {
  const end = bytes.indexOf(NEWLINE);
  if (end < 0) throw new Error("no header");
  const header = JSON.parse(bytes.subarray(0, end).toString("utf8")) as { format?: unknown; v?: unknown; repo?: unknown } | null;
  if (header?.format !== FORMAT || header.v !== VERSION) throw new Error(`not a ${FORMAT} ${VERSION} file`);
  if (header.repo !== repo) throw new Error("it belongs to another repo");
  const doc = new LoroDoc();
  doc.import(bytes.subarray(end + 1));
  return doc;
}

function setAside(file: string, repo: string, e: unknown, warn: (message: string) => void, then = "starting empty"): LoroDoc {
  const aside = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch { /* leave it where it is */ }
  warn(`the layout file for ${repo} was unreadable (${e instanceof Error ? e.message : String(e)}); kept as ${aside}, ${then}`);
  return new LoroDoc();
}

/** The keys (repos) of the documents stored in `dir`, read from their headers; a file that is not
 *  one is skipped. */
export function storedKeys(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".loro"));
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const name of names) {
    try {
      const fd = fs.openSync(path.join(dir, name), "r");
      try {
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        const end = head.subarray(0, n).indexOf(NEWLINE);
        const header = JSON.parse(head.subarray(0, end).toString("utf8")) as { format?: unknown; v?: unknown; repo?: unknown };
        if (header.format === FORMAT && header.v === VERSION && typeof header.repo === "string") keys.push(header.repo);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* not one of ours */
    }
  }
  return keys;
}

/** Take away the document stored for `repo`, if there is one. */
export function removeDoc(dir: string, repo: string): void {
  const file = workspaceFile(dir, repo);
  fs.rmSync(file, { force: true });
  fs.rmSync(updatesFile(file), { force: true });
}

/**
 * Replace the stored document: a private temp file renamed over the old one, then the updates it
 * now holds removed. It keeps the history since `since` (none given: the state alone; none at all:
 * every change). Its bytes. Throws when it cannot.
 */
export function writeDoc(dir: string, repo: string, doc: LoroDoc, since: Frontiers = doc.oplogFrontiers()): number {
  const file = workspaceFile(dir, repo);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const header = Buffer.from(`${JSON.stringify({ format: FORMAT, v: VERSION, repo })}\n`, "utf8");
  const content = Buffer.concat([header, since.length === 0 ? doc.export({ mode: "snapshot" }) : doc.export({ mode: "shallow-snapshot", frontiers: since })]);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
  fs.rmSync(updatesFile(file), { force: true });
  return content.length;
}

/** Append `update` (a Loro update made since what is stored) after the stored document. Its bytes
 *  on disk. Throws when it cannot: the caller writes the document whole instead. */
export function appendUpdate(dir: string, repo: string, update: Uint8Array): number {
  const record = Buffer.alloc(LENGTH + update.length);
  record.writeUInt32BE(update.length, 0);
  record.set(update, LENGTH);
  fs.appendFileSync(updatesFile(workspaceFile(dir, repo)), record, { mode: 0o600 });
  return record.length;
}
