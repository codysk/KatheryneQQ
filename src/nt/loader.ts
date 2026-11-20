/**
 * Loader for QQ's native kernel modules.
 *
 * KatheryneQQ loads wrapper.node / major.node directly with process.dlopen.
 * This is the same native code the official client uses, resolved relative to
 * the QQ installation we are booted from — nothing is copied or patched.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WrapperNodeApi } from './wrapper.js';

export interface QQPackageInfo {
    name: string;
    version: string;
    buildVersion: string;
    appid?: Record<string, string>;
    main?: string;
    platform?: string;
    eleArch?: string;
}

export interface LoadedKernel {
    wrapper: WrapperNodeApi;
    packageInfo: QQPackageInfo;
    appDir: string;
    resourcesPath: string;
}

function dlopenNative(exportsObject: { exports: Record<string, unknown> }, modulePath: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).dlopen(exportsObject, modulePath);
}

export function resolveAppDir(): string {
    // boot.js sits inside resources/app/katheryne (ESM: derive from import.meta.url).
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist layout: <app>/katheryne/<...>. Walk up until package.json (ours) is found.
    let dir = here;
    for (let i = 0; i < 6; i++) {
        if (existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(here, '../..');
}

export function findWrapperNode(appDir: string): string {
    const candidates = [
        path.join(appDir, 'wrapper.node'),
        path.join(appDir, '..', 'app', 'wrapper.node'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error(`wrapper.node not found under ${appDir}`);
}

export function findMajorNode(appDir: string): string | null {
    const candidates = [path.join(appDir, 'major.node'), path.join(appDir, '..', 'app', 'major.node')];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

export function loadKernelFromQQ(): LoadedKernel {
    const appDir = resolveAppDir();
    const packageInfo = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8')) as QQPackageInfo;

    const wrapperMod = { exports: {} as Record<string, unknown> };
    dlopenNative(wrapperMod, findWrapperNode(appDir));
    const wrapper = wrapperMod.exports as unknown as WrapperNodeApi;

    const majorPath = findMajorNode(appDir);
    if (majorPath) {
        // major.node carries the packet/oidb machinery. Loading it early makes
        // getMSFService()/packet send paths fully functional later on.
        try {
            const majorMod = { exports: {} as Record<string, unknown> };
            dlopenNative(majorMod, majorPath);
            (wrapper as unknown as Record<string, unknown>)['__katheryneMajor'] = majorMod.exports;
        } catch {
            // major.node is optional for basic flows; packet API degrades.
        }
    }

    return {
        wrapper,
        packageInfo,
        appDir,
        resourcesPath: path.dirname(appDir),
    };
}

/**
 * AppID / QUA for the running QQ build. Reads the `QQAppId/` marker embedded
 * in major.node (the authoritative source), falling back to the known table.
 */
export function resolveAppIdentity(packageInfo: QQPackageInfo, appDir: string): { appid: string; qua: string } {
    const version = packageInfo.version; // e.g. 3.2.35-54395
    const build = packageInfo.buildVersion ?? version.split('-')[1] ?? '0';
    const qua = `V1_LNX_NQ_${version}_${build}_GW_B`;

    const majorPath = findMajorNode(appDir);
    if (majorPath) {
        try {
            const content = readFileSync(majorPath);
            const marker = Buffer.from('QQAppId/', 'utf-8');
            let pos = 0;
            while (true) {
                const i = content.indexOf(marker, pos);
                if (i === -1) break;
                const start = i + marker.length;
                const end = content.indexOf(0x00, start);
                if (end === -1) break;
                const s = content.subarray(start, end).toString('utf-8');
                if (/^\d+$/.test(s)) return { appid: s, qua };
                pos = end + 1;
            }
        } catch {
            // fall through to fallback table
        }
    }
    // Conservative fallback for recent Linux builds.
    const fallback: Record<string, string> = {
        '3.2.35-54395': '537403759',
    };
    return { appid: fallback[version] ?? '537246140', qua };
}
