/**
 * KatheryneQQ Web Console.
 *
 * Serves a self-contained control page (no external assets) and a small JSON
 * API for status / QR login / event stream / action testing. It mounts on its
 * own HTTP server, separate from the OneBot HTTP endpoint.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { OB11AnyEvent, EventBus } from '../onebot/events/bus.js';
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
    version: string;
    appid: string;
    loginError: string | null;
    qrcodeDataUrl: string | null;
    startedAt: number;
}

export interface ConsoleBridge {
    state(): ConsoleRuntimeState;
    events(): OB11AnyEvent[];
    startQRLogin(): Promise<void>;
    quickLogin(uin: string): Promise<void>;
    cancelLogin(): Promise<void>;
    actionContext(): ActionContext | null;
    logs(): string[];
    scanVtables?(): unknown;
    setPacketDebug?(on: boolean, count: number): unknown;
    /** Local QQ login records for the quick-login page. */
    logins?(): Promise<Array<{ uin: string; uid?: string; nick?: string; faceUrl?: string }>>;
    /** Raw config file (used by the network/config page). */
    getConfig?(): Promise<{ path: string; content: string }>;
    saveConfig?(content: string): Promise<{ ok: boolean; path: string; restartRequired?: boolean }>;
}

const CONSOLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KatheryneQQ</title></head>
<body style="font-family:system-ui;background:#0f1117;color:#e6ebf5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>控制台资源缺失</h2><p style="color:#8b97ad">console.html 未随运行时部署，请重新执行安装器。</p></div>
</body></html>`;

export class WebConsole {
    private server: http.Server | null = null;
    private logs: string[] = [];

    constructor(
        private readonly config: ConsoleConfig,
        private readonly bridge: ConsoleBridge,
    ) {}

    log(line: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        this.logs.push(`[${ts}] ${line}`);
        if (this.logs.length > 300) this.logs.shift();
    }

    recentLogs(): string[] {
        return this.logs;
    }

    start(): void {
        if (!this.config.enabled) return;
        this.server = http.createServer(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const send = (code: number, body: string, type = 'application/json') => {
                res.writeHead(code, { 'content-type': type });
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
                        // Serve the embedded template; a console.html alongside can override.
                        const html = fs.existsSync(htmlPath)
                            ? fs.readFileSync(htmlPath, 'utf-8')
                            : CONSOLE_HTML;
                        send(200, html, 'text/html; charset=utf-8');
                        break;
                    }
                    case '/api/state':
                        send(200, JSON.stringify(this.bridge.state()));
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
                    case '/api/scan-vtables': {
                        const r = await Promise.resolve(this.bridge.scanVtables?.()).catch((e) => ({ error: String(e) }));
                        send(200, JSON.stringify(r ?? { error: "not available" }));
                        break;
                    }
                    case '/api/packet-debug': {
                        const body = await readBody(req);
                        const { on, count } = JSON.parse(body || '{}') as { on?: boolean; count?: number };
                        const r = await Promise.resolve(this.bridge.setPacketDebug?.(!!on, Number(count) || 20)).catch((e) => ({ error: String(e) }));
                        send(200, JSON.stringify(r ?? { error: "not available" }));
                        break;
                    }
                    case '/api/mem-read': {
                        // Debug helper: read N bytes at (wrapper load bias + rva) from /proc/self/mem.
                        const rva = parseInt(url.searchParams.get('rva') ?? '0', 16);
                        const len = Math.min(parseInt(url.searchParams.get('len') ?? '32', 10) || 32, 4096);
                        try {
                            const fsMod = await import('node:fs');
                            const fs = fsMod.default ?? fsMod;
                            const maps = fs.readFileSync('/proc/self/maps', 'utf8');
                            let bias = null as bigint | null;
                            for (const l of maps.split('\n')) {
                                if (l.includes('wrapper.node') && l.includes('r-x')) {
                                    const s = BigInt('0x' + l.split('-')[0]);
                                    const off = BigInt('0x' + (l.split(/\s+/)[2] ?? '0'));
                                    bias = s - off - 0x1000n;
                                    break;
                                }
                            }
                            if (bias === null) throw new Error('wrapper r-x not mapped');
                            const addr = bias + BigInt(rva);
                            const fd = fs.openSync('/proc/self/mem', 'r');
                            const buf = Buffer.alloc(len);
                            const n = fs.readSync(fd, buf, 0, len, Number(addr));
                            fs.closeSync(fd);
                            send(200, JSON.stringify({ bias: '0x' + bias.toString(16), addr: '0x' + addr.toString(16), n, hex: buf.subarray(0, n).toString('hex') }));
                        } catch (e) {
                            send(200, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
                        }
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

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => resolve(body));
    });
}

import { fileURLToPath } from 'node:url';
