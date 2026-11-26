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
import { ntElementsToSegments, segmentsToCQCode, type OB11Segment } from '../onebot/message/segments.js';
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
    /** Report messages sent by the bot itself as message events with
     * sub_type 'self' (NapCat's reportSelfMessage). Default: false. */
    report_self_message?: boolean;
    /** meta_event heartbeat interval in ms (default 30000). */
    heartbeat_interval_ms?: number;
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

/** Detect common image formats from magic bytes (for extension-less base64). */
function sniffImageExt(buf: Buffer): string | undefined {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
    return undefined;
}

/** Detect common audio formats from magic bytes. */
function sniffAudioExt(buf: Buffer): string | undefined {
    if (buf.length >= 9 && buf.subarray(0, 9).toString('latin1').includes('#!SILK')) return 'silk';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
    if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
    if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
    if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === '#!AMR\n') return 'amr';
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
    if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
    return undefined;
}

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
    /** groupCode -> { at, uin -> {nick, card, role} } for @ and sender meta. */
    private memberInfoCache = new Map<string, { at: number; byUin: Map<string, { nick: string; card: string; role: string }> }>();
    /**
     * CDN rkey for NT v2 images (appid 1406/1407). The kernel keeps its own
     * rkey manager but does not expose it over NAPI, so mirror NapCat's
     * fallback: fetch from a public rkey service and cache until expiry.
     * Images on the md5 path need no rkey.
     */
    private rkeyData: { group: string; private: string; expireAt: number } | null = null;
    private rkeyFetching: Promise<void> | null = null;
    private static readonly RKEY_SERVICES = [
        'http://ss.xingzhige.com/music_card/rkey',
        'https://secret-service.bietiaop.com/rkeys',
    ];
    /** uid/uin -> nickname for private-chat senders (LRU-bounded). */
    private nickCache = new Map<string, string>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private groupListCache = new Map<string, Record<string, unknown>>();
    /** friend-request flag (reqTime) -> {uid, reqTime}, for set_friend_add_request. */
    private friendReqCache = new Map<string, { uid: string; reqTime: string }>();
    /** Recently seen message ids, oldest -> newest (for rounded-id recovery). */
    private recentMsgIds: string[] = [];
    private recentMsgIdSet = new Set<string>();
    /** fileKey -> media element location (get_image / get_record downloads). */
    private mediaIndex = new Map<string, {
        peer: { chatType: number; peerUid: string; guildId?: string };
        msgId: string;
        elementId: string;
        kind: 'image' | 'record';
        fileName?: string;
        fileSize?: number;
        url?: string;
        localPath?: string;
    }>();
    private downloadTempPath = '';
    /** pending rich-media downloads keyed by msgId|elementId */
    private pendingMediaDownloads = new Map<string, {
        resolve: (path: string) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

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

        // 3. Auto quick-login if configured and a record exists. The login
        // service connection may still be coming up right after kernel init
        // ("登录系统连接异常"), so retry a few times before giving up.
        const preferred = this.config.quick_login_uin;
        if (preferred) {
            void (async () => {
                for (let attempt = 1; attempt <= 6; attempt++) {
                    try {
                        await this.quickLogin(preferred);
                        return;
                    } catch (e) {
                        this.loginError = e instanceof Error ? e.message : String(e);
                        if (attempt === 6) {
                            console.error('[katheryne] auto quick login failed:', this.loginError);
                            return;
                        }
                        console.error(`[katheryne] auto quick login attempt ${attempt} failed, retrying in 2s:`, this.loginError);
                        await new Promise((r) => setTimeout(r, 2000));
                    }
                }
            })();
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
                // The QR callback carries no nickname; afterLogin resolves it.
                void this.afterLogin(uin, uid, '');
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
                    self_id: Number(this.selfUin) || this.selfUin,
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
            this.downloadTempPath = sessionConfig.defaultFileDownloadPath;
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
            void this.ensureRkey(true);
            // Quick-login often reports an empty nick; resolve the real one from
            // the profile service (NapCat does the same for selfInfo).
            if (!nick && uid) {
                void this.nickOfUid(uid, uin).then((n) => {
                    if (n) this.selfNick = n;
                });
            }

            this.phase = 'online';
            this.loginError = null;
            this.bus.emit({
                time: Math.floor(Date.now() / 1000),
                self_id: Number(this.selfUin) || this.selfUin,
                post_type: 'meta_event',
                meta_event_type: 'lifecycle',
                sub_type: 'connect',
            });
            this.startHeartbeat();
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
                            void this.emitRecallEvent(m, revokeEl.grayTipElement.revokeElement);
                        }
                        continue;
                    }
                    if (Number((m as Record<string, unknown>).msgType ?? 0) === 5) void this.emitGrayTip(m);
                }
            },
            onAddSendMsg: (m: RawMessage) => void this.emitMessage(m, true),
            onRichMediaDownloadComplete: (info: Record<string, any>) => {
                console.error('[rich-media-download]', JSON.stringify(info)?.slice(0, 400));
                const mid = String(info?.msgId ?? '');
                const eid = String(info?.msgElementId ?? info?.elementId ?? '');
                const key = `${mid}|${eid}`;
                const pending = this.pendingMediaDownloads.get(key);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pendingMediaDownloads.delete(key);
                const p = String(info?.filePath ?? '');
                if (p) pending.resolve(p);
                else pending.reject(new Error('download completed without filePath'));
            },
            onRecvMsgSvrRspTransInfo: () => undefined,
            onMsgEventListUpdate: () => undefined,
            onSendMsgError: () => undefined,
            onKickedOffLine: (info: { tipsTitle?: string; tipsDesc?: string }) => {
                this.bus.emit({
                    time: Math.floor(Date.now() / 1000),
                    self_id: Number(this.selfUin) || this.selfUin,
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
                        group_id: Number(code) || code,
                        group_name: String(g.groupName ?? ''),
                        member_count: Number(g.memberCount ?? 0),
                        max_member_count: Number(g.maxMember ?? 0),
                        group_all_shut: Number(g.groupShutupExpireTime ?? 0) > 0 ? -1 : 0,
                        group_remark: String(g.remarkName ?? ''),
                    });
                }
            },
            onGroupNotifiesUpdated: (_doubt: boolean, notifies: Array<Record<string, unknown>>) => {
                void this.emitGroupNotifies(notifies);
            },
            onGroupSingleScreenNotifies: (_doubt: boolean, _seq: string, notifies: Array<Record<string, unknown>>) => {
                void this.emitGroupNotifies(notifies);
            },
        }));
    }

    /** Resolve uids first so notice user_id/operator_id are numeric uins. */
    private async emitGroupNotifies(notifies: Array<Record<string, unknown>>): Promise<void> {
        const recent = (notifies ?? []).filter((n) => {
            // notify.seq is microsecond-based; skip pre-boot backlog (NapCat parity).
            const notifyTime = Number(n.seq ?? 0) / 1_000_000;
            return !(notifyTime > 0 && notifyTime < this.bootTimeSec);
        });
        const uids = new Set<string>();
        for (const n of recent) {
            for (const key of ['user1', 'user2', 'actionUser']) {
                const uid = String((n[key] as Record<string, unknown> | undefined)?.uid ?? '');
                if (uid && uid !== '0') uids.add(uid);
            }
        }
        await Promise.all([...uids].map((uid) => this.uinOfUid(uid)));
        for (const n of recent) {
            const ev = groupNotifyToNotice(n, this.selfUin, (uid) => this.uidToUin.get(uid) ?? null);
            if (ev) this.bus.emit(ev);
        }
    }

    private async emitBuddyRequests(arg: Record<string, unknown>): Promise<void> {
        const reqs = (arg?.reqList ?? arg?.newList ?? []) as Array<Record<string, unknown>>;
        for (const r of reqs) {
            const uid = String(r.friendUid ?? r.uid ?? '');
            const reqTime = String(r.reqTime ?? '');
            const flag = reqTime || uid;
            this.friendReqCache.set(flag, { uid, reqTime });
            const uin = uid ? await this.uinOfUid(uid) : '';
            const userId = uin || this.uidToUin.get(uid) || uid;
            this.bus.emit({
                time: Math.floor(Date.now() / 1000),
                self_id: Number(this.selfUin) || this.selfUin,
                post_type: 'request',
                request_type: 'friend',
                sub_type: String(r.sourceType ?? 'normal'),
                user_id: Number(userId) || userId,
                comment: String(r.reqTopic ?? ''),
                flag,
            });
        }
    }

    private attachBuddyListener(): void {
        const buddyService = this.services?.buddy;
        if (!buddyService) return;
        buddyService.addKernelBuddyListener(listenerProxy({
            onBuddyReqChange: (arg: Record<string, unknown>) => {
                void this.emitBuddyRequests(arg);
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
                        const res = (await profile.getCoreAndBaseInfo('nodeStore', uids)) as any;
                        // Map<uid, {coreInfo:{uin},...}> (usually), or a plain object.
                        const raw: any = res instanceof Map ? res : (res?.result?.info ?? res?.info ?? res);
                        const entries: Array<[string, any]> = raw instanceof Map
                            ? [...raw.entries()]
                            : Array.isArray(raw)
                                ? raw.map((f: any) => [String(f.uid ?? ''), f] as [string, any])
                                : Object.entries(raw ?? {});
                        let mapped = 0;
                        for (const [uid, info] of entries) {
                            const uin = String(info?.coreInfo?.uin ?? info?.uin ?? '');
                            if (uid && uin && uin !== '0') {
                                this.uinToUid.set(uin, uid);
                                this.uidToUin.set(uid, uin);
                                mapped++;
                            }
                        }
                        console.log(`[katheryne] getCoreAndBaseInfo: ${entries.length} entries, ${mapped} uin mappings`);
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
            await this.emitRecallEvent(recalled as RawMessage, revoke);
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
    private async emitRecallEvent(m: RawMessage, revoke: Record<string, any>): Promise<void> {
        const key = String(m.msgId ?? '');
        if (this.reportedRecalls.has(key)) return;
        this.reportedRecalls.add(key);
        if (this.reportedRecalls.size > 500) this.reportedRecalls.clear();
        const isGroup = Number(m.chatType ?? 0) === 2;
        const operatorUid = String(revoke.operatorUid ?? '');
        const operator = (await this.uinOfUid(operatorUid)) || this.resolveUidLive(operatorUid) || operatorUid;
        const author = (await this.uinOfUid(String(m.senderUid ?? ''))) || String(m.senderUin ?? '');
        const groupUin = this.uidToUin.get(String(m.peerUid ?? '')) ?? (String(m.peerUin ?? '') || String(m.peerUid ?? ''));
        const asId = (v: string): number | string => (Number(v) > 0 ? Number(v) : v);
        this.bus.emit({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(this.selfUin) || this.selfUin,
            post_type: 'notice',
            notice_type: isGroup ? 'group_recall' : 'friend_recall',
            group_id: isGroup ? asId(groupUin) : undefined,
            user_id: asId(author || operator),
            operator_id: isGroup ? asId(operator) : undefined,
            message_id: String(m.msgId ?? ''),
        } as never);
        this.consoleMgr?.log(`recall: ${isGroup ? 'group' : 'friend'} msg=${key}`);
    }

    /** uid -> nickname via the profile service (cached). */
    private async nickOfUid(uid: string, uin: string): Promise<string | null> {
        const key = uid || uin;
        const cached = this.nickCache.get(key);
        if (cached) return cached;
        const profile = this.services?.profile as any;
        let nick = '';
        if (profile && uid) {
            try {
                const res = await profile.getCoreAndBaseInfo?.('nodeStore', [uid]);
                const raw: any = res instanceof Map ? res : (res?.result?.info ?? res?.info ?? res);
                const info = raw instanceof Map ? raw.get(uid) : raw?.[uid];
                nick = String(info?.coreInfo?.nick ?? '');
            } catch { /* fall through */ }
            if (!nick) {
                try {
                    const d = await profile.getUserDetailInfo?.(uid);
                    nick = String(d?.coreInfo?.nick ?? d?.nick ?? d?.detail?.simpleInfo?.coreInfo?.nick ?? '');
                } catch { /* ignore */ }
            }
        }
        if (!nick && uin && /^\d+$/.test(uin)) {
            try {
                const d = await profile?.getUserDetailInfoByUin?.(uin);
                nick = String(d?.detail?.simpleInfo?.coreInfo?.nick ?? d?.coreInfo?.nick ?? '');
            } catch { /* ignore */ }
        }
        if (nick) {
            this.nickCache.set(key, nick);
            if (this.nickCache.size > 2000) {
                const oldest = this.nickCache.keys().next().value;
                if (oldest !== undefined) this.nickCache.delete(oldest);
            }
        }
        return nick || null;
    }

    /** uid -> uin (self-aware, kernel uix fallback). */
    private async uinOfUid(uid: string): Promise<string> {
        if (!uid) return '';
        if (uid === this.selfUid) return this.selfUin;
        const cached = this.uidToUin.get(uid);
        if (cached) return cached;
        try {
            const uix = this.services?.uix;
            const uin = uix?.getUin?.([uid])?.uinInfo?.get?.(uid);
            if (uin && String(uin) !== '0') {
                this.uidToUin.set(uid, String(uin));
                this.uinToUid.set(String(uin), uid);
                return String(uin);
            }
        } catch { /* ignore */ }
        // uix only knows contacts already in its cache; the profile service
        // can resolve any uid (same Map<uid,{coreInfo}> path as the friend
        // list and get_stranger_info).
        try {
            const profile = this.services?.profile;
            const res = (await profile?.getCoreAndBaseInfo?.('nodeStore', [uid])) as any;
            const raw: any = res instanceof Map ? res : (res?.result?.info ?? res?.info ?? res);
            const info = raw instanceof Map ? raw.get(uid) : raw?.[uid];
            const uin = String(info?.coreInfo?.uin ?? info?.uin ?? '');
            if (uin && uin !== '0') {
                this.uidToUin.set(uid, uin);
                this.uinToUid.set(uin, uid);
                return uin;
            }
        } catch { /* ignore */ }
        return '';
    }

    private async emitGrayTip(m: RawMessage): Promise<void> {
        try {
            const els = (m.elements ?? []) as Array<Record<string, any>>;
            const isGroup = Number(m.chatType ?? 0) === 2;
            const peerUid = String(m.peerUid ?? '');
            const groupUin = this.uidToUin.get(peerUid) ?? (String(m.peerUin ?? '') || peerUid);
            const asId = (v: string): number | string => (Number(v) > 0 ? Number(v) : v);
            for (const el of els) {
                const gray = el.grayTipElement;
                if (!gray) continue;
                const base = {
                    time: Number(m.msgTime ?? 0) || Math.floor(Date.now() / 1000),
                    self_id: Number(this.selfUin) || this.selfUin,
                    post_type: 'notice' as const,
                    group_id: isGroup ? (Number(groupUin) || groupUin) : undefined,
                };
                if (gray.revokeElement) {
                    await this.emitRecallEvent(m, gray.revokeElement);
                    continue;
                }
                // Group system tips: name change / member shut-up / self join.
                const ge = gray.groupElement as Record<string, any> | undefined;
                if (ge) {
                    const tipType = Number(ge.type ?? 0);
                    if (tipType === 5) { // KGROUPNAMEMODIFIED
                        const operator = await this.uinOfUid(String(ge.memberUid ?? ''));
                        this.bus.emit({
                            ...base,
                            notice_type: 'notify',
                            sub_type: 'group_name',
                            user_id: asId(operator || '0'),
                            name_new: String(ge.groupName ?? ''),
                        } as never);
                        continue;
                    }
                    if (tipType === 8 && ge.shutUp) { // KSHUTUP
                        const su = ge.shutUp as Record<string, any>;
                        let duration = Number(su.duration ?? 0);
                        const memberUid = String(su.member?.uid ?? '');
                        const adminUid = String(su.admin?.uid ?? '');
                        const memberUin = memberUid ? (await this.uinOfUid(memberUid) || memberUid) : '0';
                        const adminUin = adminUid ? (await this.uinOfUid(adminUid) || adminUid) : '0';
                        if (memberUin && adminUin) {
                            // Decide before normalizing: whole-group bans use
                            // duration -1 in the OB11 event but are still `ban`.
                            const isBan = duration > 0;
                            if (!memberUid && isBan) duration = -1;
                            this.bus.emit({
                                ...base,
                                notice_type: 'group_ban',
                                sub_type: isBan ? 'ban' : 'lift_ban',
                                user_id: memberUin === '0' ? 0 : asId(memberUin),
                                operator_id: adminUin === '0' ? 0 : asId(adminUin),
                                duration,
                            } as never);
                        }
                        continue;
                    }
                    if (tipType === 1) { // KMEMBERADD — self joined
                        if (String(ge.memberUid ?? '') === this.selfUid) {
                            const op = await this.uinOfUid(String(ge.adminUid ?? ''));
                            this.bus.emit({
                                ...base,
                                notice_type: 'group_increase',
                                sub_type: 'approve',
                                user_id: asId(this.selfUin),
                                operator_id: asId(op || '0'),
                            } as never);
                        }
                        continue;
                    }
                }
                const jsonStr = gray.jsonGrayTipElement?.jsonStr;
                if (!jsonStr) continue;
                let json: Record<string, any>;
                try { json = JSON.parse(jsonStr) as Record<string, any>; } catch { continue; }
                // Poke tips: NapCat keys on busiId 1061; fall back to wording.
                const busiId = String(gray.jsonGrayTipElement?.busiId ?? '');
                const isPoke = busiId === '1061' || jsonStr.includes('戳了戳') || jsonStr.includes('拍了拍');
                if (!isPoke) continue;
                const uids = (json.items ?? [])
                    .filter((it: { uid?: string }) => it.uid)
                    .map((it: { uid: string }) => it.uid) as string[];
                if (uids.length < 2) continue;
                const fromUid = uids[0];
                const toUid = uids[uids.length - 1];
                const fromUin = await this.uinOfUid(fromUid);
                const toUin = await this.uinOfUid(toUid);
                // go-cqhttp / NapCat format: notice_type=notify, sub_type=poke.
                this.bus.emit({
                    ...base,
                    notice_type: 'notify',
                    sub_type: 'poke',
                    user_id: asId(fromUin || fromUid),
                    target_id: asId(toUin || toUid),
                    ...(isGroup ? {} : { sender_id: asId(fromUin || fromUid) }),
                    raw_info: json,
                } as never);
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
    /**
     * Refresh the CDN rkey when stale. Never throws: on failure the previous
     * value (if any) is kept and callers get '' so they fall back to the
     * md5-style URL.
     */
    private async ensureRkey(force = false): Promise<void> {
        const now = Date.now();
        if (!force && this.rkeyData && this.rkeyData.expireAt - now > 60_000) return;
        if (this.rkeyFetching) return await this.rkeyFetching;
        this.rkeyFetching = (async () => {
            for (const url of KatheryneRuntime.RKEY_SERVICES) {
                try {
                    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
                    if (!res.ok) continue;
                    let data = (await res.json()) as Record<string, any>;
                    if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;
                    // Values arrive as "&rkey=<token>" (or already bare).
                    const strip = (v: unknown): string => String(v ?? '').replace(/^&?rkey=/, '');
                    const group = strip(data?.group_rkey);
                    const priv = strip(data?.private_rkey);
                    const expireAt = (Number(data?.expired_time) || 0) * 1000;
                    if (!group && !priv) continue;
                    this.rkeyData = { group, private: priv, expireAt: expireAt || now + 10 * 60_000 };
                    return;
                } catch {
                    // try the next service
                }
            }
            // All services failed: keep serving a still-valid cached value.
            if (!this.rkeyData || this.rkeyData.expireAt <= now) this.rkeyData = null;
        })();
        try { await this.rkeyFetching; } finally { this.rkeyFetching = null; }
    }

    /**
     * Build a directly downloadable URL for an inbound picture, matching
     * NapCat's FileApi.getImageUrl:
     *  - NT v2 (appid 1406 private / 1407 group) needs an rkey;
     *  - everything else uses the md5 path, which needs none.
     * Returns '' when a usable URL cannot be built.
     */
    private picUrl(pic: Record<string, any>): string {
        const origin = String(pic?.originImageUrl ?? '');
        const appid = /(?:[?&])appid=(\d+)/.exec(origin)?.[1] ?? '';
        const fileid = /(?:[?&])fileid=([^&]+)/.exec(origin)?.[1] ?? '';
        if (appid && fileid && (appid === '1406' || appid === '1407')) {
            const rkey = appid === '1406' ? this.rkeyData?.private : this.rkeyData?.group;
            if (rkey) return `https://gchat.qpic.cn/download?appid=${appid}&fileid=${fileid}&rkey=${rkey}&spec=0`;
            // No rkey yet: the md5 form is the only URL that can work.
        }
        const md5 = String(pic?.md5HexStr ?? '').toUpperCase();
        if (md5) return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0`;
        return '';
    }

    /** Index a media element so get_image/get_record can ask the kernel to download it. */
    private rememberMediaElement(key: string, meta: {
        peer: { chatType: number; peerUid: string; guildId?: string };
        msgId: string;
        elementId: string;
        kind: 'image' | 'record';
        fileName?: string;
        fileSize?: number;
        url?: string;
        localPath?: string;
    }): void {
        if (!key) return;
        this.mediaIndex.set(key, meta);
        if (meta.url) this.mediaIndex.set(meta.url, meta);
        if (this.mediaIndex.size > 4000) {
            const first = this.mediaIndex.keys().next().value;
            if (first) this.mediaIndex.delete(first);
        }
    }

    /** Drive NodeIKernelMsgService.downloadRichMedia for one element. */
    private async downloadRichMedia(meta: {
        peer: { chatType: number; peerUid: string; guildId?: string };
        msgId: string;
        elementId: string;
    }, timeoutMs = 120_000): Promise<string> {
        const svc = this.requireServices().msg as unknown as Record<string, any>;
        if (typeof svc.downloadRichMedia !== 'function') throw new Error('kernel downloadRichMedia unavailable');
        const key = `${meta.msgId}|${meta.elementId}`;
        const done = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingMediaDownloads.delete(key);
                reject(new Error('rich media download timeout'));
            }, timeoutMs);
            this.pendingMediaDownloads.set(key, { resolve, reject, timer });
        });
        try {
            await svc.downloadRichMedia([{
                fileModelId: '0',
                downSourceType: 0,
                downloadSourceType: 0,
                triggerType: 1,
                msgId: meta.msgId,
                chatType: meta.peer.chatType,
                peerUid: meta.peer.peerUid,
                elementId: meta.elementId,
                thumbSize: 0,
                downloadType: 1,
                filePath: '',
            }]);
        } catch (e) {
            const pending = this.pendingMediaDownloads.get(key);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingMediaDownloads.delete(key);
                pending.reject(e instanceof Error ? e : new Error(String(e)));
            }
            throw e;
        }
        return await done;
    }

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

    /** groupCode -> uin -> {nick, card, role}; cached for 5 minutes. */
    private async ensureMemberInfo(groupCode: string, force = false): Promise<Map<string, { nick: string; card: string; role: string }> | null> {
        const now = Date.now();
        const key = String(groupCode);
        const cached = this.memberInfoCache.get(key);
        if (!force && cached && now - cached.at < 300_000) return cached.byUin;
        try {
            const group = this.requireServices().group;
            const res = await group.getAllMemberList(key, true);
            const result = (res?.result ?? res ?? {}) as Record<string, unknown>;
            const ids = (result?.ids ?? []) as Array<{ uid: string }>;
            const infosRaw = result?.infos as unknown;
            const asMap = infosRaw as Map<string, Record<string, any>>;
            const getInfo = (uid: string) => (typeof asMap?.get === 'function'
                ? asMap.get(uid)
                : (infosRaw as Record<string, Record<string, any>>)?.[uid]);
            const byUin = new Map<string, { nick: string; card: string; role: string }>();
            for (const { uid } of ids) {
                const info = getInfo(uid) ?? {};
                const u = String(info.uin ?? '');
                if (!u) continue;
                const roleNum = Number(info.role ?? 0);
                byUin.set(u, {
                    nick: String(info.nick ?? ''),
                    card: String(info.cardName ?? ''),
                    role: roleNum === 4 ? 'owner' : roleNum === 3 ? 'admin' : 'member',
                });
            }
            this.memberInfoCache.set(key, { at: now, byUin });
            return byUin;
        } catch {
            return cached?.byUin ?? null;
        }
    }

    private async memberMeta(groupCode: string, uin: string): Promise<{ nick: string; card: string; role: string } | undefined> {
        const map = await this.ensureMemberInfo(String(groupCode));
        return map?.get(String(uin));
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        const interval = Math.max(5_000, Number(this.config.heartbeat_interval_ms ?? 30_000));
        const beat = () => this.bus.emit({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(this.selfUin) || this.selfUin,
            post_type: 'meta_event',
            meta_event_type: 'heartbeat',
            status: { online: this.phase === 'online', good: this.phase === 'online' },
            interval,
        } as never);
        beat();
        this.heartbeatTimer = setInterval(beat, interval);
    }

    /** group_upload notice for file messages (KMSGTYPEFILE = 3). */
    private emitGroupUpload(m: RawMessage): void {
        const fileEl = ((m.elements ?? []) as Array<Record<string, any>>).find((e) => e?.fileElement);
        const fe = fileEl?.fileElement as Record<string, any> | undefined;
        if (!fe) return;
        const peerUid = String(m.peerUid ?? '');
        const groupUin = this.uidToUin.get(peerUid) ?? (String(m.peerUin ?? '') || peerUid);
        const senderUin = String(m.senderUin ?? '') || this.uidToUin.get(String(m.senderUid ?? '')) || '';
        const asId = (v: string): number | string => (Number(v) > 0 ? Number(v) : v);
        this.bus.emit({
            time: Number(m.msgTime ?? 0) || Math.floor(Date.now() / 1000),
            self_id: Number(this.selfUin) || this.selfUin,
            post_type: 'notice',
            notice_type: 'group_upload',
            group_id: asId(groupUin),
            user_id: asId(senderUin),
            file: {
                id: String(fe.fileUuid ?? fe.fileId ?? fe.fileName ?? ''),
                name: String(fe.fileName ?? ''),
                size: Number(fe.fileSize ?? 0),
                busid: Number(fe.fileBizId ?? 0),
            },
        } as never);
    }

    /** Emit group_card when a member's group card differs from our cache. */
    private async maybeEmitGroupCard(m: RawMessage): Promise<void> {
        const senderUin = String(m.senderUin ?? '') || this.uidToUin.get(String(m.senderUid ?? '')) || '';
        if (!senderUin || senderUin === '0') return;
        const peerUid = String(m.peerUid ?? '');
        const groupUin = this.uidToUin.get(peerUid) ?? (String(m.peerUin ?? '') || peerUid);
        const map = await this.ensureMemberInfo(String(groupUin));
        const cached = map?.get(senderUin);
        if (!cached) return;
        const newCard = String(m.sendMemberName ?? '');
        if (cached.card === newCard) return;
        const asId = (v: string): number | string => (Number(v) > 0 ? Number(v) : v);
        this.bus.emit({
            time: Number(m.msgTime ?? 0) || Math.floor(Date.now() / 1000),
            self_id: Number(this.selfUin) || this.selfUin,
            post_type: 'notice',
            notice_type: 'group_card',
            group_id: asId(groupUin),
            user_id: asId(senderUin),
            card_new: newCard,
            card_old: cached.card,
        } as never);
        cached.card = newCard;
    }

    /** Build the OB11 (array-format) message object for a raw kernel message. */
    private rememberMsgId(id: string): void {
        if (!id || this.recentMsgIdSet.has(id)) return;
        this.recentMsgIdSet.add(id);
        this.recentMsgIds.push(id);
        if (this.recentMsgIds.length > 1000) {
            const dropped = this.recentMsgIds.shift();
            if (dropped) this.recentMsgIdSet.delete(dropped);
        }
    }

    /**
     * 19-digit snowflake ids cannot round-trip through a JSON number. If a
     * caller passes a rounded id (common with clients that coerce
     * message_id to Number), map it back to the recent id within the double
     * ULP window — but only when the match is unambiguous.
     */
    private canonicalMsgId(rawId: string): string {
        const id = String(rawId ?? '');
        if (!/^\d{17,}$/.test(id)) return id;
        if (this.recentMsgIdSet.has(id) || this.msgPeerCache.has(id)) return id;
        let input: bigint;
        try { input = BigInt(id); } catch { return id; }
        let match = '';
        for (let i = this.recentMsgIds.length - 1; i >= 0; i--) {
            const cand = this.recentMsgIds[i];
            if (!/^\d+$/.test(cand)) continue;
            const c = BigInt(cand);
            const diff = c > input ? c - input : input - c;
            if (diff > 4096n) continue;
            if (match && match !== cand) return id; // ambiguous: never guess
            match = cand;
        }
        return match || id;
    }

    /** Human hint for the classic "id came back as a JSON number" failure. */
    private msgNotFoundError(id: string): Error {
        const rounded = /^\d{17,}$/.test(id) && String(Number(id)) === id;
        return new Error(rounded
            ? `message not found: ${id} looks like a 19-digit id rounded by JSON number precision; keep message_id as a string`
            : `message not found: ${id}`);
    }

    private async buildOB11Message(m: RawMessage, sentOverride?: boolean): Promise<Record<string, unknown>> {
        const senderUid = String(m.senderUid ?? '');
        const senderUinRaw = String(m.senderUin ?? '');
        if (senderUid && senderUinRaw && senderUinRaw !== '0') {
            this.uidToUin.set(senderUid, senderUinRaw);
            this.uinToUid.set(senderUinRaw, senderUid);
        }
        const chatType = Number(m.chatType ?? 0);
        const isGroup = chatType === 2;
        const peerUid = String(m.peerUid ?? '');
        const peerUin = this.uidToUin.get(peerUid) ?? (String(m.peerUin ?? '') || peerUid);
        const senderUin = senderUinRaw || this.uidToUin.get(senderUid) || '';
        const sent = sentOverride ?? (!!senderUin && senderUin === this.selfUin);
        const mid = String(m.msgId ?? '');
        if (mid) this.rememberMsgId(mid);
        if (mid && peerUid) this.msgPeerCache.set(mid, { chatType, peerUid });

        let nick = String(m.senderNick ?? '');
        let card = '';
        let role: string | undefined;
        let groupName = '';
        if (isGroup) {
            const meta = await this.memberMeta(String(peerUin), senderUin);
            if (meta) {
                nick = meta.nick || nick;
                card = meta.card;
                role = meta.role;
            }
            const g = this.groupListCache.get(String(peerUin)) as Record<string, unknown> | undefined;
            groupName = String(g?.group_name ?? g?.groupName ?? '');
        } else if (senderUin) {
            // NapCat's handlePrivateMessage: the kernel's sendNickName is often
            // empty (or just the QQ number), so resolve the real nickname from
            // the profile service. Friends resolve through core/base info,
            // everyone else through getUserDetailInfo(uid).
            const resolved = senderUin === this.selfUin ? this.selfNick : await this.nickOfUid(senderUid, senderUin);
            if (resolved) nick = resolved;
        }

        const segments = await ntElementsToSegments(
            (m.elements ?? []) as Array<Record<string, unknown>>,
            {
                resolveUid: (uid) => this.uidToUin.get(uid) ?? null,
                selfUid: this.selfUid,
                peer: { chatType, peerUid, guildId: '' },
                resolveReplyId: (p2, seq) => this.resolveReplyLocalId(p2, seq),
                msgId: mid,
                resolvePicUrl: (pic) => this.picUrl(pic),
                rememberMedia: (key, meta) => this.rememberMediaElement(key, meta),
            },
        );

        const event: Record<string, unknown> = {
            time: Number(m.msgTime ?? 0) || Math.floor(Date.now() / 1000),
            self_id: Number(this.selfUin) || this.selfUin,
            post_type: sent ? 'message_sent' : 'message',
            message_type: isGroup ? 'group' : 'private',
            sub_type: isGroup ? 'normal' : 'friend',
            message_id: mid,
            message_seq: mid,
            real_id: mid,
            real_seq: String(m.msgSeq ?? ''),
            user_id: Number(senderUin) || senderUin,
            message: segments,
            raw_message: segmentsToCQCode(segments),
            font: 14,
            message_format: 'array',
            sender: {
                user_id: Number(senderUin) || senderUin,
                nickname: nick || senderUin,
                card: isGroup ? card : '',
                role,
            },
        };
        if (isGroup) {
            event.group_id = Number(peerUin) || peerUin;
            event.group_name = groupName;
        }
        if (sent || !isGroup) {
            event.target_id = Number(peerUin) || peerUin;
        }
        return event;
    }

    private async emitMessage(m: RawMessage, sent: boolean): Promise<void> {
        try {
            // NapCat-style message filters (parity with its onRecvMsg path):
            // 1) self messages are only reported when report_self_message=true
            if (sent && !this.config.report_self_message) return;
            const msgType = Number((m as Record<string, unknown>).msgType ?? 0);
            // 2) KMSGTYPENULL (1) carries no content
            if (msgType === 1) return;
            // 3) history/backfill older than process start is not reported
            if (!sent && Number(m.msgTime ?? 0) > 0 && Number(m.msgTime) < this.bootTimeSec) return;
            // KMSGTYPEGRAYTIPS = 5; 9 is REPLY, not a gray tip.
            if (msgType === 5) {
                void this.emitGrayTip(m);
                return;
            }
            const chatType = Number(m.chatType ?? 0);
            if (!sent && chatType === 2) {
                try {
                    if (msgType === 3) this.emitGroupUpload(m);
                    else await this.maybeEmitGroupCard(m);
                } catch { /* non-fatal */ }
            }
            const event = await this.buildOB11Message(m, sent);
            this.bus.emit(event as OB11AnyEvent);
        } catch (e) {
            console.error('[katheryne] emitMessage error', e);
        }
    }

    /**
     * Turn a flexible image source into a local file the kernel can ingest.
     * Accepts absolute paths, file://, data: URIs (base64 or percent-encoded),
     * base64://, bare base64 image bodies, and http(s) URLs (downloaded).
     */
    private async materializeMediaSource(src: string, kind: 'image' | 'record' = 'image'): Promise<string> {
        const raw = String(src ?? '').trim();
        if (!raw) throw new Error('empty image source');
        if (raw.startsWith('/')) {
            if (!fs.existsSync(raw)) throw new Error(`image file not found: ${raw}`);
            return raw;
        }
        if (/^file:\/\//i.test(raw)) {
            const { fileURLToPath } = await import('node:url');
            const p = fileURLToPath(raw);
            if (!fs.existsSync(p)) throw new Error(`image file not found: ${p}`);
            return p;
        }
        // Received-image file name: reuse the indexed local path or URL.
        if (!/^(data:|base64:|https?:)/i.test(raw)) {
            const meta = this.mediaIndex.get(raw);
            if (meta?.localPath && fs.existsSync(meta.localPath)) return meta.localPath;
            if (meta?.url) return await this.materializeMediaSource(meta.url, kind);
        }
        const dir = this.downloadTempPath && fs.existsSync(this.downloadTempPath)
            ? this.downloadTempPath
            : os.tmpdir();
        fs.mkdirSync(dir, { recursive: true });
        const sniff = kind === 'record' ? sniffAudioExt : sniffImageExt;
        const defaultExt = kind === 'record' ? 'silk' : 'png';
        const writeTemp = (buf: Buffer, extHint?: string): string => {
            if (!buf.length) throw new Error('empty media data');
            const ext = String(extHint || sniff(buf) || defaultExt).replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || defaultExt;
            const prefix = kind === 'record' ? 'katheryne-ptt' : 'katheryne-img';
            const file = path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
            fs.writeFileSync(file, buf);
            return file;
        };
        const dataUri = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(raw);
        if (dataUri) {
            const mime = dataUri[1] ?? '';
            const buf = dataUri[2]
                ? Buffer.from(dataUri[3], 'base64')
                : Buffer.from(decodeURIComponent(dataUri[3]), 'utf8');
            return writeTemp(buf, mime.split('/')[1]?.split('+')[0]);
        }
        if (/^base64:\/\//i.test(raw)) {
            return writeTemp(Buffer.from(raw.replace(/^base64:\/\//i, '').replace(/\s+/g, ''), 'base64'));
        }
        // Bare base64 body (only when it clearly decodes to image/audio).
        if (!/[\\/:]/.test(raw) && /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, '').length > 100) {
            const buf = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
            const ext = sniff(buf);
            if (ext) return writeTemp(buf, ext);
        }
        if (/^https?:\/\//i.test(raw)) {
            // Re-sending an image we received: the CDN URL may need QQ's
            // internal downloader (plain fetch gets 400), so reuse the
            // indexed element path first.
            for (const meta of this.mediaIndex.values()) {
                if (meta.url !== raw) continue;
                if (meta.localPath && fs.existsSync(meta.localPath)) return meta.localPath;
                if (meta.elementId) {
                    try { return await this.downloadRichMedia(meta, 4_000); } catch { /* fall through */ }
                }
                break;
            }
            const res = await fetch(raw, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
            if (!res.ok) {
                throw new Error(`media download failed: HTTP ${res.status} (QQ CDN URLs may only be downloadable by the client; use a local path/base64 instead)`);
            }
            const declared = Number(res.headers.get('content-length') ?? 0);
            if (declared > 20 * 1024 * 1024) throw new Error('media too large (>20MB)');
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 20 * 1024 * 1024) throw new Error('media too large (>20MB)');
            const ctype = (res.headers.get('content-type') ?? '').split(';')[0];
            const mimeExt = /^(image|audio)\//.test(ctype) ? ctype.split('/')[1] : '';
            return writeTemp(buf, mimeExt);
        }
        throw new Error(`unsupported media source: ${raw.slice(0, 48)}`);
    }

    /**
     * Prepare a local voice file for sending (NapCat parity): md5/size,
     * kernel rich-media staging path, and the pttElement fields the NT
     * sendMsg path expects.
     */
    private async decodeAudioWithFfmpeg(sourcePath: string): Promise<Buffer> {
        const { execFile } = await import('node:child_process');
        return await new Promise<Buffer>((resolve, reject) => {
            execFile(
                'ffmpeg',
                ['-v', 'error', '-i', sourcePath, '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'],
                { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
                (err, stdout) => {
                    if (err) {
                        reject(new Error(`voice transcode failed: ${err.message} (install ffmpeg, or provide mono 16-bit WAV at 8/12/16/24/32/44.1/48kHz or SILK)`));
                    } else {
                        resolve(stdout as Buffer);
                    }
                },
            );
        });
    }

    private async preparePttElement(sourcePath: string, durationHint = 0): Promise<Record<string, unknown>> {
        const crypto = await import('node:crypto');
        const silk = await import('silk-wasm');
        let data = fs.readFileSync(sourcePath);
        let workPath = sourcePath;
        let fileName = path.basename(sourcePath);
        let duration = 0;
        // QQ voice is SILK. SILK passes through; simple WAV goes straight to
        // silk-wasm. Other containers / odd WAV rates are normalized to
        // mono 24kHz PCM by ffmpeg first.
        if (!silk.isSilk(data)) {
            let pcmInput: Buffer = data;
            let sampleRate = 0;
            let useFfmpeg = !silk.isWav(data);
            if (!useFfmpeg) {
                try {
                    const fmt = silk.getWavFileInfo(data).fmt;
                    const allowed = [8000, 12000, 16000, 24000, 32000, 44100, 48000];
                    useFfmpeg = fmt.numberOfChannels !== 1 || fmt.bitsPerSample !== 16 || !allowed.includes(fmt.sampleRate);
                } catch {
                    useFfmpeg = true;
                }
            }
            if (useFfmpeg) {
                pcmInput = await this.decodeAudioWithFfmpeg(sourcePath);
                sampleRate = 24000;
            }
            const enc = await silk.encode(pcmInput, sampleRate);
            data = Buffer.from(enc.data);
            duration = enc.duration / 1000;
            const dir = this.downloadTempPath && fs.existsSync(this.downloadTempPath)
                ? this.downloadTempPath
                : os.tmpdir();
            fs.mkdirSync(dir, { recursive: true });
            workPath = path.join(dir, `katheryne-ptt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.silk`);
            fs.writeFileSync(workPath, data);
            fileName = path.basename(workPath);
        } else {
            try { duration = silk.getDuration(data) / 1000; } catch { /* use hint */ }
        }
        const hint = Number(durationHint) || 0;
        if (duration <= 0) duration = hint;
        // Last resort: NapCat's size-based estimate (~3 KB/s).
        if (duration <= 0) duration = Math.max(1, Math.floor(data.length / 1024 / 3));
        const md5 = crypto.createHash('md5').update(data).digest('hex');
        const fileSize = data.length;
        const msgService = this.services?.msg;
        let mediaPath = workPath;
        try {
            mediaPath = await (msgService as any).getRichMediaFilePathForGuild({
                md5HexStr: md5,
                fileName,
                elementType: 4, // PTT
                elementSubType: 0,
                thumbSize: 0,
                needCreate: true,
                downloadType: 1,
                file_uuid: '',
            });
            if (mediaPath && mediaPath !== workPath) {
                fs.mkdirSync(path.dirname(String(mediaPath)), { recursive: true });
                fs.copyFileSync(workPath, String(mediaPath));
            }
        } catch { /* fall back to original path */ }
        return {
            elementType: 4,
            elementId: '',
            pttElement: {
                fileName,
                filePath: String(mediaPath),
                md5HexStr: md5,
                fileSize: String(fileSize),
                duration,
                formatType: 1,
                voiceType: 1,
                voiceChangeType: 0,
                canConvert2Text: true,
                waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
                fileSubId: '',
                playState: 1,
                autoConvertText: 0,
                storeID: 0,
                otherBusinessInfo: { aiVoiceType: 0 },
            },
        };
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
        /** Map a kernel group member info record to the OB11 shape (NapCat parity). */
        const memberToOb11 = (groupCode: string, info: Record<string, any>): Record<string, unknown> => {
            const roleNum = Number(info.role ?? 0);
            const sexNum = Number(info.sex ?? 0);
            const qqLevel = info.qqLevel as Record<string, any> | number | undefined;
            const qqLevelNum = Number(typeof qqLevel === 'object' ? qqLevel?.level : qqLevel);
            const areaParts = [info.country, info.province, info.city]
                .filter((x) => typeof x === 'string' && x) as string[];
            return {
                group_id: Number(groupCode) || groupCode,
                user_id: Number(info.uin ?? 0) || String(info.uin ?? ''),
                nickname: String(info.nick ?? ''),
                card: String(info.cardName ?? ''),
                sex: sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown',
                age: Number(info.age ?? 0),
                area: String(info.area ?? (areaParts.length ? areaParts.join(' ') : '')),
                level: String(info.memberRealLevel ?? info.memberLevel ?? 0),
                qq_level: Number.isFinite(qqLevelNum) ? qqLevelNum : 0,
                join_time: Number(info.joinTime ?? 0),
                last_sent_time: Number(info.lastSpeakTime ?? 0),
                title: String(info.memberSpecialTitle ?? info.title ?? ''),
                title_expire_time: 0,
                card_changeable: true,
                unfriendly: false,
                is_robot: Boolean(info.isRobot),
                shut_up_timestamp: Number(info.shutUpTime ?? 0),
                role: roleNum === 4 ? 'owner' : roleNum === 3 ? 'admin' : 'member',
            };
        };
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
                return self.msgPeerCache.get(self.canonicalMsgId(msgId)) ?? null;
            },
            async fetchMsgByMsgId(peer, msgId) {
                const svc = self.requireServices().msg;
                const r = await svc.getMsgsByMsgId(peer, [self.canonicalMsgId(String(msgId))]);
                return ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>)[0];
            },
            async fetchMsgBySeq(peer, seq) {
                const svc = self.requireServices().msg;
                // getMsgsBySeqAndCount(peer, seq, count, desc, isReverseOrder)
                const r = await svc.getMsgsBySeqAndCount(peer, String(seq), 1, true, true);
                return ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>)[0];
            },
            async resolveMemberNickname(groupCode, uin) {
                const meta = await self.memberMeta(groupCode, uin);
                return meta ? (meta.card || meta.nick || null) : null;
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
                    if (el?.elementType === 4) {
                        const ptt = el.pttElement as Record<string, unknown> | undefined;
                        const src = String(ptt?.filePath ?? '');
                        if (src) {
                            const local = await self.materializeMediaSource(src, 'record');
                            elements[i] = await self.preparePttElement(local, Number(ptt?.duration ?? 0)) as never;
                        }
                        continue;
                    }
                    if (el?.elementType !== 2) continue;
                    const pic = el.picElement as Record<string, unknown> | undefined;
                    const src = String(pic?.sourcePath ?? '');
                    if (!src) continue;
                    // Paths, data:/base64:/file:/http(s) URLs, bare base64.
                    let local: string;
                    try {
                        local = await self.materializeMediaSource(src, 'image');
                    } catch (e) {
                        // Some clients send file=<name> plus a separate url.
                        const alt = String(pic?.picSubUrl ?? '');
                        if (!alt || alt === src) throw e;
                        local = await self.materializeMediaSource(alt, 'image');
                    }
                    elements[i] = await self.prepareImageElement(local) as never;
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
                self.rememberMsgId(finalId);
                self.msgPeerCache.set(finalId, { chatType: peer.chatType, peerUid: peer.peerUid });
                return { msgId: finalId };
            },
            async deleteMsg(peer, msgId) {
                const svc = self.requireServices().msg;
                // kernel: recallMsg(peer, msgIds[])
                await svc.recallMsg(peer, [self.canonicalMsgId(msgId)]);
            },
            async getMsg(peer, msgId) {
                const svc = self.requireServices().msg;
                const id = self.canonicalMsgId(msgId);
                const r = await svc.getMsgsByMsgId(peer, [id]);
                const raw = ((r?.result?.msgList ?? r?.msgList ?? []) as RawMessage[])[0];
                if (!raw) throw self.msgNotFoundError(String(msgId));
                await self.ensureRkey();
                return await self.buildOB11Message(raw);
            },
            async getMsgHistory(peer, msgId, count) {
                const svc = self.requireServices().msg;
                // kernel: getMsgsIncludeSelf(peer, startMsgId, count, isReverseOrder)
                const r = await svc.getMsgsIncludeSelf(peer, self.canonicalMsgId(msgId), count, false);
                const list = ((r?.result?.msgList ?? r?.msgList ?? []) as RawMessage[]);
                await self.ensureRkey();
                const out: Array<Record<string, unknown>> = [];
                for (const raw of list) out.push(await self.buildOB11Message(raw));
                return out;
            },
            /**
             * NapCat-parity history (go-cqhttp get_group_msg_history /
             * get_friend_msg_history): no cursor -> latest N messages
             * (getAioFirstViewLatestMsgs); with a cursor -> page from that
             * message. The cursor may be our snowflake message_id or a real
             * msgSeq, so disambiguate by magnitude before mapping.
             */
            async isBuddy(uid) {
                try {
                    return Boolean(await (self.requireServices().buddy as any)?.isBuddy?.(uid));
                } catch {
                    return false;
                }
            },
            async getChatHistory(peer, cursor, count, reverseOrder): Promise<Array<Record<string, unknown>>> {
                const svc = self.requireServices().msg as any;
                const peerRef = { chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' };
                const limit = Math.min(Math.max(Number(count) || 20, 1), 100);
                const cur = String(cursor ?? '').trim();
                const hasCursor = !!cur && cur !== '0';
                // Over-fetch, because system entries (gray tips / placeholders)
                // are dropped afterwards; NapCat returns a full page too.
                const fetchN = Math.min(limit * 2 + 4, 200);
                let list: RawMessage[];
                if (hasCursor) {
                    let startId = cur;
                    // Snowflake message ids are ~19 digits; msgSeq values are far
                    // smaller. Only treat short numbers as seq, otherwise the
                    // seq lookup silently matches a different message.
                    if (/^\d{1,12}$/.test(cur)) {
                        const bySeq = await svc.getMsgsBySeqAndCount(peerRef, cur, 1, true, true);
                        const hit = ((bySeq?.result?.msgList ?? bySeq?.msgList ?? []) as RawMessage[])[0];
                        // The kernel answers an unknown seq with the nearest
                        // message instead of failing, so verify the seq matches.
                        if (!hit?.msgId || String(hit.msgSeq) !== cur) throw new Error(`消息${cur}不存在`);
                        startId = String(hit.msgId);
                    }
                    const r = await svc.getMsgsIncludeSelf(peerRef, self.canonicalMsgId(startId), fetchN, !!reverseOrder);
                    list = ((r?.result?.msgList ?? r?.msgList ?? []) as RawMessage[]);
                } else {
                    const r = await svc.getAioFirstViewLatestMsgs(peerRef, fetchN);
                    list = ((r?.result?.msgList ?? r?.msgList ?? []) as RawMessage[]);
                }
                // Same content filter as the realtime path: KMSGTYPENULL (1)
                // entries are empty placeholders and KMSGTYPEGRAYTIPS (5) are
                // system notices (both surface as uid "0" / no text).
                list = list.filter((m) => {
                    const t = Number((m as Record<string, unknown>).msgType ?? 0);
                    return t !== 1 && t !== 5;
                });
                // NapCat throws when the page is empty; clients rely on this to
                // detect "no history" instead of treating it as success.
                if (list.length === 0) throw new Error(`消息${cur}不存在`);
                await self.ensureRkey();
                const out: Array<Record<string, unknown>> = [];
                for (const raw of list.slice(0, limit)) out.push(await self.buildOB11Message(raw));
                return out;
            },
            async markRead(peer) {
                const svc = self.requireServices().msg;
                await svc.setMsgRead(peer);
            },
            async getLoginInfo() {
                return { user_id: Number(self.selfUin), nickname: self.selfNick };
            },
            async getFriendList() {
                const buddy = self.requireServices().buddy;
                const profile = self.requireServices().profile;
                let uids: string[] = [];
                try {
                    const res = await buddy.getBuddyListV2('0', true, 0);
                    const cats = res?.data ?? [];
                    for (const cat of cats) for (const u of cat.buddyUids ?? []) uids.push(String(u));
                } catch { /* empty */ }
                // Bulk profile info: the kernel returns Map<uid, {coreInfo,
                // baseInfo}> directly (not {result:{info}}).
                const infoMap = new Map<string, Record<string, any>>();
                if (uids.length > 0) {
                    try {
                        const res = (await profile.getCoreAndBaseInfo('nodeStore', uids)) as any;
                        const raw: any = res instanceof Map ? res : (res?.result?.info ?? res?.info ?? res);
                        if (raw instanceof Map) {
                            for (const [uid, info] of raw) infoMap.set(String(uid), info as Record<string, any>);
                        } else if (raw && typeof raw === 'object') {
                            for (const [uid, info] of Object.entries(raw as Record<string, Record<string, any>>)) {
                                infoMap.set(String(uid), info);
                            }
                        }
                    } catch { /* per-uid fallback below */ }
                }
                const detailOf = async (uid: string): Promise<Record<string, any> | undefined> => {
                    const bulk = infoMap.get(uid);
                    if (bulk?.coreInfo) return bulk;
                    const uin = /^\d+$/.test(uid) ? uid : await self.uinOfUid(uid);
                    if (!uin) return undefined;
                    try {
                        const d = await profile.getUserDetailInfoByUin(uin);
                        const info = (d?.detail?.simpleInfo ?? d) as Record<string, any>;
                        if (info?.coreInfo) return info;
                        return { coreInfo: { uin, nick: '' } } as Record<string, any>;
                    } catch {
                        return undefined;
                    }
                };
                const build = (uid: string, info: Record<string, any> | undefined) => {
                    const core = (info?.coreInfo ?? {}) as Record<string, any>;
                    const base = (info?.baseInfo ?? {}) as Record<string, any>;
                    const resolvedUin = String(core.uin ?? info?.uin ?? self.uidToUin.get(uid) ?? '');
                    if (uid.startsWith('u_') && resolvedUin && resolvedUin !== '0') {
                        self.uidToUin.set(uid, resolvedUin);
                        self.uinToUid.set(resolvedUin, uid);
                    }
                    const sexNum = Number(base.sex ?? 0);
                    return {
                        user_id: Number(resolvedUin) || resolvedUin,
                        nickname: String(core.nick ?? ''),
                        remark: String(core.remark ?? core.nick ?? ''),
                        sex: sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown',
                        age: Number(base.age ?? 0),
                        birthday_year: Number(base.birthday_year ?? base.birthdayYear ?? 0),
                        birthday_month: Number(base.birthday_month ?? base.birthdayMonth ?? 0),
                        birthday_day: Number(base.birthday_day ?? base.birthdayDay ?? 0),
                        phone_num: String(base.phoneNum ?? ''),
                        email: String(base.eMail ?? ''),
                        category_id: Number(base.categoryId ?? 0),
                        level: 0,
                    };
                };
                const out: Array<Record<string, unknown>> = [];
                for (let i = 0; i < uids.length; i += 8) {
                    const batch = uids.slice(i, i + 8);
                    const details = await Promise.all(batch.map(detailOf));
                    for (let j = 0; j < batch.length; j++) {
                        const entry = build(batch[j], details[j]);
                        // Drop entries we could not resolve to a numeric uin
                        // (self and stale uid-only records) — OB11 clients
                        // require numeric user_id.
                        if (typeof entry.user_id === 'number' && entry.user_id !== Number(self.selfUin)) out.push(entry);
                    }
                }
                return out;
            },
            async getStrangerInfo(userUid) {
                const profile = self.requireServices().profile;
                const uin = self.uidToUin.get(userUid) ?? '';
                let detail: Record<string, any> | undefined;
                let byUin: Record<string, any> | undefined;
                try { detail = (await profile.getUserDetailInfo?.(userUid)) as Record<string, any>; } catch { /* ignore */ }
                if (uin && typeof profile.getUserDetailInfoByUin === 'function') {
                    try { byUin = (await profile.getUserDetailInfoByUin(uin)) as Record<string, any>; } catch { /* ignore */ }
                }
                const simple = (byUin?.detail?.simpleInfo ?? {}) as Record<string, any>;
                const common = (byUin?.detail?.commonExt ?? {}) as Record<string, any>;
                const core = (simple.coreInfo ?? (detail as any)?.coreInfo ?? {}) as Record<string, any>;
                const base = (simple.baseInfo ?? (detail as any)?.baseInfo ?? {}) as Record<string, any>;
                const vas = (simple.vasInfo ?? {}) as Record<string, any>;
                const status = (simple.status ?? {}) as Record<string, any>;
                let userId = String(uin || byUin?.detail?.uin || core.uin || '');
                let nickname = String(core.nick ?? (detail as any)?.nick ?? '');
                if (!nickname) {
                    // Fallback: bulk core/base info (Map<uid, {coreInfo}>).
                    try {
                        const res = (await profile.getCoreAndBaseInfo('nodeStore', [userUid])) as any;
                        const raw: any = res instanceof Map ? res : (res?.result?.info ?? res?.info ?? res);
                        const info = raw instanceof Map ? raw.get(userUid) : raw?.[userUid];
                        const c = (info?.coreInfo ?? {}) as Record<string, any>;
                        nickname = String(c.nick ?? '');
                        userId = userId || String(c.uin ?? '');
                    } catch { /* ignore */ }
                }
                const sexNum = Number(base.sex ?? (detail as any)?.sex ?? 0);
                const qqLevel = (common.qqLevel ?? (detail as any)?.qqLevel) as Record<string, any> | number | undefined;
                const qqLevelNum = Number(typeof qqLevel === 'object' ? qqLevel?.level : qqLevel);
                const asId = (v: string): number | string => (Number(v) > 0 ? Number(v) : v);
                return {
                    user_id: asId(userId),
                    uid: userUid,
                    nickname,
                    age: Number(base.age ?? (detail as any)?.age ?? 0),
                    qid: String(base.qid ?? (detail as any)?.qid ?? ''),
                    qq_level: Number.isFinite(qqLevelNum) ? qqLevelNum : 0,
                    sex: sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown',
                    long_nick: String(base.longNick ?? (detail as any)?.longNick ?? ''),
                    reg_time: Number(common.regTime ?? (detail as any)?.regTime ?? 0),
                    is_vip: Boolean(vas.svipFlag ?? false),
                    is_years_vip: Boolean(vas.yearVipFlag ?? false),
                    vip_level: Number(vas.vipLevel ?? 0),
                    remark: String(core.remark ?? (detail as any)?.remark ?? ''),
                    status: Number(status.status ?? (detail as any)?.status ?? 0),
                    login_days: 0,
                };
            },
            async sendLike(userUid, times) {
                const like = self.requireServices().profileLike;
                await like.setBuddyProfileLike({
                    friendUid: userUid,
                    sourceId: 71,
                    doLikeCount: Math.min(Math.max(times, 1), 10),
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
                const g = (res?.result ?? res) as Record<string, any>;
                return {
                    group_id: Number(g.groupCode ?? groupCode) || groupCode,
                    group_name: String(g.groupName ?? ''),
                    member_count: Number(g.memberCount ?? 0),
                    max_member_count: Number(g.maxMember ?? 0),
                    group_all_shut: Number(g.groupShutupExpireTime ?? 0) > 0 ? -1 : 0,
                    group_remark: String(g.remarkName ?? ''),
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
                const byUin = new Map<string, { nick: string; card: string; role: string }>();
                const out: Array<Record<string, unknown>> = [];
                for (const { uid } of ids) {
                    const info = infosGet(uid) ?? {};
                    const uin = String(info.uin ?? '');
                    if (uid && uin && uin !== '0') {
                        self.uidToUin.set(uid, uin);
                        self.uinToUid.set(uin, uid);
                        const roleNum = Number(info.role ?? 0);
                        byUin.set(uin, {
                            nick: String(info.nick ?? ''),
                            card: String(info.cardName ?? ''),
                            role: roleNum === 4 ? 'owner' : roleNum === 3 ? 'admin' : 'member',
                        });
                    }
                    out.push(memberToOb11(groupCode, info));
                }
                self.memberInfoCache.set(String(groupCode), { at: Date.now(), byUin });
                return out;
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
                return memberToOb11(groupCode, mem);
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
                // flag is the request's reqTime (as emitted in the request
                // event); the kernel needs the requester's uid too.
                const cached = self.friendReqCache.get(String(flag));
                const friendUid = cached?.uid ?? (/^u_/.test(flag) ? flag : '');
                const reqTime = cached?.reqTime ?? flag;
                if (!friendUid) throw new Error(`unknown friend request flag ${flag}`);
                await buddy.approvalFriendRequest({ friendUid, reqTime, accept });
                self.friendReqCache.delete(String(flag));
            },
            async handleGroupRequest(flag, accept, reason) {
                const group = self.requireServices().group;
                // operateType: 1 accept, 2 reject (NTGroupRequestOperateTypes)
                await group.handleGroupRequest(false, { seqId: flag } as never, accept ? 1 : 2, reason ?? '');
            },
            async sendPoke(targetUin, peerUin, isGroup) {
                return await self.sendPoke(Number(targetUin), Number(peerUin), isGroup);
            },
            async getForwardMsg(rawMsgId) {
                const svc = self.requireServices().msg;
                const msgId = self.canonicalMsgId(String(rawMsgId));
                const cachedPeer = self.msgPeerCache.get(msgId);
                if (!cachedPeer) throw new Error('cannot resolve message peer (forward message not seen by this session)');
                const fPeer = { chatType: cachedPeer.chatType, peerUid: cachedPeer.peerUid, guildId: '' };
                const rootRes = await svc.getMsgsByMsgId(fPeer, [msgId]);
                const root = ((rootRes?.result?.msgList ?? rootRes?.msgList ?? []) as Array<Record<string, any>>)[0];
                if (!root) throw new Error('forward message not found');
                const rootId = String(root.msgId);
                const nodes: Array<Record<string, unknown>> = [];
                const walk = async (parentMsgId: string, depth: number): Promise<void> => {
                    if (depth > 8) return;
                    const r = await svc.getMultiMsg(fPeer, rootId, parentMsgId);
                    const list = ((r?.result?.msgList ?? r?.msgList ?? []) as Array<Record<string, any>>);
                    for (const m of list) {
                        const segs = await ntElementsToSegments((m.elements ?? []) as Array<Record<string, unknown>>, {
                            resolveUid: (uid) => self.uidToUin.get(uid) ?? null,
                            selfUid: self.selfUid,
                            peer: fPeer,
                            msgId: String(m.msgId ?? ''),
                            resolvePicUrl: (pic) => self.picUrl(pic),
                            rememberMedia: (key, meta) => self.rememberMediaElement(key, meta),
                        });
                        const senderUin = String(m.senderUin ?? self.uidToUin.get(String(m.senderUid ?? '')) ?? '');
                        nodes.push({
                            sender: {
                                user_id: Number(senderUin) || senderUin,
                                nickname: String(m.senderNick ?? ''),
                            },
                            time: Number(m.msgTime ?? 0),
                            message: segs,
                            content: segs,
                        });
                        const hasNested = ((m.elements ?? []) as Array<Record<string, any>>).some((el) => !!el?.multiForwardMsgElement);
                        if (hasNested) await walk(String(m.msgId ?? ''), depth + 1);
                    }
                };
                await walk(rootId, 0);
                return nodes;
            },
            async getGroupHonorInfo(groupCode) {
                const group = self.requireServices().group;
                // The NAPI binding's GroupMemberHonorReq shape varies between
                // builds; probe the common variants until the kernel accepts one.
                const reqVariants: Array<Record<string, unknown>> = [
                    { groupCodes: [String(groupCode)] },
                    { groupCode: String(groupCode) },
                    { groupCode: Number(groupCode) },
                    { groupCodes: [Number(groupCode)] },
                    { group_id: String(groupCode) },
                ];
                let res: any = null;
                for (const req of reqVariants) {
                    try {
                        const r = await group.getGroupHonorList(req);
                        const code = Number(r?.errCode ?? r?.result?.errCode ?? 0);
                        if (code === 0) { res = r; break; }
                    } catch { /* try next shape */ }
                }
                if (!res) console.error('[honor-info] kernel rejected all request shapes for group', groupCode);
                const raw = (res?.result ?? res ?? {}) as Record<string, any>;
                const list: Array<Record<string, any>> = Array.isArray(raw)
                    ? raw as unknown as Array<Record<string, any>>
                    : ((raw.honorList ?? raw.list ?? raw.honors ?? []) as Array<Record<string, any>>);
                const mapHonor = (items: Array<Record<string, any>>) => items.map((it) => ({
                    user_id: Number(it?.uin ?? it?.user_id ?? 0) || 0,
                    nickname: String(it?.name ?? it?.nickname ?? ''),
                    avatar: String(it?.avatar ?? ''),
                    description: String(it?.desc ?? it?.description ?? ''),
                }));
                const pick = (t: number) => mapHonor(list.filter((it) => Number(it?.type ?? it?.honorType ?? -1) === t));
                const talkative = pick(1);
                return {
                    ...(talkative[0] ? { current_talkative: { ...talkative[0], day_count: 0 } } : {}),
                    talkative_list: talkative,
                    performer_list: pick(2),
                    legend_list: pick(3),
                    emotion_list: pick(6),
                    strong_newbie_list: [],
                };
            },
            async getCredentials(domain) {
                const misc = self.requireServices().misc;
                let cookies = '';
                try {
                    const r = await misc.getCookies(String(domain ?? ''));
                    cookies = String(r?.result?.cookies ?? r?.cookies ?? '');
                } catch { /* cookies unavailable on this build */ }
                const m = /(?:^|;\s*)skey=([^;]+)/.exec(cookies);
                let token = 0;
                if (m) {
                    let h = 5381;
                    for (const ch of m[1]) h += (h << 5) + ch.charCodeAt(0);
                    token = h & 0x7fffffff;
                }
                return { cookies, token };
            },
            async getMedia(file, outFormat) {
                const key = String(file ?? '');
                if (!key) throw new Error('file or file_id is required');
                if (/^https?:\/\//i.test(key)) {
                    return { file: key, url: key, file_name: key.split('/').pop() ?? '', file_size: '' };
                }
                if (key.startsWith('/') && fs.existsSync(key)) {
                    return { file: key, url: key, file_name: path.basename(key), file_size: String(fs.statSync(key).size) };
                }
                let lookup = key;
                try { lookup = decodeURIComponent(key); } catch { /* keep as-is */ }
                const meta = self.mediaIndex.get(key) ?? self.mediaIndex.get(lookup);
                if (!meta) throw new Error('file not found (only media from messages seen by this session can be fetched)');
                const urlFallback = (): Record<string, unknown> => ({
                    file: meta.url as string,
                    url: meta.url as string,
                    file_name: meta.fileName ?? '',
                    file_size: String(meta.fileSize ?? 0),
                });
                let outFile = '';
                if (meta.localPath && fs.existsSync(meta.localPath)) {
                    outFile = meta.localPath;
                } else if (meta.kind === 'image' && meta.url) {
                    // Image URLs are directly downloadable (rkey-signed for NT
                    // v2, md5 path otherwise), so skip the kernel download,
                    // which times out for pictures on this build and used to
                    // cost a fixed 8s per call. Records still need the kernel
                    // to produce a local file for transcoding.
                    return urlFallback();
                } else if (meta.elementId) {
                    try {
                        outFile = await self.downloadRichMedia(meta, 8_000);
                    } catch (e) {
                        console.error('[get_media] kernel download failed:', e instanceof Error ? e.message : e,
                            'meta', JSON.stringify({ msgId: meta.msgId, elementId: meta.elementId, chatType: meta.peer.chatType }));
                        if (meta.url) return urlFallback();
                        throw e;
                    }
                } else if (meta.url) {
                    return urlFallback();
                } else {
                    throw new Error('media element cannot be downloaded (no element id / url)');
                }
                let fileName = meta.fileName ?? path.basename(outFile);
                let fileSize = meta.fileSize ?? (fs.existsSync(outFile) ? fs.statSync(outFile).size : 0);
                if (meta.kind === 'record' && outFormat) {
                    const ext = path.extname(outFile).replace('.', '').toLowerCase();
                    const want = String(outFormat).toLowerCase();
                    if (want && want !== ext) {
                        try {
                            const { execFileSync } = await import('node:child_process');
                            const converted = `${outFile}.${want}`;
                            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', outFile, converted], { stdio: 'ignore' });
                            outFile = converted;
                            fileName = `${path.basename(outFile, path.extname(outFile))}.${want}`;
                            fileSize = fs.statSync(outFile).size;
                        } catch {
                            console.error('[get_record] ffmpeg conversion unavailable, returning original format');
                        }
                    }
                }
                const result: Record<string, unknown> = {
                    file: outFile,
                    url: meta.url || outFile,
                    file_name: fileName,
                    file_size: String(fileSize),
                };
                if (meta.kind === 'record' && fileSize > 0 && fileSize <= 8 * 1024 * 1024) {
                    try { result.base64 = fs.readFileSync(outFile).toString('base64'); } catch { /* ignore */ }
                }
                return result;
            },
            async restart(delaySec) {
                const delay = Math.max(0, Number(delaySec) || 0);
                console.error(`[katheryne] restart requested (delay=${delay}s)`);
                setTimeout(() => process.exit(0), delay * 1000);
            },
            async cleanCache() {
                self.msgPeerCache.clear();
                self.memberInfoCache.clear();
                self.mediaIndex.clear();
                if (self.downloadTempPath && fs.existsSync(self.downloadTempPath)) {
                    for (const entry of fs.readdirSync(self.downloadTempPath)) {
                        try { fs.rmSync(path.join(self.downloadTempPath, entry), { recursive: true, force: true }); } catch { /* ignore */ }
                    }
                }
                return { cleared: true };
            },
            async getCookies(domain) {
                const misc = self.requireServices().misc;
                try {
                    const r = await misc.getCookies(String(domain ?? ''));
                    return String(r?.result?.cookies ?? r?.cookies ?? '');
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
