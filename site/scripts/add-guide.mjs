// The guide is its own app (docs/), exported as static files; the site serves them at /guide.
import { cpSync, existsSync, rmSync } from 'node:fs';

const from = new URL('../docs/out/', import.meta.url);
const to = new URL('../dist/guide/', import.meta.url);
if (!existsSync(from)) throw new Error('guide: docs/out is missing; run `npm --prefix docs run build` first');
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('guide: copied docs/out into dist/guide');
