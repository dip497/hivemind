import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await access(here('../../views/orbit/dist/hivemind-view.json'));
await rm(here('./dist'), { recursive: true, force: true });
await mkdir(here('./dist/views'), { recursive: true });
await cp(here('../../views/orbit/dist'), here('./dist/views/orbit'), { recursive: true });
await cp(here('./hivemind-package.json'), here('./dist/hivemind-package.json'));
console.log('Built review-room/dist. This does not install or start the bundle.');
