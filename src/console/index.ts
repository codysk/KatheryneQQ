/**
 * KatheryneQQ Web Console.
 *
 * Serves a self-contained industrial tactical control page (no external assets)
 * plus JSON + SSE endpoints for status, QR/quick login, real-time event/log
 * streaming, action playground, config editing, and mascot image management.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OB11AnyEvent } from '../onebot/events/bus.js';
import { dispatchAction, actionNames, type ActionContext, type ActionParams } from '../onebot/actions/index.js';

export interface ConsoleConfig {
    enabled: boolean;
    host: string;
    port: number;
    username?: string;
    password?: string;
}

export interface ConsoleRuntimeState {
    phase: 'loading' | 'awaiting_login' | 'logging_in' | 'online' | 'error';
    selfUin: string;
    selfNick: string;
    appVersion: string;
    version: string;
    appid: string;
    loginError: string | null;
    qrcodeDataUrl: string | null;
    startedAt: number;
    wsClients: number;
    reverseWsClients: number;
    friendCount: number;
    groupCount: number;
    eventStats: { total: number; message: number; notice: number; request: number };
    hasServerMascot?: boolean;
}

export interface ConsoleBridge {
    state(): ConsoleRuntimeState;
    events(): OB11AnyEvent[];
    subscribeEvents?(fn: (ev: OB11AnyEvent) => void): () => void;
    startQRLogin(): Promise<void>;
    quickLogin(uin: string): Promise<void>;
    cancelLogin(): Promise<void>;
    restart?(): Promise<void>;
    actionContext(): ActionContext | null;
    logs(): string[];
    /** Local QQ login records for the quick-login page. */
    logins?(): Promise<Array<{ uin: string; uid?: string; nick?: string; faceUrl?: string }>>;
    /** Raw config file (used by the network/config page). */
    getConfig?(): Promise<{ path: string; content: string }>;
    saveConfig?(content: string): Promise<{ ok: boolean; path: string; restartRequired?: boolean }>;
    /** Directory where persistent console assets (e.g. mascot.png) live. */
    configDir?(): string;
}

const MASCOT_EXTS = ['png', 'webp', 'jpg', 'jpeg', 'gif'] as const;
const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
};

const CONSOLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KatheryneQQ</title></head>
<body style="font-family:system-ui;background:#eceef2;color:#14161a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>控制台资源缺失</h2><p style="color:#5a6270">console.html 未随运行时部署，请重新执行安装器。</p></div>
</body></html>`;

export class WebConsole {
    private server: http.Server | null = null;
    private logs: string[] = [];
    private logListeners = new Set<(line: string) => void>();

    constructor(
        private readonly config: ConsoleConfig,
        private readonly bridge: ConsoleBridge,
    ) {}

    log(line: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        const formatted = `[${ts}] ${line}`;
        this.logs.push(formatted);
        if (this.logs.length > 400) this.logs.shift();
        for (const fn of this.logListeners) {
            try { fn(formatted); } catch { /* ignore dead listener */ }
        }
    }

    recentLogs(): string[] {
        return this.logs;
    }

    /** Locate a mounted or uploaded server-side mascot image if present. */
    private findMascotFile(): { file: string; mime: string } | null {
        const candidates: string[] = [];
        if (process.env.KATHERYNE_MASCOT_PATH) {
            candidates.push(process.env.KATHERYNE_MASCOT_PATH);
        }
        const dirs = new Set<string>();
        const cfgDir = this.bridge.configDir?.();
        if (cfgDir) dirs.add(cfgDir);
        dirs.add('/data');
        for (const d of dirs) {
            for (const ext of MASCOT_EXTS) {
                candidates.push(path.join(d, `mascot.${ext}`));
            }
        }
        for (const file of candidates) {
            try {
                if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                    const ext = path.extname(file).replace('.', '').toLowerCase();
                    return { file, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
                }
            } catch { /* ignore */ }
        }
        return null;
    }

    private currentState(): ConsoleRuntimeState {
        return {
            ...this.bridge.state(),
            hasServerMascot: this.findMascotFile() !== null,
        };
    }

    start(): void {
        if (!this.config.enabled) return;
        this.server = http.createServer(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const send = (code: number, body: string, type = 'application/json') => {
                res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
                res.end(body);
            };
            // basic auth when credentials configured
            if (this.config.username && this.config.password) {
                const auth = req.headers.authorization ?? '';
                const expected = 'Basic ' + Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
                if (auth !== expected) {
                    res.writeHead(401, { 'www-authenticate': 'Basic realm="katheryne"' });
                    res.end();
                    return;
                }
            }

            try {
                switch (url.pathname) {
                    case '/':
                    case '/console': {
                        const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'console.html');
                        const html = fs.existsSync(htmlPath)
                            ? fs.readFileSync(htmlPath, 'utf-8')
                            : CONSOLE_HTML;
                        send(200, html, 'text/html; charset=utf-8');
                        break;
                    }
                    case '/api/state':
                        send(200, JSON.stringify(this.currentState()));
                        break;
                    case '/api/events':
                        send(200, JSON.stringify(this.bridge.events()));
                        break;
                    case '/api/logs':
                        send(200, JSON.stringify(this.logs));
                        break;
                    case '/api/actions':
                        send(200, JSON.stringify(actionNames));
                        break;
                    case '/api/stream': {
                        res.writeHead(200, {
                            'content-type': 'text/event-stream; charset=utf-8',
                            'cache-control': 'no-cache, no-transform',
                            connection: 'keep-alive',
                            'x-accel-buffering': 'no',
                        });
                        const emit = (event: string, payload: unknown) => {
                            try {
                                res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
                            } catch { /* closed */ }
                        };
                        let lastStateJson = JSON.stringify(this.currentState());
                        res.write(`event: state\ndata: ${lastStateJson}\n\n`);

                        const unsubEv = this.bridge.subscribeEvents?.((ev) => emit('ob11', ev));
                        const onLog = (line: string) => emit('log', line);
                        this.logListeners.add(onLog);

                        const stateTick = setInterval(() => {
                            const next = JSON.stringify(this.currentState());
                            if (next !== lastStateJson) {
                                lastStateJson = next;
                                try { res.write(`event: state\ndata: ${next}\n\n`); } catch { /* closed */ }
                            } else {
                                try { res.write(': ping\n\n'); } catch { /* closed */ }
                            }
                        }, 2000);

                        req.on('close', () => {
                            clearInterval(stateTick);
                            unsubEv?.();
                            this.logListeners.delete(onLog);
                        });
                        break;
                    }
                    case '/api/mascot': {
                        if (req.method === 'GET' || req.method === 'HEAD') {
                            const found = this.findMascotFile();
                            if (!found) {
                                send(404, '{"error":"no server mascot"}');
                                break;
                            }
                            const data = fs.readFileSync(found.file);
                            res.writeHead(200, {
                                'content-type': found.mime,
                                'content-length': data.length,
                                'cache-control': 'no-cache',
                            });
                            res.end(req.method === 'HEAD' ? undefined : data);
                            break;
                        }
                        if (req.method === 'POST') {
                            const body = await readBody(req, 16 * 1024 * 1024);
                            const { dataUrl } = JSON.parse(body || '{}') as { dataUrl?: string };
                            const m = /^data:image\/(png|webp|jpeg|jpg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? '').trim());
                            if (!m) {
                                send(400, '{"error":"invalid image data URL (png/webp/jpeg/gif supported)"}');
                                break;
                            }
                            const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
                            const buf = Buffer.from(m[2], 'base64');
                            if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
                                send(400, '{"error":"image exceeds 10MB limit"}');
                                break;
                            }
                            const dir = this.bridge.configDir?.() || '/data';
                            fs.mkdirSync(dir, { recursive: true });
                            for (const oldExt of MASCOT_EXTS) {
                                const oldPath = path.join(dir, `mascot.${oldExt}`);
                                try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { /* ignore */ }
                            }
                            const outPath = path.join(dir, `mascot.${ext}`);
                            fs.writeFileSync(outPath, buf);
                            send(200, JSON.stringify({ ok: true, path: outPath, url: `/api/mascot?t=${Date.now()}` }));
                            break;
                        }
                        if (req.method === 'DELETE') {
                            const dir = this.bridge.configDir?.() || '/data';
                            let removed = false;
                            for (const ext of MASCOT_EXTS) {
                                const p = path.join(dir, `mascot.${ext}`);
                                try {
                                    if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; }
                                } catch { /* may be read-only mount */ }
                            }
                            send(200, JSON.stringify({ ok: true, removed }));
                            break;
                        }
                        send(405, '{"error":"method not allowed"}');
                        break;
                    }
                    case '/api/logins': {
                        const r = await Promise.resolve(this.bridge.logins?.() ?? []).catch(() => []);
                        send(200, JSON.stringify(r));
                        break;
                    }
                    case '/api/config': {
                        if (req.method === 'POST') {
                            const body = await readBody(req);
                            const content = String(JSON.parse(body || '{}').content ?? '');
                            try {
                                const r = await this.bridge.saveConfig?.(content);
                                send(200, JSON.stringify(r ?? { error: 'not available' }));
                            } catch (e) {
                                send(200, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
                            }
                        } else {
                            const r = await Promise.resolve(this.bridge.getConfig?.() ?? { path: '', content: '' })
                                .catch((e) => ({ path: '', content: JSON.stringify({ error: String(e) }, null, 2) }));
                            send(200, JSON.stringify(r));
                        }
                        break;
                    }
                    case '/api/login/qr':
                        await this.bridge.startQRLogin();
                        send(200, '{"ok":true}');
                        break;
                    case '/api/login/quick': {
                        const body = await readBody(req);
                        const uin = String(JSON.parse(body || '{}').uin ?? '');
                        await this.bridge.quickLogin(uin);
                        send(200, '{"ok":true}');
                        break;
                    }
                    case '/api/login/cancel':
                        await this.bridge.cancelLogin();
                        send(200, '{"ok":true}');
                        break;
                    case '/api/restart': {
                        if (req.method !== 'POST') {
                            send(405, '{"error":"method not allowed"}');
                            break;
                        }
                        send(200, '{"ok":true}');
                        void this.bridge.restart?.();
                        break;
                    }
                    case '/api/action': {
                        const body = await readBody(req);
                        const { action, params } = JSON.parse(body || '{}') as { action: string; params: ActionParams };
                        const ctx = this.bridge.actionContext();
                        if (!ctx) {
                            send(200, JSON.stringify({ status: 'failed', retcode: 1403, data: null, message: 'not logged in' }));
                        } else {
                            send(200, JSON.stringify(await dispatchAction(action, params ?? {}, ctx)));
                        }
                        break;
                    }
                    default:
                        send(404, '{"error":"not found"}');
                }
            } catch (e) {
                send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            }
        });
        this.server.listen(this.config.port, this.config.host);
        this.log(`console listening on http://${this.config.host}:${this.config.port}/console`);
    }

    stop(): void {
        this.server?.close();
    }
}

function readBody(req: http.IncomingMessage, limitBytes = 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limitBytes) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
