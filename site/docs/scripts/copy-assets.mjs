// The guide's pictures and icon live beside its pages in guide/; the app serves them from public/.
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guide = path.resolve(app, '../../guide');
const pub = path.join(app, 'public');

rmSync(pub, { recursive: true, force: true });
cpSync(path.join(guide, 'images'), path.join(pub, 'images'), { recursive: true });
cpSync(path.join(guide, 'favicon.png'), path.join(pub, 'favicon.png'));
console.log('guide: copied images and favicon into public/');
