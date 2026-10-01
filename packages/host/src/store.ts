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
 * that the names are text. A workspace the host may only read (a copy of one shared from
 * elsewhere, as a viewer or after it ended, M1) takes no write: the client is told the part
 * changed, so it reads it again and its own change is put back. Nor does a copy take a change to
 * its layout that this person's role there does not allow (`refuse`): its host would not take it,
 * and the copy would part from the host's.
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import type { LegacyLayout, ViewLayout, WorkspaceChange, WorkspaceStore } from "@hivemind/workspace-host/store";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";

type StoreMethod = Extract<Method, `store.${string}`>;

/** Where a client is: the workspace it shows, and the frame its user is in there. */
export interface Shown { repo: string; frame: string | null }

export interface LayoutsOptions {
  /** Whether a repo's layouts may be written. */
  mayWrite?(repo: string): boolean;
  /** Why a client may not change a repo's core layout from `before` to `after` here, or null. */
  refuse?(repo: string, before: CoreLayout | null, after: CoreLayout): string | null;
  /** A client changed a repo's core layout: from `before`, as the store had it, to `after`, as it
   *  has it now. */
  wrote?(repo: string, before: CoreLayout | null, after: CoreLayout): void;
}

export class Layouts {
  readonly domain: Domain<StoreMethod, "store.shown">;
  private readonly writers = new WeakMap<Connection, string>();
  /** The stores each client has written to: its history goes from each when it goes. */
  private readonly wroteTo = new WeakMap<Connection, Set<WorkspaceStore>>();
  private readonly shown = new Map<Connection, Shown>();
  private writersMade = 0;

  /** `store`: the store that holds a repo's layout (the host's own, or its replicas of others'
   *  workspaces, M1), made when it is first needed. */
  constructor(store: (repo: string) => WorkspaceStore, o: LayoutsOptions = {}) {
    const { mayWrite = () => true, refuse = () => null, wrote = () => {} } = o;
    const repoOf = (v: unknown) => text(v, "repo");
    /** Tell `from` that `part` of `repo` changed: it reads it again, and its own change is put back. */
    const putBack = (from: Connection, repo: string, part: string): false => {
      setTimeout(() => from.send({ event: "store.changed", params: [{ repo, part }] }), 0);
      return false;
    };
    /** Whether `from` may write `part` of `repo`; when not, it is told the part changed. */
    const writable = (from: Connection, repo: string, part: string): boolean => mayWrite(repo) || putBack(from, repo, part);
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
        "store.setCore": (from, repo, core, base) => {
          const r = repoOf(repo);
          if (!writable(from, r, "core")) return;
          const s = writing(from, r);
          const prior = s.getCore(r);
          // What the client changed: from the layout it read, else the one here.
          if (refuse(r, (base ?? prior) as CoreLayout | null, core as CoreLayout)) return void putBack(from, r, "core");
          refused(() => s.setCore(r, core, { ...as(from), base }));
          // What this write made of the store, not what the client says it read: one that read an
          // older layout still brings nothing in that another writer put there meanwhile.
          wrote(r, prior, s.getCore(r)!);
        },
        "store.setView": (from, repo, viewId, layout, base) => {
          const r = repoOf(repo);
          const id = text(viewId, "viewId");
          if (writable(from, r, `view:${id}`)) refused(() => writing(from, r).setView(r, id, layout as ViewLayout, { ...as(from), base }));
        },
        "store.setObjects": (from, repo, objects, base) => {
          const r = repoOf(repo);
          if (writable(from, r, "board")) refused(() => writing(from, r).setObjects(r, objects, { ...as(from), base }));
        },
        "store.import": (_, repo, legacy) => { const r = repoOf(repo); if (mayWrite(r)) refused(() => store(r).importLegacy(r, legacy as LegacyLayout)); },
        "store.undo": (from, repo) => { const r = repoOf(repo); return mayWrite(r) && writing(from, r).undo(r, as(from)); },
        "store.redo": (from, repo) => { const r = repoOf(repo); return mayWrite(r) && writing(from, r).redo(r, as(from)); },
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
