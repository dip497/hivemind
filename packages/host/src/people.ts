/**
 * Who is in a workspace (the workspace API's `people.*`; M1, M3, design §4.2 B–C, §6): the people
 * on its access list, whether each is connected now, their roles, and the links that let more in,
 * as the workspace's host keeps them. Its owner asks, at a window of the host's own or from another
 * of their devices while the workspace is hosted on one they moved it to; nobody else may
 * (`roles.ts` names none of these). Changing someone's role or taking them off closes their
 * connections, so what they do from then on is under the list as it is.
 *
 * Someone asking to join (`Sharing`) is asked about of the owner wherever they are: each of their
 * windows connected to the host is told (`people.asked`), the first answer counts and the others
 * are told it came (`people.answered`); with none of their windows here, their phones are. A
 * workspace may instead let in anyone with a valid invite at its role (`people.answering`).
 */
import path from "node:path";
import { ANSWERING, LINK_ROLES, ROLES, type AccessLists, type LinkRole, type Person } from "@hivemind/workspace-host/access";
import type { Ready } from "@hivemind/workspace-host/hive-net";
import { formatJoinLink } from "@hivemind/workspace-host/join-link";
import type { NetworkProfiles } from "@hivemind/workspace-host/network-profile";
import type { JoinRequest } from "@hivemind/workspace-host/sharing";
import type { JoinQuestion } from "@hivemind/workspace-api/people";
import { flag, oneOf, text, whole } from "@hivemind/workspace-api/protocol";
import { named, type Connection, type Domain, type WorkspaceServer } from "@hivemind/workspace-api/server";

/** How long the owner has to answer someone asking to join before they are declined. */
export const ANSWER_WITHIN_MS = 170_000;

export interface PeopleOptions {
  lists(): AccessLists;
  /** The workspace the repo here is, once it says whose it is; null before. */
  workspaceOf(repo: string): string | null;
  /** The people connected to `workspace` now. */
  connected(workspace: string): Set<string>;
  /** Close each connection `person` has to `workspace`, telling them `reason`. */
  disconnect(workspace: string, person: string, reason: string): void;
  /** Whom the lists admit changed: tell the gate. */
  admit(): void;
  /** This device on the network, and the network in use: what a link says of where it is. */
  network(): Promise<{ ready: Ready; profiles: Pick<NetworkProfiles, "active" | "voucher"> }>;
  /** Whose workspaces these are, as a link names them to the person it lets in. */
  owner(): Promise<string>;
  /** The public key of `workspace`, which a record of where it is hosted is checked against. */
  keyOf(workspace: string): string;
  /** Tell the clients `to` picks. */
  publishTo: WorkspaceServer["publishTo"];
  /** Whether the owner of `workspace` is at one of its clients now, to be asked. */
  ownerHere(workspace: string): boolean;
  /** Ask the owner's phones about `question` on `repo`, while none of their clients is here (M5):
   *  whether any phone was told. */
  phones(repo: string, question: JoinQuestion): boolean;
  /** Wait for an answer even when nobody was told: a host with no window, whose person answers at
   *  its command line (`hive people allow`). */
  waitsAway: boolean;
}

type PeopleMethod = "people.list" | "people.role" | "people.remove" | "people.invite" | "people.answer" | "people.requests" | "people.answering";

/** The owner's clients: a window of this host's own, or one of their devices. */
const owners = (c: Connection): boolean => c.actor.kind === "person" || (c.actor.kind === "peer" && c.actor.access === "owner");

export class People {
  readonly domain: Domain<PeopleMethod>;
  /** Questions waiting on the owner, by number. */
  private readonly asking = new Map<number, { repo: string; question: JoinQuestion; settle: (allow: boolean) => void }>();
  private next = 1;

