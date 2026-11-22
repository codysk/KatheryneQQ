# KatheryneQQ

OneBot v11 机器人框架，面向 **QQNT Linux**（3.2.X），通过 NT 内核 API（wrapper.node）驱动，无需协议实现、无需 patch QQ 二进制。

[![CI](https://github.com/codysk/KatheryneQQ/actions/workflows/ci.yml/badge.svg)](https://github.com/codysk/KatheryneQQ/actions/workflows/ci.yml)

> ⚠️ 仅供学习与研究。使用第三方框架操作账号存在风险，请自行评估并遵守《QQ 用户协议》。KatheryneQQ 与腾讯/QQ 无隶属关系。

## 特性

- **完整 OneBot v11 动作集**（34 个动作：32 标准 + `group_poke`/`friend_poke` 扩展），本机实测 29 个通过，详见[支持矩阵](#onebot-v11-支持矩阵)
- **主动戳一戳可用**：经 MSF 二进制通道发送 OIDB 0xED3_1（含原生插件放行内核 cmd 白名单），群聊/私聊均实测送达，原理见 [docs/poke.md](docs/poke.md)
- **Web 控制台**：扫码登录、事件流、动作调试器、运行日志
- **无 asar 解密、无二进制 patch**：只改明文 `resources/app/package.json` 的 `main` 字段
- **默认进程足迹极小**：无代码 trampoline；仅 1 个 16KB 原生插件在首次 poke 时加载，改 16 字节 RELRO 表项并恢复页权限（详见 [docs/poke.md](docs/poke.md)）
- **无 renderer 注入**：headless 直接驱动内核，QQ 渲染进程不启动
- **消息段**：text / at / face / image / record / reply / json
- **事件**：message / notice（撤回、戳一戳、群变动）/ request / meta_event

## 兼容性

| 项目 | 说明 |
|---|---|
| 平台 | Linux x86_64（AppImage / deb / rpm） |
| QQ 版本 | **3.2.35-54395**（已验证）。其它 3.2.x 版本消息/群管等核心能力可用；**poke 的白名单 RVA 是版本相关的**，未命中时 poke 会返回明确错误而不是静默失败 |
| Node | ≥ 20（构建用；运行在 QQ 自带 Electron 内） |
| 构建依赖 | gcc + Node 头文件（编译 16KB 原生插件） |

## 原理

QQNT Linux 版的 Electron 主进程从 `resources/app/package.json` 的 `main` 字段启动（该文件为明文，位于加密 `application.asar` 之外）。KatheryneQQ 利用这一点：

1. **不改 asar、不改二进制**。安装器只把 `main` 改为 `./katheryne/boot.js`，并复制运行时文件。
2. QQ 启动时直接执行 KatheryneQQ 的 `boot.js` —— 此刻我们就在 QQ 自己的 Electron（node 24 / electron 40）里。
3. `process.dlopen` 加载 QQ 自带的 `wrapper.node`（NT 内核 NAPI 绑定）与 `major.node`，通过官方内核 API 完成引擎初始化 → 登录 → 会话 → 收发消息。
4. OneBot v11 的 WS/HTTP 服务在进程内运行，与内核事件直连。

与 NapCat / LiteLoader 的差异（降低风控特征）：

- 不 hook `process.dlopen`、不代理/包装 QQ 自己创建的 session；
- 不解密、不替换 `application.asar`，也不修改 QQ 的 JS bundle；
- 无 renderer/preload 注入，QQ 的渲染进程不启动；
- 使用的全部是 QQ 原生二进制与原生模块，行为面接近官方客户端。

## 快速开始（宿主机）

### 1. 准备 QQ

```bash
# AppImage（推荐）
./QQ_3.2.35_x86_64.AppImage --appimage-extract
# 得到 squashfs-root/，即 QQ 根目录

# 或 deb/rpm 安装后的 /opt/QQ
```

### 2. 构建并安装

```bash
npm install
npm run build          # tsc + 编译原生插件 → dist/
node dist/installer/install.js /path/to/QQRoot
```

### 3. 登录

KatheryneQQ 复用 QQ 已有的本地登录记录（首次需先运行官方 QQ 登录一次），或通过控制台扫码：

```bash
KATHERYNE_CONFIG=./config.json /path/to/QQRoot/qq --no-sandbox --headless
```

`config.json`：

```json
{
  "quick_login_uin": "10000",
  "http":  { "enabled": true, "host": "0.0.0.0", "port": 5700 },
  "ws":    { "enabled": true, "host": "0.0.0.0", "port": 6700, "access_token": "" },
  "reverseWs": { "enabled": false, "urls": ["ws://127.0.0.1:8080/"] },
  "console": { "enabled": true, "host": "0.0.0.0", "port": 6099 }
}
```

## Docker

镜像**不包含 QQ 本体**（腾讯二进制不可再分发）。把宿主机解包好的 QQ 根目录挂进容器即可：

```bash
# 1. 宿主机解包 QQ
./QQ_3.2.35_x86_64.AppImage --appimage-extract   # → squashfs-root/

# 2. 构建镜像（网络受限时可换 apt 镜像：
#    --build-arg APT_MIRROR=mirrors.aliyun.com）
docker build -t katheryneqq .

# 3. 运行（首次扫码登录，之后复用 /data 里的登录记录）
docker run -d --name katheryne \
  -p 5700:5700 -p 6700:6700 -p 6099:6099 \
  -v "$PWD/squashfs-root":/qq \
  -v "$PWD/data":/data \
  -v "$HOME/.config/QQ":/data/.config/QQ \
  katheryneqq
```

- `/qq`：解包后的 QQ 根目录（可写，安装器要改 `package.json` 并复制运行时）
- `/data`：`config.json`、QQ 登录记录（`HOME=/data`）、日志
- 打开 `http://<host>:6099/console` 扫码或快速登录
- 预构建镜像（GitHub Actions 发布）：`ghcr.io/codysk/katheryneqq:latest`

## Web 控制台

启动后打开 `http://127.0.0.1:6099/console`：

- 实时状态（运行阶段/QQ 版本/AppID）
- 扫码登录（二维码直接在页面显示）/ 快速登录
- 事件流（最近 500 条，分类着色）
- 动作调试器（下拉选择动作 + JSON 参数执行）
- 运行日志

## OneBot v11 支持矩阵

传输层：WebSocket 服务端（`ws://...:6700`，支持 access_token）、HTTP 服务端（`:5700`）、反向 WebSocket、HTTP POST 事件上报。

响应 envelope 遵循 OB11 规范：`{ status, retcode, data, message?, echo }`；retcode：0 成功 / 1400 参数错误 / 1403 未授权 / 1404 动作不支持 / 1500 内部错误。

### ✅ 已实测通过（29）

`send_private_msg`、`send_group_msg`、`send_msg`、`delete_msg`（真撤回）、`get_msg`、`get_msg_history`、`mark_msg_as_read`、`get_login_info`、`get_friend_list`、`get_stranger_info`、`send_like`、`get_group_list`、`get_group_info`、`get_group_info_simple`、`get_group_member_list`、`get_group_member_info`、`set_group_ban`、`set_group_whole_ban`、`set_group_card`、`set_group_name`、`set_group_avatar`、`can_send_image`、`can_send_record`、`get_version_info`、`get_status`、`get_cookies`、`get_csrf_token`、`group_poke`、`friend_poke`

群管理类均做过可逆恢复验证（禁言→解禁、改名→改回、换头像→恢复原图）；内核返回非 0 时动作会正确报错（错误码透传）。

### ⚠️ 权限受限（1）

| 动作 | 说明 |
|---|---|
| `set_group_admin` | 链路正常；腾讯要求**群主**身份（管理员返回 `120101007 ERR_NO_PERMISSION`） |

### ⏳ 未实测（4）

| 动作 | 原因 |
|---|---|
| `set_group_kick` | 不可逆 |
| `set_group_leave` | 不可逆 |
| `set_friend_add_request` | 需真实待处理好友申请 |
| `set_group_add_request` | 需真实待处理加群申请 |

### 事件

`message`（私聊/群聊/自发）、`notice`（群增减员/禁言/踢出/群撤回/戳一戳）、`request`（好友/加群请求）、`meta_event`（lifecycle/heartbeat）。

### 扩展动作

`group_poke` / `friend_poke`（go-cqhttp 风格参数）：经 MSF 二进制通道发送 OIDB 0xED3_1，依赖原生插件 `katheryne_memsync.node` 在进程内放行内核 cmd 白名单。完整原理与失效路径分析见 [docs/poke.md](docs/poke.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 启动即崩溃（SIGTRAP/SIGSEGV），日志有 `Couldn't mmap icu data file` | QQ 根目录在 DrvFS/9p 等网络盘上（如 WSL 的 `/mnt/d`）。把 QQ 根目录放到本地 ext4（如 `/tmp` 或容器卷）再运行 |
| 进程被 SIGPIPE 杀死（signal 13） | QQ 的 Bugly 崩溃处理会写已关闭的 stdout。用常驻守护进程持有日志 fd（参考 `runtime/qq_daemon.py`），或在 Docker 中运行 |
| 快速登录不可用 | 需要先在宿主机用官方 QQ 登录一次生成记录，并把 `~/.config/QQ` 挂载/复制到运行环境 |
| poke 返回 `cmd whitelist patch not applied` | 当前 QQ 版本与插件内 RVA 不匹配（见 `docs/poke.md` 的跨版本说明） |

## 目录结构

```
src/
  boot.ts               # 入口：QQ main 指向这里
  core/runtime.ts       # 运行时编排：内核→登录→会话→OneBot
  native/memsync.c      # 原生插件：poke cmd 白名单放行（编译为 dist/native/*.node）
  nt/                   # wrapper.node/major.node 加载、登录、会话
  onebot/
    actions/            # OneBot v11 动作实现
    events/bus.ts       # 事件总线
    message/segments.ts # 消息段 <-> NT 元素转换
    network/index.ts    # WS/HTTP/反向WS 传输层（零依赖）
  console/              # Web 控制台
  installer/            # 安装/卸载器
scripts/
  build-native.sh       # 原生插件构建
  docker-entrypoint.sh  # 容器入口
docs/poke.md            # 主动 poke 逆向与实现记录
.github/workflows/      # CI（构建+Docker）与 Release（产物+GHCR）
```

## 开发

```bash
npm install
npm run build        # tsc + 原生插件
npm run build:native # 只编译原生插件
```

- CI（`.github/workflows/ci.yml`）：push/PR 构建 + 校验产物 + Docker 镜像构建
- Release（`.github/workflows/release.yml`）：打 `v*` 标签时发布 `katheryne-<tag>.tar.gz` 运行时包并推送 `ghcr.io/<owner>/katheryneqq` 镜像

## License

MIT
