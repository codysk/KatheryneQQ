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
    /** Opt-in: install the MoeHoo SSO packet hook (debug/packet inspection).
     * Poke send does NOT need it on 3.2.35; default off keeps the process free
     * of .text trampolines and third-party modules. Also enabled by
     * KATHERYNE_PACKET_DEBUG=1. */
    packet_debug?: boolean;
}

function resolveConfigPath(): string {
    return process.env.KATHERYNE_CONFIG
        ?? path.join(os.homedir(), '.config', 'katheryneqq', 'config.json');
}

function loadConfig(): KatheryneConfig {
    const p = resolveConfigPath();
    if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as KatheryneConfig;
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
    private readonly configPath = resolveConfigPath();
    private consoleMgr: WebConsole | null = null;
    private network: NetworkManager | null = null;
    private uinToUid = new Map<string, string>();
    private uidToUin = new Map<string, string>();
    /** msgId -> peer, harvested from every message; enables message_id-only actions. */
    private msgPeerCache = new Map<string, { chatType: number; peerUid: string; senderUid?: string; senderUin?: string; msgSeq?: string }>();
    /** groupCode -> { at, uin -> display name } for @-segment rendering. */
    private memberNickCache = new Map<string, { at: number; byUin: Map<string, string> }>();
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
            // MoeHoo SSO packet hook is OPT-IN (debug/packet inspection only):
            // on 3.2.35 the legacy MSFSDK send path it taps is dead, and poke
            // goes through sendMsfRequest without it. Skipping it by default
            // keeps wrapper.node free of .text trampolines and avoids loading
            // a third-party module into the QQ process.
            if (this.packetDebugEnabled()) {
                void this.initPacketHook().then((ok) => {
                    this.consoleMgr?.log(`packet hook ${ok ? 'active' : 'unavailable'}`);
                });
            }
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
                    void this.emitMessage(m, false);
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
            onAddSendMsg: (m: RawMessage) => void this.emitMessage(m, true),
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
                // Debug: dump gray-tip payload shapes to learn the real poke representation.
                if (this.pokeShapeDebug && gray) {
                    const json = gray.jsonGrayTipElement?.jsonStr;
                    const summary = typeof json === 'string' ? json.slice(0, 300) : undefined;
                    console.error('[graytip-shape]', JSON.stringify({
                        chatType: m.chatType,
                        subType: gray.subElementType,
                        hasFace: !!el.faceElement,
                        faceElement: el.faceElement ?? undefined,
                        json: summary,
                    }).slice(0, 700));
                }
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
     * Scan this process's memory for the KernelMsgService vtable.
     * We're inside the QQ process so /proc/self/mem is readable.
     */
    /**
     * Find the KernelMsgService vtable entry 241 (sendSsoCmdReqByContend impl)
     * by using MoeHoo's hook mechanism + writev interception.
     * Alternative: use V8's external memory to get the service object pointer.
     */
    private findMsgServiceVtable(): unknown {
        try {
            // The NAPI wrapper for msgService holds a native pointer to the C++ object.
            // We can't get it from JS directly, but we can use a trick:
            // The kernel's sendSsoCmdReqByContend NAPI binding reads vtable+0x788.
            // We hook sendSsoCmdReqByContend at the NAPI level and inspect internals.
            // 
            // Simplest reliable approach: MoeHoo already hooks write/writev.
            // When ANY SSO packet is written to socket, we can inspect the call stack
            // to find the caller in wrapper.node text segment.
            // But this requires backtrace support.
            //
            // Most direct: we already know the NAPI binding for sendSsoCmdReqByContend
            // is at static offset 0x39e4440 (from our capstone analysis).
            // The binding calls [vtable+0x788]. We can read the vtable from the 
            // service object if we know its address.
            //
            // Trick: NAPI objects have internal fields. The service JS object wraps
            // a C++ pointer. We can extract it using napi_external or by reading
            // the object's aligned pointer via a native addon.
            // 
            // For now, return what we can: scan for vtable-like patterns near the
            // known entry offsets found in rwPtrs dump
            return { hint: 'Use wrapperRwPtrs dump + NAPI binding cross-reference' };
        } catch (e) { return { error: String(e) }; }
    }

    private async scanVtablesInProcess(): Promise<unknown> {
        try {
            const fsMod = await import('node:fs');
            const fs = fsMod.default ?? fsMod;
            const maps = fs.readFileSync('/proc/self/maps', 'utf8');
            let textStart = 0, textEnd = 0, base = 0;
            for (const l of maps.split('\n')) {
                if (l.includes('wrapper.node')) {
                    const [range] = l.split(' ');
                    const [s2, e2] = range.split('-');
                    if (!base) base = parseInt(s2, 16);
                    if (l.includes('r-xp')) { textStart = parseInt(s2, 16); textEnd = parseInt(e2, 16); }
                }
            }
            if (!textStart) return { error: 'wrapper.node text not found' };
            const fd = fs.openSync('/proc/self/mem', 'r');
            const results: unknown[] = [];
            const CHUNK = 0x100000; // 1MB chunks
            const buf = Buffer.alloc(CHUNK);
            for (const l of maps.split('\n')) {
                const parts = l.split(' ');
                if (parts.length < 2 || !(parts[1].startsWith('rw') || (parts[1].startsWith('r--') && l.includes('wrapper.node')))) continue;
                const [rs, re] = parts[0].split('-');
                const start = parseInt(rs, 16), end = parseInt(re, 16);
                const size = end - start;
                if (size < 0x1000 || size > 0x1000000) continue; // 4KB-16MB
                let run = 0, runStart = 0;
                for (let off = 0; off < size; off += CHUNK) {
                    const toRead = Math.min(CHUNK, size - off);
                    const n = fs.readSync(fd, buf, 0, toRead, start + off);
                    if (n < toRead) break;
                    for (let j = 0; j < n; j += 8) {
                        const v = buf.readBigUInt64LE(j);
                        if (v >= BigInt(textStart) && v < BigInt(textEnd)) {
                            if (run === 0) runStart = start + off + j;
                            run++;
                            (globalThis as any).__ktp = ((globalThis as any).__ktp ?? 0) + 1;
                        } else {
                            if (run >= 40) {
                                // Check entry 241 from runStart (allow gaps)
                                const e241Addr = runStart + 241 * 8;
                                try {
                                    const n2 = fs.readSync(fd, buf, 0, 8, e241Addr);
                                    if (n2 === 8) {
                                        const e241 = buf.readBigUInt64LE(0);
                                        if (e241 >= BigInt(textStart) && e241 < BigInt(textEnd)) {
                                            results.push({
                                                vtable: '0x' + runStart.toString(16),
                                                runLen: run,
                                                entry241: '0x' + e241.toString(16),
                                                rva241: '0x' + (e241 - BigInt(base)).toString(16),
                                            });
                                        }
                                    }
                                } catch { /* unreadable */ }
                            }
                            run = 0;
                        }
                    }
                }
                if (run >= 80) results.push({ vtable: '0x' + runStart.toString(16), entries: run, partial: true });
            }
            const wrapperRw = maps.split('\n').filter((l: string) => l.includes('wrapper.node') && (l.includes('rw') || l.includes('r--'))).filter((l: string) => !l.includes('r-x')).map((l: string) => {
                const [r] = l.split(' ');
                const [a, b] = r.split('-');
                return { start: parseInt(a, 16), end: parseInt(b, 16) };
            });
            const ptrLocs: string[] = [];
            for (const w of wrapperRw) {
                for (let a = w.start; a < w.end - 8; a += 8) {
                    const n2 = fs.readSync(fd, buf, 0, 8, a);
                    if (n2 === 8) {
                        const v = buf.readBigUInt64LE(0);
                        if (v >= BigInt(textStart) && v < BigInt(textEnd)) {
                            ptrLocs.push('0x' + (a - base).toString(16) + '->0x' + (v - BigInt(base)).toString(16));
                        }
                    }
                }
            }
            // Analyze RELRO runs for vtable with entry 241
            const allPairs: Array<[number, bigint]> = [];
            for (const w of wrapperRw) {
                for (let a = w.start; a < w.end - 8; a += 8) {
                    const n2 = fs.readSync(fd, buf, 0, 8, a);
                    if (n2 === 8) {
                        const v = buf.readBigUInt64LE(0);
                        if (v >= BigInt(textStart) && v < BigInt(textEnd)) {
                            allPairs.push([a, v]);
                        }
                    }
                }
            }
            allPairs.sort((a, b) => a[0] - b[0]);
            const vtResults: unknown[] = [];
            let runStart2 = -1, runCount = 0, lastLoc = -1;
            for (const [loc, v] of allPairs) {
                if (runStart2 < 0 || loc - lastLoc > 32) {
                    if (runCount >= 200 && runStart2 >= 0) {
                        const idx = runStart2 + 241 * 8;
                        const hit = allPairs.find((p2) => p2[0] === idx);
                        if (hit) {
                            vtResults.push({ at: '0x' + runStart2.toString(16), entries: runCount, entry241Rva: '0x' + hit[1].toString(16) });
                        }
                    }
                    runStart2 = loc; runCount = 1;
                } else { runCount++; }
                lastLoc = loc;
            }
            if (runCount >= 200 && runStart2 >= 0) {
                const idx = runStart2 + 241 * 8;
                const hit = allPairs.find((p2) => p2[0] === idx);
                if (hit) vtResults.push({ at: '0x' + runStart2.toString(16), entries: runCount, entry241Rva: '0x' + hit[1].toString(16) });
            }
            fs.closeSync(fd);
            return { base: '0' + 'x' + base.toString(16), totalRelroPtrs: allPairs.length, bigVtables: vtResults.slice(0, 10) };
        } catch (e) {
            return { error: String(e) };
        }
    }

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
            this.pbUint(12, 1), // isReserved (uid mode, NapCat pattern)
        ];
        if (withServiceType) parts.push(this.pbUint(15, 0)); // ServiceType (Lagrange-compatible)
        return Buffer.concat(parts);
    }

    /** Build SendPoke body (0xED3_1): {uin: target, groupUin|friendUin: peer, ext: 0} */
    private buildPokeBody(targetUin: number, peerUin: number, isGroup: boolean): Buffer {
        const parts = [this.pbUint(1, targetUin)];
        parts.push(isGroup ? this.pbUint(2, peerUin) : this.pbUint(5, peerUin));
        parts.push(this.pbUint(6, 0)); // ext: 0
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
                // The kernel coerces the param via napi_coerce_to_string which calls
// Buffer.toString() (utf8). Binary data with invalid UTF-8 sequences gets
// corrupted. Fix: encode as latin1 string (byte-preserving in JS strings).
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

    // ---------------- native packet hook (MoeHoo) ----------------
    //
    // MoeHoo.linux.x64.node (NapCat's packet module) hooks the SSO send/recv
    // functions inside wrapper.node via funchook, exposing every SSO packet
    // as (type, uin, cmd, seq, hex_data) callbacks. InitHook takes hex strings
    // whose parsed values it shifts RIGHT by 1 — so we must pass realRva << 1.
    //
    // For QQ 3.2.35-54395 the SSO send function was located by signature: the
    // 3.2.34-53644 anchor (real RVA 0x65f92d0) matches byte-for-byte and
    // uniquely in our wrapper.node (verified against the pristine AppImage).
    // Function entry is 0x65f9110; the mid-function address NapCat-style
    // tables carry (0x65f92d0) hooks equally well — we pass the entry.
    private static readonly SSO_SEND_RVA = 0x670dd20; // MSF::MSFSDK::sendPacket(unique_ptr<MSFRequest>) — dynsym
    private static readonly SSO_RECV_RVA = 0x65fa070; // 3.2.34 recv anchor (>>1 decoded)
    private static readonly MOEHOOK_PATH = '../../work/ref/NapCatQQ/packages/napcat-native/packet/MoeHoo.linux.x64.node';

    private moehooMod: { exports: Record<string, (...a: unknown[]) => unknown> } | null = null;
    /** Packet listeners by SSO command name ('' = all). */
    private packetListeners = new Map<string, Set<(pkt: { type: number; uin: string; cmd: string; seq: number; hex: string }) => void>>();
    private hooked = false;
    /** Set by console API: log the next N packets at full detail. */
    packetDebug = false;
    packetDebugCount = 0;
    /** Log incoming face-bearing gray tips (poke shape research). */
    pokeShapeDebug = false;

    /** Encode a real RVA the way MoeHoo's InitHook expects (left-shifted by 1). */
    private encodeRva(rva: number): string {
        return (rva << 1).toString(16);
    }

    /** Subscribe to SSO packets; returns an unsubscribe function. */
    onPacket(cmd: string, fn: (pkt: { type: number; uin: string; cmd: string; seq: number; hex: string }) => void): () => void {
        const key = cmd ?? '';
        if (!this.packetListeners.has(key)) this.packetListeners.set(key, new Set());
        this.packetListeners.get(key)!.add(fn);
        return () => { this.packetListeners.get(key)?.delete(fn); };
    }

    /**
     * Install the MoeHoo SSO packet hook (opt-in debug feature, see
     * packetDebugEnabled). Idempotent; failure is non-fatal.
     */
    async initPacketHook(): Promise<boolean> {
        if (this.hooked) return true;
        try {
            const fsMod = await import('node:fs');
            const fs = fsMod.default ?? fsMod;
            const pathMod = await import('node:path');
            const path = pathMod.default ?? pathMod;
            const { fileURLToPath } = await import('node:url');
            const here = path.dirname(fileURLToPath(import.meta.url));
            const candidates = [
                // Bundled next to the runtime (deploy your own copy here).
                path.resolve(here, '../native/MoeHoo.linux.x64.node'),
                // Development tree (NapCat reference checkout).
                path.resolve(here, '../../../..', 'work/ref/NapCatQQ/packages/napcat-native/packet/MoeHoo.linux.x64.node'),
                '/mnt/d/project/KatheryneQQ/work/ref/NapCatQQ/packages/napcat-native/packet/MoeHoo.linux.x64.node',
            ];
            const modPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
            if (!modPath) {
                console.error('[katheryne] MoeHoo module not found');
                return false;
            }
            const mod = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
            (process as unknown as { dlopen: (m: unknown, p: string) => void }).dlopen(mod, modPath);
            if (typeof mod.exports.initHook !== 'function') {
                console.error('[katheryne] MoeHoo initHook export missing');
                return false;
            }
            this.moehooMod = mod;
            const dispatch = (type: number, uin: string, cmd: string, seq: number, hex: string) => {
                if (this.packetDebug) {
                    // First N packets logged at full length for envelope analysis.
                    if (this.packetDebugCount > 0) {
                        this.packetDebugCount--;
                        console.error(`[moehoo-cb] type=${type} uin=${uin} cmd=${cmd} seq=${seq} len=${hex.length / 2} hex=${hex.slice(0, 400)}`);
                    }
                }
                for (const fn of this.packetListeners.get('') ?? []) {
                    try { fn({ type, uin, cmd, seq, hex }); } catch { /* listener error */ }
                }
                for (const fn of this.packetListeners.get(cmd) ?? []) {
                    try { fn({ type, uin, cmd, seq, hex }); } catch { /* listener error */ }
                }
            };
            const result = mod.exports.initHook(
                this.encodeRva(KatheryneRuntime.SSO_SEND_RVA),
                this.encodeRva(KatheryneRuntime.SSO_RECV_RVA),
                dispatch,
                false,
            ) as string;
            const ok = result === 'success' || String(result).includes('success');
            this.hooked = ok;
            console.error(`[katheryne] moehoo initHook -> ${result}`);
            return ok;
        } catch (e) {
            console.error('[katheryne] moehoo load error', e instanceof Error ? e.message : e);
            return false;
        }
    }

    /** True once the SSO hook is live (optional packet inspection feature). */
    get packetHookReady(): boolean {
        return this.hooked;
    }

    /** MoeHoo packet hook is opt-in: config.packet_debug or env var. */
    private packetDebugEnabled(): boolean {
        if (process.env.KATHERYNE_PACKET_DEBUG === '1') return true;
        return this.config.packet_debug === true;
    }

    /** Poke a user in a group or privately.
     *
     * Path: NodeIKernelMSFService.sendMsfRequest — the kernel's binary SSO
     * channel. Working combination verified on 3.2.35-54395:
     *   - payload = OIDB 0xED3_1 wrapped in OidbSvcTrpcTcpBase, passed as a
     *     real TypedArray (the binding reads napi_get_typedarray_info; a Node
     *     Buffer is typeof object and is silently ignored);
     *   - cmd must be whitelisted in the kernel's static table (RELRO), hence
     *     the memsync patch (see ensurePokeCmdWhitelisted);
     *   - account = self uin (the MSF request account context is the sending
     *     account; passing the peer/group code makes MSF drop the request),
     *     accountType = 1;
     *   - the binding is fire-and-forget: it returns undefined immediately and
     *     MSF queues the packet, so success = call did not throw.
     */
    private async sendPoke(targetUin: number, peerUin: number, isGroup: boolean): Promise<boolean> {
        try {
            const msf = this.services?.msf as any;
            if (typeof msf?.sendMsfRequest !== 'function') {
                console.error('[poke] sendMsfRequest not available on this kernel');
                return false;
            }
            // The kernel drops cmds missing from its static whitelist — add ours.
            await this.ensurePokeCmdWhitelisted();
            if (!this.pokeCmdWhitelisted) {
                console.error('[poke] cmd whitelist patch not applied; packet would be dropped');
                return false;
            }
            const body = this.buildPokeBody(targetUin, peerUin, isGroup);
            const packet = this.buildOidb(0xED3, 1, body);
            const seq = String(Date.now() % 1000000000);
            msf.sendMsfRequest(seq, 'OidbSvcTrpcTcp.0xED3_1', new Uint8Array(packet), {
                sendTimeout: 5000,
                sendTimeoutOnSlowNet: 10000,
                resendNum: 0,
                sendOptions: 0,
                reqTargetAccountType: 1,
                account: String(this.selfUin),
                accountType: 1,
                transInfoMap: new Map(),
            });
            return true;
        } catch (e) {
            console.error('[poke] error', e instanceof Error ? e.message : e);
            return false;
        }
    }

    /** One-time repoint of a harmless MSF whitelist entry to the poke cmd.
     *
     * sendMsfRequest drops cmds missing from its two static tables (RELRO,
     * see docs/poke.md). Our tiny native addon mprotects the table page and
     * repoints entry "QQClubComm.getNewFlag" (unused QQ-club poller) at
     * OidbSvcTrpcTcp.0xED3_1. Idempotent; original entry restorable.
     */
    private memsyncMod: { exports: { patch?: (cmd: string) => string; restore?: () => string } } | null = null;
    private pokeCmdWhitelisted = false;
    private async ensurePokeCmdWhitelisted(): Promise<void> {
        if (this.pokeCmdWhitelisted) return;
        try {
            const fsMod = await import('node:fs');
            const fs = fsMod.default ?? fsMod;
            const pathMod = await import('node:path');
            const path = pathMod.default ?? pathMod;
            const { fileURLToPath } = await import('node:url');
            const here = path.dirname(fileURLToPath(import.meta.url));
            const candidates = [
                path.resolve(here, '../native/katheryne_memsync.node'),
                '/mnt/d/project/KatheryneQQ/native/katheryne_memsync.node',
            ];
            const modPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
            if (!modPath) {
                console.error('[poke-whitelist] memsync addon not found');
                return;
            }
            const mod = this.memsyncMod ?? { exports: {} as { patch?: (cmd: string) => string; restore?: () => string } };
            if (!this.memsyncMod) {
                (process as unknown as { dlopen: (m: unknown, p: string) => void }).dlopen(mod, modPath);
                this.memsyncMod = mod;
            }
            const r = mod.exports.patch?.('OidbSvcTrpcTcp.0xED3_1');
            this.pokeCmdWhitelisted = typeof r === 'string' && r.startsWith('patched');
            console.error('[poke-whitelist]', r);
        } catch (e) {
            console.error('[poke-whitelist] error', e instanceof Error ? e.message : e);
        }
    }

    // ---------------- message -> OB11 ----------------

    /**
     * Map a reply element's server-side msgId onto the id this runtime exposes
     * (the kernel's local msgId). Messages we sent ourselves carry different
     * server/local ids, so quoting them would otherwise point at an id that
     * never appeared in our event stream. msgSeq is stable across both.
     */
    private async resolveReplyLocalId(peer: { chatType: number; peerUid: string; guildId?: string }, seq: string): Promise<string | null> {
        try {
            const svc = this.requireServices().msg;
            const r = await svc.getMsgsBySeqAndCount(peer, String(seq), 1, true, true);
            const raw = ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>)[0];
            return raw?.msgId ? String(raw.msgId) : null;
        } catch {
            return null;
        }
    }

    private async emitMessage(m: RawMessage, sent: boolean): Promise<void> {
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
            // Cache message_id -> peer so message_id-only actions (get_msg,
            // delete_msg, mark_msg_as_read) work for received messages too.
            const mid = String(m.msgId ?? '');
            if (mid && peerUid) {
                this.msgPeerCache.set(mid, { chatType, peerUid });
            }
            const segments = await ntElementsToSegments(
                (m.elements ?? []) as Array<Record<string, unknown>>,
                {
                    resolveUid: (uid) => this.uidToUin.get(uid) ?? null,
                    selfUid: this.selfUid,
                    peer: { chatType, peerUid, guildId: '' },
                    resolveReplyId: (p2, seq) => this.resolveReplyLocalId(p2, seq),
                },
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
        /** Log a kernel group-op response and throw when it reports failure. */
        const kernelOp = (op: string, r: unknown): void => {
            const rr = (r ?? {}) as Record<string, any>;
            const nested = rr.result && typeof rr.result === 'object' ? rr.result : null;
            const code = typeof rr.result === 'number' ? rr.result
                : typeof nested?.result === 'number' ? nested.result
                : undefined;
            const msg = String(rr.errMsg ?? nested?.errMsg ?? '');
            console.error(`[group-op] ${op}:`, JSON.stringify(r)?.slice(0, 300));
            if (code !== undefined && code !== 0) {
                throw new Error(`${op} rejected: code=${code} ${msg}`.trim());
            }
        };
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
            async ensureUid(uin: string): Promise<string | null> {
                if (uin === self.selfUin) return self.selfUid;
                const cached = self.uinToUid.get(uin);
                if (cached) return cached;
                try {
                    const uix = self.services?.uix;
                    if (uix?.getUid) {
                        const rr = await uix.getUid([uin]) as Record<string, any>;
                        const uidInfo = rr?.uidInfo;
                        const uid = uidInfo?.get?.(uin) ?? uidInfo?.[uin]
                            ?? rr?.result?.uidInfo?.get?.(uin) ?? rr?.result?.uidInfo?.[uin];
                        if (uid && !String(uid).includes('*')) {
                            self.uinToUid.set(uin, String(uid));
                            self.uidToUin.set(String(uid), uin);
                            return String(uid);
                        }
                    }
                } catch { /* fallthrough */ }
                // Last resort: harvest from any cached group member list.
                for (const [uid, u] of self.uidToUin) {
                    if (u === uin) return uid;
                }
                return null;
            },
            resolveMsgPeer(msgId: string): { chatType: number; peerUid: string } | null {
                return self.msgPeerCache.get(msgId) ?? null;
            },
            async fetchMsgByMsgId(peer, msgId) {
                const svc = self.requireServices().msg;
                const r = await svc.getMsgsByMsgId(peer, [String(msgId)]);
                return ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>)[0];
            },
            async fetchMsgBySeq(peer, seq) {
                const svc = self.requireServices().msg;
                // getMsgsBySeqAndCount(peer, seq, count, desc, isReverseOrder)
                const r = await svc.getMsgsBySeqAndCount(peer, String(seq), 1, true, true);
                return ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>)[0];
            },
            async resolveMemberNickname(groupCode, uin) {
                const now = Date.now();
                const cached = self.memberNickCache.get(groupCode);
                if (cached && now - cached.at < 300_000) {
                    return cached.byUin.get(String(uin)) ?? null;
                }
                try {
                    const group = self.requireServices().group;
                    const res = await group.getAllMemberList(groupCode, true);
                    const result = (res?.result ?? res ?? {}) as Record<string, unknown>;
                    const ids = (result?.ids ?? []) as Array<{ uid: string }>;
                    const infosRaw = result?.infos as unknown;
                    const asMap = infosRaw as Map<string, Record<string, any>>;
                    const getInfo = (uid: string) => (typeof asMap?.get === 'function'
                        ? asMap.get(uid)
                        : (infosRaw as Record<string, Record<string, any>>)?.[uid]);
                    const byUin = new Map<string, string>();
                    for (const { uid } of ids) {
                        const info = getInfo(uid) ?? {};
                        const u = String(info.uin ?? '');
                        if (u) byUin.set(u, String(info.cardName || info.nick || u));
                    }
                    self.memberNickCache.set(groupCode, { at: now, byUin });
                    return byUin.get(String(uin)) ?? null;
                } catch {
                    return null;
                }
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
                const segments = await ntElementsToSegments(
                    (raw.elements ?? []) as Array<Record<string, unknown>>,
                    {
                        resolveUid: (uid) => self.uidToUin.get(uid) ?? null,
                        selfUid: self.selfUid,
                        peer,
                        resolveReplyId: (p2, seq) => self.resolveReplyLocalId(p2, seq),
                    },
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
                const out: Array<Record<string, unknown>> = [];
                for (const raw of list) {
                    const segments = await ntElementsToSegments(
                        (raw.elements ?? []) as Array<Record<string, unknown>>,
                        {
                            resolveUid: (uid) => self.uidToUin.get(uid) ?? null,
                            selfUid: self.selfUid,
                            peer,
                            resolveReplyId: (p2, seq) => self.resolveReplyLocalId(p2, seq),
                        },
                    );
                    out.push({
                        message_id: String(raw.msgId ?? ''),
                        real_id: Number(raw.msgSeq ?? 0),
                        sender: { user_id: String(raw.senderUin ?? '') },
                        time: Number(raw.msgTime ?? 0),
                        message: segments,
                        raw_message: segmentsToRawText(segments as OB11Segment[]),
                    });
                }
                return out;
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
                // The kernel exposes no per-member getter: pull the full list
                // and pick the member (same source NapCat's cache uses).
                const res = await group.getAllMemberList(groupCode, true);
                const result = (res?.result ?? res ?? {}) as Record<string, unknown>;
                const infosRaw = result?.infos as unknown;
                const asMap = infosRaw as Map<string, Record<string, unknown>>;
                const mem = (typeof asMap?.get === 'function'
                    ? asMap.get(memberUid)
                    : (infosRaw as Record<string, Record<string, unknown>>)?.[memberUid]) as Record<string, unknown> | undefined;
                if (!mem) throw new Error('member not found');
                const roleNum = Number(mem.role ?? 0);
                return {
                    user_id: String(mem.uin ?? self.uidToUin.get(memberUid) ?? ''),
                    nickname: String(mem.nick ?? ''),
                    card: String(mem.cardName ?? ''),
                    role: roleNum === 1 ? 'owner' : roleNum === 2 ? 'admin' : 'member',
                    level: Number(mem.level ?? 0),
                    title: String(mem.title ?? ''),
                };
            },
            async setGroupBan(groupCode, memberUid, durationSec) {
                const group = self.requireServices().group;
                kernelOp('setMemberShutUp', await group.setMemberShutUp(groupCode, [{ uid: memberUid, timeStamp: Math.max(0, durationSec) }]));
            },
            async setGroupWholeBan(groupCode, enable) {
                const group = self.requireServices().group;
                kernelOp('setGroupShutUp', await group.setGroupShutUp(groupCode, enable));
            },
            async setGroupKick(groupCode, memberUids, rejectForever) {
                const group = self.requireServices().group;
                kernelOp('kickMember', await group.kickMember(groupCode, memberUids, rejectForever, ''));
            },
            async setGroupLeave(groupCode, dismiss) {
                const group = self.requireServices().group;
                if (dismiss) kernelOp('destroyGroup', await group.destroyGroup(groupCode));
                else kernelOp('quitGroup', await group.quitGroup(groupCode));
            },
            async setGroupCard(groupCode, memberUid, card) {
                const group = self.requireServices().group;
                kernelOp('modifyMemberCardName', await group.modifyMemberCardName(groupCode, memberUid, card));
            },
            async setGroupName(groupCode, name) {
                const group = self.requireServices().group;
                kernelOp('modifyGroupName', await group.modifyGroupName(groupCode, name, false));
            },
            async setGroupAdmin(groupCode, memberUid, enable) {
                const group = self.requireServices().group;
                kernelOp('modifyMemberRole', await group.modifyMemberRole(groupCode, memberUid, enable ? 2 : 3));
            },
            async setGroupAvatar(groupCode, file) {
                const group = self.requireServices().group;
                kernelOp('setHeader', await group.setHeader(groupCode, file));
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
            scanVtables() {
                return self.scanVtablesInProcess();
            },
            setPacketDebug(on: boolean, count: number) {
                self.packetDebug = on;
                self.packetDebugCount = on ? Math.max(1, Math.min(count || 20, 100)) : 0;
                return { on: self.packetDebug, count: self.packetDebugCount };
            },
            logs() {
                return self.consoleMgr?.recentLogs() ?? [];
            },
            async logins() {
                if (!self.loginFlow) return [];
                const list = await self.loginFlow.listLogins();
                return list.map((item) => {
                    const raw = item as unknown as Record<string, unknown>;
                    return {
                        uin: String(raw.uin ?? ''),
                        uid: String(raw.uid ?? ''),
                        nick: String(raw.nick ?? raw.nickName ?? ''),
                        faceUrl: String(raw.faceUrl ?? ''),
                    };
                });
            },
            async getConfig() {
                const p = self.configPath;
                const content = fs.existsSync(p)
                    ? fs.readFileSync(p, 'utf-8')
                    : JSON.stringify(self.config, null, 2);
                return { path: p, content };
            },
            async saveConfig(content: string) {
                // Validate before writing so the next boot can't fail on syntax.
                const parsed = JSON.parse(content) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('config must be a JSON object');
                }
                const p = self.configPath;
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify(parsed, null, 2));
                return { ok: true, path: p, restartRequired: true };
            },
        };
    }
}

export async function initRuntime(): Promise<void> {
    const runtime = new KatheryneRuntime();
    await runtime.start();
}

export { groupPeer, c2cPeer };
