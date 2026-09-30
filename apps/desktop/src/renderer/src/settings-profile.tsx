/**
 * Settings → Profile (R3): who you are to the people you work with — the name and colour they see
 * beside your cursor and your edits (`profile` in settings.json) — and the ids this machine is
 * known by: its device's, and the person's it holds the key of.
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Section } from "./appearance-controls";
import { patchSettings, useSettings } from "./settings-store";
import { PROFILE_COLORS, colorFor } from "./multiplayer/people";

type Identity = Awaited<ReturnType<typeof window.hive.identity>>;

export function ProfilePrefs() {
  const { profile } = useSettings();
  // undefined while it is asked for; null where no app answers (a window in a browser).
  const [me, setMe] = useState<Identity | null | undefined>(undefined);
  useEffect(() => { void window.hive.identity().then((i) => setMe(i ?? null), () => setMe(null)); }, []);
  const color = profile.color || (me ? colorFor(me.personId) : "");
  return (
    <div className="settings-stack">
      <Section title="You" hint="What the people you work with see">
        <div className="settings-row">
          <div>
            <label htmlFor="profile-name">Name</label>
            <p>Beside your cursor and your edits.{me?.suggestedName ? ` Left empty, it is ${me.suggestedName}.` : ""}</p>
          </div>
          <NameInput saved={profile.name} placeholder={me?.suggestedName ?? ""} />
        </div>
        <div className="settings-row">
          <div>
            <label id="profile-color-label">Colour</label>
            <p>{profile.color ? "Your cursor, your edits and your avatar." : "Picked for you until you choose one."}</p>
          </div>
          <div className="settings-accents" role="radiogroup" aria-labelledby="profile-color-label">
            {PROFILE_COLORS.map((c) => {
              const sel = color === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  aria-label={c.name}
                  title={c.name}
                  className="settings-accent"
                  data-profile-color={c.value}
                  onClick={() => patchSettings("profile.color", c.value)}
                  style={{ background: c.value, ...(sel ? { boxShadow: `0 0 0 2px var(--color-bg2), 0 0 0 4px ${c.value}` } : {}) }}
                />
              );
            })}
          </div>
        </div>
      </Section>
      <Section title="This computer" hint="Made here the first time, and kept">
        <IdRow label="Device" about="This computer. Other devices know it by this id." id={me === undefined ? undefined : me?.deviceId ?? null} />
        <IdRow label="Person" about="You. Your other devices take it when you pair them with this one." id={me === undefined ? undefined : me?.personId ?? null} />
      </Section>
    </div>
  );
}

/** Saved when it loses focus or on Enter, not on each key: the name is trimmed when saved, and a
 *  space typed between two words would otherwise be taken away as it is typed. */
function NameInput({ saved, placeholder }: { saved: string; placeholder: string }) {
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(saved); }, [saved, editing]);
  return (
    <Input
      id="profile-name"
      value={draft}
      placeholder={placeholder}
      maxLength={64}
      spellCheck={false}
      autoComplete="off"
      className="w-[220px] max-w-full"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft.trim() !== saved) patchSettings("profile.name", draft.trim()); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

/** `id` is undefined while it is asked for, and null where no app answers. */
function IdRow({ label, about, id }: { label: string; about: string; id: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="settings-row" data-identity={label.toLowerCase()} data-id={id ?? ""}>
      <div><label>{label}</label><p>{about}</p></div>
      {id ? (
        <Button variant="outline" size="sm" title={id}
          onClick={() => { void navigator.clipboard.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          <code>{`${id.slice(0, 8)}…${id.slice(-8)}`}</code>{copied ? <Check /> : <Copy />}
        </Button>
      ) : id === null ? (
        <span className="settings-note">Only the app knows</span>
      ) : null}
    </div>
  );
}
