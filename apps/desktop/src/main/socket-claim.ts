/** Bind a unix socket without stealing it from a live listener, which would orphan its PTYs. */
import net from "node:net";
import fs from "node:fs";

export type ListenResult = "listening" | "taken";

/** A connect that neither succeeds nor fails in time counts as live: never steal on a guess. */
export function probeLive(p: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(p);
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function listenOnce(server: net.Server, p: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off("listening", onListening); resolve(e); };
    const onListening = () => { server.off("error", onError); resolve(null); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(p);
  });
}

export async function listenExclusive(server: net.Server, p: string): Promise<ListenResult> {
  const first = await listenOnce(server, p);
  if (!first) return "listening";
  if (first.code !== "EADDRINUSE" || process.platform === "win32") throw first;
  if (await probeLive(p)) return "taken";
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st && !st.isSocket()) throw new Error(`${p} exists and is not a socket — refusing to remove it`);
  try { fs.unlinkSync(p); } catch { /* raced away — fine */ }
  const second = await listenOnce(server, p);
  if (!second) return "listening";
  if (second.code === "EADDRINUSE") return "taken"; // another launcher won the race
  throw second;
}
