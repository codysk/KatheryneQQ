/**
 * OneBot v11 event model + dispatcher.
 *
 * Event envelope (OB11 spec): every event carries `time`, `self_id`,
 * `post_type`; message events add `message_type`, notice events
 * `notice_type`, request events `request_type`, meta events
 * `meta_event_type`.
 */
export interface OB11Event {
    time: number;
    self_id: string | number;
    post_type: string;
    [k: string]: unknown;
}

export type OB11MessageEvent = OB11Event & {
    post_type: 'message';
    message_type: 'private' | 'group';
    sub_type: string;
    message_id: string;
    user_id: string;
    group_id?: string;
    message: unknown[];
    raw_message: string;
    font: number;
    sender: { user_id: string; nickname: string; card?: string; role?: string };
};

export type OB11NoticeEvent = OB11Event & {
    post_type: 'notice';
    notice_type: string;
};

export type OB11RequestEvent = OB11Event & {
    post_type: 'request';
    request_type: string;
};

export type OB11MetaEvent = OB11Event & {
    post_type: 'meta_event';
    meta_event_type: 'lifecycle' | 'heartbeat';
};

export type OB11AnyEvent = OB11MessageEvent | OB11NoticeEvent | OB11RequestEvent | OB11MetaEvent;

export type EventListener = (event: OB11AnyEvent) => void;

export class EventBus {
    private listeners = new Set<EventListener>();
    /** Ring buffer of recent events for the console page. */
    recent: OB11AnyEvent[] = [];

    subscribe(fn: EventListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(event: OB11AnyEvent): void {
        this.recent.push(event);
        if (this.recent.length > 500) this.recent.shift();
        for (const fn of this.listeners) {
            try {
                fn(event);
            } catch (e) {
                console.error('[katheryne] event listener error', e);
            }
        }
    }
}

export function segmentsToRawText(segments: unknown[]): string {
    if (!Array.isArray(segments)) return '';
    let out = '';
    for (const seg of segments as Array<{ type: string; data: Record<string, unknown> }>) {
        if (!seg || typeof seg !== 'object') continue;
        switch (seg.type) {
            case 'text':
                out += String(seg.data?.text ?? '');
                break;
            case 'at':
                out += `@${seg.data?.qq ?? ''}`;
                break;
            case 'image':
                out += '[图片]';
                break;
            case 'record':
                out += '[语音]';
                break;
            case 'face':
                out += `[表情${seg.data?.id ?? ''}]`;
                break;
            case 'reply':
                out += `[回复${seg.data?.seq ?? ''}]`;
                break;
            case 'json':
                out += '[JSON]';
                break;
            case 'file':
                out += '[文件]';
                break;
            default:
                out += `[${seg.type}]`;
        }
    }
    return out;
}

/**
 * NT group notify types (napcat-core GroupNotifyMsgType) mapped to OB11
 * request/presence notices. Presence/admin are normally derived from system
 * messages in NapCat; here we map the notify equivalents best-effort.
 *   1 INVITED_BY_MEMBER, 4 AGREED_TOJOIN_DIRECT, 5 INVITED_NEED_ADMIN_PASS,
 *   6 AGREED_TO_JOIN_BY_ADMIN, 7 REQUEST_JOIN_NEED_ADMIN_PASS, 8 SET_ADMIN,
 *   9 KICK_NOTIFY_ADMIN, 10 KICK_NOTIFY_KICKED, 11 MEMBER_LEAVE,
 *   12/13 CANCEL_ADMIN, 14/15 TRANSFER_GROUP
 */
export function groupNotifyToNotice(
    notify: Record<string, unknown>,
    selfUin: string,
    resolve: (uid: string) => string | null,
): OB11AnyEvent | null {
    const type = Number(notify.type ?? 0);
    const status = Number(notify.status ?? 0);
    const group = (notify.group ?? {}) as Record<string, unknown>;
    const groupCode = String(group.groupCode ?? notify.groupCode ?? notify.group_id ?? '');
    const uinOf = (u: unknown): string => {
        const obj = (u ?? {}) as Record<string, unknown>;
        const uid = String(obj.uid ?? '');
        if (!uid || uid === '0') return '0';
        return resolve(uid) ?? uid;
    };
    const user1 = uinOf(notify.user1);
    const user2 = uinOf(notify.user2);
    const actionUser = uinOf(notify.actionUser);
    const operator = actionUser !== '0' ? actionUser : user2;
    const asId = (u: string): number | string => (Number(u) > 0 ? Number(u) : u);
    const base = {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(selfUin) || selfUin,
        group_id: Number(groupCode) || groupCode,
    };
    const comment = String(notify.postscript ?? '');
    const flag = String(notify.seq ?? '');
    // Requests only matter while pending (KUNHANDLE = 1).
    const pending = status === 1;
    switch (type) {
        case 7: // REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS
        case 5: // INVITED_NEED_ADMINI_STRATOR_PASS
            if (!pending) return null;
            return { ...base, post_type: 'request', request_type: 'group', sub_type: 'add', user_id: asId(user1), comment, flag };
        case 1: // INVITED_BY_MEMBER (bot invited by a member)
            if (!pending) return null;
            return { ...base, post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: asId(user2), comment, flag };
        case 4: // AGREED_TOJOIN_DIRECT
        case 6: // AGREED_TO_JOIN_BY_ADMINI_STRATOR
            return { ...base, post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', user_id: asId(user1), operator_id: asId(operator) };
        case 9: // KICK_MEMBER_NOTIFY_ADMIN
        case 10: // KICK_MEMBER_NOTIFY_KICKED
            return { ...base, post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick', user_id: asId(user1), operator_id: asId(operator) };
        case 11: // MEMBER_LEAVE_NOTIFY_ADMIN
            return { ...base, post_type: 'notice', notice_type: 'group_decrease', sub_type: 'leave', user_id: asId(user1), operator_id: 0 };
        case 8: // SET_ADMIN
            return { ...base, post_type: 'notice', notice_type: 'group_admin', sub_type: 'set', user_id: asId(user1) };
        case 12: // CANCEL_ADMIN_NOTIFY_CANCELED
        case 13: // CANCEL_ADMIN_NOTIFY_ADMIN
            return { ...base, post_type: 'notice', notice_type: 'group_admin', sub_type: 'unset', user_id: asId(user1) };
        default:
            return null;
    }
}
