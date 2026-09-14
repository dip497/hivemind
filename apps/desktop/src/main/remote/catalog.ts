/** The machines.json the app shares with `hive machine`: one writer at a time, and never over a file it could not read. */
import { machinesPath, readMachines, writeMachines, type Machine } from "@hivemind/core";

export class Catalog {
  list: Machine[] = [];
  /** Why the file on disk could not be read; edits are refused until it can. */
  error: string | undefined;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = machinesPath(), private readonly onChange: () => void = () => {}) {}

  async reload(): Promise<void> {
    try {
      this.list = await readMachines(this.file);
      this.error = undefined;
    } catch (e) {
      // Keep the last good list for display and live connections; the next edit on disk retries.
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.onChange();
  }

  /** Applies `fn` to the list as it stands once earlier edits have landed; returning the same array writes nothing. */
  mutate(fn: (list: Machine[]) => Machine[]): Promise<void> {
    const next = this.writing.then(async () => {
      // Re-read first: `hive machine` may have edited the file since, and a file that was broken may be fixed.
      await this.reload();
      if (this.error) throw new Error(`machines.json could not be read (${this.error}); fix or remove it first — nothing was changed`);
      const list = fn(this.list);
      if (list === this.list) return;
      await writeMachines(list, this.file);
      this.list = list;
      this.onChange();
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
