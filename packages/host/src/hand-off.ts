/**
 * Hand off by bundle (M4, design §5.4 item 5): the branch a participant has checked out in a frame
 * of theirs on their machine lands in the workspace host's repository as a branch of its own,
 * `handoff/<who>/<branch>`, and a Diff tile on the board shows what it adds to the branch the host
 * has checked out. It goes as a git bundle of what it adds to the branches the participant's clone
 * tracks, or of its whole history when the host lacks what that builds on (`handOffFrom`). The
 * host checks the bundle against its repository and fetches from it (`handOff`, the workspace
 * API's `git.handOff`): its working tree, index and own branches are never touched, and a person
 * lands again only over a hand-off of their own, never over anyone else's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import { named, type Connection, type Domain } from "@hivemind/workspace-api/server";
import { mintId } from "@hivemind/workspace-api/tile-id";
import type { HandedOff } from "@hivemind/workspace-api/git";
import type { TileRecord } from "@hivemind/workspace-doc/shapes";
import { gitBundleCreate, gitBundleVerify, gitLandBranch, gitListBranches } from "./git-adapter.js";

/** The largest bundle a host takes. */
export const HAND_OFF_MAX_BYTES = 32 * 1024 * 1024;
/** What a host answers a bundle whose history it lacks the start of. */
export const LACKS_HISTORY = "the host's repository lacks commits this hand-off builds on";

export interface HandOffOptions {
  /** Who a connection is: their person key, and the name the workspace knows them by. */
  who(from: Connection): { person: string; name: string };
  /** Put `tile` on the board of the workspace whose repo is `repo`, named `name`. */
  place(repo: string, tile: TileRecord, name: string): void;
}

/** Who writes a hand-off's Diff tile to the board. */
export const HANDED_OFF = { writer: "hand-off" };

/** A Diff tile that compares two branches. */
export type CompareTile = TileRecord & { compare: { base: string; head: string } };

/** A name as a branch's path takes it: lowercase letters and digits, joined by dashes. */
const slug = (name: string): string => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** A branch name as a hand-off takes it: one git takes as a branch, written plainly. */
function branchOf(value: unknown): string {
  const b = text(value, "branch");
  const plain = /^[A-Za-z0-9._/-]{1,200}$/.test(b) && !b.includes("..") && !b.includes("//") && !b.endsWith(".lock")
    && b.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.startsWith("-") && !part.endsWith("."));
  if (!plain) throw new ApiError("BAD_REQUEST", `not a branch name: ${JSON.stringify(b)}`);
  return b;
}

/** A temporary file of its own for `body`, as long as `use` runs. */
async function withFile<T>(use: (file: string) => Promise<T>, body?: Buffer): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-handoff-"));
  try {
    const file = path.join(dir, "branch.bundle");
    if (body) fs.writeFileSync(file, body, { mode: 0o600 });
    return await use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The host's side: the workspace API's `git.handOff`. */
export function handOff(o: HandOffOptions): Domain<"git.handOff"> {
  return {
    answers: {
      "git.handOff": async (from, repo, branch, bundle): Promise<HandedOff> => {
        const r = text(repo, "repo");
        const b = branchOf(branch);
        const data = text(bundle, "bundle");
        if (data.length > Math.ceil(HAND_OFF_MAX_BYTES / 3) * 4) throw new ApiError("BAD_REQUEST", `a hand-off is ${HAND_OFF_MAX_BYTES / 1024 / 1024} MB at most`);
        const { person, name } = o.who(from);
        const as = `handoff/${slug(name) || person.slice(0, 8)}/${b}`;
        await withFile(async (file) => {
          const verified = await gitBundleVerify(r, file);
          if (verified === "lacks") throw new ApiError("FAILED", LACKS_HISTORY);
          if (verified === "bad") throw new ApiError("BAD_REQUEST", "that is not a git bundle this repository reads");
          try {
            await gitLandBranch(r, file, b, as, person);
          } catch (e) {
            throw new ApiError("FAILED", e instanceof Error ? e.message : String(e));
          }
        }, Buffer.from(data, "base64"));
        const base = (await gitListBranches(r)).current ?? "HEAD";
        const tile: CompareTile = { id: mintId("tile-diff"), kind: "diff", label: "Diff", compare: { base, head: as } };
        o.place(r, tile, `${name || "Hand-off"}: ${b}`);
        return { branch: as, base };
      },
    },
    effects: {
      "git.handOff": (repo, branch) => ({ target: named(repo), detail: named(branch) }),
    },
  };
}

/** The participant's side: hand off the branch checked out in `folder` to a workspace's host,
 *  which `send` gives it to (its `git.handOff`, throwing what the host answers that is not the
 *  branch landed). What lands there. */
export async function handOffFrom(folder: string, send: (branch: string, bundle: string) => Promise<HandedOff>): Promise<HandedOff> {
  const branch = (await gitListBranches(folder)).current;
  if (!branch) throw new Error("check out a branch to hand it off");
  const bundleOf = (whole: boolean): Promise<string | null> => withFile(async (file) => {
    if (!(await gitBundleCreate(folder, file, branch, whole))) return null;
    if (fs.statSync(file).size > HAND_OFF_MAX_BYTES) throw new Error(`${branch} is over ${HAND_OFF_MAX_BYTES / 1024 / 1024} MB as a bundle: push it somewhere the host can fetch it from instead`);
    return fs.readFileSync(file).toString("base64");
  });
  const added = await bundleOf(false);
  if (added !== null) {
    try {
      return await send(branch, added);
    } catch (e) {
      if (!(e instanceof Error && e.message.includes(LACKS_HISTORY))) throw e;
    }
  }
  return send(branch, (await bundleOf(true))!);
}
