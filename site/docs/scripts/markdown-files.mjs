// Each page as Markdown sits beside the page: /guide/machines/ and /guide/machines.md.
import { readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../out');
const from = path.join(out, 'md');
const files = readdirSync(from).filter((name) => name.endsWith('.md'));
for (const name of files) renameSync(path.join(from, name), path.join(out, name.replaceAll('~', '/')));
rmSync(from, { recursive: true, force: true });
console.log(`guide: ${files.length} pages as Markdown`);
