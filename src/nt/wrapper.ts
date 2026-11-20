/**
 * NT kernel wrapper types — minimal surface KatheryneQQ relies on.
 *
 * These mirror the NAPI classes exported by QQ's wrapper.node. The runtime
 * objects are native and opaque; TypeScript only needs the call shapes.
 */

export enum PlatformType {
    KWINDOWS = 1,
    KMAC = 2,
    KLINUX = 3,
}

export enum VendorType {
    KNOSETONIOS = 1,
}

export interface DesktopGlobalPathConfig {
    desktopGlobalPath: string;
}

export interface ThumbConfig {
    maxSide: number;
    minSide: number;
    longLimit: number;
    density: number;
}

export interface DesktopEngineConfig {
    base_path_prefix: string;
    platform_type: PlatformType;
    app_type: number;
    app_version: string;
    os_version: string;
    use_xlog: boolean;
    qua: string;
    global_path_config: DesktopGlobalPathConfig;
    thumb_config: ThumbConfig;
}

export interface LoginInitConfig {
    machineId: string;
    appid: string;
    platVer: string;
    commonPath: string;
    clientVer: string;
    hostName: string;
    externalVersion: boolean;
}

export interface LoginListItem {
    uin: string;
    uid: string;
    nickName: string;
    faceUrl: string;
    facePath: string;
    loginType: number;
    isQuickLogin: boolean;
    isAutoLogin: boolean;
}

export interface LoginErrorInfo {
    step: number;
    errMsg: string;
    proofWaterUrl: string;
    newDevicePullQrCodeSig: string;
    jumpUrl: string;
    jumpWord: string;
    tipsTitle: string;
    tipsContent: string;
}

export interface QuickLoginResult {
    result: string;
    loginErrorInfo: LoginErrorInfo;
}

export interface DeviceInfo {
    guid: string;
    buildVer: string;
    localId: number;
    devName: string;
    devType: string;
    vendorName: string;
    osVer: string;
    vendorOsName: string;
    setMute: boolean;
    vendorType: VendorType;
}

export interface RDeliveryConfig {
    appKey: string;
    systemId: number;
    appId: string;
    logicEnvironment: string;
    platform: PlatformType;
    language: string;
    sdkVersion: string;
    userId: string;
    appVersion: string;
    osVersion: string;
    bundleId: string;
    serverUrl: string;
    fixedAfterHitKeys: string[];
}

export interface SessionInitConfig {
    selfUin: string;
    selfUid: string;
    desktopPathConfig: { account_path: string };
    clientVer: string;
    a2: string;
    d2: string;
    d2Key: string;
    machineId: string;
    platform: PlatformType;
    platVer: string;
    appid: string;
    rdeliveryConfig: RDeliveryConfig;
    defaultFileDownloadPath: string;
    deviceInfo: DeviceInfo;
    deviceConfig: string;
}

export type Peer = {
    chatType: number;
    peerUid: string;
    guildId?: string;
};

export interface GeneralCallResult {
    result: number;
    errMsg: string;
}

export interface WrapperNodeApi {
    NodeIQQNTWrapperEngine: {
        get(): {
            initWithDeskTopConfig(config: DesktopEngineConfig, globalAdapter: unknown): void;
        };
    };
    NodeIKernelLoginService: {
        get(): {
            connect(): boolean;
            addKernelLoginListener(listener: unknown): number;
            initConfig(config: LoginInitConfig): void;
            getLoginList(): Promise<{ result: number; LocalLoginInfoList: LoginListItem[] }>;
            quickLoginWithUin(uin: string): Promise<QuickLoginResult>;
            getMachineGuid(): string;
            getQRCodePicture(): boolean;
            startPolling(): void;
            abortPolling(): void;
            cancel(): void;
        };
    };
    NodeIQQNTWrapperSession: {
        getNTWrapperSession(name: string): unknown;
        create(): unknown;
    };
    NodeIQQNTStartupSessionWrapper: {
        create(): { start(): void };
    };
    NodeQQNTWrapperUtil: {
        get(): {
            getNTUserDataInfoConfig(): string;
            getNTUserDataPath?(): string;
        };
    };
    NodeIO3MiscService: {
        get(): Record<string, (...args: never[]) => unknown>;
    };
    [className: string]: unknown;
}

export const SESSION_SERVICE_ACCESSORS = [
    'getMsgService',
    'getBuddyService',
    'getGroupService',
    'getProfileService',
    'getRichMediaService',
    'getUixConvertService',
    'getMSFService',
    'getNodeMiscService',
    'getTipOffService',
    'getCollectionService',
    'getFileAssistantService',
    'getOnlineStatusService',
] as const;
