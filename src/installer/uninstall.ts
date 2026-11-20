/**
 * KatheryneQQ uninstaller: restores the original main entry and removes the
 * runtime directory.
 */
import fs from 'node:fs';
import path from 'node:path';

const qqRoot = process.argv[2] ?? '/opt/QQ';
const appDir = path.join(qqRoot, 'resources', 'app');
const backupPath = path.join(appDir, 'katheryne.json');

if (!fs.existsSync(backupPath)) {
    console.error('[katheryne] not installed (no katheryne.json found)');
    process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8')) as { main: string };
const pkgPath = path.join(appDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
pkg.main = backup.main;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
fs.rmSync(path.join(appDir, 'katheryne'), { recursive: true, force: true });
fs.rmSync(backupPath, { force: true });
console.log(`[katheryne] uninstalled, main restored to ${backup.main}`);
