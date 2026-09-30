/**
 * The workspace store on a host (the workspace API's `store.*`): each workspace's core layout,
 * its views' layouts and its board, as `WorkspaceStore` keeps them. A client writes as a writer
 * of its own, one per connection, with the layout it made its change from, so the store writes
 * only what that client changed; every other client is told of the change (`store.changed`), the
 * one that made it is not. Undo takes back a client's own board edits. A client says which
 * workspace it shows (`store.shown`), which the control plane asks after. When a client goes, its
 * board history and what it showed go with it. Electron-free: main and the dev-bridge each serve
 * one over their own store.
 *
 * The store checks the layouts it is given (a TypeError refuses one); what is checked here is
 * that the names are text.
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import type { LegacyLayout, ViewLayout, WorkspaceChange, WorkspaceStore } from "@hivemind/workspace-host/store";

type StoreMethod = Extract<Method, `store.${string}`>;

/** Where a client is: the workspace it shows, and the frame its user is in there. */
export interface Shown { repo: string; frame: string | null }

export class Layouts {
  readonly domain: Domain<StoreMethod, "store.shown">;
  private readonly writers = new WeakMap<Connection, string>();
  /** The stores each client has written to: its history goes from each when it goes. */
  private readonly wroteTo = new WeakMap<Connection, Set<WorkspaceStore>>();
  private readonly shown = new Map<Connection, Shown>();
  private writersMade = 0;

  /** `store`: the store that holds a repo's layout (the host's own, or its replicas of others'
   *  workspaces, M1), made when it is first needed. */
  constructor(store: (repo: string) => WorkspaceStore) {
    const repoOf = (v: unknown) => text(v, "repo");
    const as = (from: Connection) => ({ writer: this.writerOf(from) });
    /** The store `from` writes `repo` in, remembered so its history there goes with it. */
    const writing = (from: Connection, repo: string): WorkspaceStore => {
      const s = store(repo);
      let stores = this.wroteTo.get(from);
      if (!stores) this.wroteTo.set(from, (stores = new Set()));
      stores.add(s);
      return s;
    };
    // The store refuses a malformed layout with a TypeError: that is the caller's, not a failure.
    const refused = <R>(run: () => R): R => {
      try { return run(); } catch (e) { throw e instanceof TypeError ? new ApiError("BAD_REQUEST", e.message) : e; }
    };
    this.domain = {
      answers: {
        "store.open": (_, repo) => {
          const r = repoOf(repo);
          const s = store(r);
          return { core: s.getCore(r), views: s.getViews(r), objects: s.getObjects(r) };
        },
        "store.core": (_, repo) => { const r = repoOf(repo); return store(r).getCore(r); },
        "store.view": (_, repo, viewId) => { const r = repoOf(repo); return store(r).getView(r, text(viewId, "viewId")); },
        "store.objects": (_, repo) => { const r = repoOf(repo); return store(r).getObjects(r); },
        "store.setCore": (from, repo, core, base) => { const r = repoOf(repo); return refused(() => writing(from, r).setCore(r, core, { ...as(from), base })); },
        "store.setView": (from, repo, viewId, layout, base) => {
          const r = repoOf(repo);
          return refused(() => writing(from, r).setView(r, text(viewId, "viewId"), layout as ViewLayout, { ...as(from), base }));
        },
        "store.setObjects": (from, repo, objects, base) => { const r = repoOf(repo); return refused(() => writing(from, r).setObjects(r, objects, { ...as(from), base })); },
        "store.import": (_, repo, legacy) => { const r = repoOf(repo); return refused(() => store(r).importLegacy(r, legacy as LegacyLayout)); },
        "store.undo": (from, repo) => { const r = repoOf(repo); return writing(from, r).undo(r, as(from)); },
        "store.redo": (from, repo) => { const r = repoOf(repo); return writing(from, r).redo(r, as(from)); },
      },
      effects: {},
      notices: {
        "store.shown": (from, repo, frame) => {
          if (typeof repo === "string" && repo) this.shown.set(from, { repo, frame: typeof frame === "string" && frame ? frame : null });
          else this.shown.delete(from);
        },
      },
      gone: (connection) => {
        this.shown.delete(connection);
        const writer = this.writers.get(connection);
        if (writer) for (const s of this.wroteTo.get(connection) ?? []) s.forgetWriter(writer);
      },
    };
  }

  /** Whether `connection`'s client is the one that made `change`: it is not told of it. */
  made(connection: Connection, change: WorkspaceChange): boolean {
    return this.writers.get(connection) === change.writer;
  }

  /** Where `connection`'s client is, or null. */
  shownBy(connection: Connection): Shown | null {
    return this.shown.get(connection) ?? null;
  }

  /** Where some client is, when the one asked after shows nothing. */
  anyShown(): Shown | null {
    return this.shown.values().next().value ?? null;
  }

  /** The writer a client writes as: its own, and no other client's. */
  private writerOf(connection: Connection): string {
    let writer = this.writers.get(connection);
    if (!writer) this.writers.set(connection, (writer = `client:${++this.writersMade}`));
    return writer;
  }
}
