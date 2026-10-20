/**
 * Every migration this build knows, in the order they run. A new one goes last, with the next
 * number. One is deleted, with its test and fixture, once it is six months old and every build
 * that can still update has run it.
 */
import type { Migration } from "./runner.js";

export const MIGRATIONS: readonly Migration[] = [];

/** The list is the order, so it is checked at start: a number used twice, or out of order, stops
 *  the build that has it before it touches any data. */
for (const [i, m] of MIGRATIONS.entries()) {
  if (!/^\d{4}-[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id)) throw new Error(`migration id ${m.id} is not NNNN-what-it-does`);
  const before = MIGRATIONS[i - 1];
  if (before && before.id.slice(0, 4) >= m.id.slice(0, 4)) throw new Error(`migration ${m.id} comes after ${before.id} in the list but its number is not higher`);
}
