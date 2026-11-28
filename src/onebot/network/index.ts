/**
 * OneBot v11 network adapters: WebSocket server, WebSocket client (reverse WS),
 * HTTP server, HTTP POST (upstream report).
 *
 * All transports share the same EventBus + dispatchAction pipeline.
 */
import http from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import crypto from 'node:crypto';
import type { OB11AnyEvent, EventBus } from '../events/bus.js';
import { dispatchAction, type ActionContext, type ActionParams } from '../actions/index.js';

export interface NetworkConfig {
    http: { enabled: boolean; host: string; port: number; access_token?: string; event_post_url?: string };
    ws: { enabled: boolean; host: string; port: number; access_token?: string };
    reverseWs: { enabled: boolean; urls: string[]; access_token?: string };
}

interface WsLike {
    send(data: string): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    close(code?: number): void;
}

/**
 * Minimal RFC6455 server implementation (no external deps): enough for
 * OneBot clients, keeps the package dependency-free.
 */
class WebSocketServerShim {
    private clients = new Map<number, WsLike>();
    private nextId = 1;
    private server: HttpServer | null = null;
    onConnection: ((ws: WsLike) => void) | null = null;

    private writeHandshake(socket: import('node:net').Socket, key: string): void {
        const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
    }

    private encodeFrame(payload: Buffer): Buffer {
        const opcode = 0x1; // text
        const len = payload.length;
        let header: Buffer;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, len]);
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        return Buffer.concat([header, payload]);
    }

    private handleFrame(id: number, buf: Buffer, emitData: (id: number, text: string) => void): void {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
            len = buf.readUInt16BE(2);
            off = 4;
        } else if (len === 127) {
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
        }
        let maskKey: Buffer | null = null;
        if (masked) {
            maskKey = buf.subarray(off, off + 4);
            off += 4;
        }
        const payload = buf.subarray(off, off + len);
        if (masked && maskKey) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        }
        if (opcode === 0x8) {
            this.clients.get(id)?.close(1000);
            this.clients.delete(id);
            return;
        }
        if (opcode === 0x9) {
            // ping -> pong (opcode 0xA) with same payload, server frames unmasked
            const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
            (this.clients.get(id) as unknown as { raw: import('node:net').Socket }).raw?.write(pong);
            return;
        }
        if (opcode === 0x1) {
            emitData(id, payload.toString('utf-8'));
        }
    }

    listen(port: number, host: string, token: string | undefined, onData: (text: string) => Promise<string | null>): void {
        const { createServer } = http;
        const server = createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });
        this.server = server;
        const sockets = new Map<number, import('node:net').Socket>();

        server.on('upgrade', (req: IncomingMessage, socket: import('node:net').Socket) => {
            const key = req.headers['sec-websocket-key'];
            if (!key) {
                socket.destroy();
                return;
            }
            if (token) {
                const auth = req.headers.authorization ?? '';
                const url = new URL(req.url ?? '/', 'http://localhost');
                const q = url.searchParams.get('access_token') ?? '';
                if (auth !== `Bearer ${token}` && q !== token) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
            this.writeHandshake(socket, key);
            const id = this.nextId++;
            const wsLike: WsLike = {
                send: (data: string) => {
                    socket.write(this.encodeFrame(Buffer.from(data, 'utf-8')));
                },
                on: () => undefined,
                close: () => socket.destroy(),
            };
            (wsLike as unknown as { raw: import('node:net').Socket }).raw = socket;
            this.clients.set(id, wsLike);
            sockets.set(id, socket);
            this.onConnection?.(wsLike);

            let acc: Buffer = Buffer.alloc(0);
            socket.on('data', (chunk: Buffer) => {
                acc = Buffer.concat([acc, chunk]);
                // process as many frames as available
                while (acc.length >= 2) {
                    let len = acc[1] & 0x7f;
                    let off = 2;
                    if (len === 126) {
                        if (acc.length < 4) return;
                        len = acc.readUInt16BE(2);
                        off = 4;
                    } else if (len === 127) {
                        if (acc.length < 10) return;
                        len = Number(acc.readBigUInt64BE(2));
                        off = 10;
                    }
                    const masked = (acc[1] & 0x80) !== 0;
                    if (masked) off += 4;
                    if (acc.length < off + len) return;
                    const frame = acc.subarray(0, off + len);
                    acc = acc.subarray(off + len);
                    this.handleFrame(id, frame, (_i, text) => {
                        void onData(text).then((resp) => {
                            if (resp) wsLike.send(resp);
                        });
                    });
                }
            });
            socket.on('close', () => {
                this.clients.delete(id);
                sockets.delete(id);
            });
            socket.on('error', () => {
                this.clients.delete(id);
                sockets.delete(id);
            });
        });

        server.listen(port, host);
    }

    broadcast(text: string): void {
        for (const ws of this.clients.values()) {
            try {
                ws.send(text);
            } catch {
                // dead socket cleaned up on its own error/close path
            }
        }
    }

    clientCount(): number {
        return this.clients.size;
    }

    close(): void {
        this.server?.close();
        for (const ws of this.clients.values()) ws.close();
        this.clients.clear();
    }
}

