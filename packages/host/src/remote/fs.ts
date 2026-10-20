/** Remote filesystem over the system ssh; remote paths are always POSIX. */
import { shScript } from "@hivemind/core";
import { PHOTOS_KEPT_DAYS } from "../start-places.js";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}
export type RunRemote = (cmd: string, input?: string | Buffer) => Promise<ExecResult>;

export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

/** Refuse to slurp very large files into the editor. */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

// A symlink is reported as a link, not a dir: the tree walk must not follow cycles.
const LIST = `cd "$1" || exit 1
for f in .* *; do
  case "$f" in .|..) continue ;; esac
  if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; elif [ -e "$f" ]; then t=f; else continue; fi
  printf '%s/%s\\000' "$t" "$f"
done`;

const READ = `n=$(wc -c < "$1" | tr -d ' ') || exit 1
if [ "$n" -gt ${MAX_EDIT_BYTES} ]; then echo "remote file too large to open ($n bytes): $1" >&2; exit 1; fi
cat "$1"`;

export class RemoteFs {
  constructor(private readonly run: RunRemote) {}

  private async ok(cmd: string, input?: string | Buffer): Promise<Buffer> {
    const r = await this.run(cmd, input);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `remote command exited ${r.code}`);
    return r.stdout;
  }

  /** The folder picker's default start dir. */
  async home(): Promise<string> {
    return (await this.ok(shScript('printf %s "$HOME"'))).toString("utf8");
  }

  async realpath(p: string): Promise<string> {
    return (await this.ok(shScript('cd "$1" && pwd -P', p))).toString("utf8").trim();
  }

  async readdir(dir: string): Promise<RemoteDirEntry[]> {
    // `/` cannot occur in a file name, so it separates type from name; NUL ends a record.
    return (await this.ok(shScript(LIST, dir))).toString("utf8").split("\0").filter(Boolean)
      .map((rec) => {
        const t = rec.slice(0, rec.indexOf("/"));
        return { name: rec.slice(t.length + 1), isDir: t === "d", isSymlink: t === "l" };
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  async readFile(path: string): Promise<string> {
    return (await this.ok(shScript(READ, path))).toString("utf8");
  }

  /** Which of the commands `bins` are found by the login shell its sessions run in (ssh.ts). */
  async found(bins: string[]): Promise<string[]> {
    const out = (await this.ok(shScript(`bash -lc 'for b; do command -v "$b" >/dev/null 2>&1 && printf "HIVEFOUND %s\\n" "$b"; done' bash "$@"`, ...bins))).toString("utf8");
    return out.split("\n").flatMap((l) => (l.startsWith("HIVEFOUND ") ? [l.slice(10)] : []));
  }

  /** Keep `data` as `name` in its person's photos folder, in its folder `under` when given: where
   *  it is. Photos kept there more than PHOTOS_KEPT_DAYS ago go first. */
  async keep(name: string, data: Buffer, under = ""): Promise<string> {
    const script = 'd="$HOME/.hivemind/photos"; find "$d" -type f -mtime +$3 -delete 2>/dev/null; find "$d" -mindepth 1 -type d -empty -delete 2>/dev/null; '
      + 't="$d${2:+/$2}" && mkdir -p -m 700 "$t" && (umask 077 && cat > "$t/$1") && printf %s "$t/$1"';
    return (await this.ok(shScript(script, name, under, String(PHOTOS_KEPT_DAYS - 1)), data)).toString("utf8");
  }

  /** Truncates in place (not replace-by-rename) so the file keeps its mode and owner. */
  async writeFile(path: string, data: string): Promise<void> {
    await this.ok(shScript('cat > "$1"', path), data);
  }
}
