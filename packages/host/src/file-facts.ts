/**
 * What a path in a local repo is before it is opened (`file.stat`), and a picture's bytes for the
 * Image tile (`file.bytes`). Confined to the repo, symlinks included, as `file.read` is.
 */
import fsp from "node:fs/promises";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { FILE_BYTES_MAX } from "@hivemind/workspace-api/opener";
import { isRemote } from "@hivemind/core/remote-uri";
import { resolveRealInRepo } from "./repo-paths.js";

const localRepo = (repo: unknown): string => {
  const r = text(repo, "repo");
  if (isRemote(r)) throw new ApiError("UNSUPPORTED", "a file on another machine: open it there");
  return r;
};

export const fileFacts: Domain<"file.stat" | "file.bytes"> = {
  answers: {
    "file.stat": async (_, repo, file) => {
      const st = await fsp.stat(await resolveRealInRepo(localRepo(repo), text(file, "file"))).catch(() => null);
      if (!st || !(st.isFile() || st.isDirectory())) return null;
      return { kind: st.isDirectory() ? "folder" : "file", size: st.isDirectory() ? 0 : st.size };
    },
    "file.bytes": async (_, repo, file) => {
      const at = await resolveRealInRepo(localRepo(repo), text(file, "file"));
      const st = await fsp.stat(at).catch(() => null);
      if (!st?.isFile()) throw new ApiError("NOT_FOUND", `no file ${String(file)}`);
      if (st.size > FILE_BYTES_MAX) throw new ApiError("FILE_TOO_BIG", `${String(file)} is ${st.size} bytes; at most ${FILE_BYTES_MAX} are read`);
      return { base64: (await fsp.readFile(at)).toString("base64"), size: st.size };
    },
  },
  effects: {},
};
