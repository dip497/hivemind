/**
 * The issues of the workspace a plugin shows (protocol 1.9), from the app's own issue calls: the
 * list now and whenever its `.hivemind` changes (an agent's `hive update` included), and each
 * issue method. What reaches a plugin never says where the workspace is on disk, and it writes
 * only to this workspace.
 */
import type { IssueCall, ViewIssue, ViewIssueSummary } from "@hivemind/view-sdk/protocol";
import type { LinkServices } from "@hivemind/view-host/link";
import type { Issue, IssueSummary } from "@hivemind/core/types";

const summary = ({ path: _, ...rest }: IssueSummary): ViewIssueSummary => rest;
const full = ({ path: _, raw: __, ...rest }: Issue): ViewIssue => rest;
const parent = (dir: string) => dir.slice(0, Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"))) || dir;

/** The issues service for the workspace whose `.hivemind` is `root()`, as asked each time. Only
 *  `read` reaches another of the host's workspaces (a link's other end), found by the id's prefix. */
export function issueService(root: () => string | null): NonNullable<LinkServices["issues"]> {
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };
  const need = (): string => {
    const r = root();
    if (!r) throw Object.assign(new Error("this workspace has no issues: `hive init` sets them up"), { code: "BAD_REQUEST" });
    return r;
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v) throw Object.assign(new Error(`${what} is required`), { code: "BAD_REQUEST" });
    return v;
  };
  return {
    subscribe(cb) {
      const r = root();
      if (!r) { cb([]); return () => {}; }
      let live = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const load = () => { void window.hive.listIssues(r).then((list) => { if (live) cb(list.map(summary)); }, () => { if (live) cb([]); }); };
      const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 200); };
      load();
      listeners.add(load);
      const off = window.hive.onFsChanged(parent(r), ({ paths }) => { if (paths.some((p) => p.startsWith(r))) soon(); });
      return () => { live = false; if (timer) clearTimeout(timer); listeners.delete(load); off(); };
    },
    async call(call: IssueCall, args: unknown[]) {
      const here = need();
      const [a, b, c] = args;
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