export class NetworkManager {
    private wsServer = new WebSocketServerShim();
    private httpServer: HttpServer | null = null;
    private reverseClients: Array<{ send(t: string): void }> = [];
    private unsubscribers: Array<() => void> = [];

    constructor(
        private readonly config: NetworkConfig,
        private readonly bus: EventBus,
        private readonly actionCtx: () => ActionContext,
    ) {}

    private dispatchJson(text: string): Promise<string | null> {
        return (async () => {
            try {
                const parsed = JSON.parse(text) as { action?: string; params?: ActionParams; echo?: unknown };
                if (parsed.action) {
                    const result = await dispatchAction(parsed.action, parsed.params ?? {}, this.actionCtx());
                    return JSON.stringify({ ...result, echo: parsed.echo ?? null });
                }
                return null;
            } catch (e) {
                const err = e as Error & { retcode?: number };
                return JSON.stringify({
                    status: 'failed',
                    retcode: err.retcode ?? 1200,
                    message: err.message,
                    data: null,
                });
            }
        })();
    }

    start(): void {
        const sub = this.bus.subscribe((event: OB11AnyEvent) => {
            const text = JSON.stringify(event);
            if (this.config.ws.enabled) this.wsServer.broadcast(text);
            for (const rc of this.reverseClients) {
                try {
                    rc.send(text);
                } catch {
                    // dropped client
                }
            }
            if (this.config.http.enabled && this.config.http.event_post_url) {
                void this.postEvent(text);
            }
        });
        this.unsubscribers.push(sub);

        if (this.config.ws.enabled) {
            this.wsServer.listen(
                this.config.ws.port,
                this.config.ws.host,
                this.config.ws.access_token,
                (t) => this.dispatchJson(t),
            );
        }

        if (this.config.http.enabled) {
            this.httpServer = http.createServer((req, res) => {
                if (!req.url) {
                    res.writeHead(400).end();
                    return;
                }
                const url = new URL(req.url, 'http://localhost');
                if (this.config.http.access_token) {
                    const q = url.searchParams.get('access_token') ?? '';
                    const auth = req.headers.authorization ?? '';
                    if (q !== this.config.http.access_token && auth !== `Bearer ${this.config.http.access_token}`) {
                        res.writeHead(403, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ status: 'failed', retcode: 1403, data: null }));
                        return;
                    }
                }
                const action = url.pathname.replace(/^\//, '');
                const collect = (body: string) => {
                    let params: ActionParams = {};
                    try {
                        const urlParams: Record<string, unknown> = {};
                        for (const [k, v] of url.searchParams.entries()) urlParams[k] = v;
                        params = body ? (JSON.parse(body) as ActionParams) : urlParams;
                    } catch {
                        params = {};
                    }
                    void this.dispatchJson(JSON.stringify({ action, params }))
                        .then((out) => {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(out ?? '{}');
                        });
                };
                let body = '';
                req.on('data', (c: Buffer) => (body += c.toString()));
                req.on('end', () => collect(body));
            });
            this.httpServer.listen(this.config.http.port, this.config.http.host);
        }

