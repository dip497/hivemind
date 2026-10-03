/**
 * Sharing a workspace, the host's side (M1; design §4.2 A–B): someone with an invite asks to join
 * over `hive/pair/1`. Their device shows its certificate, which must name the device that
 * connected, and the invite's secret; the person at the host allows or declines; on allow the
 * person is granted the invite's role, their device is recorded and the invite is used. The
 * devices the lists admit are then what the network gate lets in.
 */
import { profileOf, type ProfileSettings } from "@hivemind/core/settings-schema";
import type { AccessLists, LinkRole } from "./access.js";
import { certificateVerifies, type DeviceCertificate } from "./identity.js";

/** What someone asking to join sends. */
export interface Hello {
  v: 1;
  workspace: string;
  secret: string;
  certificate: DeviceCertificate;
  profile: ProfileSettings;
}

/** Someone asking to join, as the person at the host is asked about them. */
export interface JoinRequest {
  workspace: string;
  repo: string;
  person: string;
  device: string;
  profile: ProfileSettings;
  role: LinkRole;
}

export type PairReply =
  | { ok: true; role: LinkRole; workspace: string }
  | { ok: false; error: "expired" | "declined" | "not-this-device" | "malformed" };

export class Sharing {
  constructor(
    private readonly lists: AccessLists,
    /** Ask the person at the host: the role they are let in at (the link's, or another the
     *  person chose), or null. */
    private readonly ask: (request: JoinRequest) => Promise<LinkRole | null>,
    /** The devices the lists admit changed: give them to the gate. */
    private readonly admittedChanged: (devices: string[]) => void,
  ) {}

  /** The answer to `peer` (the device that connected, as its key proved it), who sent `hello`. */
  async answer(peer: string, hello: unknown): Promise<PairReply> {
    const h = hello as Partial<Hello> | null;
    if (!h || h.v !== 1 || typeof h.workspace !== "string" || typeof h.secret !== "string") return { ok: false, error: "malformed" };
    if (!certificateVerifies(h.certificate)) return { ok: false, error: "malformed" };
    if (h.certificate.device !== peer) return { ok: false, error: "not-this-device" };
    const role = this.lists.offered(h.workspace, h.secret);
    const repo = this.lists.repoOf(h.workspace);
    if (!role || !repo) return { ok: false, error: "expired" };
    const request: JoinRequest = { workspace: h.workspace, repo, person: h.certificate.person, device: peer, profile: profileOf(h.profile), role };
    const given = await this.ask(request);
    if (!given) return { ok: false, error: "declined" };
    // Asked again after the answer: the invite may have been used or expired while the person decided.
    if (this.lists.offered(h.workspace, h.secret) !== role) return { ok: false, error: "expired" };
    this.lists.grant(h.workspace, request.person, given);
    this.lists.redeem(h.workspace, h.secret, request.person);
    this.lists.remember(h.workspace, request.person, request.profile);
    this.lists.addDevice(h.workspace, h.certificate);
    this.admittedChanged(this.lists.admitted());
    return { ok: true, role: given, workspace: h.workspace };
  }
}
