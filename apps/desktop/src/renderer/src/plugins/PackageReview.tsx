/**
 * What installing or updating a package does, before it is done: every member, where its code runs
 * and what it asks for, and on an update what changed in each and whether that switches the
 * package off. The facts are the install's own dry run (`hive plugins install --dry-run`); this
 * only says them.
 */
import { useState } from "react";
import { Blocks, Bot, ChevronDown, ChevronRight, LayoutGrid, PanelsTopLeft, Wrench } from "../components/icons";
import { permissionWords } from "@hivemind/view-sdk/protocol";
import type { ReactNode } from "react";
import type { PackageReview as Review } from "../../../shared/ipc";

type Runs = Review["members"][number]["runs"];
type Change = Review["changes"][number];

export const MEMBER_KIND: Record<string, string> = { tool: "Tool", widget: "Widget", view: "View", "agent-preset": "Agent preset" };
export const RUNS_LABEL: Record<Runs, string> = { sandboxed: "Sandboxed", "in the app": "Runs in the app", "as an agent's instructions": "Agent instructions" };

export function MemberIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = kind === "tool" ? Wrench : kind === "widget" ? LayoutGrid : kind === "view" ? PanelsTopLeft : kind === "agent-preset" ? Bot : Blocks;
  return <Icon size={size} />;
}

/** What it may do, in words; a permission this app has no words for is shown by its name. */
export const askedFor = (perms: readonly string[]): string[] => perms.map((p) => permissionWords([p])[0] ?? p);

/** What changed in one member, in a few words. */
export function changeText(c: Pick<Change, "change" | "newPermissions" | "runs">): string {
  if (c.change === "gone") return "Removed";
  if (c.change === "new") return c.newPermissions.length ? `New; may ${askedFor(c.newPermissions).join("; ")}` : "New";
  if (c.newPermissions.length) return `Now may ${askedFor(c.newPermissions).join("; ")}`;
  return c.runs === "sandboxed" ? "Its files changed" : c.runs === "in the app" ? "Its code changed" : "Its instructions changed";
}

/** Why a change switches the package off, or null when it does not. */
export function offBecause(c: Pick<Change, "change" | "newPermissions" | "runs" | "switchesOff">): string | null {
  if (!c.switchesOff) return null;
  if (c.runs === "sandboxed") return "it asks for more";
  return c.runs === "in the app" ? `${c.change === "new" ? "new" : "changed"} code that runs in the app` : "agents follow its instructions";
}

/** The line under the list: whether it is on afterwards, and why not. */
function outcome(r: Review): string {
  if (!r.replaces) {
    if (r.on) return "It arrives on: everything in it is sandboxed.";
    const outside = r.members.filter((m) => m.runs !== "sandboxed").map((m) => m.name);
    return `It arrives off, because ${outside.join(" and ")} ${outside.length > 1 ? "run" : "runs"} outside the sandbox. Switch it on once you trust who wrote it.`;
  }
  if (!r.replaces.on) return "It stays off.";
  if (r.on) return "It stays on.";
  return `${r.name} switches off until you switch it on again.`;
}

function MemberLine({ kind, name, runs, children }: { kind: string; name: string; runs: Runs; children?: ReactNode }) {
  return <li className="package-review-member">
    <span className="plugin-row-mark" aria-hidden="true"><MemberIcon kind={kind} /></span>
    <span className="plugin-row-text">
      <span className="plugin-row-name">{name}</span>
      <span className="plugin-row-detail">{MEMBER_KIND[kind] ?? kind} · {RUNS_LABEL[runs] ?? runs}</span>
      {children}
    </span>
  </li>;
}

export function PackageReview({ review: r, heading }: { review: Review; heading?: boolean }) {
  const update = !!r.replaces;
  const switching = update && r.replaces!.on && !r.on;
  const [all, setAll] = useState(false);
  const members = <ul className="package-review-list" data-package-members>
    {r.members.map((m) => <MemberLine key={`${m.kind}:${m.id}`} kind={m.kind} name={m.name} runs={m.runs}>
      <span className="package-review-asks" data-package-member={`${m.kind}:${m.id}`}>{m.permissions.length ? `May ${askedFor(m.permissions).join("; ")}` : "Asks for nothing more"}</span>
    </MemberLine>)}
  </ul>;
  return <div className="package-review" data-package-review={r.id} data-review-kind={update ? "update" : "install"}>
    {heading && <div className="settings-section-heading"><h3>{update ? `Update ${r.name}` : `Install ${r.name}`}</h3>
      <span>{update ? `${r.replaces!.version} → ${r.version}` : r.version}</span></div>}
    {!heading && update && <p className="package-review-versions">{r.replaces!.version} → {r.version}</p>}
    {update ? <>
      {r.changes.length ? <ul className="package-review-list" data-package-changes>
        {r.changes.map((c) => {
          const off = offBecause(c);
          return <MemberLine key={`${c.kind}:${c.id}`} kind={c.kind} name={c.name} runs={c.runs}>
            <span className="package-review-change" data-package-change={`${c.kind}:${c.id}`}>{changeText(c)}</span>
            {off && r.replaces!.on && <span className="package-review-off" data-switches-off>Switches it off: {off}</span>}
          </MemberLine>;
        })}
      </ul> : <p>Nothing in it changed.</p>}
      <button type="button" className="catalog-holds-toggle package-review-all" aria-expanded={all} onClick={() => setAll(!all)} data-package-all>
        {all ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Everything it holds ({r.members.length})</button>
      {all && members}
    </> : members}
    <p className={switching ? "package-review-outcome warn" : "package-review-outcome"} data-package-outcome={r.on ? "on" : "off"}>{outcome(r)}</p>
    {update && <p className="settings-note">{r.replaces!.version} is kept: Roll back puts it back.</p>}
  </div>;
}