  constructor(private readonly o: PeopleOptions) {
    /** The workspace the repo `repo` here is. */
    const workspaceAt = (repo: unknown): { repo: string; workspace: string } => {
      const r = text(repo, "repo");
      const workspace = o.workspaceOf(r);
      if (!workspace) throw new Error("people: this workspace does not say whose it is yet; change something in it first");
      return { repo: r, workspace };
    };
    /** `person` as the list of `workspace` has them. */
    const onList = (workspace: string, person: unknown): Person => {
      const found = o.lists().people(workspace).find((p) => p.person === person);
      if (!found) throw new Error("people: they are not on this workspace's list");
      return found;
    };
    this.domain = {
      answers: {
        // A workspace that does not say whose it is yet has nobody on a list.
        "people.list": (_, repo) => {
          const workspace = o.workspaceOf(text(repo, "repo"));
          if (!workspace) return [];
          const here = o.connected(workspace);
          return o.lists().people(workspace).map((p) => ({ ...p, present: here.has(p.person) }));
        },
        // They are reconnected, to work under the new role at once. Driving agents runs commands
        // on the host: it is given only to someone connected now.
        "people.role": (_, repo, person, role) => {
          const { workspace } = workspaceAt(repo);
          const r = oneOf(role, "role", ROLES);
          const current = onList(workspace, person);
          if (r === "agents" && !o.connected(workspace).has(current.person)) throw new Error("people: Can drive agents is given only to someone here now");
          o.lists().grant(workspace, current.person, r, current.expires);
          o.disconnect(workspace, current.person, "role changed");
        },
        // Their connections close at once, and the link they came in by lets nobody in again.
        "people.remove": (_, repo, person) => {
          const { workspace } = workspaceAt(repo);
          const current = onList(workspace, person);
          o.lists().revoke(workspace, current.person);
          o.disconnect(workspace, current.person, "removed");
          o.admit();
        },
        // A link for `role`, for `expiresIn` ms, used once unless `reusable`.
        "people.invite": async (_, repo, role, expiresIn, reusable) => {
          const { repo: r, workspace } = workspaceAt(repo);
          const offered = oneOf(role, "role", LINK_ROLES) as LinkRole;
          const ms = whole(expiresIn, "expiresIn", 1);
          const many = flag(reusable, "reusable") === true;
          // Made before the network is reached: a network that starts now says where each
          // workspace with a list is hosted, this one among them.
          const secret = o.lists().invite(workspace, r, offered, ms, many);
          const { ready, profiles } = await o.network();
          // On a network whose relays admit only who they are told to, the link carries a voucher
          // for the guest's device, for as long as the link lasts; on an open one, where to register.
          const access = (await profiles.active()).profile.access;
          const admission = !access ? null : {
            access: access.url,
            voucher: access.policy === "closed" ? await profiles.voucher({ expiresIn: ms / 1000, uses: many ? 100 : 1 }) : null,
          };
          // The workspace's key, which a record of where it is hosted is checked against, and on a
          // network with a lookup server where to look for that record: the guest finds its host
          // there wherever it is by then.
          const hosting = { key: o.keyOf(workspace), lookup: ready.lookup };
          return formatJoinLink({
            host: ready.id, workspace, secret, where: { addrs: ready.addrs, relay: ready.relay },
            names: { workspace: path.basename(r), host: await o.owner() }, admission, hosting,
          });
        },
        // The owner answers someone asking to join `repo`: the first answer counts.
        "people.answer": (_, repo, req, allow) => {
          const asked = this.asking.get(whole(req, "req", 1));
          if (!asked || asked.repo !== text(repo, "repo")) return { answered: false };
          asked.settle(flag(allow, "allow") === true);
          return { answered: true };
        },
        "people.requests": (_, repo) => {
          const r = text(repo, "repo");
          const workspace = o.workspaceOf(r);
          return {
            answering: workspace ? o.lists().answering(workspace) : "ask",
            asking: [...this.asking.values()].filter((a) => a.repo === r).map((a) => a.question),
          };
        },
        "people.answering": (_, repo, rule) => {
          const { workspace } = workspaceAt(repo);
          o.lists().setAnswering(workspace, oneOf(rule, "rule", ANSWERING));
        },
      },
      effects: {
        "people.role": (repo, person, role) => ({ target: named(repo), detail: `${String(person).slice(0, 8)}… → ${String(role)}` }),
        "people.remove": (repo, person) => ({ target: named(repo), detail: String(person).slice(0, 8) }),
        "people.invite": (repo, role) => ({ target: named(repo), detail: named(role) }),
        "people.answer": (repo, _req, allow) => ({ target: named(repo), detail: allow === true ? "allow" : "deny" }),
        "people.answering": (repo, rule) => ({ target: named(repo), detail: named(rule) }),
      },
    };
  }

  /** Ask the owner whether to let in someone asking to join (`Sharing`'s question): yes at once
   *  when the workspace lets in anyone with a valid invite. Otherwise each of the owner's clients
   *  here is asked, or with none here their phones, and the first answer counts. No, at once when
   *  nobody was asked (unless the host `waitsAway`), and when none answers within ANSWER_WITHIN_MS. */
  ask(request: JoinRequest): Promise<boolean> {
    if (this.o.lists().answering(request.workspace) === "invite") return Promise.resolve(true);
    const req = this.next++;
    const { repo } = request;
    const question: JoinQuestion = { req, workspace: path.basename(repo), profile: request.profile, role: request.role };
    const here = this.o.ownerHere(request.workspace);
    if (!here && !this.o.phones(repo, question) && !this.o.waitsAway) return Promise.resolve(false);
    return new Promise((resolve) => {
      const settle = (allow: boolean): void => {
        clearTimeout(timer);
        this.asking.delete(req);
        this.o.publishTo(owners, "people.answered", repo, req);
        resolve(allow);
      };
      const timer = setTimeout(() => settle(false), ANSWER_WITHIN_MS);
      timer.unref?.();
      this.asking.set(req, { repo, question, settle });
      this.o.publishTo(owners, "people.asked", repo, question);
    });
  }
}
