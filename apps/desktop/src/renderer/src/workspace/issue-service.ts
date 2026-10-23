/**
 * The issues of the workspace a plugin shows (protocol 1.9), from the app's own issue calls: the
 * list now and whenever one of them is written (`issue.changed`, an agent's `hive update` included;
 * nothing else under `.hivemind`, a sync's bookkeeping among it, reads them again), and each
 * issue method. What reaches a plugin never says where the workspace is on disk, and it writes
 * only to this workspace.
 */
import type { IssueCall, ViewIssue, ViewIssueSummary } from "@hivemind/view-sdk/protocol";
import type { LinkServices } from "@hivemind/view-host/link";
import type { Issue, IssueSummary } from "@hivemind/core/types";

const summary = ({ path: _, ...rest }: IssueSummary): ViewIssueSummary => rest;
const full = ({ path: _, raw: __, ...rest }: Issue): ViewIssue => rest;

/** The prefix a folder's issue ids would start with: its name, letters and digits, upper case. */
export function suggestedPrefix(folder: string | null): string {
  const p = (folder ?? "").split(/[\\/]/).filter(Boolean).pop()?.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) ?? "";
  return p.length >= 2 ? p : "HIVE";
}

/** The issues service for the workspace whose `.hivemind` is `root()`, as asked each time. Only
 *  `read` reaches another of the host's workspaces (a link's other end), found by the id's prefix.
 *  A workspace that keeps no issues yet is set up by the plugin (`setUp`) in `folder()`; the app
 *  hears of it by `hivemind:issues-set-up`. */
export function issueService(root: () => string | null, folder: () => string | null): NonNullable<LinkServices["issues"]> {
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };
  // Set up here before the app re-reads the workspace: this service already knows where.
  let made: string | null = null;
  const current = () => root() ?? made;
  const need = (): string => {
    const r = current();
    if (!r) throw Object.assign(new Error("this workspace keeps no issues yet: `setUp` starts them"), { code: "BAD_REQUEST" });
    return r;
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v) throw Object.assign(new Error(`${what} is required`), { code: "BAD_REQUEST" });
    return v;
  };
  const status = () => {
    const dir = folder();
    return { ready: !!current(), folder: dir ? dir.split(/[\\/]/).filter(Boolean).pop() ?? null : null, suggested: suggestedPrefix(dir) };
  };
  return {
    subscribe(cb) {
      let live = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watched: string | null = null;
      let off = () => {};
      const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 200); };
      // Read again on each change, and watch whatever root is current: one set up later included.
      const load = () => {
        const r = current();
        if (r !== watched) {
          off();
          watched = r;
          off = r ? window.hive.onIssueChanged(r, soon) : () => {};
        }
        if (!r) { cb([]); return; }
        void window.hive.listIssues(r).then((list) => { if (live) cb(list.map(summary)); }, () => { if (live) cb([]); });
      };
      load();
      listeners.add(load);
      return () => { live = false; if (timer) clearTimeout(timer); listeners.delete(load); off(); };
    },
    async call(call: IssueCall, args: unknown[]) {
      const [a, b, c] = args;
      if (call === "status") return status();
      if (call === "setUp") {
        const dir = folder();
        if (!dir) throw Object.assign(new Error("this workspace has no folder on this computer"), { code: "BAD_REQUEST" });
        if (!current()) {
          made = (await window.hive.initWorkspace(dir, str(a, "prefix").trim())).root;
          window.dispatchEvent(new CustomEvent("hivemind:issues-set-up", { detail: { dir, root: made } }));
          changed();
        }
        return status();
      }
      const here = need();
      if (call === "workspaces") {
        return (await window.hive.listWorkspaces()).map((w) => ({ prefix: w.prefix, title: w.title }));
      }
      const r = call === "read" && typeof a === "string" ? (await window.hive.resolveIssueRoot(a).catch(() => ({ root: null }))).root ?? here : here;
      const wrote = <T>(p: Promise<T>) => p.then((v) => { changed(); return v; });
      switch (call) {
        case "read": return full(await window.hive.readIssue(r, str(a, "id")));
        case "create": return full(await wrote(window.hive.createIssue(r, a as Parameters<typeof window.hive.createIssue>[1])));
        case "update": return full(await wrote(window.hive.updateIssue(r, str(a, "id"), b as Parameters<typeof window.hive.updateIssue>[2])));
        case "setState": return full(await wrote(window.hive.updateIssueState(r, str(a, "id"), b as IssueSummary["state"], typeof c === "string" ? c : undefined)));
        case "comment": return full(await wrote(window.hive.commentOnIssue(r, str(a, "id"), str(b, "message"))));
        case "delete": await wrote(window.hive.deleteIssue(r, str(a, "id"))); return null;
        case "link": return wrote(window.hive.linkIssue(r, str(a, "id"), str(b, "other"), c as Parameters<typeof window.hive.linkIssue>[3]));
        case "unlink": return wrote(window.hive.unlinkIssue(r, str(a, "id"), str(b, "other")));
        case "move": return wrote(window.hive.moveIssue(r, str(a, "id"), str(b, "prefix"), c === "copy" ? "copy" : "move"));
      }
    },
  };
}
