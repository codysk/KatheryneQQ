/**
 * OneBot v11 message segment <-> NT element conversion.
 *
 * OB11: https://github.com/botuniverse/onebot-11  (message segment arrays)
 * NT:   element objects consumed by NodeIKernelMsgService.sendMsg.
 */
import type { RawElement } from '../../nt/session.js';

export type OB11Segment = {
    type: string;
    data: Record<string, unknown>;
};

export const ChatType_C2C = 1;
export const ChatType_Group = 2;

/** NT at types (NTMsgAtType) */
const AT_TYPE_ALL = 1;
const AT_TYPE_ONE = 2;

export interface SendMessageElement {
    elementType: number;
    elementId?: string;
    [elementName: string]: unknown;
}

export interface PeerRef {
    chatType: number;
    peerUid: string;
    guildId?: string;
}

/** Context needed to build/parse elements (kernel queries live on the runtime). */
export interface SegmentContext {
    selfUin: string;
    selfUid: string;
    /** Target chat of the send (at/reply resolution depends on it). */
    peer: PeerRef;
    resolveUin(uin: string): string | null;
    ensureUid?(uin: string): Promise<string | null>;
    resolveUid(uid: string): string | null;
    resolveMsgPeer(msgId: string): { chatType: number; peerUid: string } | null;
    /** Kernel lookups for reply targets. */
    fetchMsgByMsgId(peer: { chatType: number; peerUid: string; guildId?: string }, msgId: string): Promise<Record<string, any> | undefined>;
    fetchMsgBySeq(peer: { chatType: number; peerUid: string; guildId?: string }, seq: string): Promise<Record<string, any> | undefined>;
    /** Group member display name (card/nick) for @ rendering; optional. */
    resolveMemberNickname?(groupCode: string, uin: string): Promise<string | null>;
}

const ELEMENT_TYPE = {
    TEXT: 1,
    PIC: 2,
    FILE: 3,
    PTT: 4,
    VIDEO: 5,
    FACE: 6,
    REPLY: 7,
    ARK: 10,
    MARKDOWN: 14,
} as const;

/**
 * Build NT send elements from OB11 segments.
 *
 * at: NT textElement carries the target UIN in `atUid` and the NT uid in
 * `atNtUid` (atType 2), or 'all'/'all' with atType 1 for @全体成员. NT has no
 * at element in C2C chats, so at segments are dropped there (same as NapCat).
 *
 * reply: NT replyElement needs the replied message's seq/id/sender from the
 * kernel — OB11 only supplies our message_id (or seq), so we look the message
 * up before building the element.
 */
