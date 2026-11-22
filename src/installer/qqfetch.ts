/**
 * Official QQNT-for-Linux download support.
 *
 * The version metadata is the same JSONP config the official download page
 * uses:
 *   https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js
 *   (fallback: https://im.qq.com/rainbow/linuxConfig.js)
 * It yields { version, updateDate, x64DownloadUrl{deb,appimage,rpm}, ... }.
 *
 * We sign the package URL through the official UrlSign endpoint (qqdl
 * rejects unsigned requests with 403), download the AppImage (portable, no
 * root, any glibc distro), verify it is an ELF, then extract it with its own
 * `--appimage-extract` (no FUSE required).
 *
 * Environment overrides (useful for mirrors/CI):
 *   KATHERYNE_QQ_CONFIG_URL      – metadata JSONP URL
 *   KATHERYNE_QQ_DOWNLOAD_URL    – direct package URL (skips metadata fetch)
 *   KATHERYNE_QQ_DOWNLOAD_DIR    – where packages are cached/extracted
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface QQRelease {
    version: string;
    updateDate?: string;
    url: string;
    arch: 'x64' | 'arm64';
    kind: 'appimage';
}

const CONFIG_URLS = [
    process.env.KATHERYNE_QQ_CONFIG_URL,
    'https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js',
    'https://im.qq.com/rainbow/linuxConfig.js',
].filter(Boolean) as string[];

/**
 * Official download-link signing service, used by the im.qq.com download SPA
 * before handing a URL to the browser. Unsigned qqdl.gtimg.cn requests are
 * rejected (403); the response carries `?sign=<hex>&t=<ts>`.
 */
const SIGN_ENDPOINT = 'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
const SIGN_OIDB = JSON.stringify({ uint32_command: '0x9b8e', uint32_service_type: 1 });

function log(msg: string): void {
    console.log(`[qq-download] ${msg}`);
}

/** Sign a package URL via the official UrlSign endpoint (fallback: as-is). */
export async function signQqUrl(url: string): Promise<string> {
    try {
        const res = await fetch(SIGN_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-oidb': SIGN_OIDB,
                origin: 'https://im.qq.com',
                referer: 'https://im.qq.com/index/',
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) KatheryneQQ-installer',
            },
            body: JSON.stringify({ url }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { retcode?: number; data?: { url?: string } };
        if (body?.retcode === 0 && body?.data?.url) return body.data.url;
        throw new Error(`retcode=${body?.retcode}`);
    } catch (e) {
        log(`signing failed (${e instanceof Error ? e.message : String(e)}), using unsigned URL`);
        return url;
    }
}

function dataRoot(): string {
    return process.env.KATHERYNE_QQ_DOWNLOAD_DIR
        ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'katheryneqq', 'qq');
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) KatheryneQQ-installer',
            referer: 'https://im.qq.com/',
        },
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
}

/** Parse the JSONP payload `var params= {...}` from linuxConfig.js. */
export function parseLinuxConfig(js: string): Record<string, unknown> {
    const m = /params\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:typeof|$)/.exec(js);
    const raw = m ? m[1] : js.trim();
    // Trailing callback code may follow the object; cut at the balanced brace.
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const json = end > 0 ? raw.slice(0, end) : raw;
    return JSON.parse(json) as Record<string, unknown>;
}

/** Resolve the official AppImage for this machine (metadata or env override). */
export async function resolveQQRelease(): Promise<QQRelease> {
    const arch: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64';
    const direct = process.env.KATHERYNE_QQ_DOWNLOAD_URL;
    if (direct) {
        return { version: process.env.KATHERYNE_QQ_VERSION ?? 'custom', url: direct, arch, kind: 'appimage' };
    }

    let lastErr: unknown;
    for (const cfgUrl of CONFIG_URLS) {
        try {
            log(`fetching version metadata: ${cfgUrl}`);
            const cfg = parseLinuxConfig(await fetchText(cfgUrl));
            const version = String(cfg.version ?? 'unknown');
            const archKey = arch === 'arm64' ? 'armDownloadUrl' : 'x64DownloadUrl';
            const urls = (cfg[archKey] ?? {}) as Record<string, string>;
            const url = urls.appimage;
            if (!url) throw new Error(`no ${archKey}.appimage in metadata (version ${version})`);
            log(`official channel: QQ ${version} (${cfg.updateDate ?? 'n/a'})`);
            return { version, updateDate: String(cfg.updateDate ?? ''), url, arch, kind: 'appimage' };
        } catch (e) {
            lastErr = e;
            log(`metadata source failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    throw new Error(`cannot fetch QQ version metadata: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function download(url: string, dest: string): Promise<void> {
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const signed = await signQqUrl(url);
    if (signed !== url) log('URL signed');
    const res = await fetch(signed, {
        headers: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) KatheryneQQ-installer',
            // Real browsers download from the im.qq.com SPA; fragments are
            // stripped by the client, so the wire value has no '#/linux'.
            referer: 'https://im.qq.com/index/',
        },
        redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${signed}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let written = 0, lastLog = 0;
    const out = fs.createWriteStream(part);
    await pipeline(
        Readable.fromWeb(res.body as never),
        async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
                written += chunk.length;
                if (written - lastLog > 10 * 1024 * 1024) {
                    lastLog = written;
                    const pct = total ? ` (${((written / total) * 100).toFixed(0)}%)` : '';
                    log(`downloaded ${(written / 1048576).toFixed(1)} MiB${pct}`);
                }
                yield chunk;
            }
        },
        out,
    );
    fs.renameSync(part, dest);
    if (written < 20 * 1024 * 1024) {
        throw new Error(`download too small (${written} bytes) — likely an error page, not an AppImage`);
    }
    const fd = fs.openSync(dest, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString('binary') !== '\x7fELF') {
        throw new Error('downloaded file is not an ELF AppImage');
    }
}

/** Download + extract official QQ; returns the extracted QQ root. */
export async function downloadQQ(release?: QQRelease): Promise<{ qqRoot: string; release: QQRelease }> {
    const rel = release ?? await resolveQQRelease();
    const root = dataRoot();
    const workDir = path.join(root, rel.version);
    const cached = path.join(root, 'downloads', `QQ_${rel.version}_${rel.arch}.AppImage`);
    const qqRoot = path.join(workDir, 'squashfs-root');

    if (fs.existsSync(path.join(qqRoot, 'resources', 'app', 'package.json'))) {
        log(`already extracted: ${qqRoot}`);
        return { qqRoot, release: rel };
    }

    if (!fs.existsSync(cached)) {
        log(`downloading ${rel.url}`);
        await download(rel.url, cached);
    } else {
        log(`using cached package: ${cached}`);
    }

    fs.mkdirSync(workDir, { recursive: true });
    log(`extracting AppImage -> ${workDir}`);
    fs.chmodSync(cached, 0o755);
    execFileSync(cached, ['--appimage-extract'], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] });
    if (!fs.existsSync(path.join(qqRoot, 'resources', 'app', 'package.json'))) {
        throw new Error(`extraction failed: ${qqRoot}/resources/app/package.json missing`);
    }
    log(`extracted: ${qqRoot}`);
    return { qqRoot, release: rel };
}
