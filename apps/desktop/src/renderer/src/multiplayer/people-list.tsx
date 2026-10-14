/**
 * Who has access (design §4.2 E): the person here, its owner, then everyone on this workspace's
 * list, under the names they joined with, their role, when they joined and whether they are here
 * now. The person here changes a role inline (the person is reconnected under it), or removes
 * someone: they are disconnected at once, and the link they came in by lets nobody in again. *Can drive agents* runs commands on this machine: it
 * is given only to someone here now, and only once the person here says so.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { SharedPerson } from "../../../shared/ipc";
import { useSettings } from "../settings-store";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ROLE_LABELS, colorOf, initialsOf } from "./people";
import { useFacesHere } from "./presence";

const ROLES = ["view", "edit", "terminals", "agents"] as const;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?(people: )?/, "");

function since(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function PeopleList({ repo }: { repo: string }) {
  const [people, setPeople] = useState<SharedPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [granting, setGranting] = useState<SharedPerson | null>(null);
  const [me, setMe] = useState<string>("");
  const profile = useSettings().profile;
  const load = useCallback(() => window.hive.people(repo).then(setPeople, (e: unknown) => setError(messageOf(e))), [repo]);
  // Who is here changes as people come and go: read the list again.
  const here = useFacesHere(repo);
  useEffect(() => { void load(); }, [load, here]);
  useEffect(() => { void window.hive.identity().then((i) => setMe(i.personId), () => {}); }, []);

  const run = async (what: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await what();
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      void load();
    }
  };
  const setRole = (p: SharedPerson, role: string): void => {
    if (role === "agents") return setGranting(p);
    void run(() => window.hive.setRole(repo, p.person, role));
  };
  const remove = async (p: SharedPerson): Promise<void> => {
    setRemoving(null);
    if (await run(() => window.hive.removePerson(repo, p.person))) toast(`${p.name || "They"} ${p.name ? "was" : "were"} removed`);
  };
  const face = (p: { person: string; color: string; name: string }) => (
    <span className="grid size-7 shrink-0 place-items-center rounded-full text-count font-semibold text-white" style={{ background: colorOf(p) }}>
      {initialsOf(p.name)}
    </span>
  );

  return (
    <div className="flex flex-col gap-2" data-people-list>
      <ul className="flex flex-col">
        {me && <li className="flex items-center gap-2.5 py-1.5" data-people-owner>
          {face({ person: me, color: profile.color, name: profile.name || "You" })}
          <span className="min-w-0 flex-1 truncate text-body">{profile.name || "You"} <span className="text-[var(--color-fg3)]">(you)</span></span>
          <span className="pr-1 text-label text-[var(--color-fg2)]">{ROLE_LABELS.owner}</span>
        </li>}
        {people?.map((p) => (
          <li key={p.person} className="flex items-center gap-2.5 py-1.5" data-shared-person={p.person} data-present={p.present}>
            {face(p)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body">{p.name || "Someone"}</span>
              <span className="block text-count text-[var(--color-fg3)]">
                {p.present ? <span className="text-[var(--color-ok)]">Here now</span> : "Away"} · joined {since(p.grantedAt)}
              </span>
            </span>
            {removing === p.person ? (
              <>
                <Button variant="destructive" onClick={() => void remove(p)} data-remove-confirm>Remove {p.name || "them"}</Button>
                <Button variant="ghost" onClick={() => setRemoving(null)}>Keep</Button>
              </>
            ) : (
              <>
                <Select value={p.role} onValueChange={(v) => setRole(p, v)}>
                  <SelectTrigger aria-label={`Role of ${p.name || "someone"}`} className="min-w-36" data-person-role><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r} disabled={r === "agents" && !p.present && p.role !== "agents"}>{ROLE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="ghost" onClick={() => setRemoving(p.person)} data-remove>Remove</Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {people?.length === 0 && <p className="text-label text-[var(--color-fg3)]" data-people-none>Nobody else yet: press Connect above, and send them the code.</p>}
      {granting && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--color-warn)] p-3 text-label" role="alertdialog" data-grant-agents>
          <p>{granting.name || "They"} will be able to run commands on your machine through your agents.</p>
          <div className="flex gap-2">
            <Button variant="destructive" onClick={() => { const p = granting; setGranting(null); void run(() => window.hive.setRole(repo, p.person, "agents")); }}>Let them drive agents</Button>
            <Button variant="ghost" onClick={() => setGranting(null)}>Not now</Button>
          </div>
        </div>
      )}
      {error && <p className="text-label text-[var(--color-err)]" role="alert">{error}</p>}
    </div>
  );
}
