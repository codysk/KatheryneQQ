/**
 * KatheryneQQ runtime: boot -> kernel -> (login) -> session -> OneBot+Console.
 *
 * The console and OneBot network start even before login so operators can
 * scan a QR code from the web page. Login retries are driven from the console
 * or config; everything downstream (session, listeners, actions) attaches
 * once the kernel reports a logged-in state.
 */
import fs from 'node:fs';

/**
 * Kernel listeners are invoked by method name; any method missing on the
 * registered object can break the whole callback dispatch. Mirror NapCat's
 * proxiedListenerOf: a Proxy returning no-op functions for unknown methods.
 */
function listenerProxy<T extends object>(listener: T): T {
    return new Proxy(listener, {
        get(target, prop: string | symbol, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value === 'undefined') {
                // Kernel validates the return value of every listener call;
                // resolve with a Promise so the napi check passes.
                return (..._args: unknown[]) => Promise.resolve();
            }
            return value;
        },
    });
}
import path from 'node:path';
import os from 'node:os';
import { loadKernelFromQQ, type LoadedKernel } from '../nt/loader.js';
import { LoginFlow } from '../nt/login.js';
import { collectServices, groupPeer, c2cPeer, type SessionServices } from '../nt/session.js';
import type { RawMessage } from '../nt/session.js';
import { EventBus, segmentsToRawText, groupNotifyToNotice, type OB11AnyEvent } from '../onebot/events/bus.js';
import { ntElementsToSegments, type OB11Segment } from '../onebot/message/segments.js';
import { NetworkManager, type NetworkConfig } from '../onebot/network/index.js';
import { dispatchAction, type ActionContext } from '../onebot/actions/index.js';
import { WebConsole, type ConsoleConfig, type ConsoleBridge, type ConsoleRuntimeState } from '../console/index.js';

export interface KatheryneConfig extends NetworkConfig {
    console?: ConsoleConfig;
    quick_login_uin?: string;
    data_path?: string;
}

function loadConfig(): KatheryneConfig {
    const candidates = [
        process.env.KATHERYNE_CONFIG,
        path.join(os.homedir(), '.config', 'katheryneqq', 'config.json'),
    ].filter(Boolean) as string[];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf-8')) as KatheryneConfig;
        }
    }
    return {
        http: { enabled: true, host: '0.0.0.0', port: 5700 },
        ws: { enabled: true, host: '0.0.0.0', port: 6700 },
        reverseWs: { enabled: false, urls: [] },
        console: { enabled: true, host: '0.0.0.0', port: 6099 },
    };
}

type Phase = ConsoleRuntimeState['phase'];

class KatheryneRuntime {
    private kernel: LoadedKernel | null = null;
    private loginFlow: LoginFlow | null = null;
    private bus = new EventBus();
    private services: SessionServices | null = null;
    private session: unknown = null;
    private selfUin = '';
    private selfUid = '';
    private selfNick = '';
    private phase: Phase = 'loading';
    private loginError: string | null = null;
    private qrcodeDataUrl: string | null = null;
    private readonly startedAt = Date.now();
    private readonly bootTimeSec = Math.floor(Date.now() / 1000);
    private config: KatheryneConfig = loadConfig();
    private consoleMgr: WebConsole | null = null;
    private network: NetworkManager | null = null;
    private uinToUid = new Map<string, string>();
    private uidToUin = new Map<string, string>();
    /** msgId -> peer, harvested from every message; enables message_id-only actions. */
    private msgPeerCache = new Map<string, { chatType: number; peerUid: string; senderUid?: string; senderUin?: string; msgSeq?: string }>();
    private groupListCache = new Map<string, Record<string, unknown>>();

    async start(): Promise<void> {
        // 1. Console + network up first (works pre-login).
        this.consoleMgr = new WebConsole(this.config.console ?? { enabled: true, host: '0.0.0.0', port: 6099 }, this.buildConsoleBridge());
        this.consoleMgr.start();
        this.network = new NetworkManager(this.config, this.bus, () => this.buildActionContext());
        this.network.start();
        console.log('[katheryne] network + console started (pre-login)');

        // 2. Kernel.
        try {
            this.kernel = loadKernelFromQQ();
            this.loginFlow = new LoginFlow(this.kernel, this.config.data_path);
            this.loginFlow.initEngine();
            this.loginFlow.initLoginConfig();
            this.phase = 'awaiting_login';
            console.log(`[katheryne] kernel ready: QQ ${this.kernel.packageInfo.version}, appid=${this.loginFlow.identity.appid}`);
        } catch (e) {
            this.phase = 'error';
            this.loginError = e instanceof Error ? e.message : String(e);
            console.error('[katheryne] kernel load failed', e);
            return;
        }

        // 3. Auto quick-login if configured and a record exists.
        const preferred = this.config.quick_login_uin;
        if (preferred) {
            this.quickLogin(preferred).catch((e) => {
                this.loginError = e instanceof Error ? e.message : String(e);
                console.error('[katheryne] auto quick login failed:', this.loginError);
            });
        }
    }

    // ---------------- login ----------------

    private loginListenersInstalled = false;
    private loginConnected = false;
    private pendingQRRequest = false;
    private loginServiceInstance: unknown = null;

    private loginSvc() {
        // Single shared instance: kernel may return fresh NAPI objects per
        // .get() call; listeners must live on the same object we connect().
        if (!this.loginServiceInstance && this.kernel) {
            this.loginServiceInstance = this.kernel.wrapper.NodeIKernelLoginService.get();
        }
        return this.loginServiceInstance;
    }

