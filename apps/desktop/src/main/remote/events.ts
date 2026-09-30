/** A machine may only report on its own tiles. */
export function acceptRemoteEvent(data: unknown, isOwnTile: (tileId: string) => boolean): unknown | null {
  const d = data as { tileId?: unknown } | null;
  if (!d || typeof d !== "object" || typeof d.tileId !== "string" || !isOwnTile(d.tileId)) return null;
  return d;
}