export async function segmentsToNtElements(
    segments: OB11Segment[],
    ctx: SegmentContext,
): Promise<SendMessageElement[]> {
    const out: SendMessageElement[] = [];
    const isGroup = ctx.peer.chatType === ChatType_Group;

    for (const seg of segments) {
        const d = seg.data ?? {};
        switch (seg.type) {
            case 'text': {
                out.push({
                    elementType: ELEMENT_TYPE.TEXT,
                    textElement: {
                        content: String(d.text ?? ''),
                        atType: 0,
                        atUid: '',
                        atTinyId: '',
                        atNtUid: '',
                    },
                });
                break;
            }
            case 'at': {
                // NT has no per-user at in private chats.
                if (!isGroup) break;
                const qq = String(d.qq ?? '');
                if (!qq) break;
                if (qq === 'all') {
                    out.push({
                        elementType: ELEMENT_TYPE.TEXT,
                        textElement: {
                            content: '@全体成员',
                            atType: AT_TYPE_ALL,
                            atUid: 'all',
                            atTinyId: '',
                            atNtUid: 'all',
                        },
                    });
                    break;
                }
                const uid = ctx.resolveUin(qq) ?? (ctx.ensureUid ? await ctx.ensureUid(qq) : null);
                if (!uid) throw new Error(`cannot resolve at target ${qq} to uid`);
                let name = String(d.name ?? '');
                if (!name && ctx.resolveMemberNickname) {
                    name = (await ctx.resolveMemberNickname(ctx.peer.peerUid, qq)) ?? '';
                }
                if (!name) name = qq;
                out.push({
                    elementType: ELEMENT_TYPE.TEXT,
                    textElement: {
                        content: `@${name}`,
                        atType: AT_TYPE_ONE,
                        atUid: qq,        // UIN, per NT semantics
                        atTinyId: '',
                        atNtUid: uid,     // NT uid
                    },
                });
                break;
            }
            case 'reply': {
                const id = d.id !== undefined && d.id !== null ? String(d.id) : '';
                const seq = d.seq !== undefined && d.seq !== null ? String(d.seq) : '';
                if (!id && !seq) throw new Error('reply segment needs id or seq');
                let raw: Record<string, any> | undefined;
                if (seq) {
                    raw = await ctx.fetchMsgBySeq(ctx.peer, seq);
                }
                if (!raw && id) {
                    raw = await ctx.fetchMsgByMsgId(ctx.peer, id);
                    if (!raw) {
                        // Reply target may live in another chat (quoted forward etc.).
                        const cached = ctx.resolveMsgPeer(id);
                        if (cached) raw = await ctx.fetchMsgByMsgId(cached, id);
                    }
                }
                if (!raw) throw new Error(`reply target message not found: ${id || `seq=${seq}`}`);
                out.push({
                    elementType: ELEMENT_TYPE.REPLY,
                    replyElement: {
                        replayMsgSeq: String(raw.msgSeq ?? ''),
                        replayMsgId: String(raw.msgId ?? ''),
                        senderUin: String(raw.senderUin ?? ''),
                        senderUinStr: String(raw.senderUin ?? ''),
                        replyMsgClientSeq: String(raw.clientSeq ?? ''),
                        replyMsgTime: String(raw.msgTime ?? ''),
                    },
                });
                break;
            }
            case 'face': {
                out.push({
                    elementType: ELEMENT_TYPE.FACE,
                    faceElement: {
                        faceIndex: Number(d.id ?? 0),
                        faceType: Number(d.type ?? 1),
                        faceText: '',
                        compatText: '',
                    },
                });
                break;
            }
            case 'image': {
                out.push({
                    elementType: ELEMENT_TYPE.PIC,
                    picElement: {
                        md5HexStr: '',
                        fileSize: '0',
                        picWidth: 0,
                        picHeight: 0,
                        fileName: String(d.file ?? 'image'),
                        sourcePath: String(d.file ?? ''),
                        original: Boolean(d.original),
                        picType: Number(d.picType ?? 0),
                        picSubType: Number(d.subType ?? 0),
                        picSubUrl: String(d.url ?? ''),
                        previewThumb: '',
                        picExt: /\.(png|gif|jpg|jpeg|webp|bmp)$/i.exec(String(d.file ?? ''))?.[1] ?? 'png',
                    },
                });
                break;
            }
            case 'record': {
                out.push({
                    elementType: ELEMENT_TYPE.PTT,
                    pttElement: {
                        fileName: String(d.file ?? 'voice.wav'),
                        filePath: String(d.file ?? ''),
                        md5HexStr: '',
                        fileSize: 0,
                        duration: Number(d.duration ?? 0),
                        formatType: 0,
                        voiceType: 0,
                        voiceLength: Number(d.duration ?? 0),
                        canConvertToText: false,
                        transferStatus: 0,
                    },
                });
                break;
            }
            case 'json': {
                out.push({
                    elementType: ELEMENT_TYPE.ARK,
                    arkElement: {
                        jsonContent: String(d.data ?? ''),
                        subElementType: 0,
                    },
                });
                break;
            }
            case 'forward': {
                // Multi-message forwarding is a separate kernel call; surfaced
                // through send_forward_msg in later phases.
                break;
            }
            default:
                break;
        }
    }

    return out;
}

/**
 * Convert a NT RawMessage's elements into OB11 segments.
 *
 * `resolveReplyId` maps the reply element's server-side msgId onto the id this
 * framework exposes for the same message (our local msgId space), so reply
 * segments point at ids clients actually received in message events.
 */
