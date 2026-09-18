// A HiveHub-shaped catalog built from the e2e fixtures, with ids shaped the way HiveHub's are —
// views scoped `@owner/name`, agents one bare name — so an e2e run installs what the app gets.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SCOPE = "@e2e";
const FIXTURES = path.resolve("tests/e2e/fixtures");
const VIEWS = ["queue", "tiled"];

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const walk = (dir: string, base = dir): string[] => fs.readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return fs.statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
});
const hashed = (dir: string) => walk(dir).sort().map((f) => ({ path: f, sha256: sha(fs.readFileSync(path.join(dir, f))) }));
const field = (yaml: string, k: string) => yaml.match(new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, "m"))?.[1] ?? "";

export interface Registry { dir: string; indexUrl: string; add(p: { id: string; type: "agent" | "view"; name: string; files: Record<string, string>; bin?: string }): void }

/** Write the registry into `dir`. */
export function buildRegistry(dir: string): Registry {
  const plugins: Record<string, unknown>[] = [];
  for (const v of VIEWS) {
    const dest = path.join(dir, "views", v);
    fs.cpSync(path.join(FIXTURES, "views", v), dest, { recursive: true });
    const file = path.join(dest, "hivemind-view.json");
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.id = `${SCOPE}/${v}`;
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
    plugins.push({
      id: m.id, type: "view", name: m.name, description: m.name, author: "e2e", version: m.version, path: `views/${v}`, files: hashed(dest),
    });
  }
  for (const a of fs.readdirSync(path.join(FIXTURES, "agents"))) {
    const yaml = fs.readFileSync(path.join(FIXTURES, "agents", a, "agent.yaml"), "utf8").replace(/^id:.*$/m, `id: ${a}`);
    fs.mkdirSync(path.join(dir, "agents", a), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", a, "agent.yaml"), yaml);
    const label = field(yaml, "label") || a;
    plugins.push({
      id: a, type: "agent", name: label, description: label, author: "e2e", version: "1.0.0",
      path: `agents/${a}`, bin: field(yaml, "bin"), files: [{ path: "agent.yaml", sha256: sha(yaml) }],
    });
  }
  const write = () => fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ version: 1, plugins }));
  write();
  return {
    dir,
    indexUrl: pathToFileURL(path.join(dir, "index.json")).href,
    add({ id, type, name, files, bin }) {
      const folder = `${type}s/${id.split("/").pop()}`;
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, folder, f), body);
      plugins.push({
        id, type, name, description: `A test ${type} from the catalog.`, author: "e2e", version: "1.0.0", path: folder,
        ...(bin ? { bin } : {}), files: Object.entries(files).map(([f, body]) => ({ path: f, sha256: sha(body) })),
      });
      write();
    },
  };
}
