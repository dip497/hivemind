// Sharing a workspace, the host's side (sharing.ts, design §4.2 A–B): someone with a valid invite
// whom the host's person lets in gets the invite's role for their device, and a single-use invite
// is spent; a declined request, a spent or expired invite, a certificate for another device or a
// malformed request gets nothing. And the link an invite travels in.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessLists } from "../src/access.ts";
import { Sharing, type JoinRequest } from "../src/sharing.ts";
import { formatJoinLink, parseJoinLink } from "../src/join-link.ts";
import { certifyDevice, idOf, newSeed, newWorkspaceId } from "../src/identity.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sharing-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function host(answers: boolean[] = []) {
  const lists = new AccessLists({ dir: path.join(dir, "access"), owner: newSeed() });
  const asked: JoinRequest[] = [];
  const admitted: string[][] = [];
  const sharing = new Sharing(lists, async (r) => { asked.push(r); return answers.shift() ?? true; }, (d) => admitted.push(d));
  return { lists, sharing, asked, admitted };
}
function guest() {
  const person = newSeed();
  const certificate = certifyDevice(person, idOf(newSeed()));
  return { person: idOf(person), certificate, device: certificate.device };
}
const hello = (ws: string, secret: string, g: ReturnType<typeof guest>, name = "Priya") =>
  ({ v: 1, workspace: ws, secret, certificate: g.certificate, profile: { name, color: "#14B8A6" } });

test("someone with an invite whom the host lets in gets its role for their device, and a single-use invite is spent", async () => {
  const { lists, sharing, asked, admitted } = host();
  const ws = newWorkspaceId();
  const secret = lists.invite(ws, "/work/api", "edit", 60_000);
  const priya = guest();
  expect(await sharing.answer(priya.device, hello(ws, secret, priya, "  Priya  "))).toEqual({ ok: true, role: "edit", workspace: ws });
  expect(asked).toEqual([{ workspace: ws, repo: "/work/api", person: priya.person, device: priya.device, profile: { name: "Priya", color: "#14b8a6" }, role: "edit" }]);
  expect(lists.accessOf(ws, priya.device)).toBe("edit");
  expect(admitted.at(-1)).toEqual([priya.device]);
  // Spent: nobody else joins with it.
  const sam = guest();
  expect(await sharing.answer(sam.device, hello(ws, secret, sam))).toEqual({ ok: false, error: "expired" });
  expect(lists.accessOf(ws, sam.device)).toBeNull();
  // A reusable one lets several in.
  const open = lists.invite(ws, "/work/api", "view", 60_000, true);
  expect((await sharing.answer(sam.device, hello(ws, open, sam))).ok).toBe(true);
  const kim = guest();
  expect((await sharing.answer(kim.device, hello(ws, open, kim))).ok).toBe(true);
  expect(admitted.at(-1)).toEqual([priya.device, sam.device, kim.device].sort());
});

test("a declined request, an expired invite, a certificate for another device or a malformed request gets nothing", async () => {
  const { lists, sharing } = host([false]);
  const ws = newWorkspaceId();
  const secret = lists.invite(ws, "/work/api", "terminals", 60_000);
  const priya = guest();
  expect(await sharing.answer(priya.device, hello(ws, secret, priya))).toEqual({ ok: false, error: "declined" });
  expect(lists.accessOf(ws, priya.device)).toBeNull();
  // Declining does not spend the invite.
  expect(lists.offered(ws, secret)).toBe("terminals");
  // The certificate must be the connecting device's: a link copied to another device does not work.
  expect(await sharing.answer(idOf(newSeed()), hello(ws, secret, priya))).toEqual({ ok: false, error: "not-this-device" });
  for (const bad of [null, "hi", { ...hello(ws, secret, priya), v: 2 }, { ...hello(ws, secret, priya), certificate: { ...priya.certificate, issuedAt: 1 } }]) {
    expect(await sharing.answer(priya.device, bad)).toEqual({ ok: false, error: "malformed" });
  }
  expect(await sharing.answer(priya.device, hello(ws, "0".repeat(64), priya))).toEqual({ ok: false, error: "expired" });
  const soon = lists.invite(ws, "/work/api", "view", 50);
  await Bun.sleep(80);
  expect(await sharing.answer(priya.device, hello(ws, soon, priya))).toEqual({ ok: false, error: "expired" });
  expect(lists.accessOf(ws, priya.device)).toBeNull();
  expect(() => lists.invite(ws, "/work/api", "agents" as never, 60_000)).toThrow(TypeError);
});

test("an invite link carries the host, the workspace, the secret and where to reach the host; anything else is not one", () => {
  const link = { host: "a".repeat(64), workspace: "b".repeat(32), secret: "c".repeat(64), where: { addrs: ["192.168.1.4:51820"], relay: null }, names: { workspace: "api", host: "Adarsh" } };
  const text = formatJoinLink(link);
  expect(text).toMatch(/^hivemind:\/\/join\/a{64}#[A-Za-z0-9_-]+$/);
  expect(parseJoinLink(`  ${text}\n`)).toEqual(link);
  for (const bad of ["", "https://example.com", `hivemind://join/${"a".repeat(64)}`, `hivemind://join/${"a".repeat(63)}#e30`, `hivemind://join/${"a".repeat(64)}#e30`]) {
    expect(parseJoinLink(bad)).toBeNull();
  }
});
