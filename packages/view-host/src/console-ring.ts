/**
 * The last console lines of each plugin tile, kept in the window and read only when asked
 * (`hive ctl tile look`): never sent to an agent unasked.
 */
import { CONSOLE_LINES, type ConsoleLine } from "@hivemind/workspace-api/plugins";

/** A line longer than this is cut, so one huge log cannot hold the ring's memory. */
export const CONSOLE_LINE_CHARS = 2_000;

export class ConsoleRings {
  private readonly rings = new Map<string, ConsoleLine[]>();

  push(instance: string, level: ConsoleLine["level"], text: string, at = Date.now()): void {
    let ring = this.rings.get(instance);
    if (!ring) this.rings.set(instance, (ring = []));
    ring.push({ level, text: text.length > CONSOLE_LINE_CHARS ? `${text.slice(0, CONSOLE_LINE_CHARS)}…` : text, at });
    if (ring.length > CONSOLE_LINES) ring.splice(0, ring.length - CONSOLE_LINES);
  }

  /** Its lines, oldest first. */
  read(instance: string): ConsoleLine[] {
    return [...(this.rings.get(instance) ?? [])];
  }

  forget(instance: string): void {
    this.rings.delete(instance);
  }
}
