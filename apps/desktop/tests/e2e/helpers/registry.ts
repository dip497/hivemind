// A HiveHub-shaped catalog built from this repository's examples, every id scoped the way a
// published plugin's is, so an e2e run installs the same kind of id the app gets from HiveHub.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SCOPE = "@e2e";
const REPO = path.resolve("../..");
const VIEWS = ["queue", "tiled", "board"];

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const walk = (dir: string, base = dir): string[] => fs.readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return fs.statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
});
const hashed = (dir: string) => walk(dir).sort().map((f) => ({ path: f, sha256: sha(fs.readFileSync(path.join(dir, f))) }));
const field = (yaml: string, k: string) => yaml.match(new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, "m"))?.[1] ?? "";

export interface Registry { dir: string; indexUrl: string; add(p: { id: string; type: "agent" | "view"; name: string; files: Record<string, string>; bin?: string }): void }

/** Write the registry into `dir`; views need their dist built first. */
export function buildRegistry(dir: string): Registry {
  const plugins: Record<string, unknown>[] = [];
  for (const v of VIEWS) {
    const dest = path.join(dir, "views", v);
    fs.cpSync(path.join(REPO, "examples/views", v, "dist"), dest, { recursive: true });
    const file = path.join(dest, "hivemind-view.json");
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.id = `${SCOPE}/${v}`;
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "examples/views", v, "package.json"), "utf8"));
    plugins.push({
      id: m.id, type: "view", name: m.name, author: "e2e", version: m.version, path: `views/${v}`, files: hashed(dest),
      description: String(pkg.description ?? m.name).replace(/^Example community view for hivemind: /, ""),
    });
  }
  for (const a of fs.readdirSync(path.join(REPO, "examples/agents"))) {
    const yaml = fs.readFileSync(path.join(REPO, "examples/agents", a, "agent.yaml"), "utf8").replace(/^id:.*$/m, `id: "${SCOPE}/${a}"`);
    fs.mkdirSync(path.join(dir, "agents", a), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", a, "agent.yaml"), yaml);
    const label = field(yaml, "label") || a;
    plugins.push({
      id: `${SCOPE}/${a}`, type: "agent", name: label, description: label, author: "e2e", version: "1.0.0",
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