export async function ntElementsToSegments(
    elements: RawElement[],
    ctx: {
        resolveUid: (uid: string) => string | null;
        selfUid: string;
        peer?: { chatType: number; peerUid: string; guildId?: string };
        resolveReplyId?: (peer: { chatType: number; peerUid: string; guildId?: string }, seq: string, serverId: string) => Promise<string | null>;
        /** Message id of the raw message being converted (media index keys). */
        msgId?: string;
        /** Register media elements so get_image / get_record can download them. */
        rememberMedia?: (key: string, meta: {
            peer: { chatType: number; peerUid: string; guildId?: string };
            msgId: string;
            elementId: string;
            kind: 'image' | 'record';
            fileName?: string;
            fileSize?: number;
            url?: string;
            localPath?: string;
        }) => void;
    },
): Promise<OB11Segment[]> {
    const out: OB11Segment[] = [];
    for (const el of elements ?? []) {
        const t = Number(el.elementType ?? 0);
        switch (t) {
            case ELEMENT_TYPE.TEXT: {
                const te = (el.textElement ?? {}) as Record<string, unknown>;
                const content = String(te.content ?? '');
                const atType = Number(te.atType ?? 0);
                if (atType > 0) {
                    // NT stores the target UIN in atUid (atType 2), 'all' for
                    // at-all (atType 1); older payloads only carry atNtUid.
                    let qq = 'all';
                    if (atType !== AT_TYPE_ALL) {
                        const atUin = String(te.atUid ?? '');
                        if (atUin && atUin !== '0') {
                            qq = String(Number(atUin) >>> 0);
                        } else {
                            const uid = String(te.atNtUid ?? te.atTinyId ?? '');
                            qq = uid ? (ctx.resolveUid(uid) ?? uid) : '';
                        }
                    }
                    out.push({ type: 'at', data: { qq } });
                    const rest = content.replace(/^@[^\s@]+\s?/, '');
                    if (rest) out.push({ type: 'text', data: { text: rest } });
                } else if (content) {
                    out.push({ type: 'text', data: { text: content } });
                }
                break;
            }
            case ELEMENT_TYPE.PIC: {
                const pe = (el.picElement ?? {}) as Record<string, unknown>;
                // originImageUrl is the relative CDN path; prefix the host.
                const origin = String(pe.originImageUrl ?? '');
                const url = origin
                    ? (origin.startsWith('http') ? origin : `https://gchat.qpic.cn${origin}`)
                    : String(pe.picSubUrl ?? pe.url ?? '');
                const imgKey = String(pe.fileName ?? pe.md5HexStr ?? '');
                out.push({
                    type: 'image',
                    data: {
                        file: imgKey,
                        url,
                        file_size: Number(pe.fileSize ?? 0),
                    },
                });
                if (imgKey && ctx.msgId && ctx.peer && ctx.rememberMedia) {
                    ctx.rememberMedia(imgKey, {
                        peer: ctx.peer,
                        msgId: ctx.msgId,
                        elementId: String(el.elementId ?? ''),
                        kind: 'image',
                        fileName: imgKey,
                        fileSize: Number(pe.fileSize ?? 0),
                        url,
                        localPath: String(pe.sourcePath ?? pe.filePath ?? ''),
                    });
                }
                break;
            }
            case ELEMENT_TYPE.PTT: {
                const pe = (el.pttElement ?? {}) as Record<string, unknown>;
                const pttKey = String(pe.fileName ?? '');
                const pttUrl = String(pe.url ?? '');
                out.push({
                    type: 'record',
                    data: {
                        file: pttKey,
                        url: pttUrl,
                        duration: Number(pe.duration ?? pe.voiceLength ?? 0),
                    },
                });
                if (pttKey && ctx.msgId && ctx.peer && ctx.rememberMedia) {
                    ctx.rememberMedia(pttKey, {
                        peer: ctx.peer,
                        msgId: ctx.msgId,
                        elementId: String(el.elementId ?? ''),
                        kind: 'record',
                        fileName: pttKey,
                        fileSize: Number(pe.fileSize ?? 0),
                        url: pttUrl,
                        localPath: String(pe.filePath ?? ''),
                    });
                }
                break;
            }
            case ELEMENT_TYPE.FACE: {
                const fe = (el.faceElement ?? {}) as Record<string, unknown>;
                out.push({ type: 'face', data: { id: String(fe.faceIndex ?? '0') } });
                break;
            }
            case ELEMENT_TYPE.REPLY: {
                const re = (el.replyElement ?? {}) as Record<string, unknown>;
                // replayMsgId is the server-side id of the quoted message and
                // sourceMsgIdInRecords a local record index. Map the former onto
                // our exposed id space via msgSeq when possible.
                const serverId = String(re.replayMsgId ?? '');
                const seq = String(re.replayMsgSeq ?? '');
                let id = serverId && serverId !== '0' ? serverId : String(re.sourceMsgIdInRecords ?? '');
                if (seq && ctx.resolveReplyId && ctx.peer) {
                    const local = await ctx.resolveReplyId(ctx.peer, seq, id);
                    if (local) id = local;
                }
                out.push({ type: 'reply', data: { id, seq } });
                break;
            }
            case ELEMENT_TYPE.ARK: {
                const ae = (el.arkElement ?? {}) as Record<string, unknown>;
                out.push({ type: 'json', data: { data: String(ae.jsonContent ?? '') } });
                break;
            }
            case ELEMENT_TYPE.FILE: {
                const fe = (el.fileElement ?? {}) as Record<string, unknown>;
                out.push({
                    type: 'file',
                    data: {
                        file: String(fe.fileName ?? ''),
                        file_size: Number(fe.fileSize ?? 0),
                    },
                });
                break;
            }
            default:
                break;
        }
    }
    return out;
}

