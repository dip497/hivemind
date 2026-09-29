/**
 * An ordered set of ids in a Loro movable list: the tiles' order, a checklist's items. A write
 * moves an id that is already there instead of removing and re-adding it, so two writers
 * reordering different ids both keep their move.
 */
import type { LoroMovableList } from "loro-crdt";

/** Make `order` hold exactly `ids`, in that order. */
export function writeOrder(order: LoroMovableList, ids: string[]): void {
  const current = order.toArray() as unknown[];
  ids.forEach((id, index) => {
    if (current[index] === id) return;
    const from = current.indexOf(id, index + 1);
    if (from >= 0) {
      order.move(from, index);
      current.splice(index, 0, ...current.splice(from, 1));
    } else {
      order.insert(index, id);
      current.splice(index, 0, id);
    }
  });
  if (current.length > ids.length) order.delete(ids.length, current.length - ids.length);
}

/**
 * `ids` in the order `listed` (the list's values) has them, each once. An id a merge left out of
 * the list (or listed twice) still reads back once; one the list lacks goes last, in id order.
 */
export function readOrder(listed: readonly unknown[], ids: string[]): string[] {
  const wanted = new Set(ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of listed) {
    if (typeof id === "string" && wanted.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); }
  }
  for (const id of [...wanted].sort()) if (!seen.has(id)) ordered.push(id);
  return ordered;
}
