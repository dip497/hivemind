import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

const exe = process.platform === "win32" ? "hive-net.exe" : "hive-net";

/** Where hive-net is: named by HIVEMIND_HIVE_NET, else where the installers put it, else on PATH,
 *  else (running from source) the crate's build. */
export function hiveNetBin(): string | null {
  const candidates = [
    process.env.HIVEMIND_HIVE_NET,
    path.join(os.homedir(), ".hivemind-app", exe),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
    ...(app.isPackaged ? [] : ["release", "debug"].map((p) => path.join(app.getAppPath(), "../../crates/hive-net/target", p, exe))),
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}
