/**
 * Files an agent here sends the person's phone (`hive ctl send-file`, spec/sent-files.md): each a
 * copy frozen when sent, kept in one folder readable by this user alone, for the phone to fetch in
 * pieces by its id whenever it is next reached. The phone never names a path. No role names these
 * methods, so no guest reaches them. Electron-free.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { mimeFor } from "@hivemind/core/view-files";
import type { SentFile, SentFilePiece } from "@hivemind/workspace-api/agents";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { onThisMachine } from "./conversations.js";

/** The most of a file sent in one answer. */
export const SENT_FILE_PIECE = 1024 * 1024;
/** The largest file sent at all: a phone holds it whole in memory until it is saved. */
export const SENT_FILE_MAX = 32 * 1024 * 1024;
export const SENT_FILE_KEPT_DAYS = 7;
const KEPT_MS = SENT_FILE_KEPT_DAYS * 24 * 60 * 60 * 1000;
/** What all the copies here may take: the oldest go first. */
const KEPT_BYTES = 1024 * 1024 * 1024;
/** The files an agent's chat shows at most: its oldest go first. */
export const SENT_FILES_PER_AGENT = 50;

/** The folder under the app's data that holds the copies. */
export const SENT_FILES_DIR = "sent-files";

/** What the views' list of file types has not. */
const DOCUMENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".csv": "text/csv", ".md": "text/markdown", ".log": "text/plain", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const typeOf = (name: string): string => DOCUMENT_TYPES[path.extname(name).toLowerCase()] ?? mimeFor(name).split(";")[0]!;

const ID = /^[0-9a-f]{32}$/;
const NAME_MAX = 200;

/** What a file is called on the phone: its name with no folder, and nothing that draws as something
 *  else (a control character, or one that reverses the text around it). */
export function sentFileName(file: string): string {
  const name = path.basename(file).replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (name.length <= NAME_MAX) return name || "file";
  const ext = path.extname(name).slice(0, 20);
  return name.slice(0, NAME_MAX - ext.length) + ext;
}

function fileOf(value: unknown): SentFile | null {
  const f = value as Partial<SentFile> | null;
  return f && typeof f.id === "string" && ID.test(f.id) && typeof f.tile === "string" && typeof f.name === "string" && typeof f.type === "string"
    && Number.isSafeInteger(f.size) && Number.isFinite(f.at)
    ? (f as SentFile)
    : null;
}

/** The copies, and what each is, read from the folder once and held from then on. */
export class SentFileStore {
  private held: Promise<Map<string, SentFile>> | null = null;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private bytesOf(id: string): string {
    return path.join(this.dir, id);
  }

  private files(): Promise<Map<string, SentFile>> {
    return (this.held ??= this.load());
  }

  /** What the folder holds. What a stop part way through a send left is removed. */
  private async load(): Promise<Map<string, SentFile>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const names = await readdir(this.dir);
    const files = new Map<string, SentFile>();
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const file = fileOf(await readFile(path.join(this.dir, name), "utf8").then(JSON.parse).catch(() => null));
      if (file && `${file.id}.json` === name) files.set(file.id, file);
    }
    await Promise.all(names.filter((n) => !files.has(n.replace(/\.json$/, ""))).map((n) => rm(path.join(this.dir, n), { force: true })));
    await this.sweep(files);
    return files;
  }

  private alive(file: SentFile): boolean {
    return this.now() - file.at < KEPT_MS;
  }

  private async remove(files: Map<string, SentFile>, id: string): Promise<void> {
    files.delete(id);
    await rm(`${this.bytesOf(id)}.json`, { force: true });
    await rm(this.bytesOf(id), { force: true });
  }

  /** Past their time, past what an agent's chat shows, past what the folder may hold: oldest first. */
  private async sweep(files: Map<string, SentFile>): Promise<void> {
    const oldest = [...files.values()].sort((a, b) => a.at - b.at);
    const going = new Set(oldest.filter((f) => !this.alive(f)));
    const staying = oldest.filter((f) => !going.has(f));
    const perAgent = new Map<string, number>();
    for (const f of staying) perAgent.set(f.tile, (perAgent.get(f.tile) ?? 0) + 1);
    let bytes = staying.reduce((all, f) => all + f.size, 0);
    for (const f of staying) {
      const over = perAgent.get(f.tile)! > SENT_FILES_PER_AGENT;
      if (!over && bytes <= KEPT_BYTES) continue;
      going.add(f);
      perAgent.set(f.tile, perAgent.get(f.tile)! - 1);
      bytes -= f.size;
    }
    await Promise.all([...going].map((f) => this.remove(files, f.id)));
  }

  /** Copy `source` here for the agent of `tile`: what was frozen, and the tiles whose lists changed
   *  by what that pushed out. */
  async add(tile: string, source: string): Promise<{ file: SentFile; changed: string[] }> {
    const files = await this.files();
    const found = await stat(source).catch(() => null);
    if (!found) throw new ApiError("NOT_FOUND", `there is no file at ${source}`);
    if (!found.isFile()) throw new ApiError("BAD_REQUEST", `${source} is not a file`);
    const tooBig = (size: number) => new ApiError("FILE_TOO_BIG", `${path.basename(source)} is ${Math.ceil(size / 1024 / 1024)} MiB: a phone takes at most ${SENT_FILE_MAX / 1024 / 1024} MiB`);
    if (found.size > SENT_FILE_MAX) throw tooBig(found.size);
    const id = randomBytes(16).toString("hex");
    const going = `${this.bytesOf(id)}.going`;
    try {
      await copyFile(source, going);
      await chmod(going, 0o600);
      // It may have grown on its way here: the copy is what is sent.
      const { size } = await stat(going);
      if (size > SENT_FILE_MAX) throw tooBig(size);
      const name = sentFileName(source);
      const file: SentFile = { id, tile, name, size, type: typeOf(name), at: this.now() };
      await rename(going, this.bytesOf(id));
      await writeFile(`${this.bytesOf(id)}.going.json`, JSON.stringify(file), { mode: 0o600 });
      await rename(`${this.bytesOf(id)}.going.json`, `${this.bytesOf(id)}.json`);
      const before = new Map(files);
      files.set(id, file);
      await this.sweep(files);
      const changed = new Set([tile]);
      for (const [gone, was] of before) if (!files.has(gone)) changed.add(was.tile);
      return { file, changed: [...changed] };
    } catch (e) {
      await rm(going, { force: true });
      throw e;
    }
  }

  /** What the agent of `tile` sent and is still here, oldest first. */
  async of(tile: string): Promise<SentFile[]> {
    const files = await this.files();
    return [...files.values()].filter((f) => f.tile === tile && this.alive(f)).sort((a, b) => a.at - b.at);
  }

  async find(id: string): Promise<SentFile | null> {
    const file = (await this.files()).get(id);
    return file && this.alive(file) ? file : null;
  }

  /** Up to a piece of the copy `id`, from `offset`. */
  async piece(id: string, offset: number): Promise<SentFilePiece> {
    const file = await this.find(id);
    if (!file) throw new ApiError("NOT_FOUND", "that file is no longer on this computer");
    const handle = await open(this.bytesOf(id), "r").catch(() => {
      throw new ApiError("NOT_FOUND", "that file is no longer on this computer");
    });
    try {
      const piece = Buffer.alloc(Math.max(0, Math.min(SENT_FILE_PIECE, file.size - offset)));
      const { bytesRead } = await handle.read(piece, 0, piece.length, offset);
      return { data: piece.subarray(0, bytesRead).toString("base64"), size: file.size };
    } finally {
      await handle.close();
    }
  }

  /** Remove the copy `id`. */
  async take(id: string): Promise<void> {
    await this.remove(await this.files(), id);
  }
}

