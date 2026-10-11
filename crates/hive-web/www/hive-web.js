// This browser as one of the person's devices (docs/design/phone-browser-2026-10-03.md §3): its
// device key and what pairing gave it, kept in IndexedDB; the wasm (hive-phone's core) pairs,
// signs and reads. iroh signs with the key's bytes, so a non-extractable WebCrypto key cannot be
// the device key itself: the seed is kept sealed under one (AES-GCM), which the page cannot read
// out, so a copy of the browser's storage alone does not carry the key.
import init, { Device, deviceId, pair } from "./pkg/hive_web.js";

const STORE = "kept";

function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("hive-web", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function kept(op) {
  const store = (await db()).transaction(STORE, "readwrite").objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = op(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const get = (key) => kept((s) => s.get(key));
const put = (key, value) => kept((s) => s.put(value, key));
const remove = (key) => kept((s) => s.delete(key));

/** This browser's device key, its 32-byte seed: made the first time, then kept sealed. */
async function deviceKey() {
  const [sealing, sealed] = [await get("sealing"), await get("device")];
  if (sealing && sealed) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, sealing, sealed.key));
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await put("sealing", key);
  await put("device", { iv, key: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed) });
  return seed;
}

/** This browser as the person's device: its id, the computer it paired with, and what it reads
 *  there. `wasm` is where the module is, when not beside this file. */
export async function openPhone(wasm) {
  await init(wasm);
  const seed = await deviceKey();
  let paired = (await get("paired")) ?? null;
  return {
    id: deviceId(seed),
    /** `{with, certificate, network, admission}`, or null before it pairs. */
    get paired() {
      return paired;
    },
    /** Pair with the computer whose link (Settings → Devices → Pair a phone) is `link`, as `name`. */
    async pair(link, name) {
      const given = await pair(seed, link, name);
      await put("paired", given);
      paired = given;
      return given;
    },
    /** A connection to the computer: `needs()`, `follow(listed)`, `open(name)`, `close()`. */
    async reach() {
      if (!paired) throw new Error("this browser is paired with nothing yet: pair it with your computer");
      const { device: id, relay, name } = paired.with;
      const device = await Device.start(seed, relay ? [relay] : []);
      try {
        const host = await device.reach(id, relay);
        return {
          needs: () => host.needs(name),
          follow: (listed) => host.follow(listed),
          open: (stream) => host.open(stream),
          close: async () => {
            host.close();
            await device.close();
          },
        };
      } catch (e) {
        await device.close();
        throw e;
      }
    },
    /** Forget the computer: pairing again starts afresh. */
    async forget() {
      await remove("paired");
      paired = null;
    },
  };
}
