/**
 * Decoder for QQNT 0x2dc_0x10 (msgType=732, subType=16, serviceType=35)
 * group emoji reaction push payloads delivered via
 * NodeIKernelMsgListener.onSysMsgNotification.
 *
 * Verified against live QQNT 3.2.35 samples (add & cancel, QQ faces &
 * Unicode emojis, both group_code == group_uin and transformed group_uin).
 */

export interface GroupEmojiLikePush {
    groupCode: string;
    msgSeq: string;
    eventSeq: string;
    msgTime: number;
    emojiId: string;
    emojiType: number;
    count: number;
    operatorUid: string;
    isAdd: boolean;
}

interface PbField {
    field: number;
    wireType: number;
    varint?: bigint;
    bytes?: Buffer;
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } | null {
    let value = 0n;
    let shift = 0n;
    let i = offset;
    while (i < buf.length) {
        const b = buf[i++];
        value |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value, next: i };
        shift += 7n;
        if (shift > 70n) return null;
    }
    return null;
}

function decodePb(buf: Buffer): PbField[] | null {
    const out: PbField[] = [];
    let i = 0;
    while (i < buf.length) {
        const tag = readVarint(buf, i);
        if (!tag) return null;
        i = tag.next;
        const field = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (field <= 0) return null;
        if (wireType === 0) {
            const v = readVarint(buf, i);
            if (!v) return null;
            i = v.next;
            out.push({ field, wireType, varint: v.value });
        } else if (wireType === 2) {
            const len = readVarint(buf, i);
            if (!len) return null;
            const n = Number(len.value);
            if (!Number.isSafeInteger(n) || n < 0 || len.next + n > buf.length) return null;
            out.push({ field, wireType, bytes: buf.subarray(len.next, len.next + n) });
            i = len.next + n;
        } else if (wireType === 5) {
            if (i + 4 > buf.length) return null;
            i += 4;
            out.push({ field, wireType });
        } else if (wireType === 1) {
            if (i + 8 > buf.length) return null;
            i += 8;
            out.push({ field, wireType });
        } else {
            return null;
        }
    }
    return out;
}

function firstBytes(fields: PbField[], num: number): Buffer | undefined {
    return fields.find((f) => f.field === num && f.wireType === 2)?.bytes;
}

function firstVarint(fields: PbField[], num: number): bigint | undefined {
    return fields.find((f) => f.field === num && f.wireType === 0)?.varint;
}

/**
 * Parse a raw `onSysMsgNotification` msgBuf (signed int8[] from NAPI or Buffer)
 * for group emoji reaction events (0x2dc_0x10, service_type=35, event_type=4).
 * Returns an empty array for non-reaction 0x2dc_0x10 notifications (e.g. group
 * name changes, gray tips) or malformed buffers.
 */
export function parseGroupEmojiLikeSysMsg(msgBuf: number[] | Uint8Array | Buffer): GroupEmojiLikePush[] {
    if (!msgBuf || msgBuf.length === 0) return [];
    const buf = Buffer.isBuffer(msgBuf)
        ? msgBuf
        : Buffer.from(Array.isArray(msgBuf) ? msgBuf.map((b) => b & 0xff) : msgBuf);

    const outer = decodePb(buf);
    if (!outer) return [];

    // ContentHead (f2): msg_type=732 (0x2dc), sub_type=16 (0x10), msg_time=f6
    const contentHeadRaw = firstBytes(outer, 2);
    let msgTime = 0;
    if (contentHeadRaw) {
        const ch = decodePb(contentHeadRaw);
        if (!ch) return [];
        const msgType = firstVarint(ch, 1);
        const subType = firstVarint(ch, 2);
        if (msgType !== undefined && msgType !== 732n) return [];
        if (subType !== undefined && subType !== 16n) return [];
        msgTime = Number(firstVarint(ch, 6) ?? 0n);
    }

    // MsgBody (f3) -> bytes_msg_content (f2)
    const bodyRaw = firstBytes(outer, 3);
    if (!bodyRaw) return [];
    const body = decodePb(bodyRaw);
    if (!body) return [];
    const content = firstBytes(body, 2);
    // 0x2dc_0x10 framing: [4B group_code BE][1B 0x10][2B pb_len BE][protobuf...]
    if (!content || content.length <= 7 || content[4] !== 0x10) return [];

    const headerGroupCode = content.readUInt32BE(0);
    const pbLen = content.readUInt16BE(5);
    const innerSlice = 7 + pbLen <= content.length && pbLen > 0
        ? content.subarray(7, 7 + pbLen)
        : content.subarray(7);

    const inner = decodePb(innerSlice);
    if (!inner) return [];

    // service_type (f13) == 35 (0x23) for group msg events (emoji reactions)
    if (firstVarint(inner, 13) !== 35n) return [];

    // Always use inner f4 (real group_code), NOT RoutingHead f1 (which carries
    // QQ's legacy transformed group_uin for older 9-digit groups).
    const groupCodeBig = firstVarint(inner, 4);
    const groupCode = groupCodeBig && groupCodeBig > 0n
        ? groupCodeBig.toString()
        : (headerGroupCode > 0 ? String(headerGroupCode) : '');
    if (!groupCode) return [];

    // f44 -> f1 -> repeated f1 (event items)
    const f44Raw = firstBytes(inner, 44);
    if (!f44Raw) return [];
    const f44 = decodePb(f44Raw);
    if (!f44) return [];
    const pushRaw = firstBytes(f44, 1);
    if (!pushRaw) return [];
    const pushFields = decodePb(pushRaw);
    if (!pushFields) return [];

    const results: GroupEmojiLikePush[] = [];
    for (const entry of pushFields) {
        if (entry.field !== 1 || entry.wireType !== 2 || !entry.bytes) continue;
        const item = decodePb(entry.bytes);
        if (!item) continue;

        const eventSeq = (firstVarint(item, 1) ?? 0n).toString();
        const targetRaw = firstBytes(item, 2);
        const emojiRaw = firstBytes(item, 3);
        if (!targetRaw || !emojiRaw) continue;

        const target = decodePb(targetRaw);
        const emoji = decodePb(emojiRaw);
        if (!target || !emoji) continue;

        // event_type (f3) == 4 for emoji reactions (HandleMsgEventPush)
        if (firstVarint(target, 3) !== 4n) continue;
        const msgSeq = (firstVarint(target, 1) ?? 0n).toString();
        if (!msgSeq || msgSeq === '0') continue;

        const emojiIdBuf = firstBytes(emoji, 1);
        const operatorUidBuf = firstBytes(emoji, 4);
        if (!emojiIdBuf || !operatorUidBuf) continue;

        const emojiId = emojiIdBuf.toString('utf8');
        const operatorUid = operatorUidBuf.toString('utf8');
        const emojiType = Number(firstVarint(emoji, 2) ?? 1n);
        const count = Number(firstVarint(emoji, 3) ?? 0n);
        const reactionType = Number(firstVarint(emoji, 5) ?? 1n);
        // 1 = add, 2 = remove (verified against live add/cancel samples)
        if (reactionType !== 1 && reactionType !== 2) continue;

        results.push({
            groupCode,
            msgSeq,
            eventSeq,
            msgTime,
            emojiId,
            emojiType,
            count,
            operatorUid,
            isAdd: reactionType === 1,
        });
    }
    return results;
}
