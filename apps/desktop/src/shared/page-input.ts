/**
 * A browser tile's page as a viewer away from the app window sees and uses it (main/page-stream.ts):
 * the pictures it is sent, what it sends back, and the events. Node-free.
 */

/** A picture of the page, and where it is. */
export interface PageFrame { data: string; url: string; title: string; canBack: boolean; canForward: boolean }

/** What a viewer does on the page. A point is where on the picture, as fractions of its width and
 *  height. Keys are named as the DOM names them. */
export type PageInput =
  | { kind: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "left" | "middle" | "right" | "none"; clickCount: number; modifiers: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: "key"; type: "keyDown" | "keyUp"; key: string; code: string; keyCode: number; text: string; modifiers: number }
  | { kind: "text"; text: string }
  | { kind: "go"; to: "back" | "forward" | "reload" }
  | { kind: "open"; url: string };

export const FRAME_EVENT = "browser:frame";
export const SHOWN_EVENT = "browser:page-shown";
/** To the app window: someone elsewhere started or stopped watching a tile's page. */
export const WATCHED_EVENT = "browser:watched";
export const GONE_EVENT = "browser:page-gone";

const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const isCount = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
const isDelta = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10_000;
const isShort = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max;

/** `input` when it is one a viewer may send, else null: it comes from another device. */
export function pageInputOf(input: unknown): PageInput | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  switch (i.kind) {
    case "mouse":
      return ["mousePressed", "mouseReleased", "mouseMoved"].includes(i.type as string) && isFraction(i.x) && isFraction(i.y)
        && ["left", "middle", "right", "none"].includes(i.button as string) && isCount(i.clickCount, 3) && isCount(i.modifiers, 15)
        ? (i as PageInput) : null;
    case "wheel":
      return isFraction(i.x) && isFraction(i.y) && isDelta(i.deltaX) && isDelta(i.deltaY) && isCount(i.modifiers, 15) ? (i as PageInput) : null;
    case "key":
      return (i.type === "keyDown" || i.type === "keyUp") && isShort(i.key, 32) && isShort(i.code, 32) && isCount(i.keyCode, 255)
        && isShort(i.text, 4) && isCount(i.modifiers, 15) ? (i as PageInput) : null;
    case "text":
      return isShort(i.text, 100_000) ? (i as PageInput) : null;
    case "go":
      return ["back", "forward", "reload"].includes(i.to as string) ? (i as PageInput) : null;
    case "open":
      return isShort(i.url, 8192) && /^https?:\/\//i.test(i.url) ? (i as PageInput) : null;
    default:
      return null;
  }
}

