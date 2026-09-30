/**
 * A workspace's layouts, held by a client that reaches its host over a stream (R8): what it opened
 * is kept here, so every read answers at once and a window never waits on a network to draw. A
 * write changes what is held at once and goes to the host in the order it was made, with the
 * layout it was made from, so the host writes only what changed. Another writer's change
 * (`store.changed`) is read again after this client's writes have landed, so what is held has
 * both, and only then is it told on; a reading that one of this client's writes overtook is read
 * again after it, never held over it. Over a stream an undo cannot answer at once: it answers
 * false, and what it took back arrives as a change. (M1 makes this a Loro replica, R3.)
 *
 * A read of a workspace not opened answers nothing and opens it; its layouts then arrive as a
 * change. Node-free.
 */
import type { WorkspaceClient } from "./client.js";
import type { StoreSnapshot } from "./methods.js";
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";

type Change = Pick<WorkspaceChange, "repo" | "part">;
type Part = Change["part"];

const copy = <T>(value: T): T => (value === null || value === undefined ? value : structuredClone(value));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class StoreReplica {
  private readonly held = new Map<string, StoreSnapshot>();
  /** Repos being opened: settles once each is held, or could not be. */
  private readonly opening = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(change: Change) => void>();
  /** What goes to the host (writes, and the reads that must come after them), in order. */
  private queue: Promise<void> = Promise.resolve();
  /** How many writes this client has made, per repo and per part of it. */
  private readonly made = new Map<string, number>();

  constructor(private readonly client: WorkspaceClient, private readonly onError: (message: string) => void = (m) => console.warn(`[store] ${m}`)) {
    client.on("store.changed", (change) => this.readAgain(change));
  }

  /** Hold `repo`'s layouts from now on; settles once they are held, or could not be. */
  open(repo: string): Promise<void> {
    if (this.held.has(repo)) return Promise.resolve();
    let opening = this.opening.get(repo);
    if (!opening) {
      opening = new Promise<void>((settle) => {
        const load = (): void => {
          void this.enqueue(async () => {
            if (await this.fetch(repo, () => this.client.call("store.open", repo), (snapshot) => this.held.set(repo, snapshot), load)) settle();
          });
        };
        load();
      }).finally(() => this.opening.delete(repo));
      this.opening.set(repo, opening);
    }
    return opening;
  }

  core(repo: string): CoreLayout | null {
    return copy(this.snapshot(repo)?.core ?? null);
  }

  view(repo: string, viewId: string): ViewLayout | null {
    return copy(this.snapshot(repo)?.views[viewId] ?? null);
  }

  objects(repo: string): BoardObject[] {
    return copy(this.snapshot(repo)?.objects ?? []);
  }

  setCore(repo: string, core: unknown, base?: unknown): void {
    const held = this.held.get(repo);
    if (held) held.core = copy(core) as CoreLayout;
    this.write(repo, "core", () => this.client.call("store.setCore", repo, core, base));
  }

  setView(repo: string, viewId: string, layout: ViewLayout, base?: ViewLayout | null): void {
    const held = this.held.get(repo);
    if (held) held.views[viewId] = copy(layout);
    this.write(repo, `view:${viewId}`, () => this.client.call("store.setView", repo, viewId, layout, base));
  }

  setObjects(repo: string, objects: BoardObject[], base?: BoardObject[] | null): void {
    const held = this.held.get(repo);
    if (held) held.objects = copy(objects);
    this.write(repo, "board", () => this.client.call("store.setObjects", repo, objects, base));
  }

  /** What this client kept before the store: the host keeps what it lacks, and says so. */
  import(repo: string, legacy: LegacyLayout): void {
    void this.enqueue(() => this.client.call("store.import", repo, legacy).then(() => undefined));
  }

  undo(repo: string): false {
    void this.enqueue(async () => { if (await this.client.call("store.undo", repo)) this.readAgain({ repo, part: "board" }); });
    return false;
  }

  redo(repo: string): false {
    void this.enqueue(async () => { if (await this.client.call("store.redo", repo)) this.readAgain({ repo, part: "board" }); });
    return false;
  }

  /** Another writer changed a workspace this client holds; the function returned stops. */
  onChange(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private snapshot(repo: string): StoreSnapshot | undefined {
    const held = this.held.get(repo);
    if (!held && !this.opening.has(repo)) {
      void this.open(repo).then(() => {
        const opened = this.held.get(repo);
        if (!opened) return;
        for (const part of ["core", "board", ...Object.keys(opened.views).map((id) => `view:${id}` as const)] as Part[]) this.tell({ repo, part });
      });
    }
    return held;
  }

  private write(repo: string, part: Part, send: () => Promise<unknown>): void {
    for (const key of [repo, `${repo}\0${part}`]) this.made.set(key, (this.made.get(key) ?? 0) + 1);
    void this.enqueue(() => send().then(() => undefined));
  }

  /** Read `change`'s part again after what is queued now, then tell of it. */
  private readAgain(change: Change): void {
    void this.enqueue(async () => {
      if (!this.held.has(change.repo)) return;
      const read = (): Promise<unknown> => {
        if (change.part === "core") return this.client.call("store.core", change.repo);
        if (change.part === "board") return this.client.call("store.objects", change.repo);
        return this.client.call("store.view", change.repo, change.part.slice("view:".length));
      };
      const hold = (value: unknown) => {
        const held = this.held.get(change.repo)!;
        if (change.part === "core") held.core = value as CoreLayout | null;
        else if (change.part === "board") held.objects = value as BoardObject[];
        else if (value) held.views[change.part.slice("view:".length)] = value as ViewLayout;
        else delete held.views[change.part.slice("view:".length)];
        this.tell(change);
      };
      await this.fetch(`${change.repo}\0${change.part}`, read, hold, () => this.readAgain(change));
    });
  }

  /** Read with `read` and hold what it answers with `hold`, unless one of this client's writes to
   *  `key` was made meanwhile: that reading may lack it, so `again` reads after it instead (and
   *  this answers false). A reading that fails is reported, and neither held nor read again. */
  private async fetch<T>(key: string, read: () => Promise<T>, hold: (value: T) => void, again: () => void): Promise<boolean> {
    const before = this.made.get(key) ?? 0;
    let value: T;
    try {
      value = await read();
    } catch (e) {
      this.onError(messageOf(e));
      return true;
    }
    if ((this.made.get(key) ?? 0) !== before) {
      again();
      return false;
    }
    hold(value);
    return true;
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(run).catch((e: unknown) => this.onError(messageOf(e)));
    return this.queue;
  }

  private tell(change: Change): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch (e) { console.error("[store] a listener failed:", e); }
    }
  }
}
