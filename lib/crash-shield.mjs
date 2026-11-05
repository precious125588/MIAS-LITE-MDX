// ESM wrapper around lib/crash-shield.cjs so the ESM bots (mias/, new-page/)
// get the exact same protection: `import '../lib/crash-shield.mjs'`.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const shield = require(path.join(here, 'crash-shield.cjs'));

export const install = shield.install;
export const onCleanup = shield.onCleanup;
export default shield;
