/**
 * Signing in on a Browser tile's page for an agent, without the password reaching the agent. The
 * person saves a sign-in here (the site it is for, its address, its username and password). An
 * agent names one; the person says yes on the tile; and this process, which alone can read the
 * password, types it into the page's visible fields, only while the page is on that site. Page
 * and frames are read by the page's DevTools session, and the password goes in by Electron's input.
 */
import { app, safeStorage, type WebContents } from "electron";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pressKey, typeText } from "./page-keys.js";

export interface SavedSignIn {
  name: string;
  /** The one origin its password may be typed on. */
  site: string;
  url: string;
  username: string;
  /** The person said an agent need not ask again. */
  always: boolean;
  /** AES-GCM: iv, tag and text, in base64. */
  password: string;
}
/** A saved sign-in as anyone but this file sees one. */
export type SignInSummary = Omit<SavedSignIn, "password">;

const storeFile = () => path.join(app.getPath("userData"), "browser-sign-ins.json");
const keyFile = () => path.join(app.getPath("userData"), "browser-sign-ins.key");
const readText = (file: string): string => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

/** Whether this computer's keychain holds the key. Without one, a file only this person can read does. */
export function keychainInUse(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

let key: Buffer | null = null;
function theKey(): Buffer {
  if (key) return key;
  const kept = readText(keyFile()).trim();
  if (kept.startsWith("keychain:")) {
    key = Buffer.from(safeStorage.decryptString(Buffer.from(kept.slice("keychain:".length), "base64")), "base64");
  } else if (kept) {
    key = Buffer.from(kept, "base64");
  } else {
    key = randomBytes(32);
    const text = key.toString("base64");
    writeFileSync(keyFile(), keychainInUse() ? `keychain:${safeStorage.encryptString(text).toString("base64")}` : text, { mode: 0o600 });
  }
  return key;
}

function seal(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", theKey(), iv);
  const sealed = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}
function open(sealed: string): string {
  const all = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", theKey(), all.subarray(0, 12));
  decipher.setAuthTag(all.subarray(12, 28));
  return Buffer.concat([decipher.update(all.subarray(28)), decipher.final()]).toString("utf8");
}

function readAll(): SavedSignIn[] {
  try {
    const list = JSON.parse(readText(storeFile())) as SavedSignIn[];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
const writeAll = (list: SavedSignIn[]) => writeFileSync(storeFile(), JSON.stringify(list, null, 2), { mode: 0o600 });

export const listSignIns = (): SignInSummary[] => readAll().map(({ password: _hidden, ...shown }) => shown);
export const signInNamed = (name: string): SignInSummary | null => listSignIns().find((s) => s.name === name) ?? null;

export function saveSignIn(s: { name: string; url: string; username: string; password: string }): void {
  const name = s.name.trim();
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("A name is letters, numbers, dots and dashes");
  let site: string;
  try {
    const u = new URL(s.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not web");
    site = u.origin;
  } catch { throw new Error("The address has to be a web address"); }
  if (!s.username || !s.password) throw new Error("A sign-in needs a username and a password");
  const others = readAll().filter((row) => row.name !== name);
  writeAll([...others, { name, site, url: s.url, username: s.username, always: false, password: seal(s.password) }]);
}
export const removeSignIn = (name: string): void => writeAll(readAll().filter((row) => row.name !== name));
export function alwaysAllow(name: string): void {
  writeAll(readAll().map((row) => (row.name === name ? { ...row, always: true } : row)));
}

/** The ways a password can show in what a page's DevTools session reports. */
export function passwordForms(name: string): string[] {
  const row = readAll().find((s) => s.name === name);
  if (!row) return [];
  const p = open(row.password);
  const encoded = encodeURIComponent(p);
  return [...new Set([p, JSON.stringify(p).slice(1, -1), encoded, encoded.replace(/%20/g, "+"), Buffer.from(p).toString("base64")])];
}

export type SignInResult =
  /** The page moved on: signed in, as far as a page can tell. */
  | { outcome: "sent"; url: string }
  /** The person has to finish in the tile: `why` says what is on the page. */
  | { outcome: "person"; why: string };

/** Reads the page's visible sign-in fields, and focuses one when asked. Top frame only: a password
 *  is not for whatever a page puts in a frame. */
const fieldsScript = (focus: "username" | "password" | null) => `(() => {
  const shown = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01 && !el.disabled && !el.readOnly; };
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const password = inputs.find((i) => i.type === "password");
  const named = (i) => /user|email|login|account|identifier/i.test([i.autocomplete, i.name, i.id, i.placeholder, i.getAttribute("aria-label")].join(" "));
  const textual = (i) => i.type === "email" || i.type === "text" || i.type === "tel";
  const username = inputs.find((i) => textual(i) && named(i)) ?? (password ? inputs.find(textual) : undefined);
  const chosen = ${JSON.stringify(focus)} === "password" ? password : ${JSON.stringify(focus)} === "username" ? username : null;
  if (chosen) { chosen.focus(); chosen.select?.(); }
  return { password: !!password, username: !!username, usernameEmpty: !!username && !username.value, focused: !!chosen && document.activeElement === chosen };
})()`;
interface Fields { password: boolean; username: boolean; usernameEmpty: boolean; focused: boolean }

const CLEAR_PASSWORD = `(() => { const f = [...document.querySelectorAll("input[type=password]")]; for (const i of f) { i.focus(); i.select(); document.execCommand("delete"); i.blur(); } })()`;
const WAIT_FOR_FIELDS_MS = 10_000;
const WAIT_TO_LEAVE_MS = 12_000;
const LOAD_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loaded(page: WebContents, url: string): Promise<void> {
  return Promise.race([page.loadURL(url).catch(() => undefined), sleep(LOAD_MS)]).then(() => undefined);
}

/** Sign in on `page` with the saved sign-in `name`. Before each field the page has to be on its
 *  site; what it cannot do it leaves to the person. */
export async function signInOnPage(page: WebContents, name: string): Promise<SignInResult> {
  const row = readAll().find((s) => s.name === name);
  if (!row) return { outcome: "person", why: `No saved sign-in is called ${name}` };
  const onSite = () => { try { return !page.isDestroyed() && new URL(page.getURL()).origin === row.site; } catch { return false; } };
  const wrongSite = (): SignInResult => ({ outcome: "person", why: `The page is not on ${row.site}: nothing was typed` });
  if (!page.debugger.isAttached()) page.debugger.attach("1.3");
  const fields = async (focus: "username" | "password" | null) =>
    ((await page.debugger.sendCommand("Runtime.evaluate", { expression: fieldsScript(focus), returnByValue: true })) as { result: { value: Fields } }).result.value;
  const enter = () => {
    pressKey(page, { type: "keyDown", key: "Enter", text: "\r" });
    pressKey(page, { type: "keyUp", key: "Enter" });
  };
  const type = async (which: "username" | "password", text: string): Promise<boolean> => {
    if (!onSite()) return false;
    if (!(await fields(which)).focused || !onSite()) return false;
    await typeText(page, text);
    return true;
  };

  if (!onSite()) await loaded(page, row.url);
  if (!onSite()) return wrongSite();
  const first = await fields(null);
  if (!first.username && !first.password) await loaded(page, row.url);

  let usernameTyped = false;
  const until = Date.now() + WAIT_FOR_FIELDS_MS;
  while (Date.now() < until) {
    if (!onSite()) return wrongSite();
    const found = await fields(null);
    if (found.password) {
      if (found.username && found.usernameEmpty && !(await type("username", row.username))) return wrongSite();
      if (!(await type("password", open(row.password)))) return wrongSite();
      enter();
      return left(page, () => fields(null), row.site);
    }
    if (found.username && !usernameTyped) {
      // A form that asks for the username first, and the password on its next step.
      if (!(await type("username", row.username))) return wrongSite();
      usernameTyped = true;
      enter();
    }
    await sleep(200);
  }
  return { outcome: "person", why: "No sign-in form showed on this page" };
}

/** After the password went in: whether the page left its form. If it did not, it is taken back out. */
async function left(page: WebContents, fields: () => Promise<Fields>, site: string): Promise<SignInResult> {
  const until = Date.now() + WAIT_TO_LEAVE_MS;
  while (Date.now() < until) {
    await sleep(200);
    if (page.isDestroyed()) return { outcome: "person", why: "The page closed" };
    const gone = await fields().then((f) => !f.password, () => false);
    if (gone) return { outcome: "sent", url: page.getURL() };
  }
  if (new URL(page.getURL()).origin === site) await page.debugger.sendCommand("Runtime.evaluate", { expression: CLEAR_PASSWORD }).catch(() => {});
  return { outcome: "person", why: "The sign-in form is still showing: a wrong password, or a step only the person can do" };
}
