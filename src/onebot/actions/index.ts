/**
 * OneBot v11 action handlers — full standard set + go-cqhttp extensions.
 *
 * Response envelope (OB11 spec):
 *   { status: "async" | "ok" | "failed", retcode: number, data: ..., message?: string, echo }
 * retcodes: 0 ok, 1 async, 1200 internal error, 1400 bad params,
 *           1403 unauthenticated, 1404 action not supported,
 *           1500 handler crashed.
 */
import { segmentsToNtElements, type OB11Segment } from '../message/segments.js';

export interface PeerRef {
    chatType: number;
    peerUid: string;
}

export interface ActionContext {
    selfUin: string;
    selfUid: string;
    resolveUin(uin: string): string | null;
    resolveUid(uid: string): string | null;
    resolveMsgPeer(msgId: string): { chatType: number; peerUid: string } | null;
    // messaging
    sendMessage(peer: PeerRef, elements: unknown[]): Promise<{ msgId: string; seq?: string }>;
    deleteMsg(peer: PeerRef, msgId: string): Promise<void>;
    getMsg(peer: PeerRef, msgId: string): Promise<Record<string, unknown>>;
    getMsgHistory(peer: PeerRef, msgId: string, count: number): Promise<Array<Record<string, unknown>>>;
    markRead(peer: PeerRef): Promise<void>;
    // profile
    getLoginInfo(): Promise<{ user_id: string; nickname: string }>;
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

/** group_id / user_id -> NT peer. */
function peerOf(params: ActionParams, ctx: ActionContext, opts: { requireGroup?: boolean } = {}): PeerRef {
    const groupId = params.group_id as string | undefined;
    const userId = params.user_id as string | undefined;
    const messageType = params.message_type as string | undefined;

    if (messageType === 'group' || (groupId && messageType === undefined)) {
        // NT group peers are addressed by the group code (uin) directly;
        // no uid resolution needed for groups.
        return { chatType: 2, peerUid: String(groupId ?? '') };
    }
    if (messageType === 'private' || messageType === undefined) {
        if (opts.requireGroup) throw new ActionError(1400, 'group_id required');
        const uid = ctx.resolveUin(String(userId ?? ''));
        if (!uid) throw new ActionError(1400, `cannot resolve user ${userId} to uid`);
        return { chatType: 1, peerUid: uid };
    }
    throw new ActionError(1400, `unsupported message_type ${messageType}`);
}

function segmentsOf(params: ActionParams): OB11Segment[] {
    const message = params.message;
    if (typeof message === 'string') return [{ type: 'text', data: { text: message } }];
    if (Array.isArray(message)) return message as OB11Segment[];
    throw new ActionError(1400, 'message must be string or segment array');
}

const actions: Record<string, ActionHandler> = {
    // ---------- messaging ----------
    send_private_msg: async (p, ctx) => {
        const r = await ctx.sendMessage(peerOf(p, ctx), segmentsToNtElements(segmentsOf(p), ctx));
        return { message_id: r.msgId };
    },
    send_group_msg: async (p, ctx) => {
        const r = await ctx.sendMessage(peerOf(p, ctx, { requireGroup: true }), segmentsToNtElements(segmentsOf(p), ctx));
        return { message_id: r.msgId };
    },
    send_msg: async (p, ctx) => {
        const r = await ctx.sendMessage(peerOf(p, ctx), segmentsToNtElements(segmentsOf(p), ctx));
        return { message_id: r.msgId };
    },
    delete_msg: async (p, ctx) => {
        const mid = str(p, 'message_id');
        const peer = (p.user_id || p.group_id) ? peerOf(p, ctx) : (ctx.resolveMsgPeer(mid) ?? peerOf(p, ctx));
        await ctx.deleteMsg(peer, mid);
        return {};
    },
    get_msg: async (p, ctx) => {
        const mid = str(p, 'message_id');
        const peer = (p.user_id || p.group_id) ? peerOf(p, ctx) : (ctx.resolveMsgPeer(mid) ?? peerOf(p, ctx));
        return await ctx.getMsg(peer, mid);
    },
    get_msg_history: async (p, ctx) => {
        const list = await ctx.getMsgHistory(peerOf(p, ctx), String(p.message_id ?? ''), num(p, 'count', 20));
        return { messages: list };
    },
    mark_msg_as_read: async (p, ctx) => {
        await ctx.markRead(peerOf(p, ctx));
        return {};
    },

    // ---------- profile ----------
    get_login_info: async (_p, ctx) => await ctx.getLoginInfo(),
    get_friend_list: async (_p, ctx) => await ctx.getFriendList(),
    get_stranger_info: async (p, ctx) => {
        const uid = ctx.resolveUin(str(p, 'user_id'));
        if (!uid) throw new ActionError(1400, 'cannot resolve user');
        return await ctx.getStrangerInfo(uid);
    },
    send_like: async (p, ctx) => {
        const uid = ctx.resolveUin(str(p, 'user_id'));
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
        const memberUid = ctx.resolveUin(str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        return await ctx.getGroupMemberInfo(str(p, 'group_id'), memberUid);
    },
    set_group_ban: async (p, ctx) => {
        const memberUid = ctx.resolveUin(str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupBan(str(p, 'group_id'), memberUid, num(p, 'duration', 1800));
        return {};
    },
    set_group_whole_ban: async (p, ctx) => {
        await ctx.setGroupWholeBan(str(p, 'group_id'), bool(p, 'enable', true));
        return {};
    },
    set_group_kick: async (p, ctx) => {
        const memberUid = ctx.resolveUin(str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupKick(str(p, 'group_id'), [memberUid], bool(p, 'reject_add_request', false));
        return {};
    },
    set_group_leave: async (p, ctx) => {
        await ctx.setGroupLeave(str(p, 'group_id'), bool(p, 'is_dismiss', false));
        return {};
    },
    set_group_card: async (p, ctx) => {
        const memberUid = ctx.resolveUin(str(p, 'user_id'));
        if (!memberUid) throw new ActionError(1400, 'cannot resolve member');
        await ctx.setGroupCard(str(p, 'group_id'), memberUid, str(p, 'card'));
        return {};
    },
    set_group_name: async (p, ctx) => {
        await ctx.setGroupName(str(p, 'group_id'), str(p, 'group_name'));
        return {};
    },
    set_group_admin: async (p, ctx) => {
        const memberUid = ctx.resolveUin(str(p, 'user_id'));
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
        app_version: 'v0.2.0',
        protocol_version: 'v11',
    }),
    get_status: async (_p, ctx) => ({
        online: Boolean(ctx.selfUin),
        good: Boolean(ctx.selfUin),
        login_uin: ctx.selfUin,
    }),

    // ---------- go-cqhttp extensions ----------
    group_poke: async (p, ctx) => {
        // groups are addressed by their group code directly
        const peerUinNum = Number(str(p, 'group_id'));
        if (!Number.isFinite(peerUinNum)) throw new ActionError(1400, 'invalid group id');
        const ok = await ctx.sendPoke(str(p, 'user_id'), String(peerUinNum), true);
        if (!ok) throw new ActionError(1500, 'poke send unavailable on this QQ build (3.2.35 removed the raw-SSO send path; see docs/poke.md)');
        return {};
    },
    friend_poke: async (p, ctx) => {
        const target = str(p, 'user_id');
        const ok = await ctx.sendPoke(target, target, false);
        if (!ok) throw new ActionError(1500, 'poke send unavailable on this QQ build (3.2.35 removed the raw-SSO send path; see docs/poke.md)');
        return {};
    },
    get_cookies: async (p, ctx) => ({ cookies: await ctx.getCookies(str(p, 'domain')) }),
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
