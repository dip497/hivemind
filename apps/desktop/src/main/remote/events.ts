/** A machine may only report on its own tiles; a transcript path names a file there, so it is dropped. */
export function acceptRemoteEvent(data: unknown, isOwnTile: (tileId: string) => boolean): unknown | null {
  const d = data as { tileId?: unknown } | null;
  if (!d || typeof d !== "object" || typeof d.tileId !== "string" || !isOwnTile(d.tileId)) return null;
  return "transcriptPath" in d ? { ...d, transcriptPath: null } : d;
}
