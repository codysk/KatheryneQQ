# KatheryneQQ

OneBot v11 机器人框架，面向 **QQNT Linux**（3.2.X），通过 NT 内核 API（wrapper.node）驱动，无需协议实现、无需 patch QQ 二进制。

[![CI](https://github.com/codysk/KatheryneQQ/actions/workflows/ci.yml/badge.svg)](https://github.com/codysk/KatheryneQQ/actions/workflows/ci.yml)

> ⚠️ 仅供学习与研究。使用第三方框架操作账号存在风险，请自行评估并遵守《QQ 用户协议》。KatheryneQQ 与腾讯/QQ 无隶属关系。

## 特性

- **完整 OneBot v11 动作集**（44 个动作：38 个 public API 全量 + 6 个扩展），实测 32 个通过，详见[支持矩阵](#onebot-v11-支持矩阵)
- **主动戳一戳可用**：经 MSF 二进制通道发送 OIDB 0xED3_1（含原生插件放行内核 cmd 白名单），群聊/私聊均实测送达，原理见 [docs/poke.md](docs/poke.md)
- **Web 控制台**：扫码登录、事件流、动作调试器、运行日志
- **无 asar 解密、无二进制 patch**：只改明文 `resources/app/package.json` 的 `main` 字段
- **默认进程足迹极小**：无代码 trampoline；仅 1 个 16KB 原生插件在首次 poke 时加载，改 16 字节 RELRO 表项并恢复页权限（详见 [docs/poke.md](docs/poke.md)）
- **无 renderer 注入**：headless 直接驱动内核，QQ 渲染进程不启动
- **消息段**：text / at / face / image / record / reply / json / file；字符串消息按 CQ 码解析（`auto_escape` 可关闭）；图片支持本地路径、`data:` URI、`base64://`、HTTP(S) URL
- **事件**：message / message_sent / notice（撤回、戳一戳、群变动、群文件、群名片、禁言）/ request / meta_event，字段与 NapCat 对齐（`sender.role`、CQ `raw_message`、`message_seq`/`real_seq`、30s 心跳）

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

# 已安装 QQ：指定 QQ 根目录
node dist/installer/install.js /path/to/QQRoot

# 未安装 QQ：安装器会自动从腾讯官方下载对应版本并解包
# （版本元数据来自官方 linuxConfig.js，默认 AppImage，存到 ~/.local/share/katheryneqq/qq/）
node dist/installer/install.js
# 强制重新下载 / 指定镜像源：
node dist/installer/install.js --download
KATHERYNE_QQ_DOWNLOAD_URL=https://your-mirror/QQ.AppImage node dist/installer/install.js
```

下载流程自动复刻官方页面：解析版本元数据 → 调用官方 **UrlSign 签名接口** 签名下载
URL（未签名的 qqdl 请求会被 403）→ 下载 → 校验 → 解包。
相关环境变量：`KATHERYNE_QQ_DOWNLOAD_URL`（直接覆盖安装包地址）、
`KATHERYNE_QQ_DOWNLOAD_DIR`（缓存/解包目录）、`KATHERYNE_QQ_CONFIG_URL`
（版本元数据地址）。签名链路细节见 [docs/download.md](docs/download.md)。
安装完成后会打印 QQ 根目录与启动命令。

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
  "console": { "enabled": true, "host": "0.0.0.0", "port": 6099 },
  "report_self_message": false
}
```

## Docker

镜像**不包含 QQ 本体**（腾讯二进制不可再分发）。两种方式：

**A. 挂载宿主机已解包的 QQ（推荐）**

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

**B. 容器内自动下载（无需挂载 /qq）**

```bash
docker run -d --name katheryne \
  -p 5700:5700 -p 6700:6700 -p 6099:6099 \
  -e KATHERYNE_AUTO_INSTALL=1 \
  -v "$PWD/data":/data \
  katheryneqq
```

启动时检测不到 QQ 会自动从腾讯官方下载并解包到 `/data/.local/share/katheryneqq/qq/`
（首次启动需数分钟；后续复用同一数据卷）。

## Web 控制台

启动后打开 `http://127.0.0.1:6099/console`（NapCat WebUI 风格多页布局，支持浅色/深色主题）：

- **基础信息**：账号头像/昵称、在线状态、运行时长、QQ 版本/AppID、网络服务地址、最近事件
- **QQ 登录**：快速登录（本地账号列表 + 头像）/ 扫码登录（二维码自动刷新）
- **网络配置**：HTTP / WebSocket / 反向 WS / 控制台状态 + `config.json` 在线编辑（保存后重启生效）
- **运行日志**：分级过滤、暂停、自动滚动
- **接口调试**：动作下拉 + JSON 参数 + 结果展示 + 最近 10 条执行历史
- **事件流**：类型过滤、全文搜索、暂停、展开原始 JSON
- **关于**：版本信息与文档链接

配置了 `username`/`password` 时启用 HTTP Basic 认证。控制台 API：`/api/state`、`/api/events`、
`/api/logs`、`/api/actions`、`/api/action`、`/api/logins`、`/api/config`（GET/POST）、
`/api/login/qr|quick|cancel`。

## OneBot v11 支持矩阵

传输层：WebSocket 服务端（`ws://...:6700`，支持 access_token）、HTTP 服务端（`:5700`）、反向 WebSocket、HTTP POST 事件上报。

响应 envelope 遵循 OB11 规范：`{ status, retcode, data, message?, echo }`；retcode：0 成功 / 1400 参数错误 / 1403 未授权 / 1404 动作不支持 / 1500 内部错误。

`message_id` 是 19 位雪花 ID 的**十进制字符串**（JSON number 会丢精度）。若客户端仍把它转成 Number 再传回，`get_msg`/`delete_msg`/`get_msg_history` 会在最近消息中按精度误差窗口尝试还原，仅在唯一匹配时生效；多个候选或无法匹配时返回带提示的 `message not found`。

### ✅ 已实测通过（32）

`send_private_msg`、`send_group_msg`、`send_msg`、`delete_msg`（真撤回）、`get_msg`、`get_msg_history`、`mark_msg_as_read`、`get_login_info`、`get_friend_list`、`get_stranger_info`、`send_like`、`get_group_list`、`get_group_info`、`get_group_info_simple`、`get_group_member_list`、`get_group_member_info`、`set_group_ban`、`set_group_whole_ban`、`set_group_card`、`set_group_name`、`set_group_avatar`、`can_send_image`、`can_send_record`、`get_version_info`、`get_status`、`get_cookies`、`get_csrf_token`、`group_poke`、`friend_poke`

群管理类均做过可逆恢复验证（禁言→解禁、改名→改回、换头像→恢复原图）；内核返回非 0 时动作会正确报错（错误码透传）。

### ◻️ 已实现、受限或未实测（4）

| 动作 | 说明 |
|---|---|
| `get_forward_msg` | 实现（`getMultiMsg` 逐层解析，支持嵌套）；需被转发的消息在本会话事件中出现过；已用普通消息验证内核调用路径。响应同时返回 `messages`（go-cqhttp/NapCat 对象）与 `message`（public.md 节点段），均含 `sender`/`time`/`content` |
| `get_group_honor_info` | 实现（`getGroupHonorList`）；当前 3.2.35 构建返回 `param(group_id) error`，返回空荣誉列表 |
| `get_record` | 实现（本地路径 / CDN URL / 内核下载，`out_format` 可用系统 ffmpeg 转换）；暂缺真实语音样本实测 |
| `set_restart` | 实现（延迟退出进程，依赖守护进程/容器 restart 策略拉起）；会中断会话，未做破坏性实测 |

### ⚠️ 平台不支持（3，返回 1404）

| 动作 | 原因 |
|---|---|
| `set_group_anonymous` | QQNT 内核无匿名群相关 API（NapCat 同样未实现） |
| `set_group_anonymous_ban` | 同上 |
| `set_group_special_title` | QQNT 内核无群头衔设置 API（NapCat 同样未实现） |

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

消息过滤（与 NapCat 对齐）：启动前的历史补发消息不上报；`KMSGTYPENULL` 空消息忽略；机器人自己发送的消息默认不上报，配置 `"report_self_message": true` 后以 `post_type: "message_sent"` 上报（与普通消息共用 `buildOB11Message`，`sub_type` 为 `friend`/`normal`）。

### 事件

`message` / `message_sent`（私聊/群聊）、`notice`（群增减员、踢出、禁言/解禁、群名变更、群名片、群文件、群撤回、戳一戳、好友撤回）、`request`（好友/加群请求）、`meta_event`（`lifecycle` connect、`heartbeat`）。

与 NapCat 对齐的关键字段：

| 事件 | 说明 |
|---|---|
| `message` | `post_type` 为 `message` 或 `message_sent`；`sub_type` 为 `friend`/`normal`；`sender.role` 映射内核 role（owner/admin/member）；`raw_message` 为 CQ 码；`font: 14`；`message_seq`/`real_id` 为本地雪花 ID，`real_seq` 为内核 `msgSeq` |
| `heartbeat` | 上线立即一次，此后每 30s（`heartbeat_interval_ms` 可调），`status: {online, good}` |
| 戳一戳 | `notice_type: "notify"`, `sub_type: "poke"`，`user_id`/`target_id` 为 QQ 号（非 uid），私聊另有 `sender_id`，附 `raw_info` |
| 群禁言 | `group_ban`，`sub_type: ban`/`lift_ban`，`user_id`/`operator_id` 为 QQ 号；全员禁言 `duration: -1` |
| 群名/群名片 | `notify.group_name`（`name_new`）、`group_card`（`card_new`/`card_old`） |
| 群文件 | `group_upload`，`file: {id, name, size, busid}`，同时消息事件内保留 `file` 段 |
| 群请求/通知 | 按内核 `GroupNotifyMsgType` 映射为 `request group`（add/invite）与 `group_increase`/`group_decrease`/`group_admin`；`flag` 为通知 `seq` |

`get_friend_list` / 陌生人 / 群成员查询均返回数字 QQ 号与完整资料：好友列表通过内核 profile 服务把 uid 解析为 uin（批量 `getCoreAndBaseInfo` 在快速登录后为空，已改为 Map 解析 + 逐 uid 回退）；`get_credentials` 返回 public.md 要求的 `{cookies, csrf_token}`。

### 图片 / 表情发送

`image` 段的 `file` 支持以下来源（数组消息与 CQ 字符串均可）：

| 来源 | 示例 |
|---|---|
| 本地绝对路径 | `/tmp/a.png` |
| `file://` | `file:///tmp/a.png` |
| Data URI | `data:image/png;base64,iVBORw0K...` |
| `base64://` | `base64://iVBORw0K...` |
| 裸 base64 | 能嗅探出 PNG/JPEG/GIF/WEBP/BMP 魔数时按图片处理 |
| HTTP(S) URL | `https://example.com/a.png`（下载到临时目录，上限 20MB） |
| 收到的图片 `file` 名 | 若本地已缓存则直接复用；否则尝试索引的 CDN URL（QQ 的 `gchat.qpic.cn/download` 链接通常需要客户端内部下载器，建议改用本地路径/base64） |

CQ 字符串里的 `[CQ:image,file=data:image/png;base64,...]` 也已兼容（逗号不会被当作参数分隔符）。
`face` 段直接发送 QQ 小表情（如 `[CQ:face,id=14]`）；Unicode emoji 走 `text` 段。临时图片文件位于 QQ 下载目录，`clean_cache` 会一并清理。

### 扩展动作

此外还提供 `get_msg_history`、`mark_msg_as_read`、`get_group_info_simple`、`set_group_avatar` 等 go-cqhttp 风格扩展。

`group_poke` / `friend_poke`（go-cqhttp 风格参数）：经 MSF 二进制通道发送 OIDB 0xED3_1，依赖原生插件 `katheryne_memsync.node` 在进程内放行内核 cmd 白名单。完整原理与失效路径分析见 [docs/poke.md](docs/poke.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 启动即崩溃（SIGTRAP/SIGSEGV），日志有 `Couldn't mmap icu data file` | QQ 根目录在 DrvFS/9p 等网络盘上（如 WSL 的 `/mnt/d`）。把 QQ 根目录放到本地 ext4（如 `/tmp` 或容器卷）再运行 |
| 进程被 SIGPIPE 杀死（signal 13） | QQ 的 Bugly 崩溃处理会写已关闭的 stdout。用常驻守护进程持有日志 fd（参考 `runtime/qq_daemon.py`），或在 Docker 中运行 |
| 快速登录不可用 | 需要先在宿主机用官方 QQ 登录一次生成记录，并把 `~/.config/QQ` 挂载/复制到运行环境 |
| 重建容器后提示“登录态已失效” | QQ 的设备指纹包含 `/etc/machine-id`，换镜像/重建容器后该值会变，服务端会作废旧 token。把旧容器的 machine-id 持久化并挂载回去：`docker run ... -v /path/data/machine-id:/etc/machine-id:ro`（首次用 `docker exec <旧容器> cat /etc/machine-id` 取出）。本仓库 qq-proto 部署即采用此方式 |
| poke 返回 `cmd whitelist patch not applied` | 当前 QQ 版本与插件内 RVA 不匹配（见 `docs/poke.md` 的跨版本说明） |
| 自动下载 QQ 返回 403 | 安装器会自动调用官方 UrlSign 接口签名；若签名接口不可用会回退未签名地址并 403，此时可用 `KATHERYNE_QQ_DOWNLOAD_URL` 指向镜像，或手动下载后把解包目录传给安装器 |

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
  installer/            # 安装/卸载器 + 官方 QQ 自动下载（qqfetch.ts）
scripts/
  build-native.sh       # 原生插件构建
  docker-entrypoint.sh  # 容器入口
docs/poke.md            # 主动 poke 逆向与实现记录
docs/download.md        # 官方 QQ 下载签名链路分析
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
