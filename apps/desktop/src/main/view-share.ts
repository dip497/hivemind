/**
 * Share an image a view drew (protocol 1.3): check the PNG before decoding it, re-encode it so
 * nothing but pixels survives, and copy or save it only after the user chose to in a host dialog.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SHARE_MAX_BYTES, SHARE_MAX_SIDE, type ShareOutcome } from "@hivemind/view-sdk/protocol";
import type { SharePrepared } from "../shared/ipc.js";
import { localDay } from "./presence.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from the header, or why the bytes are not an acceptable PNG. */
export function checkPng(bytes: Uint8Array): { width: number; height: number } | { problem: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > SHARE_MAX_BYTES) return { problem: `an image must be 1 byte to ${SHARE_MAX_BYTES} bytes` };
  if (bytes.byteLength < 24 || !SIGNATURE.every((b, i) => bytes[i] === b)) return { problem: "not a PNG" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return { problem: "not a PNG" };
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > SHARE_MAX_SIDE || height > SHARE_MAX_SIDE) return { problem: `an image must be at most ${SHARE_MAX_SIDE} px on each side` };
  return { width, height };
}

/** A file name from a view's suggestion: its own characters only, and always today's date. */
export function shareFileName(suggested: string, fallback: string, now = Date.now()): string {
  const base = (suggested || fallback).replace(/[^\w .-]/g, "").replace(/^[. ]+/, "").trim().slice(0, 64) || "view";
  return `${base}-${localDay(now)}.png`;
}

export interface ShareDeps {
  /** Decode and re-encode as PNG; null when the bytes do not decode. */
  reencode: (bytes: Uint8Array) => { png: Uint8Array; width: number; height: number } | null;
  copy: (png: Uint8Array) => void;
  /** Ask where to save; null when the user cancelled. */
  chooseSavePath: (defaultName: string) => Promise<string | null>;
}

export class ViewShare {
  private pending = new Map<string, Uint8Array>();

  constructor(private deps: ShareDeps) {}

  prepare(buffer: ArrayBuffer): SharePrepared {
    const bytes = new Uint8Array(buffer);
    const header = checkPng(bytes);
    if ("problem" in header) throw new Error(header.problem);
    const clean = this.deps.reencode(bytes);
    if (!clean) throw new Error("the image does not decode");
    const token = randomUUID();
    // One image waits at a time: a new one replaces it.
    this.pending.clear();
    this.pending.set(token, clean.png);
    return { token, preview: `data:image/png;base64,${Buffer.from(clean.png).toString("base64")}`, width: clean.width, height: clean.height };
  }

  async commit(token: string, action: "copy" | "save" | "cancel", suggestedName: string): Promise<ShareOutcome> {
    const png = this.pending.get(token);
    this.pending.delete(token);
    if (!png || action === "cancel") return "cancelled";
    if (action === "copy") { this.deps.copy(png); return "copied"; }
    const target = await this.deps.chooseSavePath(shareFileName(suggestedName, "view"));
    if (!target) return "cancelled";
    await fs.writeFile(path.extname(target) ? target : `${target}.png`, png);
    return "saved";
  }
}
