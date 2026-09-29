/**
 * One workspace's document on disk: `<dir>/<first 32 hex of sha256(repo)>.loro`, holding a header
 * line `{"format":"hivemind-workspace","v":1,"repo":…}` and then the document as a Loro shallow
 * snapshot (its state, without the history). The repo path lives in the header, not in the
 * document, which will be shared with other devices and people. Writes are atomic and private;
 * a file that cannot be read as this repo's document is renamed aside, never overwritten.
 *
 * The name and the format are a contract with files already on users' disks: change either
 * only with a migration.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LoroDoc } from "loro-crdt";

const FORMAT = "hivemind-workspace";
const VERSION = 1;
const NEWLINE = 0x0a;

/** Any repo path (a local path, an ssh uri, `../..`) is a safe name inside `dir`. */
function workspaceFile(dir: string, repo: string): string {
  return path.join(dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 32)}.loro`);
}

/**
 * The document stored for `repo`, or an empty one when there is none. A file that cannot be
 * read as this repo's document is set aside and reported, and an empty document stands in for it.
 */
export function readDoc(dir: string, repo: string, warn: (message: string) => void): LoroDoc {
  const file = workspaceFile(dir, repo);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return new LoroDoc();
    return setAside(file, repo, e, warn);
  }
  try {
    return parse(bytes, repo);
  } catch (e) {
    return setAside(file, repo, e, warn);
  }
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

function setAside(file: string, repo: string, e: unknown, warn: (message: string) => void): LoroDoc {
  const aside = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch { /* leave it where it is */ }
  warn(`the layout file for ${repo} was unreadable (${e instanceof Error ? e.message : String(e)}); kept as ${aside}, starting empty`);
  return new LoroDoc();
}

/** Replace the stored document: a private temp file renamed over the old one. Throws when it cannot. */
export function writeDoc(dir: string, repo: string, doc: LoroDoc): void {
  const file = workspaceFile(dir, repo);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const header = Buffer.from(`${JSON.stringify({ format: FORMAT, v: VERSION, repo })}\n`, "utf8");
  const body = doc.export({ mode: "shallow-snapshot", frontiers: doc.oplogFrontiers() });
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, Buffer.concat([header, body]), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}
