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

export interface SendMessageElement {
    elementType: number;
    elementId?: string;
    [elementName: string]: unknown;
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

function atTypeOf(qq: string, selfUin: string, isAll: boolean): number {
    if (isAll) return 1; // @全体成员
    if (qq === selfUin) return 2;
    return 2; // NT: at by uin uses type 2 with atNtUid; group uses tinyId in atTinyId
}

/**
 * Build NT send elements from OB11 segments.
 * `context` supplies uin/uid maps needed for @-resolution.
 */
export function segmentsToNtElements(
    segments: OB11Segment[],
    ctx: { selfUin: string; selfUid: string; resolveUin: (uin: string) => string | null },
): SendMessageElement[] {
    const out: SendMessageElement[] = [];
    let atAll = false;
    const pendingAts: Array<{ qq: string; uid: string | null }> = [];

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
                const qq = String(d.qq ?? '');
                if (qq === 'all') {
                    atAll = true;
                    out.push({
                        elementType: ELEMENT_TYPE.TEXT,
                        textElement: {
                            content: '@全体成员',
                            atType: 1,
                            atUid: '',
                            atTinyId: '',
                            atNtUid: '',
                        },
                    });
                } else {
                    const uid = ctx.resolveUin(qq);
                    pendingAts.push({ qq, uid });
                    out.push({
                        elementType: ELEMENT_TYPE.TEXT,
                        textElement: {
                            content: `@${(d.name as string) ?? qq} `,
                            atType: atTypeOf(qq, ctx.selfUin, false),
                            atUid: uid ?? '',
                            atTinyId: '',
                            atNtUid: uid ?? '',
                        },
                    });
                }
                break;
            }
            case 'reply': {
                out.push({
                    elementType: ELEMENT_TYPE.REPLY,
                    replyElement: {
                        replayMsgSeq: String(d.seq ?? ''),
                        replyMsgTime: '0',
                        senderUid: '',
                        senderUin: '',
                        senderUinStr: '',
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

    // NT requires the trailing at-all marker via text element flags; the
    // kernel accepts atType=1 inline (already emitted above).
    void atAll;
    void pendingAts;
    return out;
}

/**
 * Convert a NT RawMessage's elements into OB11 segments.
 */
export function ntElementsToSegments(
    elements: RawElement[],
    ctx: { resolveUid: (uid: string) => string | null; selfUid: string },
): OB11Segment[] {
    const out: OB11Segment[] = [];
    for (const el of elements ?? []) {
        const t = Number(el.elementType ?? 0);
        switch (t) {
            case ELEMENT_TYPE.TEXT: {
                const te = (el.textElement ?? {}) as Record<string, unknown>;
                const content = String(te.content ?? '');
                const atType = Number(te.atType ?? 0);
                if (atType > 0) {
                    const atUid = String(te.atNtUid ?? te.atUid ?? te.atTinyId ?? '');
                    const uin = atUid ? ctx.resolveUid(atUid) ?? '' : 'all';
                    out.push({ type: 'at', data: { qq: uin === ctx.selfUid ? 'all' : uin } });
                    const rest = content.replace(/^@\S+\s?/, '');
                    if (rest) out.push({ type: 'text', data: { text: rest } });
                } else if (content) {
                    out.push({ type: 'text', data: { text: content } });
                }
                break;
            }
            case ELEMENT_TYPE.PIC: {
                const pe = (el.picElement ?? {}) as Record<string, unknown>;
                out.push({
                    type: 'image',
                    data: {
                        file: String(pe.fileName ?? pe.md5HexStr ?? ''),
                        url: String(pe.picSubUrl ?? pe.url ?? ''),
                        file_size: Number(pe.fileSize ?? 0),
                    },
                });
                break;
            }
            case ELEMENT_TYPE.PTT: {
                const pe = (el.pttElement ?? {}) as Record<string, unknown>;
                out.push({
                    type: 'record',
                    data: {
                        file: String(pe.fileName ?? ''),
                        url: String(pe.url ?? ''),
                        duration: Number(pe.duration ?? pe.voiceLength ?? 0),
                    },
                });
                break;
            }
            case ELEMENT_TYPE.FACE: {
                const fe = (el.faceElement ?? {}) as Record<string, unknown>;
                out.push({ type: 'face', data: { id: String(fe.faceIndex ?? '0') } });
                break;
            }
            case ELEMENT_TYPE.REPLY: {
                const re = (el.replyElement ?? {}) as Record<string, unknown>;
                out.push({ type: 'reply', data: { seq: String(re.replayMsgSeq ?? '') } });
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
