/**
 * OneBot v11 action handlers — full standard set + go-cqhttp extensions.
 *
 * Response envelope (OB11 spec):
 *   { status: "async" | "ok" | "failed", retcode: number, data: ..., message?: string, echo }
 * retcodes: 0 ok, 1 async, 1200 internal error, 1400 bad params,
 *           1403 unauthenticated, 1404 action not supported,
 *           1500 handler crashed.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCQCode, segmentsToNtElements, type OB11Segment } from '../message/segments.js';

/** Build-time version stamp (scripts/gen-version.mjs writes dist/version.json). */
let cachedVersion: string | null = null;
function appVersion(): string {
    if (cachedVersion !== null) return cachedVersion;
    try {
        const file = fileURLToPath(new URL('../../version.json', import.meta.url));
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version?: string };
        cachedVersion = String(raw.version ?? '0.0.0');
    } catch {
        cachedVersion = '0.0.0';
    }
    return cachedVersion;
}

export interface PeerRef {
    chatType: number;
    peerUid: string;
}

export interface ActionContext {
    selfUin: string;
    selfUid: string;
    resolveUin(uin: string): string | null;
    /** Async uin->uid resolution that actually waits for the kernel uix query. */
    ensureUid?(uin: string): Promise<string | null>;
    resolveUid(uid: string): string | null;
    resolveMsgPeer(msgId: string): { chatType: number; peerUid: string } | null;
    /** Kernel message lookups (reply segment resolution). */
    fetchMsgByMsgId(peer: PeerRef, msgId: string): Promise<Record<string, any> | undefined>;
    fetchMsgBySeq(peer: PeerRef, seq: string): Promise<Record<string, any> | undefined>;
    /** Group member display name (card/nick) for @ rendering. */
    resolveMemberNickname(groupCode: string, uin: string): Promise<string | null>;
    // messaging
    sendMessage(peer: PeerRef, elements: unknown[]): Promise<{ msgId: string; seq?: string }>;
    deleteMsg(peer: PeerRef, msgId: string): Promise<void>;
    getMsg(peer: PeerRef, msgId: string): Promise<Record<string, unknown>>;
    getMsgHistory(peer: PeerRef, msgId: string, count: number): Promise<Array<Record<string, unknown>>>;
    /** Set / unset / list a message emoji reaction (NapCat parity). */
    emojiLikes(msgId: string, emojiId: string, emojiType: string, op: 'set' | 'unset' | 'get', count?: number): Promise<Record<string, unknown>>;
    /** NapCat-parity chat history (latest N when cursor is empty). */
    getChatHistory(peer: PeerRef, cursor: string, count: number, reverseOrder: boolean): Promise<Array<Record<string, unknown>>>;
    /** Whether a uid is a friend (decides C2C vs temp C2C history peer). */
    isBuddy?(uid: string): Promise<boolean>;
    markRead(peer: PeerRef): Promise<void>;
    // profile
    getLoginInfo(): Promise<{ user_id: number; nickname: string }>;
    getFriendList(): Promise<Array<Record<string, unknown>>>;
    getStrangerInfo(userUid: string): Promise<Record<string, unknown>>;
    sendLike(userUid: string, times: number): Promise<void>;
    // groups
    getGroupList(): Promise<Array<Record<string, unknown>>>;
    getGroupInfo(groupCode: string): Promise<Record<string, unknown>>;
    getGroupMemberList(groupCode: string): Promise<Array<Record<string, unknown>>>;
    getGroupMemberInfo(groupCode: string, memberUid: string): Promise<Record<string, unknown>>;
    setGroupBan(groupCode: string, memberUid: string, durationSec: number): Promise<void>;
    setGroupWholeBan(groupCode: string, enable: boolean): Promise<void>;
    setGroupKick(groupCode: string, memberUids: string[], rejectForever: boolean): Promise<void>;
    setGroupLeave(groupCode: string, dismiss: boolean): Promise<void>;
    setGroupCard(groupCode: string, memberUid: string, card: string): Promise<void>;
    setGroupName(groupCode: string, name: string): Promise<void>;
    setGroupAdmin(groupCode: string, memberUid: string, enable: boolean): Promise<void>;
    setGroupAvatar(groupCode: string, file: string): Promise<void>;
    // requests
    handleFriendRequest(flag: string, accept: boolean, remark?: string): Promise<void>;
    handleGroupRequest(flag: string, accept: boolean, reason?: string): Promise<void>;
    // misc
    getCookies(domain: string): Promise<string>;
    sendPoke(targetUin: string, peerUin: string, isGroup: boolean): Promise<boolean>;
    // extended public API (v11 public.md parity)
    getForwardMsg(msgId: string): Promise<Array<Record<string, unknown>>>;
    getGroupHonorInfo(groupCode: string): Promise<Record<string, unknown>>;
    getCredentials(domain: string): Promise<{ cookies: string; token: number }>;
    getMedia(file: string, outFormat?: string): Promise<Record<string, unknown>>;
    restart(delaySec?: number): Promise<void>;
    cleanCache(): Promise<Record<string, unknown>>;
}

