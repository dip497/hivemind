/**
 * Files in a workspace's repo (the workspace API's `file.*`): a local repo's on this machine's
 * disk, a remote one's (machine:// or ssh://) over its connection. A file outside the repo is refused.
 */
import fsp from "node:fs/promises";
import { text, written } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { isRemote } from "@hivemind/core/remote-uri";
import { readRemoteFile, writeRemoteFile } from "./remote/git.js";
import { fileIn, remoteRel, resolveInRepo } from "./repo-paths.js";

export const files: Domain<"file.read" | "file.write"> = {
  answers: {
    "file.read": (_, repo, file) => {
      const r = text(repo, "repo");
      const f = text(file, "file");
      return isRemote(r) ? readRemoteFile(r, remoteRel(f)) : fsp.readFile(resolveInRepo(r, f), "utf8");
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
