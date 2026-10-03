/**
 * Joining a workspace with its invite link, the guest's side (M1; design §4.2 B): onto the host
 * network's relays as the link says, then asking the host (`hive/pair/1`) and waiting while its
 * owner decides; once let in, the workspace is kept in this person's joined list. The app's Join
 * dialog and `hive join` both join through here.
 */
import type { DeviceCertificate } from "./identity.js";
import type { HiveNet } from "./hive-net.js";
import type { JoinLink } from "./join-link.js";
import type { JoinedList } from "./joined.js";
import type { NetworkProfiles } from "./network-profile.js";
import type { PairReply } from "./sharing.js";

export type JoinReply = PairReply | { ok: false; error: "not-admitted"; message: string };

export interface Joiner {
  net: Pick<HiveNet, "pair">;
  profiles: Pick<NetworkProfiles, "redeem" | "register">;
  certificate: DeviceCertificate;
  /** Who this person says they are, as the owner is shown. */
  profile: { name: string; color: string };
  joined: Pick<JoinedList, "add">;
}

export async function join(link: JoinLink, j: Joiner): Promise<JoinReply> {
  if (link.admission) {
    try {
      if (link.admission.voucher) await j.profiles.redeem(link.admission.access, link.admission.voucher);
      else await j.profiles.register(link.admission.access);
    } catch (e) {
      return { ok: false, error: "not-admitted", message: e instanceof Error ? e.message : String(e) };
    }
  }
  const hello = { v: 1, workspace: link.workspace, secret: link.secret, certificate: j.certificate, profile: j.profile };
  const reply = (await j.net.pair(link.host, link.where, hello)) as PairReply;
  if (reply?.ok) {
    j.joined.add({
      workspace: link.workspace, host: link.host, where: link.where, role: reply.role, names: link.names, joinedAt: Date.now(),
      ...(link.hosting ? { hosting: link.hosting } : {}),
    });
  }
  return reply;
}
