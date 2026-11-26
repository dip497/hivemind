/**
 * The pictures on a workspace's board (`board.keepImage`, `board.image`): the document names each
 * by the sha256 of its bytes, and the bytes are kept here, one file per picture in a folder per
 * workspace, `<dir>/<first 32 hex of sha256(repo)>/<hash>`. A file is written once, atomically,
 * and never changed or removed while its workspace is here: undo can bring back any picture that
 * was on the board. What a picture is (PNG, JPEG, WebP or GIF) and its size are read from its own
 * bytes, never taken from the caller. Electron-free.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { StartImage } from "@hivemind/workspace-api/agents";
import type { BoardImage, BoardImageType } from "@hivemind/workspace-doc/shapes";

/** The most bytes a picture may have, and the most pixels on its long side once kept. */
export const IMAGE_BYTES_MOST = 10 * 1024 * 1024;
export const IMAGE_SIDE_MOST = 4096;
/** The most bytes of pictures one workspace's board keeps here. */
export const WORKSPACE_PICTURES_MOST = 500 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** What a picture's bytes say it is, and its size; null for anything the board does not show. */
export function imageFacts(b: Uint8Array): { type: BoardImageType; width: number; height: number } | null {
  const sized = (type: BoardImageType, width: number, height: number) => (width > 0 && height > 0 ? { type, width, height } : null);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return sized("image/png", ((b[16]! << 24) >>> 0) + (b[17]! << 16) + (b[18]! << 8) + b[19]!, ((b[20]! << 24) >>> 0) + (b[21]! << 16) + (b[22]! << 8) + b[23]!);
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return sized("image/gif", le16(b, 6), le16(b, 8));
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return sized("image/webp", le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
    if (chunk === "VP8L" && b[20] === 0x2f) {
      return sized("image/webp", 1 + (((b[22]! & 0x3f) << 8) | b[21]!), 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)));
    }
    if (chunk === "VP8X") return sized("image/webp", 1 + le24(b, 24), 1 + le24(b, 27));
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The size is in the first start-of-frame marker; every marker before it says how long it is.
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized("image/jpeg", be16(b, at + 7), be16(b, at + 5));
      at += 2 + be16(b, at + 2);
    }
  }
  return null;
}

export interface BoardImagesOptions {
  /** Where every workspace's pictures are kept, a folder each. */
  dir: string;
  /** A picture made no larger than `most` pixels on its long side, by a window; none: no window here,
   *  and a larger picture is refused. */
  shrink?(image: StartImage, most: number): Promise<StartImage>;
}

export class BoardImages {
  /** What each kept picture is, by workspace and hash: read from its file once. */
  private readonly facts = new Map<string, BoardImage | null>();
  /** The bytes each workspace's folder holds: read from the disk once, then counted as pictures are kept. */
  private readonly used = new Map<string, Promise<{ bytes: number }>>();

  constructor(private readonly o: BoardImagesOptions) {}

  private folder(repo: string): string {
    return path.join(this.o.dir, createHash("sha256").update(repo).digest("hex").slice(0, 32));
  }

  /** Keep `given` for `repo`'s board: what the board shows of it. The same bytes kept twice are one file. */
  async keep(repo: string, given: unknown): Promise<BoardImage> {
    let bytes = bytesOf(given);
    let facts = imageFacts(bytes);
    if (!facts) throw new ApiError("BAD_REQUEST", "a picture on the board is a PNG, JPEG, WebP or GIF: SVG and other files are not taken");
    if (Math.max(facts.width, facts.height) > IMAGE_SIDE_MOST) {
      if (!this.o.shrink) throw new ApiError("UNSUPPORTED", `the picture is ${facts.width}×${facts.height}: at most ${IMAGE_SIDE_MOST} pixels on its long side is kept here, where no window can make it smaller; make it smaller first, or add it from the app`);
      bytes = bytesOf(await this.o.shrink({ type: facts.type, data: Buffer.from(bytes).toString("base64") }, IMAGE_SIDE_MOST));
      facts = imageFacts(bytes);
      if (!facts || Math.max(facts.width, facts.height) > IMAGE_SIDE_MOST) throw new ApiError("FAILED", "the picture could not be made smaller");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const dir = this.folder(repo);
    const file = path.join(dir, hash);
    if (!fs.existsSync(file)) {
      const used = await this.usedIn(dir);
      if (used.bytes + bytes.length > WORKSPACE_PICTURES_MOST) {
        throw new ApiError("FILE_TOO_BIG", `this workspace's board keeps at most ${WORKSPACE_PICTURES_MOST / 1024 / 1024} MB of pictures and holds ${(used.bytes / 1024 / 1024).toFixed(1)} MB: make the picture smaller before adding it`);
      }
      used.bytes += bytes.length;
      try {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        const part = `${file}.${randomBytes(4).toString("hex")}.part`;
        await fs.promises.writeFile(part, bytes, { mode: 0o600 });
        await fs.promises.rename(part, file);
      } catch (e) {
        used.bytes -= bytes.length;
        throw e;
      }
    }
    const image: BoardImage = { hash, ...facts };
    this.facts.set(`${repo}\0${hash}`, image);
    return image;
  }

  private usedIn(dir: string): Promise<{ bytes: number }> {
    let used = this.used.get(dir);
    if (!used) {
      used = fs.promises.readdir(dir, { withFileTypes: true }).then(
        async (entries) => ({ bytes: (await Promise.all(entries.filter((e) => e.isFile()).map((e) => fs.promises.stat(path.join(dir, e.name)).then((st) => st.size, () => 0)))).reduce((a, b) => a + b, 0) }),
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return { bytes: 0 };
          this.used.delete(dir);
          throw e;
        },
      );
      this.used.set(dir, used);
    }
    return used;
  }

  /** What the picture `hash` kept for `repo` is, or null when none is. */
  find(repo: string, hash: string): BoardImage | null {
    if (!HASH.test(hash)) return null;
    const key = `${repo}\0${hash}`;
    if (this.facts.has(key)) return this.facts.get(key)!;
    let image: BoardImage | null = null;
    try {
      const fd = fs.openSync(path.join(this.folder(repo), hash), "r");
      try {
        // A JPEG's size can sit after its metadata.
        const head = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        const facts = imageFacts(head.subarray(0, n)) ?? (n === head.length ? imageFacts(fs.readFileSync(path.join(this.folder(repo), hash))) : null);
        image = facts ? { hash, ...facts } : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* not kept here */ }
    if (image) this.facts.set(key, image);
    return image;
  }

  /** The bytes of the picture `hash` kept for `repo`, as base64, or null when none is. */
  async read(repo: string, hash: string): Promise<{ type: BoardImageType; data: string } | null> {
    const image = this.find(repo, hash);
    if (!image) return null;
    const bytes = await fs.promises.readFile(path.join(this.folder(repo), hash)).catch(() => null);
    return bytes ? { type: image.type, data: bytes.toString("base64") } : null;
  }
}

/** The bytes of a picture as a caller sends it, `{ type, data }` in base64, at most `IMAGE_BYTES_MOST`. */
function bytesOf(given: unknown): Buffer {
  const data = (given as Partial<StartImage> | null)?.data;
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new ApiError("BAD_REQUEST", "a picture is { type, data }: its bytes in base64");
  if (data.length > Math.ceil(IMAGE_BYTES_MOST / 3) * 4) throw new ApiError("BAD_REQUEST", `a picture is at most ${IMAGE_BYTES_MOST / 1024 / 1024} MB`);
  return Buffer.from(data, "base64");
}
