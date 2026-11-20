/**
 * Login lifecycle: engine init -> login service -> QR / quick login.
 *
 * KatheryneQQ drives the kernel login service directly. Listeners are plain
 * objects implementing the kernel's expected callbacks; we subscribe only to
 * what we consume, never wrapping or proxying QQ's own instances.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
    PlatformType,
    type LoginInitConfig,
    type LoginListItem,
    type SessionInitConfig,
    type WrapperNodeApi,
    type Peer,
} from './wrapper.js';
import type { LoadedKernel } from './loader.js';
import { resolveAppIdentity } from './loader.js';

export interface LoginEvents {
    onQRCode?: (pngPath: string | null, qrcodeUrl: string) => void;
    onLoginSuccess?: (uin: string, uid: string, nick: string) => void;
    onLoginFailed?: (step: number, errMsg: string) => void;
    onKickedOffLine?: (tipsTitle: string, tipsDesc: string) => void;
    on扫码后被挂起等待确认?: never; // placeholder to keep TS from widening
}

const systemVersion = `${os.type()} ${os.release()}`;
const hostName = os.hostname();

function platformType(): PlatformType {
    return PlatformType.KLINUX;
}

export class LoginFlow {
    private readonly wrapper: WrapperNodeApi;
    private readonly kernel: LoadedKernel;
    private readonly dataPath: string;
    private readonly globalPath: string;
    readonly identity: { appid: string; qua: string };
    readonly fullVersion: string;

    constructor(kernel: LoadedKernel, dataPathOverride?: string) {
        this.kernel = kernel;
        this.wrapper = kernel.wrapper;
        this.fullVersion = kernel.packageInfo.version;
        this.identity = resolveAppIdentity(kernel.packageInfo, kernel.appDir);

        const base = dataPathOverride ?? this.detectDataPath();
        this.dataPath = base;
        this.globalPath = path.join(base, 'global');
        fs.mkdirSync(this.globalPath, { recursive: true });
    }

    private detectDataPath(): string {
        try {
            const util = this.wrapper.NodeQQNTWrapperUtil.get();
            const configured = util.getNTUserDataInfoConfig();
            if (configured) return configured;
        } catch {
            // Util may require engine init first; fall back to the XDG path.
        }
        return path.join(os.homedir(), '.config', 'QQ');
    }

    initEngine(): void {
        const engine = this.wrapper.NodeIQQNTWrapperEngine.get();
        engine.initWithDeskTopConfig(
            {
                base_path_prefix: '',
                platform_type: platformType(),
                app_type: 4,
                app_version: this.fullVersion,
                os_version: systemVersion,
                use_xlog: false,
                qua: this.identity.qua,
                global_path_config: { desktopGlobalPath: this.globalPath },
                thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
            },
            {},
        );
    }

    private loginServiceInstance: ReturnType<WrapperNodeApi['NodeIKernelLoginService']['get']> | null = null;

    private loginService() {
        // The kernel hands out a fresh NAPI object per .get(); reusing one
        // instance keeps listener registrations bound to the live service.
        if (!this.loginServiceInstance) {
            this.loginServiceInstance = this.wrapper.NodeIKernelLoginService.get();
        }
        return this.loginServiceInstance;
    }

    initLoginConfig(): void {
        const cfg: LoginInitConfig = {
            machineId: '',
            appid: this.identity.appid,
            platVer: systemVersion,
            commonPath: this.globalPath,
            clientVer: this.fullVersion,
            hostName,
            externalVersion: false,
        };
        this.loginService().initConfig(cfg);
    }

    async listLogins(): Promise<LoginListItem[]> {
        const res = await this.loginService().getLoginList();
        return res.LocalLoginInfoList ?? [];
    }

    /**
     * Quick login with an account that has local login info.
     * Resolves with uin on success; rejects with errMsg otherwise.
     */
    async quickLogin(uin: string): Promise<{ uin: string; uid: string; nick: string }> {
        const svc = this.loginService();
        const list = await this.listLogins();
        const item = list.find((x) => x.uin === uin);
        const resolved = item?.uin ?? uin;

        const outcome = await new Promise<{ uin: string; uid: string; nick: string }>((resolve, reject) => {
            let settled = false;
            const listener = {
                onLoginSuccess: (userid: string, uid: string, nick: string) => {
                    if (settled) return;
                    settled = true;
                    resolve({ uin: userid, uid, nick: nick ?? userid });
                },
                onLoginFailed: (step: number, errMsg: string) => {
                    if (settled) return;
                    settled = true;
                    reject(new Error(`login failed step=${step}: ${errMsg}`));
                },
                onLoginActive: (..._a: unknown[]) => undefined,
            };
            svc.addKernelLoginListener(listener);
            void svc.quickLoginWithUin(resolved).then((r) => {
                // Some kernel builds resolve the promise with an error payload
                // without ever firing the failed listener.
                if (!settled && r && r.result !== '0' && r.loginErrorInfo?.errMsg) {
                    settled = true;
                    reject(new Error(`login failed: ${r.loginErrorInfo.errMsg}`));
                }
            }, (e: unknown) => {
                if (!settled) {
                    settled = true;
                    reject(e instanceof Error ? e : new Error(String(e)));
                }
            });
        });

        return outcome;
    }

    buildSessionConfig(selfUin: string, selfUid: string): SessionInitConfig {
        const guidRaw = this.loginService().getMachineGuid();
        const guid = guidRaw.includes('-')
            ? guidRaw
            : guidRaw.slice(0, 8) + '-' + guidRaw.slice(8, 12) + '-' + guidRaw.slice(12, 16) + '-' + guidRaw.slice(16, 20) + '-' + guidRaw.slice(20);
        const downloadPath = path.join(this.dataPath, 'katheryne', 'temp');
        fs.mkdirSync(downloadPath, { recursive: true });

        return {
            selfUin,
            selfUid,
            desktopPathConfig: { account_path: this.dataPath },
            clientVer: this.fullVersion,
            a2: '',
            d2: '',
            d2Key: '',
            machineId: '',
            platform: PlatformType.KLINUX,
            platVer: systemVersion,
            appid: this.identity.appid,
            rdeliveryConfig: {
                appKey: '',
                systemId: 0,
                appId: '',
                logicEnvironment: '',
                platform: PlatformType.KLINUX,
                language: '',
                sdkVersion: '',
                userId: '',
                appVersion: '',
                osVersion: '',
                bundleId: '',
                serverUrl: '',
                fixedAfterHitKeys: [''],
            },
            defaultFileDownloadPath: downloadPath,
            deviceInfo: {
                guid,
                buildVer: this.fullVersion,
                localId: 2052,
                devName: hostName,
                devType: systemVersion,
                vendorName: '',
                osVer: systemVersion,
                vendorOsName: systemVersion,
                setMute: false,
            } as SessionInitConfig['deviceInfo'],
            deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
        };
    }
}

export { systemVersion, hostName };
export type { Peer };
