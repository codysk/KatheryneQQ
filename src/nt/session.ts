/**
 * Session bootstrap after login: session init, service access, message
 * listeners. Only surfaces KatheryneQQ consumes are declared; the session
 * object itself is used as-is (no proxying, no method replacement).
 */
import type { SessionInitConfig, WrapperNodeApi, Peer } from './wrapper.js';
import { SESSION_SERVICE_ACCESSORS } from './wrapper.js';

export interface RawMessage {
    msgId: string;
    msgSeq: string;
    msgRandom: string;
    senderUid?: string;
    senderUin?: string;
    senderNick?: string;
    peerUid?: string;
    peerUin?: string;
    peerName?: string;
    chatType?: number;
    msgTime?: string;
    msgMetaData?: string;
    sendStatus?: number;
    senderMemberGuid?: string;
    elements?: unknown[];
    [k: string]: unknown;
}

export type RawElement = Record<string, unknown>;

export interface SessionServices {
    msg: any;      // NodeIKernelMsgService
    buddy: any;    // NodeIKernelBuddyService
    group: any;    // NodeIKernelGroupService
    profile: any;  // NodeIKernelProfileService
    richMedia: any;
    uix: any;
    msf: any;
    misc: any;
}

export function initSession(
    wrapper: WrapperNodeApi,
    sessionConfig: SessionInitConfig,
): { session: any; services: SessionServices } {
    let session: any;
    let startupSession: { start(): void } | null = null;
    try {
        startupSession = wrapper.NodeIQQNTStartupSessionWrapper.create();
        session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    } catch {
        session = wrapper.NodeIQQNTWrapperSession.create();
    }

    const initResult = new Promise<void>((resolve, reject) => {
        const listener = {
            onOpentelemetryInit: (info: { is_init: boolean }) => {
                if (info.is_init) resolve();
                else reject(new Error('opentelemetry init failed'));
            },
        };
        session.init(sessionConfig, {}, {}, listener);
        if (startupSession) {
            startupSession.start();
        } else {
            try {
                session.startNT(0);
            } catch {
                session.startNT();
            }
        }
        setTimeout(() => reject(new Error('session init timeout')), 30000);
    });

    return { session, ready: initResult, services: null as unknown as SessionServices } as never;
}

/**
 * Grab the services we need from a live session.
 */
export function collectServices(session: any): SessionServices {
    const get = (name: (typeof SESSION_SERVICE_ACCESSORS)[number]): any => {
        try {
            return session[name]();
        } catch {
            return null;
        }
    };
    return {
        msg: get('getMsgService'),
        buddy: get('getBuddyService'),
        group: get('getGroupService'),
        profile: get('getProfileService'),
        richMedia: get('getRichMediaService'),
        uix: get('getUixConvertService'),
        msf: get('getMSFService'),
        misc: get('getNodeMiscService'),
    };
}

export function groupPeer(groupUid: string): Peer {
    return { chatType: 2, peerUid: groupUid };
}

export function c2cPeer(userUid: string): Peer {
    return { chatType: 1, peerUid: userUid };
}
