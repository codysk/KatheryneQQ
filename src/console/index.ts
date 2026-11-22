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
}

const CONSOLE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KatheryneQQ 控制台</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f1420; color: #dbe2f0; }
header { display: flex; align-items: center; gap: 12px; padding: 14px 22px; background: #151c2c; border-bottom: 1px solid #232c42; }
header h1 { font-size: 17px; margin: 0; }
.badge { padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #2b3550; }
.badge.online { background: #1d5c3d; color: #7ef0b2; }
.badge.offline { background: #5c2b2b; color: #f0a2a2; }
main { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px 22px; max-width: 1400px; margin: 0 auto; }
.card { background: #151c2c; border: 1px solid #232c42; border-radius: 10px; padding: 16px; }
.card h2 { margin: 0 0 10px; font-size: 14px; color: #9fb0d0; font-weight: 600; }
.kv { display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; font-size: 13px; }
.kv .k { color: #7f8db0; }
#qr { max-width: 240px; border-radius: 8px; background: #fff; padding: 8px; display: none; margin: 10px 0; }
button { background: #2f6fed; border: 0; color: #fff; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; }
button.gray { background: #3a4562; }
button:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
input, select { background: #0f1420; color: #dbe2f0; border: 1px solid #2b3550; border-radius: 8px; padding: 7px 10px; font-size: 13px; }
#events { height: 420px; overflow-y: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; }
#events .ev { padding: 4px 8px; border-bottom: 1px solid #1b2338; white-space: pre-wrap; word-break: break-all; }
#events .ev.message { color: #9ee493; }
#events .ev.notice { color: #e4c07a; }
#events .ev.request { color: #9db9f0; }
#events .ev.meta_event { color: #5d6b8c; }
#log { height: 180px; overflow-y: auto; font: 12px/1.5 ui-monospace, monospace; color: #8fa2c8; background: #0c111c; padding: 8px; border-radius: 8px; }
.test-result { margin-top: 8px; font: 12px ui-monospace, monospace; color: #9ee493; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1>KatheryneQQ</h1>
  <span id="phase" class="badge">loading</span>
  <span id="selfinfo" style="color:#7f8db0;font-size:13px"></span>
</header>
<main>
  <div>
    <div class="card">
      <h2>登录</h2>
      <div class="kv">
        <span class="k">QQ 版本</span><span id="qqver">-</span>
        <span class="k">AppID</span><span id="appid">-</span>
        <span class="k">运行时长</span><span id="uptime">-</span>
      </div>
      <div class="row">
        <button id="btn-qr">扫码登录</button>
        <input id="uin" placeholder="QQ 号（快速登录）" style="width:180px">
        <button id="btn-quick" class="gray">快速登录</button>
        <button id="btn-cancel" class="gray">取消</button>
      </div>
      <img id="qr" alt="二维码">
      <div id="login-hint" style="color:#e4c07a;font-size:12px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>动作调试</h2>
      <div class="row">
        <select id="action" style="min-width:200px"></select>
        <input id="params" placeholder='{"group_id":"123","message":"hi"}' style="flex:1">
        <button id="btn-run">执行</button>
      </div>
      <div id="result" class="test-result"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>运行日志</h2>
      <div id="log"></div>
    </div>
  </div>
  <div class="card">
    <h2>事件流（最近 500 条）</h2>
    <div id="events"></div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let lastEventCount = 0;

function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function refresh(){
  try {
    const st = await (await fetch('/api/state')).json();
    $('phase').textContent = st.phase;
    $('phase').className = 'badge ' + (st.phase === 'online' ? 'online' : 'offline');
    $('selfinfo').textContent = st.selfUin ? (st.selfNick + ' (' + st.selfUin + ')') : '';
    $('qqver').textContent = st.version;
    $('appid').textContent = st.appid;
    $('uptime').textContent = Math.floor((Date.now() - st.startedAt) / 1000) + 's';
    if (st.qrcodeDataUrl) { $('qr').src = st.qrcodeDataUrl; $('qr').style.display = 'block'; }
    else { $('qr').style.display = 'none'; }
    $('login-hint').textContent = st.loginError || '';
  } catch(e) {}
  const evs = await (await fetch('/api/events')).json();
  if (evs.length !== lastEventCount) {
    lastEventCount = evs.length;
    $('events').innerHTML = evs.map(e => '<div class="ev ' + esc(e.post_type) + '">' + esc(JSON.stringify(e)) + '</div>').join('');
    $('events').scrollTop = $('events').scrollHeight;
  }
  const logs = await (await fetch('/api/logs')).json();
  $('log').textContent = logs.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

$('btn-qr').onclick = async () => { await fetch('/api/login/qr', {method:'POST'}); refresh(); };
$('btn-quick').onclick = async () => {
  await fetch('/api/login/quick', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({uin: $('uin').value})});
  refresh();
};
$('btn-cancel').onclick = async () => { await fetch('/api/login/cancel', {method:'POST'}); refresh(); };
$('btn-run').onclick = async () => {
  let params = {};
  try { params = $('params').value ? JSON.parse($('params').value) : {}; } catch(e) { $('result').textContent = '参数 JSON 解析失败: ' + e.message; return; }
  const r = await (await fetch('/api/action', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({action: $('action').value, params})})).json();
  $('result').textContent = JSON.stringify(r, null, 2);
};

(async () => {
  const names = await (await fetch('/api/actions')).json();
  $('action').innerHTML = names.map(n => '<option>' + n + '</option>').join('');
})();
setInterval(refresh, 1500);
refresh();
</script>
</body>
</html>`;

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