export interface SentFilesOptions {
  store: SentFileStore;
  /** Where the agent of `tile` (bare) runs: its folder, null when no agent runs in such a tile. */
  place(tile: string): string | null;
  /** Whether a folder is on another machine, whose files this computer cannot copy. */
  elsewhere(place: string): boolean;
  /** How many of the person's phones are paired here. */
  phones(): number;
}

const callerOf = (from: Connection): string | undefined => (from.actor.kind === "peer" && from.actor.tile ? toBareId(from.actor.tile) : undefined);

export function sentFiles(o: SentFilesOptions): Domain<"agent.sendFile" | "agent.sentFiles" | "agent.takeBackFile" | "agent.files" | "agent.filePiece"> {
  /** Who follows which agent's files, each told its whole list when it changes, until they go. */
  const following = new Map<Connection, Set<string>>();
  /** The role that lets an agent here ask this lets a guest of that role ask too: a device on the
   *  network never may. */
  const here = (from: Connection): void => {
    if (!onThisMachine(from)) throw new ApiError("FORBIDDEN", "this is for a program on this computer");
  };
  const tell = async (tiles: string[]): Promise<void> => {
    for (const tile of tiles) {
      const files = await o.store.of(tile);
      for (const [connection, tilesFollowed] of following) {
        if (tilesFollowed.has(tile)) connection.send({ event: "agent.filesChanged", params: [tile, files] });
      }
    }
  };
  return {
    answers: {
      "agent.sendFile": async (from, tile, file) => {
        const bare = toBareId(text(tile, "tile"));
        const source = text(file, "path");
        here(from);
        const caller = callerOf(from);
        if (caller && caller !== bare) throw new ApiError("FORBIDDEN", "an agent sends files as itself");
        if (!path.isAbsolute(source)) throw new ApiError("BAD_REQUEST", "path must be absolute");
        const place = o.place(bare);
        if (place === null) throw new ApiError("NO_AGENT", `no agent runs in a tile ${bare}: only an agent has a chat on the phone`);
        if (o.elsewhere(place)) throw new ApiError("UNSUPPORTED", "this agent runs on another machine: its files are not on this computer");
        if (o.phones() === 0) throw new ApiError("NO_PHONE", "no phone is paired with this computer");
        const { file: sent, changed } = await o.store.add(bare, source);
        await tell(changed);
        return sent;
      },
      "agent.sentFiles": async (from, tile) => {
        here(from);
        return { files: await o.store.of(toBareId(text(tile, "tile"))) };
      },
      "agent.files": async (from, tile) => {
        const bare = toBareId(text(tile, "tile"));
        let mine = following.get(from);
        if (!mine) following.set(from, (mine = new Set()));
        mine.add(bare);
        return { files: await o.store.of(bare) };
      },
      "agent.filePiece": async (_from, id, offset) => {
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError("BAD_REQUEST", "offset is a whole number of bytes");
        return o.store.piece(text(id, "id"), offset);
      },
      "agent.takeBackFile": async (from, id) => {
        here(from);
        const file = await o.store.find(text(id, "id"));
        if (!file) return { takenBack: false };
        const caller = callerOf(from);
        if (caller && caller !== file.tile) throw new ApiError("FORBIDDEN", "an agent takes back only what it sent");
        await o.store.take(file.id);
        await tell([file.tile]);
        return { takenBack: true };
      },
    },
    effects: {
      "agent.sendFile": (tile) => ({ target: typeof tile === "string" ? toBareId(tile) : undefined }),
      "agent.takeBackFile": (id) => ({ target: typeof id === "string" ? id : undefined }),
    },
    gone: (connection) => {
      following.delete(connection);
    },
  };
}
