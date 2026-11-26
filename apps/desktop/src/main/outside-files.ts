/**
 * A file on this computer outside every workspace, that the person opened with their own click
 * (`open-thing.ts`): what is there, a picture's bytes for the Image tile, a text file read and saved
 * for the Code tile, and a viewable file handed to the system's app. Only a path the click opened
 * is read, written or handed on. Served to the app's own windows only, never to a browser tab.
 */
import fsp from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMAGE_EXT, OPENABLE_EXT } from "@hivemind/core/opener";
import { FILE_BYTES_MAX } from "@hivemind/workspace-api/opener";
import { LARGEST_TEXT_FILE } from "@hivemind/host/files";

/** The real paths the person opened, oldest first; on disk once `keepOpenedIn` names a file, so a
 *  tile showing one reads it again after a restart. */
const opened = new Set<string>();
const MOST_KEPT = 200;
let keptIn: string | null = null;
let loaded: Promise<void> = Promise.resolve();
let saving: Promise<void> = Promise.resolve();

/** Keep the paths the person opened in `file`, and take back the ones kept there; an unreadable file keeps none. */
export function keepOpenedIn(file: string): void {
  keptIn = file;
  loaded = fsp.readFile(file, "utf8").then((text) => {
    const kept: unknown = JSON.parse(text);
    if (!Array.isArray(kept)) return;
    const since = [...opened];
    opened.clear();
    for (const p of [...kept.filter((x): x is string => typeof x === "string" && path.isAbsolute(x)), ...since]) remember(p);
  }).catch(() => {});
}

function remember(real: string): void {
  opened.delete(real);
  opened.add(real);
  for (const old of opened) { if (opened.size <= MOST_KEPT) break; opened.delete(old); }
}

/** Written whole to a file beside it and moved over it, so a crash leaves the old list or the new. */
function save(): Promise<void> {
  const file = keptIn;
  if (!file) return Promise.resolve();
  const list = JSON.stringify([...opened]);
  saving = saving.then(async () => {
    const next = `${file}.next`;
    await fsp.writeFile(next, list, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(next, file);
  }).catch((e: unknown) => { console.warn(`[hivemind] could not keep the files you opened: ${(e as Error).message}`); });
  return saving;
}

export interface OutsideStat { kind: "file" | "folder"; size: number; path: string }

/** The real path of an absolute path (`~/` read from home), or null when nothing is there. */
async function realPath(asked: unknown): Promise<string | null> {
  if (typeof asked !== "string" || !asked || asked.length > 4096 || asked.includes("\0")) return null;
  const p = asked.startsWith("~/") ? path.join(os.homedir(), asked.slice(2)) : asked;
  if (!path.isAbsolute(p)) return null;
  return fsp.realpath(p).catch(() => null);
}

/** A file or a folder at `asked`, its size and its real path; null for nothing, or a device or a pipe. */
export async function outsideStat(asked: unknown): Promise<OutsideStat | null> {
  const real = await realPath(asked);
  const st = real ? await fsp.stat(real).catch(() => null) : null;
  if (!real || !st || !(st.isFile() || st.isDirectory())) return null;
  return { kind: st.isDirectory() ? "folder" : "file", size: st.isDirectory() ? 0 : st.size, path: real };
}

/** The person's click opens what is at `asked`: kept, so it can be read, saved and handed on. */
export async function personOpens(asked: unknown): Promise<OutsideStat | null> {
  const at = await outsideStat(asked);
  if (!at) return null;
  await loaded;
  remember(at.path);
  await save();
  return at;
}

/** The real path of one the person opened. */
async function openedPath(asked: unknown): Promise<string> {
  const real = await realPath(asked);
  if (!real) throw new Error(`nothing at ${String(asked)}`);
  await loaded;
  if (!opened.has(real)) throw new Error(`not opened by you: click ${real} in a terminal to open it`);
  return real;
}

/** Up to `most` bytes of a regular file: opened without waiting, then checked on the open file, so
 *  a pipe or a device is refused unread. */
async function bytesOf(real: string, most: number, tooBig: (size: number) => Error): Promise<Buffer> {
  const file = await fsp.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = await file.stat();
    if (!st.isFile()) throw new Error(`not a file: ${real}`);
    if (st.size > most) throw tooBig(st.size);
    const bytes = Buffer.alloc(st.size);
    const { bytesRead } = await file.read(bytes, 0, st.size, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** A picture's bytes as base64, at most `FILE_BYTES_MAX`; its real path must name a picture. */
export async function outsidePicture(asked: unknown): Promise<{ base64: string; size: number }> {
  const real = await openedPath(asked);
  if (!IMAGE_EXT.has(path.extname(real).toLowerCase())) throw new Error(`not a picture: ${real}`);
  const bytes = await bytesOf(real, FILE_BYTES_MAX, (size) => new Error(`${real} is ${size} bytes; at most ${FILE_BYTES_MAX} are read`));
  return { base64: bytes.toString("base64"), size: bytes.length };
}

export type OutsideText = { text: string } | { error: string; code?: "UNSUPPORTED" | "FILE_TOO_BIG" };

/** A text file as the Code tile reads one: a binary file or one over `LARGEST_TEXT_FILE` is refused. */
export async function outsideTextRead(asked: unknown): Promise<OutsideText> {
  try {
    const bytes = await bytesOf(await openedPath(asked), LARGEST_TEXT_FILE, (size) => Object.assign(new Error(`This file is too large to edit, ${(size / 1024 / 1024).toFixed(1)} MB`), { code: "FILE_TOO_BIG" }));
    if (bytes.subarray(0, 8192).includes(0)) return { error: "This file is binary", code: "UNSUPPORTED" };
    return { text: bytes.toString("utf8") };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { error: (e as Error).message, ...(code === "FILE_TOO_BIG" ? { code } : {}) };
  }
}

/** Save a text file the person opened, over what is there: only a regular file. */
export async function outsideTextWrite(asked: unknown, contents: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof contents !== "string") return { ok: false, error: "no text" };
  try {
    const real = await openedPath(asked);
    await bytesOf(real, LARGEST_TEXT_FILE, () => new Error(`${real} is too large to save over`));
    await fsp.writeFile(real, contents, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Hand a folder, or a file of a kind that is viewed and never run, to the system's app. */
export async function openOutside(asked: unknown, openPath: (real: string) => Promise<string>): Promise<{ ok: boolean; error?: string }> {
  const at = await outsideStat(asked);
  if (!at) return { ok: false, error: `nothing at ${String(asked)}` };
  await loaded;
  if (!opened.has(at.path)) return { ok: false, error: `not opened by you: ${at.path}` };
  if (at.kind === "file" && !OPENABLE_EXT.has(path.extname(at.path).toLowerCase())) return { ok: false, error: `outside the workspace: ${at.path}` };
  const error = await openPath(at.path);
  return error ? { ok: false, error } : { ok: true };
}
