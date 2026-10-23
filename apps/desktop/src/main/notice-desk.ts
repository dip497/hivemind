/**
 * The notice desk in main (notice-desk-core.ts decides): every window's `notify:agent` comes here,
 * once per change whatever the number of windows; the desk shows the OS pop-up (agent-notify.ts),
 * and sends a sound to the one window the person is at (`notify:sound`), which plays it and says
 * what became of it (`notify:sound-result`). Settings and `hive notifications` read Recent and play
 * a sound by name, over IPC and the drive socket (`notifications.play`, `notifications.recentSounds`).
 *
 * The pop-up says what an agent waits on, or its tile's last line, only when the person turned
 * that on (`notifications.popupText`): a command on screen may hold a secret. Push never carries it.
 */
import { readFileSync } from "node:fs";
import { net, type BrowserWindow } from "electron";
import { handle, on } from "./app-ipc.js";
import { appWindowOf, userWindow } from "./windows.js";
import { showAgentPopup } from "./agent-notify.js";
import { getNotificationSettings } from "./notification-settings-store.js";
import { onSettingsChange, settingsFile } from "./settings-store.js";
import { NoticeDeskCore, type Popup } from "./notice-desk-core.js";
import { NOTICE_KINDS, type NoticeKind } from "../shared/notification-settings.js";
import { themeSoundOf } from "../shared/theme-sounds.js";
import { lineFor, type AgentWait } from "../shared/line-for.js";
import type { AgentNotice, SoundResult } from "../shared/ipc.js";
import { toBareId } from "@hivemind/workspace-api/tile-id";
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

/** How long a pop-up with text waits for the feed to bring what an agent waits on: its status
 *  changes at once, its wait up to 250 ms later (agent-feed.ts). */
const WAIT_FOR_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isKind = (v: unknown): v is NoticeKind => NOTICE_KINDS.includes(v as NoticeKind);

/** The settings file as parsed, for what the schema does not read (the applied theme's sounds):
 *  read when a sound wants it, again only after settings change. */
let rawSettings: unknown;
function themeSound(moment: NoticeKind) {
  if (rawSettings === undefined) {
    try { rawSettings = JSON.parse(readFileSync(settingsFile(), "utf8")); } catch { rawSettings = null; }
  }
  return themeSoundOf(rawSettings, moment);
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
  onSettingsChange(() => { rawSettings = undefined; });

  /** What a single agent's pop-up says under its name, when the person lets it. */
  async function popupText(p: Popup): Promise<string | undefined> {
    const first = p.notices[0];
    if (p.more || !first || !getNotificationSettings().popupText) return undefined;
    const bare = toBareId(first.tileId);
    if (p.kind !== "needs") return lineFor(undefined, o.lineOf(bare)) || undefined;
    for (let waited = 0; ; waited += 250) {
      const w = o.waitingOf(bare);
      if (w) return lineFor(w, undefined) || undefined;
      if (waited >= WAIT_FOR_WAIT_MS) return undefined;
      await sleep(250);
    }
  }

  desk = new NoticeDeskCore({
    now: Date.now,
    schedule: (fn, ms) => setTimeout(fn, ms),
    settings: getNotificationSettings,
    focused: () => !!userWindow()?.isFocused(),
    popup: (p) => {
      void popupText(p).catch(() => undefined).then((text) => showAgentPopup(p, text, userWindow));
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
    desk?.receive({ ...rec, label: typeof rec.label === "string" ? rec.label : "" }, selected);
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

  handle("notify:recent-sounds", () => desk?.recent() ?? [], { local: true });
  // Only the applied theme's sounds: a window asks for no other file this way.
  handle("notify:theme-sound", async (_e, url: unknown) => {
    if (typeof url !== "string" || !NOTICE_KINDS.some((k) => themeSound(k)?.url === url)) throw new Error("not one of the applied theme's sounds");
    const r = await net.fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > THEME_SOUND_MAX) throw new Error("too large");
    return bytes;
  }, { local: true });
  handle("notify:play", (_e, moment: unknown) => {
    if (!isKind(moment)) throw new Error("moment must be needs, done or error");
    return playNamed(moment);
  }, { local: true });
}

/** The drive socket's half (spec/workspace-api.md 0.35): play a sound by name, and Recent. Both
 *  are this machine's own; an agent's tile may read Recent but never play (roles.ts). */
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
