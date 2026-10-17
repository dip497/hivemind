/**
 * Where the person may start an agent from another of their devices (spec/agents.md 0.8 "Places"):
 * each machine a workspace's projects are on, with the agents found there, its projects and the
 * folders the person opened lately; inside a project, its folders. Never the rest of the disk. A
 * folder is a path here or a `machine://` uri, as a frame holds it. Electron-free.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { optionChoices, type AgentProviderDef } from "@hivemind/agents";
import { discoverOptions, findBin } from "@hivemind/agents/discover";
import { isRemote, machineUri, parseDeviceUri, parseMachineUri, type KnownMachines } from "@hivemind/core/remote-uri";
import type { Folders, PlaceFolder, Places, StartableProgram, StartImage } from "@hivemind/workspace-api/agents";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { mintId } from "@hivemind/workspace-api/tile-id";
import type { KeptCore, FrameRecord } from "@hivemind/workspace-doc/shapes";
import { remoteConns } from "./remote/conn.js";
import type { RemoteDirEntry } from "./remote/fs.js";
import { remoteTarget } from "./remote/targets.js";

/** The most folders `agent.folders` lists. */
export const FOLDERS_MAX = 200;
/** The most photos one start takes, and the most bytes each. */
export const IMAGES_MAX = 4;
export const IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<StartImage["type"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** A machine's files, as far as starting an agent there reads them. */
export interface MachineFs {
  /** `dir` with its links followed; throws for one not there. */
  realpath(dir: string): Promise<string>;
  readdir(dir: string): Promise<RemoteDirEntry[]>;
  /** Which of the commands `bins` are found there. */
  found(bins: string[]): Promise<string[]>;
  /** Keep the photo `data` as `name` there: its path. */
  keep(name: string, data: Buffer): Promise<string>;
  /** What the command of `def` there lists for each of its options; none: it is not asked. */
  choices?(def: AgentProviderDef): Promise<Record<string, string[]>>;
}

/** How long the Start screen waits on an agent's command to list its choices: past it, the
 *  manifest's alone, and the command's once it answered, next time. */
const LISTED_WAIT_MS = 1500;

export interface PlacesOptions {
  core(repo: string): KeptCore | null;
  repos(): string[];
  machines: KnownMachines;
  /** The agents switched on. */
  agents(): AgentProviderDef[];
  /** Those found here. */
  programs(): AgentProviderDef[] | Promise<AgentProviderDef[]>;
  /** The folders the person opened lately, newest first. */
  recent(): string[];
  /** The files of the saved machine `machine`, or this computer's (""). */
  files?(machine: string): Promise<MachineFs>;
  /** Where photos are kept here. */
  photos(): string;
}

/** A folder as the machine it is on (`""`: here) and its path there; null for one on no machine
 *  an agent is started on from here. */
interface Spot { machine: string; path: string }
function spotOf(folder: string): Spot | null {
  if (!isRemote(folder)) return path.isAbsolute(folder) ? { machine: "", path: path.resolve(folder) } : null;
  const at = parseMachineUri(folder);
  return at && !parseDeviceUri(folder) ? { machine: at.machineId, path: path.posix.resolve(at.path) } : null;
}
const folderOf = (s: Spot): string => (s.machine ? machineUri(s.machine, s.path) : s.path);
const pathsOf = (s: Spot) => (s.machine ? path.posix : path);

/** Whether `p` is `root` or inside it, on the machine whose paths `paths` joins. */
function inside(paths: typeof path.posix, root: string, p: string): boolean {
  const rel = paths.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}

/** This computer's files. */
export function localFs(photos: () => string): MachineFs {
  return {
    realpath: (dir) => fs.promises.realpath(dir),
    readdir: async (dir) => (await fs.promises.readdir(dir, { withFileTypes: true }))
      .map((e) => ({ name: e.name, isDir: e.isDirectory(), isSymlink: e.isSymbolicLink() })),
    found: async (bins) => bins.filter((b) => !!findBin(b)),
    choices: async (def) => {
      const listed = discoverOptions(def).then((o) => Object.fromEntries(Object.entries(o).map(([id, c]) => [id, c.values])));
      return Promise.race([listed, new Promise<Record<string, string[]>>((r) => setTimeout(() => r({}), LISTED_WAIT_MS).unref())]);
    },
    keep: async (name, data) => {
      await fs.promises.mkdir(photos(), { recursive: true, mode: 0o700 });
      const at = path.join(photos(), name);
      await fs.promises.writeFile(at, data, { mode: 0o600 });
      return at;
    },
  };
}

/** An agent as `agent.startable` lists it: its model and mode choices, those its command `listed`
 *  and those its manifest names, as the desktop's settings offer them. */
const programOf = (p: AgentProviderDef, listed: Record<string, string[]>): StartableProgram => ({
  id: p.id,
  label: p.label,
  options: (p.options ?? []).filter((x) => x.id === "model" || x.id === "mode").map((x) => ({ id: x.id, label: x.label, values: optionChoices(x, listed[x.id] ?? []) })),
});

export class StartPlaces {
  constructor(private readonly o: PlacesOptions) {}

  private files(machine: string): Promise<MachineFs> {
    if (this.o.files) return this.o.files(machine);
    return machine ? remoteConns.fs(remoteTarget(machineUri(machine))) : Promise.resolve(localFs(this.o.photos));
  }

  private board(repo: string): KeptCore {
    if (!this.o.repos().includes(repo)) throw new ApiError("NOT_FOUND", "no such workspace here");
    return this.o.core(repo) ?? { frames: [], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} };
  }

  /** The workspace's projects: its own folder, then each frame's, as the board orders them. */
  private projects(repo: string, core: KeptCore): Array<{ spot: Spot; name: string; frame?: FrameRecord }> {
    const out: Array<{ spot: Spot; name: string; frame?: FrameRecord }> = [{ spot: { machine: "", path: path.resolve(repo) }, name: path.basename(repo) }];
    for (const f of core.frames) {
      const at = f.worktreePath ?? f.workspacePath;
      const spot = typeof at === "string" ? spotOf(at) : null;
      if (spot) out.push({ spot, name: f.title || pathsOf(spot).basename(spot.path), frame: f });
    }
    return out;
  }

  /** The agents found on `machine`. */
  async programs(machine: string): Promise<AgentProviderDef[]> {
    if (!machine) return this.o.programs();
    const agents = this.o.agents();
    const found = new Set(await (await this.files(machine)).found([...new Set(agents.map((a) => a.bin))]));
    return agents.filter((a) => found.has(a.bin));
  }

  /** `found` (none: the agents found on `machine`), with the choices each command there lists. */
  async startable(machine: string, found?: AgentProviderDef[]): Promise<StartableProgram[]> {
    const programs = found ?? (await this.programs(machine));
    const files = await this.files(machine);
    return Promise.all(programs.map(async (p) => programOf(p, (await files.choices?.(p)) ?? {})));
  }

  /** Whether the command of `def` is found where `folder` is (none: here); true for a folder on a
   *  machine this does not ask. */
  async installedAt(def: AgentProviderDef, folder?: string): Promise<boolean> {
    const spot = folder === undefined ? { machine: "", path: "" } : spotOf(folder);
    if (!spot) return true;
    return (await (await this.files(spot.machine)).found([def.bin])).length > 0;
  }

  /** The agents found where `folder` is. */
  programsAt(folder: string): Promise<AgentProviderDef[]> {
    const spot = spotOf(folder);
    if (!spot) throw new ApiError("BAD_REQUEST", "start.folder is a folder here or on a saved machine");
    return this.programs(spot.machine);
  }

  async places(repo: string): Promise<Places> {
    const projects = this.projects(repo, this.board(repo));
    const byMachine = new Map<string, PlaceFolder[]>([["", []]]);
    const add = (spot: Spot, name: string, kind: PlaceFolder["kind"], frame?: string) => {
      const folder = folderOf(spot);
      if (spot.machine && this.o.machines.saved(spot.machine) === undefined) return;
      const there = byMachine.get(spot.machine)?.find((f) => f.path === folder);
      // The workspace's own folder is its frame's there.
      if (there) return void (there.frame ??= frame);
      byMachine.set(spot.machine, [...(byMachine.get(spot.machine) ?? []), { path: folder, name, kind, ...(frame ? { frame } : {}) }]);
    };
    for (const p of projects) add(p.spot, p.name, "project", p.frame?.id);
    for (const r of this.o.recent()) {
      const spot = spotOf(r);
      if (spot) add(spot, pathsOf(spot).basename(spot.path) || spot.path, "recent");
    }
    const name = (id: string) => (id ? this.o.machines.saved(id)! : this.o.machines.self().name);
    const ids = [...byMachine.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : name(a).toLowerCase().localeCompare(name(b).toLowerCase())));
    return {
      machines: await Promise.all(ids.map(async (id) => {
        const folders = byMachine.get(id)!;
        try {
          return { id, name: name(id), programs: await this.startable(id), folders };
        } catch (e) {
          return { id, name: name(id), programs: [], folders, unreached: e instanceof Error ? e.message : String(e) };
        }
      })),
    };
  }

  /** The project `folder` is in, on its machine, links followed: its real path and the project's. */
  private async within(repo: string, folder: string): Promise<{ spot: Spot; real: string; files: MachineFs; container?: { real: string; frame?: FrameRecord } }> {
    const spot = spotOf(folder);
    if (!spot) throw new ApiError("BAD_REQUEST", "that is a folder neither here nor on a saved machine");
    const files = await this.files(spot.machine);
    const real = await files.realpath(spot.path).catch(() => {
      throw new ApiError("NOT_FOUND", `${folder} is not a folder there`);
    });
    const paths = pathsOf(spot);
    let container: { real: string; frame?: FrameRecord } | undefined;
    for (const p of this.projects(repo, this.board(repo))) {
      if (p.spot.machine !== spot.machine) continue;
      const root = await files.realpath(p.spot.path).catch(() => null);
      if (!root || !inside(paths, root, real)) continue;
      // The innermost project it is in; of two at one folder, the frame.
      if (!container || root.length > container.real.length || (root === container.real && !container.frame)) container = { real: root, ...(p.frame ? { frame: p.frame } : {}) };
    }
    return { spot, real, files, ...(container ? { container } : {}) };
  }

  async folders(repo: string, folder: string): Promise<Folders> {
    const { spot, real, files, container } = await this.within(repo, folder);
    if (!container) throw new ApiError("FORBIDDEN", "only the folders inside this workspace's projects are listed");
    const paths = pathsOf(spot);
    const dirs = (await files.readdir(real)).filter((e) => e.isDir && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    return {
      path: folderOf({ machine: spot.machine, path: real }),
      folders: dirs.slice(0, FOLDERS_MAX).map((name) => ({ name, path: folderOf({ machine: spot.machine, path: paths.join(real, name) }) })),
      ...(dirs.length > FOLDERS_MAX ? { more: true as const } : {}),
    };
  }

  /** The frame an agent started in `folder` runs in: the one there, else one opened for it, inside
   *  the project it is in, or at the top for a folder the person opened lately. */
  async frameFor(repo: string, folder: string, open: (frame: FrameRecord) => void): Promise<string> {
    const { spot, real, files, container } = await this.within(repo, folder);
    const paths = pathsOf(spot);
    for (const f of this.board(repo).frames) {
      const at = f.worktreePath ?? f.workspacePath;
      const s = typeof at === "string" ? spotOf(at) : null;
      if (s && s.machine === spot.machine && (await files.realpath(s.path).catch(() => null)) === real) return f.id;
    }
    const recent = this.o.recent().some((r) => spotOf(r) && folderOf(spotOf(r)!) === folderOf(spot));
    if (!container && !recent) throw new ApiError("FORBIDDEN", "that folder is in none of this workspace's projects, and not one opened lately");
    const frame: FrameRecord = {
      id: mintId("frame"), title: paths.basename(real) || real, workspacePath: folderOf({ machine: spot.machine, path: real }),
      ...(container?.frame ? { parentFrameId: container.frame.id } : {}),
    };
    open(frame);
    return frame.id;
  }

  /** Keep `images` on the machine `folder` is on: their paths. */
  async keep(folder: string, images: StartImage[]): Promise<string[]> {
    const spot = spotOf(folder);
    if (!spot) throw new ApiError("BAD_REQUEST", "that is a folder neither here nor on a saved machine");
    const files = await this.files(spot.machine);
    const kept: string[] = [];
    for (const i of images) kept.push(await files.keep(`${randomBytes(8).toString("hex")}.${IMAGE_TYPES[i.type]}`, Buffer.from(i.data, "base64")));
    return kept;
  }

  domain(): Domain<"agent.places" | "agent.folders"> {
    return {
      answers: {
        "agent.places": (_from, repo) => this.places(text(repo, "workspace")),
        "agent.folders": (_from, repo, folder) => this.folders(text(repo, "workspace"), text(folder, "folder")),
      },
      effects: {},
    };
  }
}

/** `start.images`, checked: at most `IMAGES_MAX`, each a known type of at most `IMAGE_BYTES`. */
export function imagesOf(value: unknown): StartImage[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > IMAGES_MAX) throw new ApiError("BAD_REQUEST", `start.images is a list of at most ${IMAGES_MAX} photos`);
  return value.map((v) => {
    const i = v as Partial<StartImage> | null;
    if (!i || typeof i.type !== "string" || !Object.hasOwn(IMAGE_TYPES, i.type) || typeof i.data !== "string") throw new ApiError("BAD_REQUEST", "a photo is { type, data }: a png, jpeg, webp or gif, in base64");
    if (i.data.length > Math.ceil(IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(i.data)) throw new ApiError("BAD_REQUEST", `a photo is base64 of at most ${IMAGE_BYTES} bytes`);
    return { type: i.type as StartImage["type"], data: i.data };
  });
}
