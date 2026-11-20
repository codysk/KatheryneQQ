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
    self_id: string;
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
 * NT group notify types (NodeIKernelGroupListener onGroupNotifiesUpdated).
 * Kernel notify.type values mapped to OB11 sub types.
 */
export function groupNotifyToNotice(
    notify: Record<string, unknown>,
    selfUin: string,
    resolve: (uid: string) => string | null,
): OB11AnyEvent | null {
    const type = Number(notify.type ?? 0);
    const groupCode = String(notify.groupCode ?? notify.group_id ?? '');
    const user1Uid = String(notify.user1Uid ?? notify.u1Uid ?? '');
    const user2Uid = String(notify.user2Uid ?? notify.u2Uid ?? '');
    const user1 = user1Uid ? resolve(user1Uid) ?? user1Uid : '';
    const user2 = user2Uid ? resolve(user2Uid) ?? user2Uid : '';
    const base = {
        time: Math.floor(Date.now() / 1000),
        self_id: selfUin,
        post_type: 'notice' as const,
        group_id: groupCode,
    };
    switch (type) {
        case 5: // member leave (kicked or quit)
            return { ...base, notice_type: 'group_decrease', sub_type: 'kick', operator_id: user1, user_id: user2 };
        case 7: // member increase (approved join)
            return { ...base, notice_type: 'group_increase', sub_type: 'approve', operator_id: '0', user_id: user1 };
        case 10: // invited by admin
            return { ...base, notice_type: 'group_increase', sub_type: 'invite', operator_id: user1, user_id: user2 };
        case 12: // join request pending
            return {
                ...base,
                post_type: 'request' as const,
                request_type: 'group' as const,
                sub_type: 'add',
                user_id: user1,
                comment: String(notify.postScript ?? ''),
                flag: String(notify.seqId ?? notify.seq ?? ''),
            };
        case 13: // friend request via group
            return {
                ...base,
                post_type: 'request' as const,
                request_type: 'friend' as const,
                sub_type: 'group',
                user_id: user1,
                comment: String(notify.postScript ?? ''),
                flag: String(notify.seqId ?? notify.seq ?? ''),
            };
        case 14: // invited to group (self)
            return {
                ...base,
                post_type: 'request' as const,
                request_type: 'group' as const,
                sub_type: 'invite',
                user_id: user1,
                comment: '',
                flag: String(notify.seqId ?? notify.seq ?? ''),
            };
        default:
            return null;
    }
}
