// Copy runtime npm dependencies into dist/node_modules so the installer can
// ship a self-contained runtime (host installs and the Docker image only copy
// dist/, not the repository's node_modules).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deps = ['silk-wasm'];
const targetRoot = path.join(root, 'dist', 'node_modules');

for (const dep of deps) {
    const src = path.join(root, 'node_modules', dep);
    const dst = path.join(targetRoot, dep);
    if (!fs.existsSync(src)) {
        console.error(`[copy-runtime-deps] missing ${dep} — run npm install`);
        process.exit(1);
    }
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    console.log(`[copy-runtime-deps] ${dep} -> dist/node_modules/${dep}`);
}