    private installLoginListeners(): void {
        if (this.loginListenersInstalled || !this.kernel) return;
        const svc = this.loginSvc() as {
            addKernelLoginListener(listener: unknown): number;
            connect(): boolean;
            getQRCodePicture(): boolean;
            cancel(): void;
        };
        this.loginListenersInstalled = true;
        svc.addKernelLoginListener({
            onLoginConnected: () => {
                // NT requires connect() first; the QR request is only accepted
                // once the login service reports connected (same order NapCat
                // uses: listener -> connect() -> onLoginConnected -> QR).
                this.loginConnected = true;
                this.consoleMgr?.log('login service connected');
                if (this.pendingQRRequest) {
                    this.pendingQRRequest = false;
                    try {
                        svc.getQRCodePicture();
                    } catch (e) {
                        this.loginError = `getQRCodePicture failed: ${e instanceof Error ? e.message : String(e)}`;
                    }
                }
            },
            onQRCodeGetPicture: (arg: { pngBase64QrcodeData?: string; qrcodeUrl?: string }) => {
                const b64 = arg?.pngBase64QrcodeData ?? '';
                this.qrcodeDataUrl = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64.replace(/^.*base64,/, '')}`;
                this.phase = 'logging_in';
                this.loginError = null;
                this.consoleMgr?.log('QR code received, waiting for scan');
            },
            onQRCodeSessionUserScaned: () => this.consoleMgr?.log('QR scanned, confirm on phone'),
            onQRCodeSessionFailed: (errType?: number, errCode?: number) => {
                // errType 1 / errCode 3 = QR expired: fetch the next code
                // automatically (same policy as NapCat). Other failures keep
                // the code on screen for a manual refresh.
                if (errType === 1 && errCode === 3) {
                    this.loginError = '二维码已过期，正在刷新';
                    try {
                        const svc = this.loginSvc() as { getQRCodePicture(): boolean };
                        svc.getQRCodePicture();
                    } catch {
                        this.qrcodeDataUrl = null;
                        this.phase = 'awaiting_login';
                    }
                    return;
                }
                this.qrcodeDataUrl = null;
                this.loginError = `QR session failed: type=${errType} code=${errCode}`;
                this.phase = 'awaiting_login';
            },
            onQRCodeLoginSucceed: (arg: Record<string, unknown>) => {
                this.qrcodeDataUrl = null;
                const uin = String(arg?.uin ?? '');
                const uid = String(arg?.uid ?? '');
                this.consoleMgr?.log(`QR login succeed: ${uin}`);
                void this.afterLogin(uin, uid, uin);
            },
            onLoginFailed: (step?: unknown, errMsg?: unknown) => {
                this.loginError = `login failed step=${step}: ${String(errMsg ?? '')}`;
                this.phase = 'awaiting_login';
                this.consoleMgr?.log(this.loginError);
            },
            onUserLoggedIn: (userid?: unknown) => {
                this.consoleMgr?.log(`user ${String(userid)} logged in`);
            },
            onKickedOffLine: (info: { tipsTitle?: string; tipsDesc?: string }) => {
                this.bus.emit({
                    time: Math.floor(Date.now() / 1000),
                    self_id: this.selfUin,
                    post_type: 'notice',
                    notice_type: 'client_kicked_offline',
                    title: info?.tipsTitle ?? '',
                    desc: info?.tipsDesc ?? '',
                });
            },
        });
    }

    async quickLogin(uin: string): Promise<void> {
        if (!this.loginFlow) throw new Error('kernel not ready');
        this.installLoginListeners();
        this.phase = 'logging_in';
        this.loginError = null;
        const r = await this.loginFlow.quickLogin(uin);
        await this.afterLogin(r.uin, r.uid, r.nick);
    }

    async startQRLogin(): Promise<void> {
        if (!this.kernel) throw new Error('kernel not ready');
        this.installLoginListeners();
        this.phase = 'logging_in';
        this.loginError = null;
        const svc = this.loginSvc() as {
            connect(): boolean;
            getQRCodePicture(): boolean;
        };
        if (!this.loginConnected) {
            // First QR request in this process: connect() now; the picture is
            // fetched from onLoginConnected once the service is up.
            this.pendingQRRequest = true;
            svc.connect();
            this.consoleMgr?.log('login service connecting (QR queued)');
            return;
        }
        svc.getQRCodePicture();
        this.consoleMgr?.log('QR login requested');
    }

    async cancelLogin(): Promise<void> {
        if (!this.kernel) return;
        const svc = this.loginSvc() as { cancel(): void };
        try {
            svc.cancel();
        } catch {
            // already idle
        }
        this.qrcodeDataUrl = null;
        this.pendingQRRequest = false;
        this.phase = 'awaiting_login';
    }

    private async afterLogin(uin: string, uid: string, nick: string): Promise<void> {
        this.selfUin = uin;
        this.selfUid = uid;
        this.selfNick = nick || uin;
        try {
            const sessionConfig = this.loginFlow!.buildSessionConfig(uin, uid);
            const sessionMod = await import('../nt/session.js');
            const { session, ready } = sessionMod.initSession(this.kernel!.wrapper, sessionConfig) as unknown as {
                session: unknown;
                ready: Promise<void>;
            };
            await ready;
            this.session = session;
            this.services = collectServices(session);
            this.attachMsgListener();
            this.attachGroupListener();
            this.attachBuddyListener();
            void this.cacheMappings();

            this.phase = 'online';
            this.loginError = null;
            this.bus.emit({
                time: Math.floor(Date.now() / 1000),
                self_id: this.selfUin,
                post_type: 'meta_event',
                meta_event_type: 'lifecycle',
                sub_type: 'connect',
            });
            this.consoleMgr?.log(`online as ${this.selfNick} (${this.selfUin})`);
        } catch (e) {
            this.phase = 'error';
            this.loginError = e instanceof Error ? e.message : String(e);
            this.consoleMgr?.log(`session init failed: ${this.loginError}`);
        }
    }

    // ---------------- listeners ----------------

    private attachMsgListener(): void {
        const msgService = this.services?.msg;
        if (!msgService) return;
        msgService.addKernelMsgListener(listenerProxy({
            onMsgRecall: (chatType: number, peerUid: string, msgSeq: string) => {
                return this.handleRecall(chatType, peerUid, msgSeq).catch(() => undefined);
            },
            onRecvMsg: (msgs: RawMessage[]) => {
                for (const m of msgs ?? []) {
                    this.emitMessage(m, false);
                }
            },
            onMsgInfoListUpdate: async (msgs: RawMessage[]) => {
                // NapCat pattern: recalls arrive here as gray-tip updates on the
                // ORIGINAL message (recallTime set, revokeElement attached) —
                // regardless of msgType. Also route pure gray-tip messages.
                for (const m of msgs ?? []) {
                    const els = (m.elements ?? []) as Array<Record<string, any>>;
                    const revokeEl = els.find((el) => el.grayTipElement?.revokeElement);
                    if (revokeEl) {
                        const recallTime = Number((m as Record<string, unknown>).recallTime ?? 0);
                        const secs = recallTime > 10_000_000_000 ? recallTime / 1000 : recallTime;
                        if (Number.isFinite(secs) && secs > this.bootTimeSec - 60) {
                            this.emitRecallEvent(m, revokeEl.grayTipElement.revokeElement);
                        }
                        continue;
                    }
                    if (Number((m as Record<string, unknown>).msgType ?? 0) === 5) void this.emitGrayTip(m);
                }
            },
            onAddSendMsg: (m: RawMessage) => this.emitMessage(m, true),
            onRecvMsgSvrRspTransInfo: () => undefined,
            onMsgEventListUpdate: () => undefined,
            onSendMsgError: () => undefined,
            onKickedOffLine: (info: { tipsTitle?: string; tipsDesc?: string }) => {
                this.bus.emit({
                    time: Math.floor(Date.now() / 1000),
                    self_id: this.selfUin,
                    post_type: 'notice',
                    notice_type: 'kicked_offline',
                    title: info?.tipsTitle ?? '',
                    desc: info?.tipsDesc ?? '',
                });
            },
        }));
        try {
            msgService.startMsgSync();
        } catch {
            try {
                msgService.startMsgSync(0);
            } catch {
                // auto-start path
            }
        }
    }

    private attachGroupListener(): void {
        const groupService = this.services?.group;
        if (!groupService) return;
        groupService.addKernelGroupListener(listenerProxy({
            onGroupListUpdate: (_updateType: unknown, groupList: Array<Record<string, unknown>>) => {
                for (const g of groupList ?? []) {
                    const code = String(g.groupCode ?? '');
                    if (code) this.groupListCache.set(code, {
                        group_id: code,
                        group_name: String(g.groupName ?? ''),
                        member_count: Number(g.memberCount ?? 0),
                        max_member_count: Number(g.maxMember ?? 0),
                    });
                }
            },
            onGroupNotifiesUpdated: (_doubt: boolean, notifies: Array<Record<string, unknown>>) => {
                for (const n of notifies ?? []) {
                    const ev = groupNotifyToNotice(n, this.selfUin, (uid) => this.uidToUin.get(uid) ?? null);
                    if (ev) this.bus.emit(ev);
                }
            },
            onGroupSingleScreenNotifies: (_doubt: boolean, _seq: string, notifies: Array<Record<string, unknown>>) => {
                for (const n of notifies ?? []) {
                    const ev = groupNotifyToNotice(n, this.selfUin, (uid) => this.uidToUin.get(uid) ?? null);
                    if (ev) this.bus.emit(ev);
                }
            },
        }));
    }

    private attachBuddyListener(): void {
        const buddyService = this.services?.buddy;
        if (!buddyService) return;
        buddyService.addKernelBuddyListener(listenerProxy({
            onBuddyReqChange: (arg: Record<string, unknown>) => {
                const reqs = (arg?.reqList ?? arg?.newList ?? []) as Array<Record<string, unknown>>;
                for (const r of reqs) {
                    const uid = String(r.friendUid ?? r.uid ?? '');
                    this.bus.emit({
                        time: Math.floor(Date.now() / 1000),
                        self_id: this.selfUin,
                        post_type: 'request',
                        request_type: 'friend',
                        sub_type: String(r.sourceType ?? 'normal'),
                        user_id: this.uidToUin.get(uid) ?? uid,
                        comment: String(r.reqTopic ?? ''),
                        flag: String(r.reqTime ?? uid),
                    });
                }
            },
        }));
    }

    private async cacheMappings(): Promise<void> {
        try {
            const buddy = this.services?.buddy;
            if (!buddy) return;
            // getBuddyListV2 returns categories: [{ buddyUids: [...] }].
            // Resolve uins via profile service per uid (kernel-side mapping).
            const uids: string[] = [];
            try {
                const res = await buddy.getBuddyListV2('0', true, 0); // BuddyListReqType.KNOMAL
                const cats = res?.data ?? [];
                for (const cat of cats) {
                    for (const u of cat.buddyUids ?? []) uids.push(String(u));
                }
            } catch { /* fall through to legacy */ }
            if (uids.length === 0) {
                try {
                    const res = await buddy.getBuddyList('BuddyList', true, false, false, false, false, 0);
                    const flat = res?.result?.buddyList ?? res?.buddyList ?? [];
                    for (const f of flat) {
                        const uid = String(f.uid ?? '');
                        const uin = String(f.uin ?? '');
                        if (uid && uin) {
                            this.uinToUid.set(uin, uid);
                            this.uidToUin.set(uid, uin);
                        }
                    }
                } catch { /* empty list kept */ }
            }
            if (uids.length > 0) {
                const profile = this.services?.profile;
                if (profile) {
                    try {
                        const res = await profile.getCoreAndBaseInfo('nodeStore', uids);
                        console.log('[katheryne] getCoreAndBaseInfo raw keys:', JSON.stringify(Object.keys(res ?? {})), 'sample:', JSON.stringify(res).slice(0, 400));
                        const infos = res?.result?.info ?? res?.info ?? [];
                        for (const f of infos) {
                            const uid = String(f.uid ?? '');
                            const uin = String(f.uin ?? '');
                            if (uid && uin && uin !== '0') {
                                this.uinToUid.set(uin, uid);
                                this.uidToUin.set(uid, uin);
                            }
                        }
                    } catch { /* kernel refused bulk fetch */ }
                }
            }
            console.log(`[katheryne] cached ${this.uinToUid.size}/${uids.length || '?'} friend uid mappings`);
        } catch {
            // partial mapping; per-call resolution still works via kernel
        }
    }


    private async handleRecall(chatType: number, peerUid: string, msgSeq: string): Promise<void> {
        try {
            const svc = this.services?.msg;
            if (!svc) return;
            const peer = { chatType, peerUid, guildId: '' };
            const r = await svc.getMsgsIncludeSelf(peer, '', 20, false);
            const list = (r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, unknown>>;
            const recalled = list.find((m) => {
                const els = (m.elements ?? []) as Array<Record<string, unknown>>;
                return String(m.msgSeq ?? '') === String(msgSeq)
                    && els.some((el) => {
                        const gt = el.grayTipElement as Record<string, unknown> | undefined;
                        return gt && gt.revokeElement;
                    });
            });
            if (!recalled) return;
            const els = (recalled.elements ?? []) as Array<Record<string, unknown>>;
            const gray = (els.find((el) => (el.grayTipElement as Record<string, unknown>)?.revokeElement)?.grayTipElement ?? {}) as Record<string, any>;
            const revoke = gray.revokeElement ?? {};
            const operatorUid = String(revoke.operatorUid ?? '');
            const isGroup = Number(chatType) === 2;
            const selfUin = this.uidToUin.get(String(recalled.senderUid ?? '')) ?? String(recalled.senderUin ?? '');
            const operator = this.uidToUin.get(operatorUid) ?? this.resolveUidLive(operatorUid) ?? operatorUid;
            this.emitRecallEvent(recalled as RawMessage, revoke);
            this.consoleMgr?.log(`recall event: seq=${msgSeq}`);
        } catch (e) {
            console.error('[katheryne] recall handler error', e);
        }
    }

    /** Live uid->uin via uix service, cached on success. */
    private resolveUidLive(uid: string): string | null {
        try {
            const uix = this.services?.uix as any;
            if (!uix) return null;
            const r = uix.getUin([uid]);
            const uin = r?.uinInfo?.get?.(uid) ?? r?.result?.uinInfo?.get?.(uid);
            if (uin && String(uin) !== '0') {
                this.uidToUin.set(uid, String(uin));
                this.uinToUid.set(String(uin), uid);
                return String(uin);
            }
        } catch { /* ignore */ }
        return null;
    }


    private reportedRecalls = new Set<string>();

    /** Emit recall notice from a gray-tip update (NapCat handleRecallMessage pattern). */
    private emitRecallEvent(m: RawMessage, revoke: Record<string, any>): void {
        const key = String(m.msgId ?? '');
        if (this.reportedRecalls.has(key)) return;
        this.reportedRecalls.add(key);
        if (this.reportedRecalls.size > 500) this.reportedRecalls.clear();
        const isGroup = Number(m.chatType ?? 0) === 2;
        const operatorUid = String(revoke.operatorUid ?? '');
        const operator = this.uidToUin.get(operatorUid) ?? this.resolveUidLive(operatorUid) ?? operatorUid;
        const author = this.uidToUin.get(String(m.senderUid ?? '')) ?? String(m.senderUin ?? '');
        this.bus.emit({
            time: Math.floor(Date.now() / 1000),
            self_id: this.selfUin,
            post_type: 'notice',
            notice_type: isGroup ? 'group_recall' : 'friend_recall',
            group_id: isGroup ? (this.uidToUin.get(String(m.peerUid ?? '')) ?? String(m.peerUid ?? '')) : undefined,
            user_id: author || operator,
            operator_id: isGroup ? operator : undefined,
            message_id: String(m.msgId ?? ''),
        } as never);
        this.consoleMgr?.log(`recall: ${isGroup ? 'group' : 'friend'} msg=${key}`);
    }

    private async emitGrayTip(m: RawMessage): Promise<void> {
        try {
            const els = (m.elements ?? []) as Array<Record<string, any>>;
            for (const el of els) {
                const gray = el.grayTipElement;
                if (!gray) continue;
                const isGroup = Number(m.chatType ?? 0) === 2;
                const base = {
                    time: Math.floor(Date.now() / 1000),
                    self_id: this.selfUin,
                    post_type: 'notice' as const,
                    group_id: isGroup ? (this.uidToUin.get(String(m.peerUid ?? '')) ?? String(m.peerUid ?? '')) : undefined,
                };
                if (gray.revokeElement) {
                    this.emitRecallEvent(m, gray.revokeElement);
                } else if (gray.jsonGrayTipElement?.jsonStr) {
                    // Poke (拍一拍): json.items = [{uid}, {uid}]
                    try {
                        const json = JSON.parse(gray.jsonGrayTipElement.jsonStr);
                        const uids = (json.items ?? []).filter((it: { uid?: string }) => it.uid).map((it: { uid: string }) => it.uid);
                        if (uids.length === 2) {
                            const [fromUid, toUid] = uids;
                            // Resolve NT uids -> QQ uins via profile batch lookup.
                            let fromUin = this.uidToUin.get(fromUid) ?? '';
                            let toUin = this.uidToUin.get(toUid) ?? '';
                            try {
                                const profile = this.services?.profile;
                                if (profile && (!fromUin || !toUin)) {
                                    const res = await profile.getUserSimpleInfo?.(false, uids);
                                    const infoMap = (res?.result?.info ?? res?.info ?? {}) as unknown;
                                    const getUin = (uid: string): string => {
                                        if (!infoMap) return '';
                                        const mm = infoMap as Map<string, Record<string, any>>;
                                        const info = typeof mm.get === 'function' ? mm.get(uid) : (infoMap as Record<string, Record<string, any>>)[uid];
                                        return String(info?.coreInfo?.uin ?? info?.uin ?? '').replace(/^0+$/, '');
                                    };
                                    fromUin = fromUin || getUin(fromUid);
                                    toUin = toUin || getUin(toUid);
                                }
                            } catch { /* fall back to uid */ }
                            this.bus.emit({
                                ...base,
                                notice_type: 'poke',
                                user_id: fromUin || fromUid,
                                target_id: toUin || toUid,
                            } as never);
                        }
                    } catch { /* not a poke json */ }
                }
            }
        } catch (e) {
            console.error('[katheryne] gray tip error', e);
        }
    }


    // ---------------- OIDB packet send (poke etc.) ----------------

    /**
     * Minimal protobuf writer (varint tags, length-delimited fields) — enough
     * for the OIDB packets the actions need (poke 0xED3_1 etc.).
     */
    private pbTag(field: number, wireType: number): Buffer {
        return this.pbVarint((field << 3) | wireType);
    }
    private pbVarint(value: number): Buffer {
        const out: number[] = [];
        let v = value >>> 0;
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
        out.push(v & 0x7f);
        return Buffer.from(out);
    }
    private pbUint(field: number, value: number): Buffer {
        return Buffer.concat([this.pbTag(field, 0), this.pbVarint(value)]);
    }
    private pbBytes(field: number, data: Buffer): Buffer {
        return Buffer.concat([this.pbTag(field, 2), this.pbVarint(data.length), data]);
    }

    /** Build OidbSvcTrpcTcpBase packet: {command, subCommand, body, isReserved} */
    private buildOidb(cmd: number, subCmd: number, body: Buffer, withServiceType = false): Buffer {
        const parts = [
            this.pbUint(1, cmd),
            this.pbUint(2, subCmd),
            this.pbBytes(4, body),
            this.pbUint(12, 1), // isReserved (uid mode)
        ];
        if (withServiceType) parts.push(this.pbUint(15, 0)); // ServiceType (Lagrange-compatible)
        return Buffer.concat(parts);
    }

    /** Build SendPoke body (0xED3_1): {uin: target, groupUin|friendUin: peer, ext: 0} */
    private buildPokeBody(targetUin: number, peerUin: number, isGroup: boolean): Buffer {
        const parts = [this.pbUint(1, targetUin)];
        parts.push(isGroup ? this.pbUint(2, peerUin) : this.pbUint(5, peerUin));
        parts.push(this.pbUint(6, 0)); // ext: 0 (NapCat sets this explicitly)
        return Buffer.concat(parts);
    }

    /** Send a raw OIDB command through the kernel MSF channel. */
    private async sendOidb(cmd: number, subCmd: number, body: Buffer, withServiceType = false): Promise<Record<string, unknown> | null> {
        const msgService = this.services?.msg as any;
        if (!msgService?.sendSsoCmdReqByContend) {
            return null;
        }
        const packet = this.buildOidb(cmd, subCmd, body);
        const full = `OidbSvcTrpcTcp.0x${cmd.toString(16)}_${subCmd}`;
        try {
            // Kernel NAPI coerce_to_string()s the param — pass a safe
            // string form. Try hex first (matches NapCat's packet representation).
            const ret = await Promise.race([
                msgService.sendSsoCmdReqByContend(full, packet.toString('latin1')),
                new Promise((_, rej) => setTimeout(() => rej(new Error('oidb timeout')), 8000)),
            ]) as { rspbuffer?: Buffer } | undefined;
            if (ret && typeof (ret as Record<string, unknown>).result === 'number'
                && (ret as Record<string, unknown>).result !== 0) {
                console.error('[katheryne] oidb rejected:', full,
                    (ret as Record<string, unknown>).errMsg ?? ret);
                return null;
            }
            return ret ?? null;
        } catch (e) {
            return null;
        }
    }

    /** Poke a user in a group or privately (OIDB 0xED3_1). */
    private async sendPoke(targetUin: number, peerUin: number, isGroup: boolean): Promise<boolean> {
        const body = this.buildPokeBody(targetUin, peerUin, isGroup);
        const withST = process.env.KATHERYNE_ST === '1';
        const ret = await this.sendOidb(0xED3, 1, body, withST);
        return ret !== null;
    }

    // ---------------- message -> OB11 ----------------

    private emitMessage(m: RawMessage, sent: boolean): void {
        try {
            // Harvest uid<->uin pairs from every message (covers friends and strangers).
            const senderUid = String(m.senderUid ?? '');
            const senderUin = String(m.senderUin ?? '');
            if (senderUid && senderUin && senderUin !== '0') {
                this.uidToUin.set(senderUid, senderUin);
                this.uinToUid.set(senderUin, senderUid);
            }
            // Gray-tip messages (msgType 9 in NapCat; 17 observed on this kernel)
            // carry recall/poke/etc. notices, not chat.
            const msgType = Number((m as Record<string, unknown>).msgType ?? 0);
            // KMSGTYPEGRAYTIPS = 5 (NapCat NTMsgType). 9 is REPLY, not gray tip!
            if (msgType === 5) {
                void this.emitGrayTip(m);
                return;
            }
            const chatType = Number(m.chatType ?? 0);
            const isGroup = chatType === 2;
            const peerUid = String(m.peerUid ?? '');
            const peerUin = this.uidToUin.get(peerUid) ?? (String(m.peerUin ?? '') || peerUid);
            const segments = ntElementsToSegments(
                (m.elements ?? []) as Array<Record<string, unknown>>,
                { resolveUid: (uid) => this.uidToUin.get(uid) ?? null, selfUid: this.selfUid },
            );
            const event = {
                time: Math.floor(Date.now() / 1000),
                self_id: this.selfUin,
                post_type: 'message' as const,
                message_type: isGroup ? ('group' as const) : ('private' as const),
                sub_type: sent ? 'self' : 'normal',
                message_id: String(m.msgId ?? ''),
                user_id: String(m.senderUin ?? this.uidToUin.get(String(m.senderUid ?? '')) ?? ''),
                group_id: isGroup ? peerUin : undefined,
                message: segments,
                raw_message: segmentsToRawText(segments),
                font: 0,
                sender: {
                    user_id: String(m.senderUin ?? ''),
                    nickname: String(m.senderNick ?? ''),
                    card: isGroup ? String(m.senderNick ?? '') : undefined,
                    role: undefined,
                },
            };
            this.bus.emit(event as OB11AnyEvent);
        } catch (e) {
            console.error('[katheryne] emitMessage error', e);
        }
    }


    /**
     * Prepare a local image for sending: compute md5/size, ask the kernel
     * for the rich-media path, copy the file there (NapCat-compatible flow).
     */
    private async prepareImageElement(sourcePath: string): Promise<Record<string, unknown>> {
        const crypto = await import('node:crypto');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const data = fs.readFileSync(sourcePath);
        const md5 = crypto.createHash('md5').update(data).digest('hex');
        const fileSize = data.length;
        const fileName = path.basename(sourcePath);
        const msgService = this.services?.msg;
        let mediaPath = sourcePath;
        try {
            mediaPath = await (msgService as any).getRichMediaFilePathForGuild({
                md5HexStr: md5,
                fileName,
                elementType: 2, // PIC
                elementSubType: 0,
                thumbSize: 0,
                needCreate: true,
                downloadType: 1,
                file_uuid: '',
            });
            if (mediaPath && mediaPath !== sourcePath) {
                fs.mkdirSync(path.dirname(String(mediaPath)), { recursive: true });
                fs.copyFileSync(sourcePath, String(mediaPath));
            }
        } catch { /* fall back to original path */ }
        // read PNG/JPEG dimensions
        let width = 0, height = 0;
        try {
            if (data[0] === 0x89 && data[1] === 0x50) { // PNG
                width = data.readUInt32BE(16); height = data.readUInt32BE(20);
            } else if (data[0] === 0xFF && data[1] === 0xD8) { // JPEG
                let off = 2;
                while (off < data.length - 8) {
                    if (data[off] !== 0xFF) { off++; continue; }
                    const marker = data[off + 1];
                    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                        height = data.readUInt16BE(off + 5); width = data.readUInt16BE(off + 7); break;
                    }
                    off += 2 + data.readUInt16BE(off + 2);
                }
            }
        } catch { /* dims unknown */ }
        return {
            elementType: 2,
            elementId: '',
            picElement: {
                md5HexStr: md5,
                fileSize: String(fileSize),
                picWidth: width,
                picHeight: height,
                fileName,
                sourcePath: String(mediaPath),
                original: true,
                picType: 0,
                picSubType: 0,
                fileUuid: '',
                fileSubId: '',
                thumbFileSize: 0,
                summary: '',
            },
        };
    }

    // ---------------- action context ----------------

    private requireServices(): SessionServices {
        if (!this.services) throw new Error('not logged in');
        return this.services;
    }

    private buildActionContext(): ActionContext {
        const self = this;
        return {
            get selfUin() {
                return self.selfUin;
            },
            get selfUid() {
                return self.selfUid;
            },
            resolveUin(uin: string): string | null {
                if (uin === self.selfUin) return self.selfUid;
                const cached = self.uinToUid.get(uin);
                if (cached) return cached;
                // Live kernel conversion fallback (uix service).
                try {
                    const uix = self.services?.uix;
                    if (uix) {
                        const r = Promise.resolve(uix.getUid([uin])).then((rr: Record<string, any>) => {
                            const uidInfo = rr?.uidInfo;
                            const uid = uidInfo?.get?.(uin) ?? uidInfo?.[uin]
                                ?? rr?.result?.uidInfo?.get?.(uin);
                            if (uid && !String(uid).includes('*')) {
                                self.uinToUid.set(uin, String(uid));
                                self.uidToUin.set(String(uid), uin);
                            }
                        }).catch(() => undefined);
                    }
                } catch { /* fallthrough */ }
                return null;
            },
            resolveMsgPeer(msgId: string): { chatType: number; peerUid: string } | null {
                return self.msgPeerCache.get(msgId) ?? null;
            },
            resolveUid(uid: string): string | null {
                if (uid === self.selfUid) return self.selfUin;
                const cached = self.uidToUin.get(uid);
                if (cached) return cached;
                try {
                    const uix = self.services?.uix;
                    if (uix) {
                        const r = uix.getUin([uid]);
                        const uin = r?.uinInfo?.get(uid) ?? r?.result?.uinInfo?.get(uid);
                        if (uin && String(uin) !== '0') {
                            self.uidToUin.set(uid, String(uin));
                            self.uinToUid.set(String(uin), uid);
                            return String(uin);
                        }
                    }
                } catch { /* fallthrough */ }
                return null;
            },
            async sendMessage(peer, elements) {
                const svc = self.requireServices().msg;
                // Kernel sendMsg signature (mirrors official client):
                //   sendMsg('0', peer, elements, attrMap)
                // and peer.guildId must carry a generated unique msg id.
                // Prepare local-file image segments before hitting the kernel.
                for (let i = 0; i < elements.length; i++) {
                    const el = elements[i] as Record<string, unknown>;
                    const pic = el?.picElement as Record<string, unknown> | undefined;
                    const src = String(pic?.sourcePath ?? '');
                    if (el?.elementType === 2 && src && !src.includes('/') === false && src.startsWith('/')) {
                        try {
                            elements[i] = await self.prepareImageElement(src) as never;
                        } catch { /* keep original element */ }
                    }
                }
                let msgId = '';
                try {
                    const msf = self.requireServices().msf;
                    const serverTime = msf.getServerTime();
                    msgId = String(await svc.generateMsgUniqueId(peer.chatType, serverTime));
                } catch {
                    msgId = String(Date.now());
                }
                const peerWithId = { ...peer, guildId: msgId };
                // The kernel-assigned msgId arrives via onAddSendMsg; capture it.
                const realId = new Promise<string>((resolve) => {
                    const listener = {
                        onAddSendMsg: (m: Record<string, unknown>) => {
                            // match by our generated id (kernel echoes it in guildId field)
                            const rec = JSON.stringify(m);
                            if (rec.includes(msgId)) {
                                resolve(String(m.msgId ?? ''));
                                svc.removeKernelMsgListener?.(listener as never);
                            }
                        },
                    };
                    try {
                        svc.addKernelMsgListener(listener);
                    } catch { /* ignore */ }
                    setTimeout(() => resolve(''), 8000);
                });
                const r = await svc.sendMsg('0', peerWithId, elements, new Map());
                const real = await realId;
                const finalId = real || String(r?.result?.msgId ?? msgId);
                // cache for message_id-only actions (recall/get_msg)
                self.msgPeerCache.set(finalId, { chatType: peer.chatType, peerUid: peer.peerUid });
                return { msgId: finalId };
            },
            async deleteMsg(peer, msgId) {
                const svc = self.requireServices().msg;
                // kernel: recallMsg(peer, msgIds[]) — log raw return for diagnosis
                const r = await svc.recallMsg(peer, [msgId]);
            },
            async getMsg(peer, msgId) {
                const svc = self.requireServices().msg;
                const r = await svc.getMsgsByMsgId(peer, [msgId]);
                const raw = (r?.result?.msgList ?? r?.msgList ?? [])[0] as RawMessage | undefined;
                if (!raw) throw new Error('message not found');
                const segments = ntElementsToSegments(
                    (raw.elements ?? []) as Array<Record<string, unknown>>,
                    { resolveUid: (uid) => self.uidToUin.get(uid) ?? null, selfUid: self.selfUid },
                );
                return {
                    message_id: String(raw.msgId ?? msgId),
                    real_id: Number(raw.msgSeq ?? 0),
                    sender: { user_id: String(raw.senderUin ?? '') },
                    time: Number(raw.msgTime ?? 0),
                    message: segments,
                    raw_message: segmentsToRawText(segments as OB11Segment[]),
                };
            },
            async getMsgHistory(peer, msgId, count) {
                const svc = self.requireServices().msg;
                // kernel: getMsgsIncludeSelf(peer, startMsgId, count, isReverseOrder)
                const r = await svc.getMsgsIncludeSelf(peer, msgId, count, false);
                const list = (r?.result?.msgList ?? r?.msgList ?? []) as RawMessage[];
                return list.map((raw) => {
                    const segments = ntElementsToSegments(
                        (raw.elements ?? []) as Array<Record<string, unknown>>,
                        { resolveUid: (uid) => self.uidToUin.get(uid) ?? null, selfUid: self.selfUid },
                    );
                    return {
                        message_id: String(raw.msgId ?? ''),
                        real_id: Number(raw.msgSeq ?? 0),
                        sender: { user_id: String(raw.senderUin ?? '') },
                        time: Number(raw.msgTime ?? 0),
                        message: segments,
                        raw_message: segmentsToRawText(segments as OB11Segment[]),
                    };
                });
            },
            async markRead(peer) {
                const svc = self.requireServices().msg;
                await svc.setMsgRead(peer);
            },
            async getLoginInfo() {
                return { user_id: self.selfUin, nickname: self.selfNick };
            },
            async getFriendList() {
                const buddy = self.requireServices().buddy;
                const profile = self.requireServices().profile;
                // categories: [{buddyUids: [...]}] -> profile.getCoreAndBaseInfo('nodeStore', uids)
                let uids: string[] = [];
                try {
                    const res = await buddy.getBuddyListV2('0', true, 0);
                    const cats = res?.data ?? [];
                    for (const cat of cats) for (const u of cat.buddyUids ?? []) uids.push(String(u));
                } catch { /* empty */ }
                const out: Array<Record<string, unknown>> = [];
                if (uids.length > 0) {
                    try {
                        const res = await profile.getCoreAndBaseInfo('nodeStore', uids);
                        const infoMap = (res?.result?.info ?? res?.info ?? {}) as unknown;
                        const getInfo = (uid: string): Record<string, any> | undefined => {
                            if (!infoMap) return undefined;
                            const m = infoMap as Map<string, Record<string, any>>;
                            if (typeof m.get === 'function') return m.get(uid);
                            return (infoMap as Record<string, Record<string, any>>)[uid];
                        };
                        for (const uid of uids) {
                            const info = getInfo(uid) ?? {};
                            const core = (info.coreInfo ?? {}) as Record<string, unknown>;
                            const uin = String(core.uin ?? info.uin ?? '');
                            if (uin && uin !== '0') {
                                self.uidToUin.set(uid, uin);
                                self.uinToUid.set(uin, uid);
                            }
                            out.push({
                                user_id: uin || self.uidToUin.get(uid) || uid,
                                nickname: String(core.nick ?? info.nick ?? ''),
                                remark: String(info.remark ?? ''),
                            });
                        }
                    } catch { /* fall through */ }
                }
                return out;
            },
            async getStrangerInfo(userUid) {
                const profile = self.requireServices().profile;
                // kernel: getUserSimpleInfo(force, uids[]) — returns Map keyed by uid
                const res = await profile.getUserSimpleInfo(true, [userUid]);
                const infoMap = (res?.result?.info ?? res?.info ?? res) as Record<string, Record<string, unknown>> | Map<string, Record<string, unknown>>;
                let info: Record<string, unknown> | undefined;
                if (infoMap instanceof Map) info = infoMap.get(userUid);
                else if (infoMap && typeof infoMap === 'object') {
                    info = (infoMap as Record<string, Record<string, unknown>>)[userUid]
                        ?? Object.values(infoMap as Record<string, Record<string, unknown>>)[0];
                }
                const core = ((info as Record<string, any>)?.coreInfo ?? info ?? {}) as Record<string, unknown>;
                const base = ((info as Record<string, any>)?.baseInfo ?? {}) as Record<string, unknown>;
                return {
                    user_id: String(core.uin ?? base.uin ?? self.uidToUin.get(userUid) ?? ''),
                    nickname: String(core.nick ?? base.nick ?? ''),
                };
            },
            async sendLike(userUid, times) {
                const like = self.requireServices().profileLike;
                await like.setBuddyProfileLike({
                    friendUid: userUid,
                    sourceId: 71,
                    doLikeCount: Math.min(Math.max(times, 1), 20),
                    doLikeTollCount: 0,
                });
            },
            async getGroupList() {
                const group = self.requireServices().group;
                // kernel returns only {result} — the actual list arrives via
                // onGroupListUpdate listener, which populates groupListCache.
                try { await group.getGroupList(true); } catch { /* listener path */ }
                await new Promise((r) => setTimeout(r, 800));
                if (self.groupListCache.size === 0) {
                    try { await group.getGroupList(true); } catch { /* retry */ }
                    await new Promise((r) => setTimeout(r, 800));
                }
                return Array.from(self.groupListCache.values());
            },
            async getGroupInfo(groupCode) {
                const cached = self.groupListCache.get(groupCode);
                if (cached) return { ...cached };
                const group = self.requireServices().group;
                // kernel signature: getGroupDetailInfo(groupCode, source); KDATACARD = 2
                const res = await group.getGroupDetailInfo(groupCode, 2);
                const g = (res?.result ?? res) as Record<string, unknown>;
                return {
                    group_id: String(g.groupCode ?? groupCode),
                    group_name: String(g.groupName ?? ''),
                    member_count: Number(g.memberCount ?? 0),
                    max_member_count: Number(g.maxMember ?? 0),
                };
            },
            async getGroupMemberList(groupCode) {
                const group = self.requireServices().group;
                const res = await group.getAllMemberList(groupCode, true);
                const result = (res?.result ?? res ?? {}) as Record<string, unknown>;
                // Kernel shape: result.ids = [{uid, index}], result.infos = { [uid]: {uin, nick, cardName, role, ...} }
                const ids = (result?.ids ?? []) as Array<{ uid: string; index: number }>;
                const infosRaw = result?.infos as unknown;
                // infos may be a plain object OR a NAPI Map; handle both.
                const infosGet = (uid: string): Record<string, unknown> | undefined => {
                    if (!infosRaw) return undefined;
                    const asMap = infosRaw as Map<string, Record<string, unknown>>;
                    if (typeof asMap.get === 'function') {
                        const direct = asMap.get(uid);
                        if (direct) return direct;
                    }
                    return (infosRaw as Record<string, Record<string, unknown>>)[uid];
                };
                let harvested = 0;
                for (const { uid } of ids) {
                    const info = infosGet(uid) ?? {};
                    const uin = String(info.uin ?? '');
                    if (uid && uin && uin !== '0') {
                        self.uidToUin.set(uid, uin);
                        self.uinToUid.set(uin, uid);
                        harvested++;
                    }
                }
                console.error(`[members-harvest] ids=${ids.length} harvested=${harvested} sample=`, JSON.stringify(infosGet(ids[0]?.uid ?? ''))?.slice(0, 300));
                return ids.map(({ uid }) => {
                    const info = infosGet(uid) ?? {};
                    const roleNum = Number(info.role ?? 0);
                    return {
                        user_id: String(info.uin ?? self.uidToUin.get(uid) ?? ''),
                        nickname: String(info.nick ?? ''),
                        card: String(info.cardName ?? ''),
                        role: roleNum === 1 ? 'owner' : roleNum === 2 ? 'admin' : 'member',
                    };
                });
            },
            async getGroupMemberInfo(groupCode, memberUid) {
                const group = self.requireServices().group;
                const res = await group.getGroupMemberInfo(groupCode, memberUid, false);
                const mem = (res?.result ?? res) as Record<string, unknown>;
                return {
                    user_id: String(mem.uin ?? ''),
                    nickname: String(mem.nick ?? ''),
                    card: String(mem.cardName ?? ''),
                    role: Number(mem.role ?? 0) === 1 ? 'owner' : Number(mem.role ?? 0) === 2 ? 'admin' : 'member',
                    level: Number(mem.level ?? 0),
                    title: String(mem.title ?? ''),
                };
            },
            async setGroupBan(groupCode, memberUid, durationSec) {
                const group = self.requireServices().group;
                await group.setMemberShutUp(groupCode, [{ uid: memberUid, timeStamp: Math.max(0, durationSec) }]);
            },
            async setGroupWholeBan(groupCode, enable) {
                const group = self.requireServices().group;
                await group.setGroupShutUp(groupCode, enable);
            },
            async setGroupKick(groupCode, memberUids, rejectForever) {
                const group = self.requireServices().group;
                await group.kickMember(groupCode, memberUids, rejectForever, '');
            },
            async setGroupLeave(groupCode, dismiss) {
                const group = self.requireServices().group;
                if (dismiss) await group.destroyGroup(groupCode);
                else await group.quitGroup(groupCode);
            },
            async setGroupCard(groupCode, memberUid, card) {
                const group = self.requireServices().group;
                await group.modifyMemberCardName(groupCode, memberUid, card);
            },
            async setGroupName(groupCode, name) {
                const group = self.requireServices().group;
                await group.modifyGroupName(groupCode, name, false);
            },
            async setGroupAdmin(groupCode, memberUid, enable) {
                const group = self.requireServices().group;
                await group.modifyMemberRole(groupCode, memberUid, enable ? 2 : 3);
            },
            async setGroupAvatar(groupCode, file) {
                const group = self.requireServices().group;
                await group.setHeader(groupCode, file);
            },
            async handleFriendRequest(flag, accept) {
                const buddy = self.requireServices().buddy;
                await buddy.approvalFriendRequest({ friendUid: flag, reqTime: String(flag), accept });
            },
            async handleGroupRequest(flag, accept, reason) {
                const group = self.requireServices().group;
                // operateType: 1 accept, 2 reject (NTGroupRequestOperateTypes)
                await group.handleGroupRequest(false, { seqId: flag } as never, accept ? 1 : 2, reason ?? '');
            },
            async sendPoke(targetUin, peerUin, isGroup) {
                return await self.sendPoke(Number(targetUin), Number(peerUin), isGroup);
            },
            async getCookies(_domain) {
                const misc = self.requireServices().misc;
                try {
                    const r = await misc.getCookies('');
                    return String(r?.result?.cookies ?? '');
                } catch {
                    return '';
                }
            },
        };
    }

    // ---------------- console bridge ----------------

    private buildConsoleBridge(): ConsoleBridge {
        const self = this;
        return {
            state(): ConsoleRuntimeState {
                return {
                    phase: self.phase,
                    selfUin: self.selfUin,
                    selfNick: self.selfNick,
                    version: self.kernel?.packageInfo.version ?? '-',
                    appid: self.loginFlow?.identity.appid ?? '-',
                    loginError: self.loginError,
                    qrcodeDataUrl: self.qrcodeDataUrl,
                    startedAt: self.startedAt,
                };
            },
            events() {
                return self.bus.recent;
            },
            async startQRLogin() {
                await self.startQRLogin();
            },
            async quickLogin(uin) {
                await self.quickLogin(uin);
            },
            async cancelLogin() {
                await self.cancelLogin();
            },
            actionContext() {
                return self.phase === 'online' ? self.buildActionContext() : null;
            },
            logs() {
                return self.consoleMgr?.recentLogs() ?? [];
            },
        };
    }
}

export async function initRuntime(): Promise<void> {
    const runtime = new KatheryneRuntime();
    await runtime.start();
}

export { groupPeer, c2cPeer };
