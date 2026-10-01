/**
 * Web Push message encryption (RFC 8291, over RFC 8188's `aes128gcm` content coding): a notice to
 * one of the person's phones, readable by that phone alone, whichever push service carries it.
 * The phone subscribes with a P-256 public key and a 16-byte secret; each message is encrypted
 * with a key pair and a salt of its own, in one record. The phone's side is crates/hive-phone;
 * both are held to conformance/push.json (RFC 8291's example).
 */
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

/** Where a phone is told, and its keys: as a Web Push subscription has them, in base64url. */
export interface Subscription {
  endpoint: string;
  /** Its P-256 public key, uncompressed (65 bytes). */
  p256dh: string;
  /** Its authentication secret (16 bytes). */
  auth: string;
}

/** The record size every message is sent in: one record holds it whole. */
export const RECORD_SIZE = 4096;

const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac("sha256", key).update(data).digest();

/** `plaintext` encrypted to the phone whose key is `uaPublic` and secret `auth`, by the key
 *  `asPrivate`, with `salt` (RFC 8291 §3.4; RFC 8188 §2): the message body to send. */
export function encryptWith(plaintext: Uint8Array, uaPublic: Uint8Array, auth: Uint8Array, asPrivate: Uint8Array, salt: Uint8Array): Buffer {
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new RangeError("web push: a notice is one record");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(asPrivate);
  const asPublic = ecdh.getPublicKey();
  // The shared secret, combined with the phone's secret (RFC 8291 §3.3).
  const prkKey = hmac(auth, ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  // The content encryption key and nonce (RFC 8188 §2.2, §2.3).
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last record, padded with its delimiter alone.
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, asPublic, record]);
}

/** `plaintext` encrypted to the phone subscribed as `to`, with a key pair and a salt of its own. */
export function encrypt(plaintext: Uint8Array, to: Subscription): Buffer {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  return encryptWith(plaintext, Buffer.from(to.p256dh, "base64url"), Buffer.from(to.auth, "base64url"), ephemeral.getPrivateKey(), randomBytes(16));
}

/** The subscription a phone gave, when it is one: an http(s) endpoint, a P-256 public key and a
 *  16-byte secret. */
export function subscriptionOf(v: unknown): Subscription | null {
  const s = v as Partial<Subscription> | null;
  if (!s || typeof s.endpoint !== "string" || typeof s.p256dh !== "string" || typeof s.auth !== "string") return null;
  let url: URL;
  try { url = new URL(s.endpoint); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || s.endpoint.length > 1000) return null;
  const key = Buffer.from(s.p256dh, "base64url");
  const auth = Buffer.from(s.auth, "base64url");
  if (key.length !== 65 || key[0] !== 4 || auth.length !== 16) return null;
  // A point on the curve: one a secret can be agreed with.
  try {
    const check = createECDH("prime256v1");
    check.generateKeys();
    check.computeSecret(key);
  } catch {
    return null;
  }
  return { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
}
