/**
 * KatheryneQQ runtime: boot -> kernel load -> login -> session -> OneBot.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadKernelFromQQ, type LoadedKernel } from '../nt/loader.js';
import { LoginFlow } from '../nt/login.js';
import { collectServices, groupPeer, c2cPeer, type SessionServices } from '../nt/session.js';
import type { RawMessage } from '../nt/session.js';
import { EventBus, segmentsToRawText, type OB11AnyEvent } from '../onebot/events/bus.js';
import { ntElementsToSegments, type OB11Segment } from '../onebot/message/segments.js';
import { NetworkManager, type NetworkConfig } from '../onebot/network/index.js';
import type { ActionContext } from '../onebot/actions/index.js';

interface KatheryneConfig extends NetworkConfig {
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
        http: { enabled: true, host: '127.0.0.1', port: 5700 },
        ws: { enabled: true, host: '127.0.0.1', port: 6700 },
        reverseWs: { enabled: false, urls: [] },
    };
}

class KatheryneRuntime {
    private kernel!: LoadedKernel;
    private loginFlow!: LoginFlow;
    private bus = new EventBus();
    private services: SessionServices | null = null;
    private session: unknown = null;
    private selfUin = '';
    private selfUid = '';
    private selfNick = '';
    private msgSeqToId = new Map<string, string>();
    private uinToUid = new Map<string, string>();
    private uidToUin = new Map<string, string>();

    async start(startedAt: number): Promise<void> {
        const config = loadConfig();
        console.log(`[katheryne] boot ${Date.now() - startedAt}ms`);

        // 1. Load native kernel modules
        this.kernel = loadKernelFromQQ();
        console.log(`[katheryne] kernel loaded: QQ ${this.kernel.packageInfo.version}`);

        // 2. Engine + login
        this.loginFlow = new LoginFlow(this.kernel, config.data_path);
        this.loginFlow.initEngine();
        this.loginFlow.initLoginConfig();
        console.log(`[katheryne] appid=${this.loginFlow.identity.appid}`);

        const logged = await this.doLogin(config.quick_login_uin);
        console.log(`[katheryne] logged in: ${logged.uin} (${logged.nick})`);
        this.selfUin = logged.uin;
        this.selfUid = logged.uid;
        this.selfNick = logged.nick;

        // 3. Session init
        const sessionConfig = this.loginFlow.buildSessionConfig(logged.uin, logged.uid);
        const sessionMod = await import('../nt/session.js');
        const { session, ready } = sessionMod.initSession(this.kernel.wrapper, sessionConfig) as unknown as { session: unknown; ready: Promise<void> };
        await ready;
        this.session = session;
        this.services = collectServices(session);
        console.log('[katheryne] session ready');

        this.cacheFriendAndGroupMappings().catch(() => undefined);
        this.attachMsgListener();

        // 4. OneBot network
        const actionCtx = this.buildActionContext();
        const network = new NetworkManager(config, this.bus, () => actionCtx);
        network.start();

        this.bus.emit({
            time: Math.floor(Date.now() / 1000),
            self_id: this.selfUin,
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: 'connect',
        });
        console.log(`[katheryne] onebot online (http:${config.http.enabled ? config.http.port : '-'} ws:${config.ws.enabled ? config.ws.port : '-'})`);

        setInterval(() => {
            this.bus.emit({
                time: Math.floor(Date.now() / 1000),
                self_id: this.selfUin,
                post_type: 'meta_event',
                meta_event_type: 'heartbeat',
                interval: 5000,
            });
        }, 5000).unref();
    }

    private async doLogin(preferredUin?: string): Promise<{ uin: string; uid: string; nick: string }> {
        const list = await this.loginFlow.listLogins();
        const target = preferredUin ?? list[0]?.uin;
        if (!target) {
            throw new Error(
                'no local login info found. Open QQ GUI once to log in, then retry (login record reused here).',
            );
        }
        return await this.loginFlow.quickLogin(target);
    }

    private async cacheFriendAndGroupMappings(): Promise<void> {
        try {
            const buddy = this.services?.buddy;
            if (!buddy) return;
            const res = await buddy.getBuddyList('BuddyList', true, false, false, false, false, 0);
            const infos = res?.result?.buddyList ?? res?.buddyList ?? [];
            for (const f of infos as Array<Record<string, unknown>>) {
                const uid = String(f.uid ?? '');
                const uin = String(f.uin ?? '');
                if (uid && uin) {
                    this.uinToUid.set(uin, uid);
                    this.uidToUin.set(uid, uin);
                }
            }
        } catch {
            // mapping stays partial; resolution falls back at call time
        }
    }

    private attachMsgListener(): void {
        const msgService = this.services?.msg;
        if (!msgService) throw new Error('msg service unavailable');
        const listener = {
            onRecvMsg: (msgs: RawMessage[]) => {
                for (const m of msgs ?? []) this.emitMessage(m, false);
            },
            onSendMsg: (m: RawMessage) => this.emitMessage(m, true),
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
        };
        msgService.addKernelMsgListener(listener);
        // Activate the receive path.
        try {
            msgService.startMsgSync();
        } catch {
            try {
                msgService.startMsgSync(0);
            } catch {
                // some builds auto-start after listener registration
            }
        }
    }

    private emitMessage(m: RawMessage, sent: boolean): void {
        try {
            const chatType = Number(m.chatType ?? 0);
            const isGroup = chatType === 2;
            const peerUin = this.resolveUinOf(m);
            const segments = ntElementsToSegments(
                (m.elements ?? []) as Array<Record<string, unknown>>,
                { resolveUid: (uid) => this.uidToUin.get(uid) ?? null, selfUid: this.selfUid },
            );
            this.msgSeqToId.set(String(m.msgSeq ?? ''), String(m.msgId ?? ''));

            const event = {
                time: Math.floor(Date.now() / 1000),
                self_id: this.selfUin,
                post_type: 'message' as const,
                message_type: isGroup ? ('group' as const) : ('private' as const),
                sub_type: sent ? 'self' : 'normal',
                message_id: String(m.msgId ?? ''),
                user_id: String(m.senderUin ?? peerUin ?? ''),
                group_id: isGroup ? String(peerUin ?? '') : undefined,
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

    private resolveUinOf(m: RawMessage): string | null {
        const peerUid = String(m.peerUid ?? '');
        if (peerUid && this.uidToUin.has(peerUid)) return this.uidToUin.get(peerUid)!;
        const uin = String(m.peerUin ?? '');
        return uin || null;
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
                const svc = self.services!.msg;
                const r = await svc.sendMsg(peer, elements);
                return { msgId: String(r?.result?.msgId ?? r?.msgId ?? '') };
            },
            async getMsg(peer, msgId) {
                const svc = self.services!.msg;
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
            async getLoginInfo() {
                return { user_id: self.selfUin, nickname: self.selfNick };
            },
            async getFriendList() {
                const buddy = self.services!.buddy;
                const res = await buddy.getBuddyList('BuddyList', true, false, false, false, false, 0);
                const infos = res?.result?.buddyList ?? res?.buddyList ?? [];
                return (infos as Array<Record<string, unknown>>).map((f) => ({
                    user_id: String(f.uin ?? ''),
                    nickname: String(f.nick ?? ''),
                    remark: String(f.remark ?? ''),
                }));
            },
            async getGroupList() {
                const group = self.services!.group;
                const res = await group.getGroupList(true, false);
                const infos = res?.result?.groupList ?? res?.groupList ?? [];
                return (infos as Array<Record<string, unknown>>).map((g) => ({
                    group_id: String(g.groupCode ?? ''),
                    group_name: String(g.groupName ?? ''),
                    member_count: Number(g.memberCount ?? 0),
                    max_member_count: Number(g.maxMember ?? 0),
                }));
            },
            async getGroupMemberList(groupUid) {
                const group = self.services!.group;
                const res = await group.getGroupMemberList(groupUid, false, false);
                const infos = res?.result?.groupMemberList ?? res?.groupMemberList ?? [];
                return (infos as Array<Record<string, unknown>>).map((mem) => ({
                    user_id: String(mem.uin ?? ''),
                    nickname: String(mem.nick ?? ''),
                    card: String(mem.cardName ?? ''),
                    role: Number(mem.role ?? 0) === 2 ? 'admin' : Number(mem.role ?? 0) === 1 ? 'owner' : 'member',
                }));
            },
            async deleteMsg(peer, msgId) {
                const svc = self.services!.msg;
                await svc.revokeMsg(peer, msgId);
            },
            async setGroupBan(groupUid, memberUid, duration) {
                const group = self.services!.group;
                await group.setMemberBan(groupUid, memberUid, false, duration);
            },
            async setGroupWholeBan(groupUid, enable) {
                const group = self.services!.group;
                await group.setGroupWholeBan(groupUid, enable);
            },
            async setGroupKick(groupUid, memberUid, rejectAdd) {
                const group = self.services!.group;
                await group.kickMember(groupUid, [memberUid], rejectAdd, false);
            },
            async setGroupLeave(groupUid, dismiss) {
                const group = self.services!.group;
                await group.quitGroup(groupUid, dismiss);
            },
            async setGroupCard(groupUid, memberUid, card) {
                const group = self.services!.group;
                await group.setMemberCard(groupUid, memberUid, card);
            },
            async getGroupInfo(groupUid) {
                const group = self.services!.group;
                const res = await group.getGroupInfo(groupUid, true);
                const g = (res?.result ?? res) as Record<string, unknown>;
                return {
                    group_id: String(g.groupCode ?? groupUid),
                    group_name: String(g.groupName ?? ''),
                    member_count: Number(g.memberCount ?? 0),
                    max_member_count: Number(g.maxMember ?? 0),
                };
            },
            async getFriendInfo(userUid) {
                const profile = self.services!.profile;
                const res = await profile.getProfileLike(userUid, ['uin', 'nick', 'remark']);
                const p = (res?.result ?? res) as Record<string, unknown>;
                return {
                    user_id: String(p.uin ?? self.uidToUin.get(userUid) ?? ''),
                    nickname: String(p.nick ?? ''),
                };
            },
            async sendLike(userUid, times) {
                const profile = self.services!.profile;
                await profile.likeSelfOrOther(userUid, Math.min(times, 20));
            },
        };
    }
}

export async function initRuntime(startedAt: number): Promise<void> {
    const runtime = new KatheryneRuntime();
    await runtime.start(startedAt);
}

export { groupPeer, c2cPeer };
