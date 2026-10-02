// Pairing (spec/pairing.md 0.3), held to conformance/pairing.json: cases made apart from this code
// (Python's hmac and OpenSSL's Ed25519), which the phone's Rust (crates/hive-phone) is held to as
// well. The app's side here: proofs, codes and links are the spec's, and an app answers a phone that
// scanned its link with its own certificate and one naming the phone, signed by the person key, in
// the case's words, and keeps the phone as one of the person's devices.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { certificateVerifies, certifyDevice, idOf, type DeviceCertificate } from "../src/identity.ts";
import { PairingOffer, formatPairLink, pairProof, parseCode, parsePairLink, type Pairing } from "../src/pairing.ts";

interface Device { deviceSeed: string; device: string; name: string; addrs: string[]; relay: string | null }
interface Cases {
  proof: Array<{ code: string; label: "entering" | "offering" | "give"; offering: string; entering: string; proof: string }>;
  code: Array<{ text: string; code: string | null; about: string }>;
  link: Array<{ text: string; link: unknown; about: string }>;
  phone: {
    code: string;
    app: Device & { personSeed: string; person: string };
    phone: Device;
    link: string;
    prove: Record<string, unknown>;
    answer: Record<string, unknown> & { certificate: DeviceCertificate; yours: DeviceCertificate };
    networks: { taken: string[]; notTaken: unknown[] };
  };
}
const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../conformance/pairing.json"), "utf8")) as Cases;
const seed = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

test("a proof is HMAC-SHA256, keyed by the code, of its label and the two devices", () => {
  expect(cases.proof.length).toBeGreaterThan(0);
  for (const c of cases.proof) expect(pairProof(c.code, c.label, c.offering, c.entering)).toBe(c.proof);
});

test("a code is six of the words however they are typed, and anything else is none", () => {
  for (const c of cases.code) expect({ about: c.about, code: parseCode(c.text) }).toEqual({ about: c.about, code: c.code });
});

test("a link is read as the spec says, or is not one", () => {
  for (const c of cases.link) expect({ about: c.about, link: parsePairLink(c.text) }).toEqual({ about: c.about, link: c.link });
});

test("an app's link for its code is the spec's", () => {
  const { app, code, link } = cases.phone;
  expect(formatPairLink({ device: app.device, addrs: app.addrs, relay: app.relay, code, name: app.name, kind: "app" })).toBe(link);
});

test("an app answers a phone that proves it holds the code with its own certificate and one naming the phone, never the person key; and keeps the phone", () => {
  const { app, phone, code, prove, answer } = cases.phone;
  expect([idOf(seed(app.deviceSeed)), idOf(seed(app.personSeed)), idOf(seed(phone.deviceSeed))]).toEqual([app.device, app.person, phone.device]);
  expect([pairProof(code, "entering", app.device, phone.device), pairProof(code, "offering", app.device, phone.device)]).toEqual([prove.proof, answer.proof]);
  // The certificates are the spec's, for when they were signed.
  expect(certifyDevice(seed(app.personSeed), app.device, answer.certificate.issuedAt)).toEqual(answer.certificate);
  expect(certifyDevice(seed(app.personSeed), phone.device, answer.yours.issuedAt)).toEqual(answer.yours);

  // An offer of the app's, answering the phone's prove made for the offer's own code.
  const settled: Pairing[] = [];
  const offer = new PairingOffer(
    { device: app.device, name: app.name, kind: "app", certificate: answer.certificate, person: seed(app.personSeed), addrs: app.addrs, relay: app.relay },
    (p) => settled.push(p),
  );
  const proved = { ...prove, proof: pairProof(offer.code, "entering", app.device, phone.device) };
  const got = offer.answer(phone.device, proved) as Record<string, unknown>;
  expect(Object.keys(got).sort()).toEqual(Object.keys(answer).sort());
  expect({ ...got, proof: null, yours: null }).toEqual({ ...answer, proof: null, yours: null });
  expect(got.proof).toBe(pairProof(offer.code, "offering", app.device, phone.device));
  // Signed now, rather than when the case's was.
  const yours = got.yours as DeviceCertificate;
  expect(certificateVerifies(yours)).toBe(true);
  expect([yours.person, yours.device]).toEqual([answer.yours.person, answer.yours.device]);
  expect(settled).toEqual([{ with: { device: phone.device, name: phone.name, kind: "phone", certificate: yours, addrs: phone.addrs, relay: phone.relay }, person: null }]);
  // Used: the code lets nobody else in.
  expect(offer.answer(phone.device, proved)).toEqual({ ok: false, error: "expired" });
});

test("an app on a network gives it to a phone, as it has it, in its answer", () => {
  const { app, phone, prove, answer, networks } = cases.phone;
  for (const network of networks.taken) {
    const offer = new PairingOffer({ device: app.device, name: app.name, kind: "app", certificate: answer.certificate, person: seed(app.personSeed), addrs: app.addrs, relay: app.relay, network }, () => {});
    const got = offer.answer(phone.device, { ...prove, proof: pairProof(offer.code, "entering", app.device, phone.device) }) as Record<string, unknown>;
    expect(got.network).toBe(network);
  }
});