        if (this.config.reverseWs.enabled) {
            for (const raw of this.config.reverseWs.urls) {
                this.connectReverse(raw, this.config.reverseWs.access_token).catch((e) =>
                    console.error('[katheryne] reverse ws connect failed', raw, e.message),
                );
            }
        }
    }

    private postEvent(text: string): void {
        const url = new URL(this.config.http.event_post_url!);
        const data = text;
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(data),
                    ...(this.config.http.access_token
                        ? { authorization: `Bearer ${this.config.http.access_token}` }
                        : {}),
                },
            },
            () => undefined,
        );
        req.on('error', () => undefined);
        req.write(data);
        req.end();
    }

    private async connectReverse(urlStr: string, token: string | undefined): Promise<void> {
        const url = new URL(urlStr);
        const net = await import('node:net');
        const socket = net.connect(Number(url.port || 80), url.hostname);
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', () => resolve());
            socket.once('error', reject);
        });
        const key = crypto.randomBytes(16).toString('base64');
        const headers =
            `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `Host: ${url.hostname}:${url.port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            (token ? `Authorization: Bearer ${token}\r\n` : '') +
            '\r\n';
        socket.write(headers);
        await new Promise<void>((resolve, reject) => {
            socket.once('data', (buf: Buffer) => {
                if (buf.toString('latin1').includes('101')) resolve();
                else reject(new Error('handshake failed'));
            });
        });

        const client: { send(t: string): void } = {
            send: (text: string) => {
                const payload = Buffer.from(text, 'utf-8');
                let header: Buffer;
                if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
                else {
                    header = Buffer.alloc(4);
                    header[0] = 0x81;
                    header[1] = 126;
                    header.writeUInt16BE(payload.length, 2);
                }
                socket.write(Buffer.concat([header, payload]));
            },
        };
        this.reverseClients.push(client);

        let acc = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            acc = Buffer.concat([acc, chunk]);
            while (acc.length >= 2) {
                let len = acc[1] & 0x7f;
                let off = 2;
                if (len === 126) {
                    if (acc.length < 4) return;
                    len = acc.readUInt16BE(2);
                    off = 4;
                } else if (len === 127) {
                    if (acc.length < 10) return;
                    len = Number(acc.readBigUInt64BE(2));
                    off = 10;
                }
                const masked = (acc[1] & 0x80) !== 0;
                if (masked) off += 4;
                if (acc.length < off + len) return;
                const frame = acc.subarray(0, off + len);
                acc = acc.subarray(off + len);
                if ((frame[0] & 0x0f) === 0x1) {
                    const payload = frame.subarray(off, off + len);
                    if (masked) {
                        const maskKey = frame.subarray(off - 4, off);
                        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
                    }
                    void this.dispatchJson(payload.toString('utf-8')).then((resp) => {
                        if (resp) client.send(resp);
                    });
                }
            }
        });
        socket.on('close', () => {
            this.reverseClients = this.reverseClients.filter((c) => c !== client);
            setTimeout(() => this.connectReverse(urlStr, token).catch(() => undefined), 5000);
        });
    }

    stats(): { wsClients: number; reverseWsClients: number } {
        return {
            wsClients: this.wsServer.clientCount(),
            reverseWsClients: this.reverseClients.length,
        };
    }

    stop(): void {
        for (const u of this.unsubscribers) u();
        this.unsubscribers = [];
        this.wsServer.close();
        this.httpServer?.close();
    }
}