export interface ActionParams {
    [k: string]: unknown;
}

export class ActionError extends Error {
    constructor(public retcode: number, message: string) {
        super(message);
    }
}

type ActionHandler = (params: ActionParams, ctx: ActionContext) => Promise<unknown>;

function str(params: ActionParams, key: string): string {
    const v = params[key];
    if (v === undefined || v === null) throw new ActionError(1400, `missing param: ${key}`);
    return String(v);
}

function num(params: ActionParams, key: string, def?: number): number {
    const v = params[key];
    if (v === undefined || v === null) {
        if (def !== undefined) return def;
        throw new ActionError(1400, `missing param: ${key}`);
    }
    const n = Number(v);
    if (Number.isNaN(n)) throw new ActionError(1400, `param ${key} must be a number`);
    return n;
}

function bool(params: ActionParams, key: string, def = false): boolean {
    const v = params[key];
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    const s = String(v);
    return s === 'true' || s === '1' || s === 'yes';
}

/** group_id / user_id -> NT peer. */async function peerOf(params: ActionParams, ctx: ActionContext, opts: { requireGroup?: boolean; requirePrivate?: boolean } = {}): Promise<PeerRef> {
    const groupId = params.group_id as string | undefined;
    const userId = params.user_id as string | undefined;
    const messageType = params.message_type as string | undefined;

    if (messageType === 'group' || (groupId && messageType === undefined)) {
        if (opts.requirePrivate) throw new ActionError(1400, 'send_private_msg requires user_id');
        if (!groupId) throw new ActionError(1400, 'group_id required');
        // NT group peers are addressed by the group code (uin) directly;
        // no uid resolution needed for groups.
        return { chatType: 2, peerUid: String(groupId) };
    }
    if (messageType === 'private' || messageType === undefined) {
        if (opts.requireGroup) throw new ActionError(1400, 'group_id required');
        if (!userId) throw new ActionError(1400, 'user_id required');
        const uid = await ensureUidOf(ctx, String(userId));
        if (!uid) throw new ActionError(1400, `cannot resolve user ${userId} to uid`);
        return { chatType: 1, peerUid: uid };
    }
    throw new ActionError(1400, `unsupported message_type ${messageType}`);
}

/** Wait-capable uin -> uid: hot cache first, then the kernel uix query. */
async function ensureUidOf(ctx: ActionContext, uin: string): Promise<string | null> {
    const cached = ctx.resolveUin(uin);
    if (cached) return cached;
    if (ctx.ensureUid) return await ctx.ensureUid(uin);
    return null;
}

/**
 * Resolve the peer for a message_id-only action: prefer explicit
 * user_id/group_id, then the cache of peers for messages this process has
 * seen (sent or received). OB11 clients commonly call delete_msg/get_msg
 * with just a message_id.
 */
async function peerForMsg(params: ActionParams, ctx: ActionContext, messageId: string): Promise<PeerRef> {
    if (params.user_id || params.group_id || params.message_type) {
        return await peerOf(params, ctx);
    }
    const cached = ctx.resolveMsgPeer(messageId);
    if (cached) return cached as PeerRef;
    throw new ActionError(1400, 'cannot resolve message peer; provide user_id/group_id (bot can only resolve ids of messages it has seen)');
}

