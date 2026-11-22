// Keep the runtime's reported version in sync with package.json.
// Emitted next to the compiled output so it travels with dist/ into QQ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: pkg.version }) + '\n');
console.log(`[gen-version] dist/version.json -> ${pkg.version}`);
