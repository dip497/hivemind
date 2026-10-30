/** Remote filesystem over the system ssh. Paths are as a machine's uri carries them: POSIX, and a
 *  Windows machine's `C:\work` as `/C:/work`, where PowerShell does the work. */
import { powershellCommand, psq, shScript } from "@hivemind/core";
import { folderInUri, windowsFolder } from "@hivemind/core/remote-uri";
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

/** A PowerShell script with `vars` set first, each one word; what it prints is UTF-8. */
const ps = (body: string, vars: Record<string, string> = {}): string => powershellCommand([
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$ErrorActionPreference = 'Stop'",
  ...Object.entries(vars).map(([k, v]) => `$${k} = ${psq(v)}`),
  body,
].join("\n"));

/** A Windows folder as PowerShell takes it: `/C:/work` as `C:\work`. */
const onWindows = (p: string): string => windowsFolder(p) ?? p;

const WIN_LIST = `if ($d -eq '/') { foreach ($v in Get-PSDrive -PSProvider FileSystem) { [Console]::Out.Write('d/' + $v.Name + ':' + [char]0) }; exit 0 }
foreach ($e in Get-ChildItem -Force -LiteralPath $d) {
  $t = if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'l' } elseif ($e.PSIsContainer) { 'd' } else { 'f' }
  [Console]::Out.Write($t + '/' + $e.Name + [char]0)
}`;

const WIN_READ = `$f = Get-Item -LiteralPath $p
if ($f.Length -gt ${MAX_EDIT_BYTES}) { [Console]::Error.Write("remote file too large to open ($($f.Length) bytes): $p"); exit 1 }
$b = [IO.File]::ReadAllBytes($f.FullName); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush()`;

/** Truncated in place, as on POSIX, so the file keeps what is set on it; made when it is not there. */
const WIN_WRITE = `$i = [Console]::OpenStandardInput(); $f = [IO.File]::Open($p, [IO.FileMode]::Create); $i.CopyTo($f); $f.Close()`;

const WIN_KEEP = `$d = Join-Path $HOME '.hivemind/photos'
if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -Recurse -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-[int]$days) } | Remove-Item -Force }
$t = if ($under) { Join-Path $d $under } else { $d }
New-Item -ItemType Directory -Force -Path $t | Out-Null
$p = Join-Path $t $name; $i = [Console]::OpenStandardInput(); $f = [IO.File]::Create($p); $i.CopyTo($f); $f.Close()
[Console]::Out.Write($p)`;

export class RemoteFs {
  constructor(private readonly run: RunRemote, private readonly windows = false) {}

  private async ok(cmd: string, input?: string | Buffer): Promise<Buffer> {
    const r = await this.run(cmd, input);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `remote command exited ${r.code}`);
    return r.stdout;
  }

  /** The folder picker's default start dir. */
  async home(): Promise<string> {
    if (this.windows) return folderInUri((await this.ok(ps("[Console]::Out.Write($HOME)"))).toString("utf8"));
    return (await this.ok(shScript('printf %s "$HOME"'))).toString("utf8");
  }

  async realpath(p: string): Promise<string> {
    if (this.windows) return folderInUri((await this.ok(ps("[Console]::Out.Write((Resolve-Path -LiteralPath $p).ProviderPath)", { p: onWindows(p) }))).toString("utf8").trim());
    return (await this.ok(shScript('cd "$1" && pwd -P', p))).toString("utf8").trim();
  }

  async readdir(dir: string): Promise<RemoteDirEntry[]> {
    // `/` cannot occur in a file name, so it separates type from name; NUL ends a record.
    const listed = this.windows ? ps(WIN_LIST, { d: dir === "/" ? "/" : onWindows(dir) }) : shScript(LIST, dir);
    return (await this.ok(listed)).toString("utf8").split("\0").filter(Boolean)
      .map((rec) => {
        const t = rec.slice(0, rec.indexOf("/"));
        return { name: rec.slice(t.length + 1), isDir: t === "d", isSymlink: t === "l" };
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  async readFile(path: string): Promise<string> {
    return (await this.ok(this.windows ? ps(WIN_READ, { p: onWindows(path) }) : shScript(READ, path))).toString("utf8");
  }

  /** Which of the commands `bins` are found by the login shell its sessions run in (ssh.ts). */
  async found(bins: string[]): Promise<string[]> {
    const asked = this.windows
      ? ps(`foreach ($b in @(${bins.map(psq).join(", ")})) { if (Get-Command $b -ErrorAction SilentlyContinue) { [Console]::Out.Write("HIVEFOUND $b\n") } }`)
      : shScript(`bash -lc 'for b; do command -v "$b" >/dev/null 2>&1 && printf "HIVEFOUND %s\\n" "$b"; done' bash "$@"`, ...bins);
    const out = (await this.ok(asked)).toString("utf8");
    return out.split("\n").flatMap((l) => (l.startsWith("HIVEFOUND ") ? [l.slice(10)] : []));
  }

  /** Keep `data` as `name` in its person's photos folder, in its folder `under` when given: where
   *  it is. Photos kept there more than PHOTOS_KEPT_DAYS ago go first. */
  async keep(name: string, data: Buffer, under = ""): Promise<string> {
    if (this.windows) return (await this.ok(ps(WIN_KEEP, { name, under, days: String(PHOTOS_KEPT_DAYS - 1) }), data)).toString("utf8");
    const script = 'd="$HOME/.hivemind/photos"; find "$d" -type f -mtime +$3 -delete 2>/dev/null; find "$d" -mindepth 1 -type d -empty -delete 2>/dev/null; '
      + 't="$d${2:+/$2}" && mkdir -p -m 700 "$t" && (umask 077 && cat > "$t/$1") && printf %s "$t/$1"';
    return (await this.ok(shScript(script, name, under, String(PHOTOS_KEPT_DAYS - 1)), data)).toString("utf8");
  }

  /** Truncates in place (not replace-by-rename) so the file keeps its mode and owner. */
  async writeFile(path: string, data: string): Promise<void> {
    await this.ok(this.windows ? ps(WIN_WRITE, { p: onWindows(path) }) : shScript('cat > "$1"', path), data);
  }
}