/** Escape a text value for CQ-code raw_message (go-cqhttp rules). */
function escapeCQText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

/**
 * Render OB11 segments as a CQ-code string, matching go-cqhttp/NapCat's
 * `raw_message` format (e.g. "hi[CQ:at,qq=123] [CQ:image,file=x.jpg]").
 */
export function segmentsToCQCode(segments: OB11Segment[]): string {
    let out = '';
    for (const seg of segments) {
        if (!seg || typeof seg !== 'object') continue;
        const d = seg.data ?? {};
        switch (seg.type) {
            case 'text':
                out += escapeCQText(String(d.text ?? ''));
                break;
            case 'at':
                out += `[CQ:at,qq=${String(d.qq ?? '')}]`;
                break;
            case 'face':
                out += `[CQ:face,id=${String(d.id ?? '')}]`;
                break;
            case 'image':
                out += `[CQ:image,file=${String(d.file ?? '')}${d.url ? `,url=${String(d.url)}` : ''}]`;
                break;
            case 'record':
                out += `[CQ:record,file=${String(d.file ?? '')}${d.url ? `,url=${String(d.url)}` : ''}]`;
                break;
            case 'reply':
                out += `[CQ:reply,id=${String(d.id ?? d.seq ?? '')}]`;
                break;
            case 'json':
                out += `[CQ:json,data=${escapeCQText(String(d.data ?? '')).replace(/,/g, '&#44;')}]`;
                break;
            case 'file':
                out += `[CQ:file,file=${String(d.file ?? '')}]`;
                break;
            default:
                out += `[CQ:${seg.type}]`;
                break;
        }
    }
    return out.trim();
}

/** Undo CQ text escaping (&amp; &#91; &#93; &#44;). */
function unescapeCQText(s: string): string {
    return s
        .replace(/&#44;/g, ',')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&amp;/g, '&');
}

/**
 * Parse a CQ-code string into OB11 segments (go-cqhttp/NapCat behavior for
 * string `message` params when `auto_escape` is false).
 */
export function parseCQCode(text: string): OB11Segment[] {
    const out: OB11Segment[] = [];
    const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const pushText = (raw: string): void => {
        if (!raw) return;
        out.push({ type: 'text', data: { text: unescapeCQText(raw) } });
    };
    while ((m = re.exec(text)) !== null) {
        pushText(text.slice(last, m.index));
        const type = m[1];
        const data: Record<string, unknown> = {};
        const params = m[2] ? m[2].slice(1) : '';
        if (/^file=data:/i.test(params)) {
            // A raw data: URI contains commas (data:image/png;base64,<body>);
            // keep the whole value instead of splitting it as CQ params.
            data.file = unescapeCQText(params.slice('file='.length));
        } else if (params) {
            for (const pair of params.split(',')) {
                const eq = pair.indexOf('=');
                if (eq <= 0) continue;
                data[pair.slice(0, eq).trim()] = unescapeCQText(pair.slice(eq + 1));
            }
        }
        out.push({ type, data });
        last = re.lastIndex;
    }
    pushText(text.slice(last));
    // A plain string always yields at least one segment.
    if (out.length === 0) out.push({ type: 'text', data: { text: unescapeCQText(text) } });
    return out;
}
