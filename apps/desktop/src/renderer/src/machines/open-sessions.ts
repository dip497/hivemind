/** Daemon session ids of the terminals mounted on the canvas, so the session picker offers only the others. */
const open = new Map<string, number>();

export function trackOpenSession(id: string): () => void {
  open.set(id, (open.get(id) ?? 0) + 1);
  return () => {
    const n = (open.get(id) ?? 1) - 1;
    if (n > 0) open.set(id, n); else open.delete(id);
  };
}

export function openSessionIds(): ReadonlySet<string> {
  return new Set(open.keys());
}
