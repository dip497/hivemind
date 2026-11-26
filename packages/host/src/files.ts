/**
 * Files in a workspace's repo (the workspace API's `file.*`): a local repo's on this machine's
 * disk, a remote one's (machine:// or ssh://) over its connection. A file outside the repo is refused.
 * `file.read` answers text only: a binary file or one over `LARGEST_TEXT_FILE` is refused, so no
 * editor shows it as text and writes that back over it.
 */
import fsp from "node:fs/promises";
import { ApiError, text, written } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { isRemote } from "@hivemind/core/remote-uri";
import { readRemoteFile, writeRemoteFile } from "./remote/git.js";
import { fileIn, remoteRel, resolveInRepo, resolveRealInRepo } from "./repo-paths.js";

/** The largest file read as text. */
export const LARGEST_TEXT_FILE = 5 * 1024 * 1024;
/** A NUL in a file's first 8 KB makes it binary. */
const BINARY_SNIFF_BYTES = 8192;

const tooLarge = (bytes: number) => new ApiError("FILE_TOO_BIG", `This file is too large to edit, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
const binary = () => new ApiError("UNSUPPORTED", "This file is binary");

async function readLocalText(file: string): Promise<string> {
  const { size } = await fsp.stat(file);
  if (size > LARGEST_TEXT_FILE) throw tooLarge(size);
  const bytes = await fsp.readFile(file);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw binary();
  return bytes.toString("utf8");
}

async function readRemoteText(repo: string, file: string): Promise<string> {
  const body = await readRemoteFile(repo, file);
  const size = Buffer.byteLength(body, "utf8");
  if (size > LARGEST_TEXT_FILE) throw tooLarge(size);
  if (body.slice(0, BINARY_SNIFF_BYTES).includes("\0")) throw binary();
  return body;
}

export const files: Domain<"file.read" | "file.write"> = {
  answers: {
    "file.read": async (_, repo, file) => {
      const r = text(repo, "repo");
      const f = text(file, "file");
      return isRemote(r) ? readRemoteText(r, remoteRel(f)) : readLocalText(await resolveRealInRepo(r, f));
    },
    "file.write": (_, repo, file, contents) => {
      const r = text(repo, "repo");
      const f = text(file, "file");
      const body = written(contents, "contents");
      return isRemote(r) ? writeRemoteFile(r, remoteRel(f), body) : fsp.writeFile(resolveInRepo(r, f), body, "utf8");
    },
  },
  effects: {
    "file.write": (repo, file) => ({ target: fileIn(repo, file) }),
  },
};
