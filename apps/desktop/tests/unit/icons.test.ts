// The app draws one icon set at one stroke weight, chosen in components/icons.tsx. A file that
// imports an icon package itself draws icons that module did not choose, and fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const OWNER = path.join("src", "renderer", "src", "components", "icons.tsx");
const PACKAGES = /from\s+["'](@hugeicons\/[^"']+|lucide-react|@phosphor-icons\/[^"']+|@tabler\/icons[^"']*|react-icons[^"']*)["']/;

/** The files under `dir` that import an icon package. */
export function strays(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...strays(p)); continue; }
    if (/\.tsx?$/.test(e.name) && path.relative(ROOT, p) !== OWNER && PACKAGES.test(fs.readFileSync(p, "utf8"))) out.push(path.relative(ROOT, p));
  }
  return out;
}

test("the check finds a file that imports an icon package", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "tests", ".icons-"));
  try {
    fs.writeFileSync(path.join(dir, "a.tsx"), 'import { X } from "lucide-react";\n');
    fs.writeFileSync(path.join(dir, "b.tsx"), 'import { X } from "../components/icons";\n');
    assert.deepEqual(strays(dir).map((f) => path.basename(f)), ["a.tsx"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const dir of ["src/renderer", "tools", "views"]) {
  test(`${dir} draws icons only through components/icons.tsx`, () => {
    assert.deepEqual(strays(path.join(ROOT, dir)), []);
  });
}
