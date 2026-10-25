/**
 * The notice desk in main (notice-desk-core.ts decides): every window's `notify:agent` comes here,
 * once per change whatever the number of windows; the desk shows the OS pop-up (agent-notify.ts),
 * and sends a sound to the one window the person is at (`notify:sound`), which plays it and says
 * what became of it (`notify:sound-result`). Settings and `hive notifications` read Recent and play
 * a sound by name over the workspace API (`notifications.play`, `notifications.recentSounds`): a
 * window on its connection, the CLI on the drive socket. A window cannot fetch `hivemedia:`, so
 * main hands it the applied theme's sound files (`notify:theme-sound`), and those only.
 *
 * The pop-up says what an agent waits on, or its tile's last line, only when the person turned
 * that on (`notifications.popupText`): a command on screen may hold a secret. Push never carries it.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { handle, on } from "./app-ipc.js";
import { appWindowOf, userWindow } from "./windows.js";
import { showAgentPopup } from "./agent-notify.js";
import { getNotificationSettings } from "./notification-settings-store.js";
import { getSettings, settingsFile } from "./settings-store.js";
import { NoticeDeskCore, popupTextOf, themeSoundOf } from "./notice-desk-core.js";
import { NOTICE_KINDS, type NoticeKind } from "../shared/notification-settings.js";
import { mediaDirOf } from "@hivemind/core/theme-apply";
import type { AgentWait } from "../shared/line-for.js";
import type { AgentNotice, SoundResult } from "../shared/ipc.js";
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";

export interface NoticeDeskOptions {
  /** What the agent of a tile (bare id) waits on, as the agent feed has it. */
  waitingOf(bare: string): AgentWait | undefined;
  /** A tile's last line (`TileLines`). */
  lineOf(bare: string): string | undefined;
}

/** How long a sound asked for by name waits for its window to answer. */
const ANSWER_MS = 3000;
/** The most of a theme sound's file handed to a window: a theme's sound is at most 400 KB. */
const THEME_SOUND_MAX = 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isKind = (v: unknown): v is NoticeKind => NOTICE_KINDS.includes(v as NoticeKind);

/** The applied theme's sound for `moment`, from the settings owner's snapshot: no file read. */
const themeSound = (moment: NoticeKind) => themeSoundOf(getSettings(), moment);

/** The bytes of `url`, when it is one of the applied theme's sounds (`hivemedia://media/<file>`,
 *  a plain name, as the record is read) and no larger than THEME_SOUND_MAX, stat'ed before it is
 *  read. */
async function themeSoundBytes(url: unknown): Promise<Uint8Array> {
  if (typeof url !== "string" || !NOTICE_KINDS.some((k) => themeSound(k)?.url === url)) throw new Error("not one of the applied theme's sounds");
  const file = path.join(mediaDirOf(settingsFile()), url.slice("hivemedia://media/".length));
  const st = await stat(file);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > THEME_SOUND_MAX) throw new Error("too large");
  return new Uint8Array(await readFile(file));
}

let desk: NoticeDeskCore | null = null;
const waiting = new Map<number, (r: SoundResult) => void>();

/** Play `moment` now in the window the person is at, and say what became of it. */
async function playNamed(moment: NoticeKind): Promise<SoundResult> {
  if (!desk) throw new ApiError("UNAVAILABLE", "the app's notice desk is not running yet");
  let answer!: (r: SoundResult) => void;
  const answered = new Promise<SoundResult>((r) => { answer = r; });
  const { id } = desk.play(moment, (sound) => waiting.set(sound.id, answer));
  const timer = setTimeout(() => {
    if (!waiting.delete(id)) return;
    desk?.result(id, false, "no window answered");
    answer({ id, played: false, why: "no window answered" });
  }, ANSWER_MS);
  try { return await answered; } finally { clearTimeout(timer); }
}

/** Start the desk: `notify:agent` and the sound channels. */
export function registerNoticeDesk(o: NoticeDeskOptions): void {
  desk = new NoticeDeskCore({
    settings: getNotificationSettings,
    focused: () => !!userWindow()?.isFocused(),
    popup: (p) => {
      void popupTextOf(p, getNotificationSettings().popupText, { ...o, sleep })
        .catch(() => undefined)
        .then((text) => showAgentPopup(p, text, userWindow));
    },
    sound: (s) => {
      const win: BrowserWindow | null = userWindow();
      if (!win || win.isDestroyed()) {
        desk?.result(s.id, false, "no window open");
        waiting.get(s.id)?.({ id: s.id, played: false, why: "no window open" });
        waiting.delete(s.id);
        return;
      }
      const theme = themeSound(s.moment);
      try {
        win.webContents.send("notify:sound", { ...s, volume: getNotificationSettings().volume, ...(theme ? { theme } : {}) });
      } catch {
        desk?.result(s.id, false, "the window closed");
      }
    },
  });

  on("notify:agent", (e, raw: unknown) => {
    const rec = raw as AgentNotice | null;
    if (!rec || typeof rec.tileId !== "string" || !isKind(rec.kind)) return;
    // A tile counts as looked at only while the window that has it selected has the focus.
    const selected = rec.selected === true && !!appWindowOf(e.sender)?.isFocused();
    const { since, ...rest } = rec;
    desk?.receive({ ...rest, label: typeof rec.label === "string" ? rec.label : "", ...(Number.isFinite(since) ? { since } : {}) }, selected);
  }, { local: true });

  on("notify:sound-result", (_e, raw: unknown) => {
    const r = raw as SoundResult | null;
    if (!r || typeof r.id !== "number") return;
    const why = typeof r.why === "string" ? r.why.slice(0, 200) : undefined;
    const pack = typeof r.pack === "string" ? r.pack.slice(0, 60) : undefined;
    desk?.result(r.id, r.played === true, why, pack);
    waiting.get(r.id)?.({ id: r.id, played: r.played === true, ...(why ? { why } : {}), ...(pack ? { pack } : {}) });
    waiting.delete(r.id);
  }, { local: true });

  // Only the applied theme's sounds: a window asks for no other file this way.
  handle("notify:theme-sound", (_e, url: unknown) => themeSoundBytes(url), { local: true });
}

/** Play a sound by name, and Recent (spec/workspace-api.md 0.35), for a window and the drive
 *  socket alike. Both are this machine's own; an agent's tile may read Recent but never play
 *  (roles.ts). */
export const noticeDeskDomain: Domain<"notifications.play" | "notifications.recentSounds"> = {
  answers: {
    "notifications.play": async (_from, moment) => {
      if (!isKind(moment)) throw new ApiError("BAD_REQUEST", "moment must be needs, done or error");
      return playNamed(moment);
    },
    "notifications.recentSounds": () => desk?.recent() ?? [],
  },
  effects: {
    "notifications.play": (moment) => ({ target: typeof moment === "string" ? moment : undefined }),
  },
};
