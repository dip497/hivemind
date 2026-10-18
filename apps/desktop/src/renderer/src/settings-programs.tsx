/**
 * Settings → API access (spec/workspace-api.md "Drive socket"): tokens for the scripts and tools
 * the person lets drive workspaces on this computer, what each may do and where, and taking one
 * back. A new token is for the workspace in this window, and is shown once.
 */
import { useCallback, useEffect, useState } from "react";
import type { ClientGrant } from "@hivemind/workspace-api/grants";
import { Check, Copy } from "./components/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Section } from "./appearance-controls";
import { useShown } from "./multiplayer/shown";

type Role = ClientGrant["role"];

const ROLES: Array<[Role, string]> = [["agents", "Drive agents"], ["terminals", "Use terminals"], ["edit", "Edit"], ["view", "View"]];
/** What a grant's role lets a program do, in the words Settings uses for it. */
export const ROLE_WORDS = Object.fromEntries(ROLES) as Record<Role, string>;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const folder = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const day = (ms: number): string => new Date(ms).toLocaleDateString();

export function ApiAccessPrefs() {
  // undefined while it is asked for; null where no app answers (a window in a browser).
  const [grants, setGrants] = useState<ClientGrant[] | null | undefined>(undefined);
  const load = useCallback(() => void window.hive.grants().then(setGrants, () => setGrants(null)), []);
  useEffect(load, [load]);
  return (
    <div className="settings-stack">
      <Section title="New token" hint="For the workspace in this window; or hive grant create from a terminal">
        <NewGrant onMade={load} />
      </Section>
      <Section title="Tokens" hint="Each reaches only its workspaces, and only at its role">
        {grants === undefined ? null : grants === null ? (
          <p className="settings-note">Only the app knows</p>
        ) : grants.length === 0 ? (
          <p className="text-label text-[var(--color-fg3)]" data-grants-none>
            None yet. A script or tool with a token, an orchestrator or a dashboard, starts and answers agents here. It cannot push or share the workspace; its role says what else it may do.
          </p>
        ) : (
          <ul className="flex flex-col" data-grants>
            {grants.map((g) => <GrantRow key={g.id} grant={g} onGone={load} />)}
          </ul>
        )}
      </Section>
    </div>
  );
}

function GrantRow({ grant, onGone }: { grant: ClientGrant; onGone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="settings-row" data-grant={grant.id}>
      <div>
        <label>{grant.name}</label>
        <p>
          {ROLE_WORDS[grant.role]} in {grant.repos.map(folder).join(", ")}
          {grant.expires !== null && ` · until ${day(grant.expires)}`}
          {` · ${grant.lastUsed === null ? "never used" : `last used ${day(grant.lastUsed)}`}`}
          {error && <span className="text-[var(--color-err)]" role="alert"> · {error}</span>}
        </p>
      </div>
      <Button variant="outline" data-grant-revoke onClick={() => void window.hive.grantRevoke(grant.id).then(onGone, (e: unknown) => setError(messageOf(e)))}>
        Revoke
      </Button>
    </li>
  );
}

function NewGrant({ onMade }: { onMade: () => void }) {
  const { repo } = useShown();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("agents");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!repo || repo.startsWith("hive://")) return <p className="settings-note">Open a workspace on this computer to make a token for it.</p>;
  const make = async () => {
    setError(null);
    try {
      const made = await window.hive.grantCreate({ name: name.trim(), repos: [repo], role });
      setToken(made.token);
      setName("");
      onMade();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const copy = () => {
    if (token) void navigator.clipboard.writeText(token).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="What uses it, e.g. my dashboard"
          className="flex-1"
          data-grant-name
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void make(); }}
        />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger aria-label="What it may do" data-grant-role className="min-w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{ROLES.map(([r, words]) => <SelectItem key={r} value={r}>{words}</SelectItem>)}</SelectContent>
        </Select>
        <Button disabled={!name.trim()} data-grant-create onClick={() => void make()}>Create token</Button>
      </div>
      <p className="settings-note">In {folder(repo)}. The script connects to the drive socket with the token and names this folder.</p>
      {token && (
        <div className="flex items-center gap-2" data-grant-token>
          <code className="flex-1 truncate font-mono text-label">{token}</code>
          <Button variant="outline" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</Button>
        </div>
      )}
      {token && <p className="settings-note">Shown this once: copy it now.</p>}
      {error && <p className="text-label text-[var(--color-err)]" role="alert">{error}</p>}
    </div>
  );
}
