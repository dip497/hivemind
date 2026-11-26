/**
 * How the Code tile reads and saves a file: one of its folder through the workspace (`file.read`,
 * `file.write`), one outside every workspace by its absolute path through main, which reads and
 * saves only a path the person opened with their own click (`open-thing.ts`).
 */

/** Whether `path` is an absolute path outside `repoPath`. */
export function outsideOf(repoPath: string, path: string): boolean {
  if (!/^(?:[a-z]:)?[\\/]/i.test(path)) return false;
  const base = repoPath.replace(/[\\/]+$/, "");
  return !(path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`));
}

const failed = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

export async function readCodeFile(repoPath: string, path: string): Promise<string> {
  if (!outsideOf(repoPath, path)) return window.hive.fileRead(repoPath, path);
  const read = window.hive.outsideTextRead;
  if (!read) throw failed(`outside the workspace: ${path}`, "UNSUPPORTED");
  const r = await read(path);
  if ("error" in r) throw failed(r.error, r.code);
  return r.text;
}

export async function writeCodeFile(repoPath: string, path: string, contents: string): Promise<void> {
  if (!outsideOf(repoPath, path)) return window.hive.fileWrite(repoPath, path, contents);
  const write = window.hive.outsideTextWrite;
  if (!write) throw failed(`outside the workspace: ${path}`);
  const r = await write(path, contents);
  if (!r.ok) throw failed(r.error ?? "not saved");
}
