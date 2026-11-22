# 主动 Poke（戳一戳）— QQ Linux 3.2.35-54395

## 结论：可用

- **发送**：`group_poke` / `friend_poke` 已实现，经 `NodeIKernelMSFService.sendMsfRequest`
  二进制 SSO 通道发送 OIDB `0xED3_1`（群聊实测送达）。
- **接收**：notice 事件 `poke` 完整可用（灰条 `jsonGrayTipElement` 解析）。

## 工作原理（3.2.35 特有）

三个必要条件，缺一包就被内核静默丢弃：

1. **MSF 二进制通道**。`session.getMSFService().sendMsfRequest(seq, cmd, data, options)`
   是内核真正的 SSO 发包接口。注意：
   - `data` 必须是**真 TypedArray**（`new Uint8Array(buf)`）。绑定用
     `napi_get_typedarray_info` 读取；Node `Buffer` 是 `typeof "object"`，会被静默忽略
     （同时 NAPI 绑定对其它类型也不报错，只返回 `undefined`）。
   - 该绑定是 **fire-and-forget**：调用立刻返回 `undefined`，请求在 MSF 队列里异步发出。
     与 NapCat 对 poke 的 fire-and-forget 行为一致。
   - `options.account` 必须是**自己 uin**（MSF 请求账户 = 发包者上下文；传群号/对端
     uin 会被 MSF 丢弃、服务器无感知），`accountType: 1`，`reqTargetAccountType: 1`。

2. **cmd 白名单**。`sendMsfRequest` 的 C++ 实现（wrapper.node `0x3538555`）会先查两张
   静态 cmd 表（RELRO 段，见下），不在表内直接
   `sendMsfRequest cmd:{} need add to cmd list call ulinzeng.` 丢弃。
   `OidbSvcTrpcTcp.0xED3_1` 不在表内 → 需要进程内 patch：
   - `src/native/memsync.c`（编译为 `native/katheryne_memsync.node`）通过
     `dl_iterate_phdr` 定位 wrapper.node load bias，`mprotect` 白名单页可写，
     把表 1 第 0 项（`QQClubComm.getNewFlag`，QQ 会员功能轮询，本进程用不到）
     重指向 `OidbSvcTrpcTcp.0xED3_1`。
   - 表 1 形如 `{char* ptr, size_t len} × 25 @ RVA 0x8e81538`（跨版本可能变化，
     需按 `sendMsfRequest cmd:{} need add to cmd list` 字符串交叉引用重新定位）。
   - 原始项可通过 addon 的 `restore()` 恢复。

3. **OIDB 包格式**（与 NapCat packet 后端一致）：
   - `OidbSvcTrpcTcpBase`：`command(1)=0xED3`、`subCommand(2)=1`、
     `body(4)`、`isReserved(12)=1`；
   - `SendPoke` body：`uin(1)=目标`、`groupUin(2)` 或 `friendUin(5)`、
     `ext(6)=0`；
   - cmd 字符串：`OidbSvcTrpcTcp.0xED3_1`。

## 已排除的路径（逆向结论，供参考）

- **NapCat MoeHoo hook**：`InitHook(sendHex, recvHex, cb, o3)` 内部把 hex
  `strtoull` 后**右移 1 位**（调用方需传 `realRva << 1`），funchook 在
  `bias + rva` 装 trampoline，hook 本身只监听不改包。3.2.34 的锚点
  （`0x65f92d0`）在 3.2.35 同字节同偏移存在，trampoline 写入验证成功，但
  **旧 MSFSDK 发送栈在 3.2.35 已停用**（`MSF::MSFSDK::sendPacket` 的初始化 flag
  `0x917dd58` 运行时为 0，函数永不执行）——这也是 NapCat `packet.json` 止步
  3.2.34 的原因。
- **`sendSsoCmdReqByContend`**：第二参被 NAPI 强转 UTF-8 字符串（string/object/
  number 三分支，见绑定 `0x39e4440` + 助手 `0x6ebe4d0`），二进制必损坏；且
  3.2.35 上对原始 OIDB 一律返回 `result:145 请求包解析失败`。
- **NT face 元素**（`faceType:5 Poke` + `pokeType:1`）：`sendMsg` 返回 `result:0`
  但内核降级为普通表情消息。真实 poke 是服务端渲染的灰条，客户端元素无法构造。

## 依赖与构建

- 构建：`npm run build`（内含 `scripts/build-native.sh`，需 gcc + Node 头文件；
  产物 `dist/native/katheryne_memsync.node`，安装器随 dist 一起部署）。
- 运行时：登录后无需额外配置，第一次 poke 时自动 patch 白名单并发送。
