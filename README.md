# KatheryneQQ

OneBot v11 机器人框架，面向 **QQNT Linux**（3.2.X），通过 NT 内核 API（wrapper.node）驱动，无需协议实现、无需 patch QQ 二进制。

> ⚠️ 仅供学习与研究。使用第三方框架操作账号存在风险，请自行评估并遵守《QQ 用户协议》。KatheryneQQ 与腾讯/QQ 无隶属关系。

## 原理

QQNT Linux 版的 Electron 主进程从 `resources/app/package.json` 的 `main` 字段启动（该文件为明文，位于加密 `application.asar` 之外）。KatheryneQQ 利用这一点：

1. **不改 asar、不改二进制**。安装器只把 `main` 改为 `./katheryne/boot.js`，并复制运行时文件。
2. QQ 启动时直接执行 KatheryneQQ 的 `boot.js` —— 此刻我们就在 QQ 自己的 Electron（node 24 / electron 40）里。
3. `process.dlopen` 加载 QQ 自带的 `wrapper.node`（NT 内核 NAPI 绑定）与 `major.node`，通过官方内核 API 完成引擎初始化 → 登录 → 会话 → 收发消息。
4. OneBot v11 的 WS/HTTP 服务在进程内运行，与内核事件直连。

与 NapCat / LiteLoader 的差异（降低风控特征）：
- 不 hook `process.dlopen`、不代理/包装 QQ 自己创建的 session；
- 不解密、不替换 `application.asar`，也不修改 QQ 的 JS bundle；
- 无 renderer/preload 注入，QQ 的渲染进程不启动（headless 直接驱动内核）；
- 使用的全部是 QQ 原生二进制与原生模块，行为面接近官方客户端。

## 使用

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
npm run build
node dist/installer/install.js /path/to/QQRoot
```

### 3. 登录

KatheryneQQ 复用 QQ 已有的本地登录记录（首次需先运行官方 QQ 登录一次）：

```bash
KATHERYNE_CONFIG=./config.json /path/to/QQRoot/qq --no-sandbox --headless
```

`config.json`：

```json
{
  "quick_login_uin": "10000",
  "http":  { "enabled": true, "host": "127.0.0.1", "port": 5700 },
  "ws":    { "enabled": true, "host": "127.0.0.1", "port": 6700, "access_token": "" },
  "reverseWs": { "enabled": false, "urls": ["ws://127.0.0.1:8080/"] }
}
```

### 4. OneBot v11

- WebSocket 服务端：`ws://127.0.0.1:6700`（支持 access_token）
- 反向 WebSocket 客户端：配置 `reverseWs.urls`
- HTTP 服务端：`http://127.0.0.1:5700/send_private_msg?user_id=...`
- 事件上报（HTTP POST）：配置 `http.event_post_url`

响应 envelope 遵循 OB11 规范：`{ status, retcode, data, message?, echo }`；retcode：0 成功 / 1400 参数错误 / 1403 未授权 / 1404 动作不支持 / 1500 内部错误。

标准动作（32 个）：`send_private_msg`、`send_group_msg`、`send_msg`、`delete_msg`、`get_msg`、`get_msg_history`、`mark_msg_as_read`、`get_login_info`、`get_friend_list`、`get_stranger_info`、`send_like`、`get_group_list`、`get_group_info`、`get_group_info_simple`、`get_group_member_list`、`get_group_member_info`、`set_group_ban`、`set_group_whole_ban`、`set_group_kick`、`set_group_leave`、`set_group_card`、`set_group_name`、`set_group_admin`、`set_group_avatar`、`set_friend_add_request`、`set_group_add_request`、`can_send_image`、`can_send_record`、`get_status`、`get_version_info`、`get_cookies`、`get_csrf_token`。

go-cqhttp 扩展：`group_poke`、`friend_poke`（主动戳一戳，经 MSF 二进制通道发送 OIDB 0xED3_1；需原生插件 `katheryne_memsync.node` 放行内核 cmd 白名单，原理见 `docs/poke.md`）。

消息段：`text`、`at`、`face`、`image`、`record`、`reply`、`json`。

事件：`message`（私聊/群聊/自发自）、`notice`（群增减员/禁言/踢出/离线）、`request`（好友/加群请求）、`meta_event`（lifecycle/heartbeat）。

### 5. Web 控制台

启动后打开 `http://127.0.0.1:6099/console`：

- 实时状态（运行阶段/QQ 版本/AppID）
- 扫码登录（二维码直接在页面显示）/ 快速登录
- 事件流（最近 500 条，分类着色）
- 动作调试器（下拉选择 32 个动作 + JSON 参数执行）
- 运行日志

```json
{
  "console": { "enabled": true, "host": "0.0.0.0", "port": 6099, "username": "", "password": "" }
}
```

### 卸载

```bash
node /path/to/QQRoot/resources/app/katheryne/uninstall.js /path/to/QQRoot
```

## 目录结构

```
src/
  boot.ts               # 入口：QQ main 指向这里
  core/runtime.ts       # 运行时编排：内核→登录→会话→OneBot
  nt/loader.ts          # wrapper.node/major.node 加载与 appid 解析
  nt/login.ts           # 引擎初始化 + 快速登录流程
  nt/session.ts         # 会话初始化与服务获取
  nt/wrapper.ts         # 内核 NAPI 类型定义
  onebot/
    actions/            # OneBot v11 动作实现
    events/bus.ts       # 事件总线
    message/segments.ts # 消息段 <-> NT 元素转换
    network/index.ts    # WS/HTTP/反向WS 传输层（零依赖）
  installer/            # 安装/卸载器
```

## License

MIT
