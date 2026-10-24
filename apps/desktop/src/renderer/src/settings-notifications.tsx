/**
 * Settings ▸ Notifications: which agents' changes reach the person and how (toasts, OS pop-ups and
 * what they say, sounds), Do Not Disturb, and Recent: the last 10 bursts main's notice desk saw and
 * what each sounded and showed. Everything is the `notifications` section of settings.json, which
 * `hive notifications` edits too.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell } from "./components/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Slider } from "./appearance-controls";
import { setNotificationSetting as set, useNotificationSettings } from "./notification-settings";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";
import { NOTICE_TONES, type NoticeKind, type NotificationSettings } from "../../shared/notification-settings";
import type { RecentSound } from "../../shared/ipc";

/** A status word as a label: "needs you" → "Needs you". */
const sentence = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** A kind's status word, as the app says it everywhere. */
const word = (k: NoticeKind) => STATUS_MARKS[NOTICE_TONES[k]].word;
const MOMENTS: { key: NoticeKind; label: string; hint: string }[] = [
  { key: "needs", label: sentence(word("needs")), hint: "Permission prompts, questions, plans to review, blocked" },
  { key: "done", label: sentence(word("done")), hint: "An agent completed its task" },
  { key: "error", label: sentence(word("error")), hint: "Agent crashed or exited non-zero" },
];

/** How often Recent is read again while the page is open. */
const RECENT_EVERY_MS = 2000;

