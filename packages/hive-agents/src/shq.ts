/** POSIX single-quote a value for safe interpolation into a shell command. Hook
 *  command strings are run by the user's shell, and a tile id derives from a
 *  renderer-controlled value — an unescaped `'` would break out of the quoting
 *  and inject arbitrary commands. Wrapping in single quotes and rewriting any
 *  inner `'` as `'\''` makes ANY string safe (incl. app-owned paths). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
