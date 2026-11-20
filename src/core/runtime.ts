/**
 * KatheryneQQ runtime: boot -> kernel -> (login) -> session -> OneBot+Console.
 *
 * The console and OneBot network start even before login so operators can
 * scan a QR code from the web page. Login retries are driven from the console
 * or config; everything downstream (session, listeners, actions) attaches
 * once the kernel reports a logged-in state.
 */
import fs from 'node:fs';
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
    private config: KatheryneConfig = loadConfig();
    private consoleMgr: WebConsole | null = null;
    private network: NetworkManager | null = null;
    private uinToUid = new Map<string, string>();
    private uidToUin = new Map<string, string>();

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

    private installLoginListeners(): void {
        if (this.loginListenersInstalled || !this.kernel) return;
        const svc = this.kernel.wrapper.NodeIKernelLoginService.get();
        this.loginListenersInstalled = true;
        svc.addKernelLoginListener({
            onQRCodeGetPicture: (arg: { pngBase64QrcodeData?: string; qrcodeUrl?: string }) => {
                const b64 = arg?.pngBase64QrcodeData ?? '';
                this.qrcodeDataUrl = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64.replace(/^.*base64,/, '')}`;
                this.phase = 'logging_in';
                this.loginError = null;
                this.consoleMgr?.log('QR code received, waiting for scan');
            },
            onQRCodeSessionUserScaned: () => this.consoleMgr?.log('QR scanned, confirm on phone'),
            onQRCodeSessionFailed: (msg?: unknown) => {
                this.qrcodeDataUrl = null;
                this.loginError = `QR session failed: ${String(msg ?? 'expired')}`;
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
        const svc = this.kernel.wrapper.NodeIKernelLoginService.get();
        svc.startPolling();
        svc.getQRCodePicture();
        this.consoleMgr?.log('QR login requested');
    }

    async cancelLogin(): Promise<void> {
        if (!this.kernel) return;
        const svc = this.kernel.wrapper.NodeIKernelLoginService.get();
        try {
            svc.cancel();
            svc.abortPolling();
        } catch {
            // already idle
        }
        this.qrcodeDataUrl = null;
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
        msgService.addKernelMsgListener({
            onRecvMsg: (msgs: RawMessage[]) => {
                for (const m of msgs ?? []) this.emitMessage(m, false);
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
        });
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
        groupService.addKernelGroupListener({
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
        });
    }

    private attachBuddyListener(): void {
        const buddyService = this.services?.buddy;
        if (!buddyService) return;
        buddyService.addKernelBuddyListener({
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
        });
    }

    private async cacheMappings(): Promise<void> {
        try {
            const buddy = this.services?.buddy;
            if (!buddy) return;
            let infos: Array<Record<string, unknown>> = [];
            try {
                const res = await buddy.getBuddyListV2('0', true, 1); // BuddyListReqType.KNOMAL = 1
                infos = res?.data?.buddyList ?? [];
            } catch {
                const res = await buddy.getBuddyList('BuddyList', true, false, false, false, false, 0);
                infos = res?.result?.buddyList ?? res?.buddyList ?? [];
            }
            for (const f of infos) {
                const uid = String(f.uid ?? '');
                const uin = String(f.uin ?? '');
                if (uid && uin) {
                    this.uinToUid.set(uin, uid);
                    this.uidToUin.set(uid, uin);
                }
            }
            console.log(`[katheryne] cached ${this.uinToUid.size} friend uid mappings`);
        } catch {
            // partial mapping; per-call resolution still works via kernel
        }
    }

    // ---------------- message -> OB11 ----------------

    private emitMessage(m: RawMessage, sent: boolean): void {
        try {
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
                return self.uinToUid.get(uin) ?? null;
            },
            resolveUid(uid: string): string | null {
                if (uid === self.selfUid) return self.selfUin;
                return self.uidToUin.get(uid) ?? null;
            },
            async sendMessage(peer, elements) {
                const svc = self.requireServices().msg;
                const r = await svc.sendMsg(peer, elements);
                return { msgId: String(r?.result?.msgId ?? r?.msgId ?? '') };
            },
            async deleteMsg(peer, msgId) {
                const svc = self.requireServices().msg;
                await svc.revokeMsg(peer, msgId);
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
                const r = await svc.getMsgHistory(peer, msgId, count, false);
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
                const res = await buddy.getBuddyListV2('0', true, 1).catch(() => null);
                const infos = res?.data?.buddyList ?? [];
                return infos.map((f: Record<string, unknown>) => ({
                    user_id: String(f.uin ?? ''),
                    nickname: String(f.nick ?? ''),
                    remark: String(f.remark ?? ''),
                }));
            },
            async getStrangerInfo(userUid) {
                const profile = self.requireServices().profile;
                const res = await profile.getUserSimpleInfo(userUid);
                const p = (res?.result ?? res) as Record<string, unknown>;
                return {
                    user_id: String(p.uin ?? self.uidToUin.get(userUid) ?? ''),
                    nickname: String(p.nick ?? ''),
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
                const res = await group.getGroupList(true, false);
                const infos = res?.result?.groupList ?? res?.groupList ?? [];
                return infos.map((g: Record<string, unknown>) => ({
                    group_id: String(g.groupCode ?? ''),
                    group_name: String(g.groupName ?? ''),
                    member_count: Number(g.memberCount ?? 0),
                    max_member_count: Number(g.maxMember ?? 0),
                }));
            },
            async getGroupInfo(groupCode) {
                const group = self.requireServices().group;
                const res = await group.getGroupDetailInfo(groupCode);
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
                const res = await group.getAllMemberList(groupCode, false);
                const infos = res?.result?.memberList ?? res?.memberList ?? res?.result?.groupMemberList ?? [];
                return infos.map((mem: Record<string, unknown>) => ({
                    user_id: String(mem.uin ?? ''),
                    nickname: String(mem.nick ?? ''),
                    card: String(mem.cardName ?? ''),
                    role:
                        Number(mem.role ?? 0) === 1 ? 'owner' : Number(mem.role ?? 0) === 2 ? 'admin' : Number(mem.role ?? 0) === 3 ? 'member' : 'member',
                }));
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
