/**
 * Remote filesystem over a single cached SFTP session per ssh2 Client. Mirrors
 * the local fs.promises surface the editor uses (readFile/writeFile) plus the
 * readdir the remote folder picker needs. Remote paths are ALWAYS POSIX.
 */
import { promisify } from "node:util";
import type { Client, SFTPWrapper, FileEntry, Stats } from "ssh2";

export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
}

/** Refuse to slurp very large files into the editor (stream them later). */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export class RemoteFs {
  private constructor(private sftp: SFTPWrapper) {}

  static open(conn: Client): Promise<RemoteFs> {
    return new Promise((resolve, reject) =>
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(new RemoteFs(sftp)))),
    );
  }

  /** realpath('.') → the remote $HOME; the folder picker's default start dir. */
  home(): Promise<string> {
    return promisify(this.sftp.realpath.bind(this.sftp))(".");
  }

  realpath(p: string): Promise<string> {
    return promisify(this.sftp.realpath.bind(this.sftp))(p);
  }

  async readdir(dir: string): Promise<RemoteDirEntry[]> {
    const list: FileEntry[] = await promisify(this.sftp.readdir.bind(this.sftp))(dir);
    // FileEntry.attrs is `Attributes` (raw POSIX bits, no isDirectory() helper),
    // so classify from the mode's file-type field.
    const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
    return list
      .filter((e) => e.filename !== "." && e.filename !== "..")
      .map((e) => ({
        name: e.filename,
        isDir: (e.attrs.mode & S_IFMT) === S_IFDIR,
        isSymlink: (e.attrs.mode & S_IFMT) === S_IFLNK,
        size: e.attrs.size,
        mtime: e.attrs.mtime,
      }))
      .sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
      );
  }

  async stat(path: string): Promise<Stats> {
    return promisify(this.sftp.stat.bind(this.sftp))(path);
  }

  /** Read a remote text file, refusing files larger than MAX_EDIT_BYTES. */
  async readFile(path: string): Promise<string> {
    const st = await this.stat(path).catch(() => null);
    if (st && st.size > MAX_EDIT_BYTES) {
      throw new Error(`remote file too large to open (${st.size} bytes): ${path}`);
    }
    const buf = (await promisify(this.sftp.readFile.bind(this.sftp))(path)) as Buffer;
    return buf.toString("utf8");
  }

  writeFile(path: string, data: string): Promise<void> {
    return promisify(this.sftp.writeFile.bind(this.sftp))(path, data);
  }
}
