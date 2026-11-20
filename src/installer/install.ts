/**
 * KatheryneQQ installer.
 *
 * Takes a QQNT Linux installation (AppImage extracted, .deb installed, or a
 * directory) and:
 *   1. copies `dist/` (this runtime) into resources/app/katheryne/
 *   2. rewrites resources/app/package.json "main" to ./katheryne/boot.js
 *
 * The encrypted application.asar is left untouched; QQ's own loader keeps
 * reading it, and the plaintext package.json alone decides the entry module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface InstallOptions {
    qqRoot: string; // directory containing `qq` binary (AppImage extracted root or /opt/QQ)
    source: string; // directory holding this runtime's dist output (default ../.. from this file)
}

function findQQRoot(argv: string[]): string {
    const explicit = argv[2];
    const candidates = explicit ? [explicit] : ['/opt/QQ', '/usr/share/qq', process.env.KATHERYNE_QQ_ROOT ?? ''];
    for (const c of candidates) {
        if (!c) continue;
        const abs = path.resolve(c);
        if (fs.existsSync(path.join(abs, 'resources', 'app', 'package.json'))) return abs;
    }
    throw new Error(
        'QQ root not found. Extract the AppImage (./QQ.AppImage --appimage-extract) or pass the directory that contains resources/app/package.json',
    );
}

function findDistRoot(): string {
    // dist/installer/install.js -> project dist root is ../../
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function install({ qqRoot, source }: InstallOptions): void {
    const appDir = path.join(qqRoot, 'resources', 'app');
    const pkgPath = path.join(appDir, 'package.json');

    if (!fs.existsSync(pkgPath)) {
        throw new Error(`not a QQ app dir: ${appDir}`);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const prevMain = pkg.main as string;

    // 1. backup original main (idempotent installs keep the first backup)
    const backupPath = path.join(appDir, 'katheryne.json');
    if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, JSON.stringify({ main: prevMain, installedAt: new Date().toISOString() }, null, 2));
    }

    // 2. copy runtime into resources/app/katheryne
    const target = path.join(appDir, 'katheryne');
    fs.mkdirSync(target, { recursive: true });
    copyDir(source, target);

    // 3. point main at our boot file
    pkg.main = './katheryne/boot.js';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    console.log(`[katheryne] installed into ${target}`);
    console.log(`[katheryne] package.json main: ${prevMain} -> ${pkg.main}`);
    console.log('[katheryne] uninstall: node katheryne/uninstall.js');
}

function copyDir(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else fs.copyFileSync(src, dst);
    }
}

// CLI
const qqRoot = findQQRoot(process.argv);
install({ qqRoot, source: findDistRoot() });