export function NotificationPrefs() {
  const s = useNotificationSettings();
  const dim = !s.enabled;

  return (
    <div className="settings-section">
      <div className="settings-row">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-[var(--color-fg2)]" />
          <span className="text-body font-medium text-[var(--color-fg)]">Notifications</span>
        </div>
        <Switch checked={s.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Enable notifications" />
      </div>

      {/* Per kind: which agent changes reach you. */}
      <div className="settings-section">
        <div className="settings-subheading">Notify me about</div>
        {MOMENTS.map((k) => (
          <div key={k.key} className="settings-row">
            <div className="min-w-0">
              <div className="text-label text-[var(--color-fg)]">{k.label}</div>
              <div className="settings-note">{k.hint}</div>
            </div>
            <Switch
              disabled={dim}
              checked={s.kinds[k.key]}
              onCheckedChange={(v) => set(`kinds.${k.key}`, v)}
              aria-label={`Notify on ${k.label}`}
            />
          </div>
        ))}
      </div>

      {/* Surface choice: in-app toast and OS pop-up, each on its own. */}
      <div className="settings-section">
        <div className="settings-subheading">Delivery</div>
        <div className="settings-row">
          {/* The window's live region (workspace/announcer.ts) follows this switch as a toast does. */}
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">In-app toasts</div>
            <div id="notify-in-app-note" className="settings-note">Also what a screen reader says</div>
          </div>
          <Switch disabled={dim} checked={s.inApp} onCheckedChange={(v) => set("inApp", v)} aria-label="In-app toasts" aria-describedby="notify-in-app-note" />
        </div>
        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">Native OS popups</div>
            <div className="settings-note">Several agents at once show as one</div>
          </div>
          <Switch disabled={dim} checked={s.osPopups} onCheckedChange={(v) => set("osPopups", v)} aria-label="Native OS popups" />
        </div>
        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">Show commands and questions</div>
            <div id="notify-text-note" className="settings-note">A pop-up says what an agent waits on, or the last line its terminal showed. A command on screen may hold a password or a key, and a pop-up can show on a locked screen.</div>
          </div>
          <Switch disabled={dim || !s.osPopups} checked={s.popupText} onCheckedChange={(v) => set("popupText", v)} aria-label="Show commands and questions" aria-describedby="notify-text-note" />
        </div>
      </div>

      <SoundPrefs s={s} dim={dim} />

      {/* Do Not Disturb: mutes finished and failed (never needs you) during a window. */}
      <div className="settings-section">
        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">Do Not Disturb</div>
            <div className="settings-note">Mutes Finished and Failed (toasts, pop-ups, sounds, the spoken line); Needs you still comes</div>
          </div>
          <Switch disabled={dim} checked={s.dnd.enabled} onCheckedChange={(v) => set("dnd.enabled", v)} aria-label="Do Not Disturb" />
        </div>
        {s.dnd.enabled && (
          <div className="mt-2 flex items-center gap-2">
            <Input type="time" disabled={dim} value={s.dnd.start} onChange={(e) => set("dnd.start", e.target.value)} className="w-auto" aria-label="DND start" />
            <span className="text-count text-[var(--color-fg2)]">to</span>
            <Input type="time" disabled={dim} value={s.dnd.end} onChange={(e) => set("dnd.end", e.target.value)} className="w-auto" aria-label="DND end" />
            <span className="text-chip text-[var(--color-fg2)] ml-auto">local time</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Sounds: the master switch, one per moment with Play, the volume, and Recent. */
function SoundPrefs({ s, dim }: { s: NotificationSettings; dim: boolean }) {
  const [recent, setRecent] = useState<RecentSound[]>([]);
  const read = useCallback(() => { void window.hive.recentSounds?.().then(setRecent).catch(() => {}); }, []);
  useEffect(() => {
    read();
    const timer = setInterval(read, RECENT_EVERY_MS);
    return () => clearInterval(timer);
  }, [read]);
  const play = (m: NoticeKind) => { void window.hive.playSound?.(m).finally(read); };
  const off = dim || !s.sound;

  return (
    <div className="settings-section" data-settings-sounds>
      <div className="settings-subheading">Sounds</div>
      <div className="settings-row">
        <div className="min-w-0">
          <div className="text-label text-[var(--color-fg)]">Play a sound</div>
          <div className="settings-note">One sound for agents that change together, in the window you are at</div>
        </div>
        <Switch disabled={dim} checked={s.sound} onCheckedChange={(v) => set("sound", v)} aria-label="Play a sound" />
      </div>
      {MOMENTS.map((k) => (
        <div key={k.key} className="settings-row">
          <div className="text-label text-[var(--color-fg)]">{k.label}</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" disabled={!window.hive.playSound} onClick={() => play(k.key)} aria-label={`Play the ${k.label} sound`}>Play</Button>
            <Switch disabled={off} checked={s.sounds[k.key]} onCheckedChange={(v) => set(`sounds.${k.key}`, v)} aria-label={`Sound on ${k.label}`} />
          </div>
        </div>
      ))}
      <Slider label="Volume" value={Math.round(s.volume * 100)} min={0} max={100} suffix="%" onChange={(v) => set("volume", v / 100)} />
      <div className="settings-subheading">Recent</div>
      {recent.length === 0 ? (
        <div className="settings-note">Nothing yet: agents that need you, finish or fail show here.</div>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Recent notifications">
          {recent.map((r) => <RecentRow key={r.id} r={r} />)}
        </ul>
      )}
    </div>
  );
}

const SOUND_WORDS: Record<RecentSound["sound"], string> = { off: "no sound", waiting: "waiting", skipped: "skipped", played: "played", blocked: "blocked" };

function RecentRow({ r }: { r: RecentSound }) {
  const when = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const sound = `${SOUND_WORDS[r.sound]}${r.pack ? ` (${r.pack})` : ""}${r.why ? `: ${r.why}` : ""}`;
  return (
    <li
      className="settings-row text-label"
      data-recent-sound={r.moment}
      data-agents={r.agents}
      data-sound={r.sound}
      data-popups={r.popups}
      {...(r.pack ? { "data-pack": r.pack } : {})}
    >
      <span className="min-w-0 text-[var(--color-fg)]">
        {sentence(word(r.moment))}
        {/* No agents: a sound asked for by name (Play, `hive notifications play`). */}
        <span className="text-[var(--color-fg2)]"> · {r.agents ? `${r.agents} agent${r.agents === 1 ? "" : "s"}` : "asked for"} · {sound}</span>
      </span>
      <span className="shrink-0 font-mono text-count text-[var(--color-fg2)]">
        {r.popups} pop-up{r.popups === 1 ? "" : "s"} · {when}
      </span>
    </li>
  );
}