function segmentsOf(params: ActionParams): OB11Segment[] {
    const message = params.message;
    if (typeof message === 'string') {
        // OB11: string messages are CQ code unless auto_escape is true.
        return bool(params, 'auto_escape', false)
            ? [{ type: 'text', data: { text: message } }]
            : parseCQCode(message);
    }
    if (Array.isArray(message)) return message as OB11Segment[];
    throw new ActionError(1400, 'message must be string or segment array');
}

const actions: Record<string, ActionHandler> = {
    // ---------- messaging ----------
    send_private_msg: async (p, ctx) => {
        const peer = await peerOf(p, ctx, { requirePrivate: true });
        const r = await ctx.sendMessage(peer, await segmentsToNtElements(segmentsOf(p), { ...ctx, peer }));
        return { message_id: r.msgId };
    },
    send_group_msg: async (p, ctx) => {
        const peer = await peerOf(p, ctx, { requireGroup: true });
        const r = await ctx.sendMessage(peer, await segmentsToNtElements(segmentsOf(p), { ...ctx, peer }));
        return { message_id: r.msgId };
    },
    send_msg: async (p, ctx) => {
        const peer = await peerOf(p, ctx);
        const r = await ctx.sendMessage(peer, await segmentsToNtElements(segmentsOf(p), { ...ctx, peer }));
        return { message_id: r.msgId };
    },
    delete_msg: async (p, ctx) => {
        const mid = str(p, 'message_id');
        await ctx.deleteMsg(await peerForMsg(p, ctx, mid), mid);
        return {};
    },
    get_msg: async (p, ctx) => {
        const mid = str(p, 'message_id');
        return await ctx.getMsg(await peerForMsg(p, ctx, mid), mid);
    },
    get_msg_history: async (p, ctx) => {
        const mid = String(p.message_id ?? '');
        // Allow message_id-only history lookups when the peer is cached.
        const peer = (p.group_id || p.user_id || p.message_type)
            ? await peerOf(p, ctx)
            : await peerForMsg(p, ctx, mid);
        const list = await ctx.getMsgHistory(peer, mid, num(p, 'count', 20));
        return { messages: list };
    },
    // ---------- go-cqhttp / NapCat history extensions ----------
    // CyberGroupmate and other clients backfill offline messages through
    // these (get_group_msg_history / get_friend_msg_history).
    get_group_msg_history: async (p, ctx) => {
        if (!p.group_id) throw new ActionError(1400, 'group_id is required');
        const peer = { chatType: 2, peerUid: String(p.group_id) };
        const list = await ctx.getChatHistory(
            peer,
            String(p.message_seq ?? ''),
            num(p, 'count', 20),
            bool(p, 'reverse_order', false) || bool(p, 'reverseOrder', false),
        );
        return { messages: list };
    },
    get_friend_msg_history: async (p, ctx) => {
        if (!p.user_id) throw new ActionError(1400, 'user_id is required');
        const uin = String(p.user_id);
        const uid = await ensureUidOf(ctx, uin);
        if (!uid) throw new ActionError(1400, `cannot resolve user ${uin} to uid`);
        // Friends use the normal C2C peer; strangers/temp chats (e.g. a group
        // member the bot has never added) live in the temp C2C session.
        const chatType = (await ctx.isBuddy?.(uid)) ? 1 : 100;
        const list = await ctx.getChatHistory(
            { chatType, peerUid: uid },
            String(p.message_seq ?? ''),
            num(p, 'count', 20),
            bool(p, 'reverse_order', false) || bool(p, 'reverseOrder', false),
        );
        return { messages: list };
    },
    // ---------- NapCat message reactions ----------
    set_msg_emoji_like: async (p, ctx) => {
        const msgId = String(p.message_id ?? '');
        const emojiId = String(p.emoji_id ?? '');
        if (!msgId) throw new ActionError(1400, 'message_id is required');
        // NapCat throws 'emojiId not found' here.
        if (!emojiId) throw new Error('emojiId not found');
        await ctx.emojiLikes(msgId, emojiId, String(p.emoji_type ?? p.emojiType ?? ''), bool(p, 'set', true) ? 'set' : 'unset');
        return {};
    },
    fetch_emoji_like: async (p, ctx) => {
        const msgId = String(p.message_id ?? '');
        const emojiId = String(p.emoji_id ?? p.emojiId ?? '');
        if (!msgId) throw new ActionError(1400, 'message_id is required');
        if (!emojiId) throw new ActionError(1400, 'emoji_id is required');
        return await ctx.emojiLikes(msgId, emojiId, String(p.emoji_type ?? p.emojiType ?? ''), 'get', num(p, 'count', 20));
    },
    mark_msg_as_read: async (p, ctx) => {
        const mid = String(p.message_id ?? '');
        const peer = mid && !(p.user_id || p.group_id) ? await peerForMsg(p, ctx, mid) : await peerOf(p, ctx);
        await ctx.markRead(peer);
        return {};
    },

    // ---------- profile ----------
    get_login_info: async (_p, ctx) => await ctx.getLoginInfo(),
    get_friend_list: async (_p, ctx) => await ctx.getFriendList(),
    get_stranger_info: async (p, ctx) => {
        const uid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!uid) throw new ActionError(1400, 'cannot resolve user');
        return await ctx.getStrangerInfo(uid);
    },
    send_like: async (p, ctx) => {
        const uid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!uid) throw new ActionError(1400, 'cannot resolve user');
        await ctx.sendLike(uid, num(p, 'times', 1));
        return {};
    },

    // ---------- groups ----------
    get_group_list: async (_p, ctx) => await ctx.getGroupList(),
    get_group_info: async (p, ctx) => await ctx.getGroupInfo(str(p, 'group_id')),
    get_group_info_simple: async (p, ctx) => await ctx.getGroupInfo(str(p, 'group_id')),
    get_group_member_list: async (p, ctx) => await ctx.getGroupMemberList(str(p, 'group_id')),
    get_group_member_info: async (p, ctx) => {
        const memberUid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        return await ctx.getGroupMemberInfo(str(p, 'group_id'), memberUid);
    },
    set_group_ban: async (p, ctx) => {
        const memberUid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupBan(str(p, 'group_id'), memberUid, num(p, 'duration', 1800));
        return {};
    },
    set_group_whole_ban: async (p, ctx) => {
        await ctx.setGroupWholeBan(str(p, 'group_id'), bool(p, 'enable', true));
        return {};
    },
    set_group_kick: async (p, ctx) => {
        const memberUid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupKick(str(p, 'group_id'), [memberUid], bool(p, 'reject_add_request', false));
        return {};
    },
    set_group_leave: async (p, ctx) => {
        await ctx.setGroupLeave(str(p, 'group_id'), bool(p, 'is_dismiss', false));
        return {};
    },
    set_group_card: async (p, ctx) => {
        const memberUid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupCard(str(p, 'group_id'), memberUid, str(p, 'card'));
        return {};
    },
    set_group_name: async (p, ctx) => {
        await ctx.setGroupName(str(p, 'group_id'), str(p, 'group_name'));
        return {};
    },
    set_group_admin: async (p, ctx) => {
        const memberUid = await ensureUidOf(ctx, str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupAdmin(str(p, 'group_id'), memberUid, bool(p, 'enable', true));
        return {};
    },
    set_group_avatar: async (p, ctx) => {
        await ctx.setGroupAvatar(str(p, 'group_id'), str(p, 'file'));
        return {};
    },

    // ---------- requests ----------
    set_friend_add_request: async (p, ctx) => {
        await ctx.handleFriendRequest(str(p, 'flag'), bool(p, 'approve', true), p.remark as string | undefined);
        return {};
    },
    set_group_add_request: async (p, ctx) => {
        await ctx.handleGroupRequest(str(p, 'flag'), bool(p, 'approve', true), p.reason as string | undefined);
        return {};
    },

    // ---------- status ----------
    can_send_image: async () => ({ yes: true }),
    can_send_record: async () => ({ yes: true }),
    get_version_info: async () => ({
        app_name: 'KatheryneQQ',
        app_version: `v${appVersion()}`,
        protocol_version: 'v11',
    }),
    get_status: async (_p, ctx) => ({
        online: Boolean(ctx.selfUin),
        good: Boolean(ctx.selfUin),
        login_uin: Number(ctx.selfUin),
    }),

    // ---------- go-cqhttp extensions ----------
    group_poke: async (p, ctx) => {
        // groups are addressed by their group code directly
        const peerUinNum = Number(str(p, 'group_id'));
        if (!Number.isFinite(peerUinNum)) throw new ActionError(1400, 'invalid group id');
        const ok = await ctx.sendPoke(str(p, 'user_id'), String(peerUinNum), true);
        if (!ok) throw new ActionError(1500, 'poke send failed');
        return {};
    },
    friend_poke: async (p, ctx) => {
        const target = str(p, 'user_id');
        const ok = await ctx.sendPoke(target, target, false);
        if (!ok) throw new ActionError(1500, 'poke send failed');
        return {};
    },
    // ---------- public API parity ----------
    get_forward_msg: async (p, ctx) => {
        const mid = String(p.id ?? p.message_id ?? '');
        if (!mid) throw new ActionError(1400, 'id is required');
        const messages = await ctx.getForwardMsg(mid);
        // public.md names the response field "message" (array of node
        // segments); go-cqhttp/NapCat clients read "messages" (sender/time/
        // content objects). Return both.
        const nodes = messages.map((m) => {
            const sender = (m.sender ?? {}) as Record<string, unknown>;
            return {
                type: 'node',
                data: {
                    user_id: sender.user_id ?? '',
                    nickname: String(sender.nickname ?? ''),
                    time: m.time,
                    content: m.message ?? m.content ?? [],
                },
            };
        });
        return { message: nodes, messages };
    },
    get_group_honor_info: async (p, ctx) => {
        const gid = str(p, 'group_id');
        const info = await ctx.getGroupHonorInfo(gid);
        return { group_id: Number(gid), ...info };
    },
    get_credentials: async (p, ctx) => {
        const r = await ctx.getCredentials(String(p.domain ?? ''));
        // OB11 public.md: { cookies, csrf_token } (not "token").
        return { cookies: r.cookies, csrf_token: r.token };
    },
    get_record: async (p, ctx) => {
        const file = String(p.file ?? p.file_id ?? '');
        if (!file) throw new ActionError(1400, 'file is required');
        return await ctx.getMedia(file, p.out_format ? String(p.out_format) : undefined);
    },
    get_image: async (p, ctx) => {
        const file = String(p.file ?? p.file_id ?? '');
        if (!file) throw new ActionError(1400, 'file is required');
        return await ctx.getMedia(file);
    },
    set_restart: async (p, ctx) => {
        await ctx.restart(Number(p.delay ?? 0));
        return {};
    },
    clean_cache: async (_p, ctx) => await ctx.cleanCache(),
    // QQNT kernel has no anonymous-group / special-title APIs (NapCat omits
    // them too); surface a clear protocol-level error instead of silence.
    set_group_anonymous_ban: async () => { throw new ActionError(1404, 'not supported on QQNT (no kernel API)'); },
    set_group_anonymous: async () => { throw new ActionError(1404, 'not supported on QQNT (no kernel API)'); },
    set_group_special_title: async () => { throw new ActionError(1404, 'not supported on QQNT (no kernel API)'); },

    get_cookies: async (p, ctx) => ({ cookies: await ctx.getCookies(String(p.domain ?? '')) }),
    get_csrf_token: async () => ({ token: 0 }),
};

export const actionNames = Object.keys(actions);

export async function dispatchAction(
    action: string,
    params: ActionParams,
    ctx: ActionContext,
): Promise<{ status: string; retcode: number; data: unknown; message?: string }> {
    const handler = actions[action];
    if (!handler) {
        return { status: 'failed', retcode: 1404, data: null, message: `unsupported action: ${action}` };
    }
    try {
        const data = await handler(params ?? {}, ctx);
        return { status: 'ok', retcode: 0, data: data ?? {} };
    } catch (e) {
        if (e instanceof ActionError) {
            return { status: 'failed', retcode: e.retcode, data: null, message: e.message };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { status: 'failed', retcode: 1500, data: null, message: msg };
    }
}
