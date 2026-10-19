// A video seeks by asking for part of the file; without an answer the browser cannot jump in it.

/**
 * The bytes a Range header asks for, as { start, end } (inclusive); null to send the whole file;
 * false when the range lies outside the file. Only a single range is answered.
 */
export function rangeFor(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return false;
  return { start, end };
}
