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
  private readonly shown = new Map<Connection, Shown>();
  private writersMade = 0;

  /** `store`: the host's store, made when it is first needed. */
  constructor(store: () => WorkspaceStore) {
    const repoOf = (v: unknown) => text(v, "repo");
    const as = (from: Connection) => ({ writer: this.writerOf(from) });
    // The store refuses a malformed layout with a TypeError: that is the caller's, not a failure.
    const refused = <R>(run: () => R): R => {
      try { return run(); } catch (e) { throw e instanceof TypeError ? new ApiError("BAD_REQUEST", e.message) : e; }
    };
    this.domain = {
      answers: {
        "store.open": (_, repo) => {
          const r = repoOf(repo);
          return { core: store().getCore(r), views: store().getViews(r), objects: store().getObjects(r) };
        },
        "store.core": (_, repo) => store().getCore(repoOf(repo)),
        "store.view": (_, repo, viewId) => store().getView(repoOf(repo), text(viewId, "viewId")),
        "store.objects": (_, repo) => store().getObjects(repoOf(repo)),
        "store.setCore": (from, repo, core, base) => refused(() => store().setCore(repoOf(repo), core, { ...as(from), base })),
        "store.setView": (from, repo, viewId, layout, base) =>
          refused(() => store().setView(repoOf(repo), text(viewId, "viewId"), layout as ViewLayout, { ...as(from), base })),
        "store.setObjects": (from, repo, objects, base) => refused(() => store().setObjects(repoOf(repo), objects, { ...as(from), base })),
        "store.import": (_, repo, legacy) => refused(() => store().importLegacy(repoOf(repo), legacy as LegacyLayout)),
        "store.undo": (from, repo) => store().undo(repoOf(repo), as(from)),
        "store.redo": (from, repo) => store().redo(repoOf(repo), as(from)),
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
        if (writer) store().forgetWriter(writer);
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
