/**
 * OneBot v11 event model + dispatcher.
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

    subscribe(fn: EventListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(event: OB11AnyEvent): void {
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
