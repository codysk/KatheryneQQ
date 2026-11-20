/**
 * OneBot v11 action handlers.
 */
import type { OB11Segment } from '../message/segments.js';
import { segmentsToNtElements } from '../message/segments.js';

export interface ActionContext {
    selfUin: string;
    selfUid: string;
    resolveUin(uin: string): string | null;
    resolveUid(uid: string): string | null;
    sendMessage(peer: { chatType: number; peerUid: string }, elements: unknown[]): Promise<{ msgId: string }>;
    getMsg(peer: { chatType: number; peerUid: string }, msgId: string): Promise<Record<string, unknown>>;
    getLoginInfo(): Promise<{ user_id: string; nickname: string }>;
    getFriendList(): Promise<Array<Record<string, unknown>>>;
    getGroupList(): Promise<Array<Record<string, unknown>>>;
    getGroupMemberList(groupUid: string): Promise<Array<Record<string, unknown>>>;
    deleteMsg(peer: { chatType: number; peerUid: string }, msgId: string): Promise<void>;
    setGroupBan(groupUid: string, memberUid: string, duration: number): Promise<void>;
    setGroupWholeBan(groupUid: string, enable: boolean): Promise<void>;
    setGroupKick(groupUid: string, memberUid: string, rejectAdd: boolean): Promise<void>;
    setGroupLeave(groupUid: string, dismiss: boolean): Promise<void>;
    setGroupCard(groupUid: string, memberUid: string, card: string): Promise<void>;
    getGroupInfo(groupUid: string): Promise<Record<string, unknown>>;
    getFriendInfo(userUid: string): Promise<Record<string, unknown>>;
    sendLike(userUid: string, times: number): Promise<void>;
}

export interface ActionParams {
    [k: string]: unknown;
}

export type ActionResult = Record<string, unknown>;

type ActionHandler = (params: ActionParams, ctx: ActionContext) => Promise<ActionResult>;

function peerOf(params: ActionParams, ctx: ActionContext): { chatType: number; peerUid: string } {
    const messageType = params.message_type as string | undefined;
    const groupId = params.group_id as string | undefined;
    const userId = params.user_id as string | undefined;
    if (messageType === 'group' || groupId) {
        const uid = ctx.resolveUin(String(groupId ?? ''));
        if (!uid) throw new Error(`cannot resolve group ${groupId}`);
        return { chatType: 2, peerUid: uid };
    }
    const uid = ctx.resolveUin(String(userId ?? ''));
    if (!uid) throw new Error(`cannot resolve user ${userId}`);
    return { chatType: 1, peerUid: uid };
}

function segmentsOf(params: ActionParams): OB11Segment[] {
    const message = params.message;
    if (typeof message === 'string') {
        return [{ type: 'text', data: { text: message } }];
    }
    if (Array.isArray(message)) return message as OB11Segment[];
    throw new Error('message must be string or segment array');
}

export const actions: Record<string, ActionHandler> = {
    async send_private_msg(params, ctx) {
        const peer = peerOf(params, ctx);
        const elements = segmentsToNtElements(segmentsOf(params), ctx);
        const r = await ctx.sendMessage(peer, elements);
        return { message_id: r.msgId };
    },
    async send_group_msg(params, ctx) {
        const peer = peerOf(params, ctx);
        const elements = segmentsToNtElements(segmentsOf(params), ctx);
        const r = await ctx.sendMessage(peer, elements);
        return { message_id: r.msgId };
    },
    async send_msg(params, ctx) {
        const peer = peerOf(params, ctx);
        const elements = segmentsToNtElements(segmentsOf(params), ctx);
        const r = await ctx.sendMessage(peer, elements);
        return { message_id: r.msgId };
    },
    async delete_msg(params, ctx) {
        const peer = peerOf(params, ctx);
        await ctx.deleteMsg(peer, String(params.message_id ?? ''));
        return {};
    },
    async get_msg(params, ctx) {
        const peer = peerOf(params, ctx);
        return await ctx.getMsg(peer, String(params.message_id ?? ''));
    },
    async get_login_info(_params, ctx) {
        return await ctx.getLoginInfo();
    },
    async get_friend_list(_params, ctx) {
        const list = await ctx.getFriendList();
        return { data: list } as ActionResult;
    },
    async get_group_list(_params, ctx) {
        const list = await ctx.getGroupList();
        return { data: list } as ActionResult;
    },
    async get_group_member_list(params, ctx) {
        const peer = peerOf(params, ctx);
        const list = await ctx.getGroupMemberList(peer.peerUid);
        return { data: list } as ActionResult;
    },
    async get_group_info(params, ctx) {
        const peer = peerOf(params, ctx);
        return await ctx.getGroupInfo(peer.peerUid);
    },
    async get_stranger_info(params, ctx) {
        const uid = ctx.resolveUin(String(params.user_id ?? ''));
        if (!uid) throw new Error('cannot resolve user');
        return await ctx.getFriendInfo(uid);
    },
    async set_group_ban(params, ctx) {
        const peer = peerOf(params, ctx);
        const memberUid = ctx.resolveUin(String(params.user_id ?? ''));
        if (!memberUid) throw new Error('cannot resolve member');
        const duration = Number(params.duration ?? 1800);
        await ctx.setGroupBan(peer.peerUid, memberUid, duration);
        return {};
    },
    async set_group_whole_ban(params, ctx) {
        const peer = peerOf(params, ctx);
        await ctx.setGroupWholeBan(peer.peerUid, Boolean(params.enable ?? true));
        return {};
    },
    async set_group_kick(params, ctx) {
        const peer = peerOf(params, ctx);
        const memberUid = ctx.resolveUin(String(params.user_id ?? ''));
        if (!memberUid) throw new Error('cannot resolve member');
        await ctx.setGroupKick(peer.peerUid, memberUid, Boolean(params.reject_add_request ?? false));
        return {};
    },
    async set_group_leave(params, ctx) {
        const peer = peerOf(params, ctx);
        await ctx.setGroupLeave(peer.peerUid, Boolean(params.is_dismiss ?? false));
        return {};
    },
    async set_group_card(params, ctx) {
        const peer = peerOf(params, ctx);
        const memberUid = ctx.resolveUin(String(params.user_id ?? ''));
        if (!memberUid) throw new Error('cannot resolve member');
        await ctx.setGroupCard(peer.peerUid, memberUid, String(params.card ?? ''));
        return {};
    },
    async send_like(params, ctx) {
        const uid = ctx.resolveUin(String(params.user_id ?? ''));
        if (!uid) throw new Error('cannot resolve user');
        await ctx.sendLike(uid, Number(params.times ?? 1));
        return {};
    },
    async can_send_image() {
        return { yes: true };
    },
    async can_send_record() {
        return { yes: true };
    },
    async get_version_info() {
        return {
            app_name: 'KatheryneQQ',
            app_version: 'v0.1.0',
            protocol_version: 'v11',
        };
    },
    async get_status(_params, ctx) {
        return {
            online: true,
            good: true,
            login_uin: ctx.selfUin,
        };
    },
};

export async function dispatchAction(
    action: string,
    params: ActionParams,
    ctx: ActionContext,
): Promise<ActionResult> {
    const handler = actions[action];
    if (!handler) {
        const err = new Error(`unsupported action: ${action}`);
        (err as Error & { status?: string; retcode?: number }).status = 'failed';
        (err as Error & { status?: string; retcode?: number }).retcode = 1404;
        throw err;
    }
    return await handler(params, ctx);
}
