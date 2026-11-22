# 主动 Poke（戳一戳）调查结论 — QQ Linux 3.2.35-54395

## 结论

**主动发送 poke 在 3.2.35 上当前没有可用的实现路径。** 接收 poke（notice 事件 `poke`）完整可用。

## 调查过的全部路径

### 1. NapCat MoeHoo hook（`MoeHoo.linux.x64.node`）— 架构性不可用

- `InitHook(sendHex, recvHex, cb, o3)`：hex 经 `strtoull` 解析后 **右移 1 位**，因此调用方必须传
  `realRva << 1` 的十六进制串（packet.json 里存的就是左移过的值）。
- 内部：`getRva2Addr` 用 `dl_iterate_phdr` + `strstr("wrapper.node")` 取模块 load bias，
  funchook 对 `bias + rva` 装 trampoline。send/recv hook 均为**被动监听**（filter 字符串
  `"fucktr.pc.o3..."` 只重写 o3 ecology 的 cmd，不改包内容）。
- 我们定位并验证了 3.2.35 的候选函数（trampoline 字节 `e9 ...` 实测写入）：
  - `0x65f9110` / `0x65f92d0`（3.2.34 NapCat 锚点，签名在本文件中逐字节唯一命中）— **该函数在
    3.2.35 的登录后路径上不再被调用**
  - `MSF::MSFSDK::sendPacket` @ `0x670dd20`（`readelf --dyn-syms` 导出符号）— 函数开头的
    MSF 初始化 flag（`0x917dd58`）运行时为 0，**整条旧 MSFSDK 发送栈在 3.2.35 已停用**。
    这与 NapCat 的 `packet.json` 偏移表止步于 3.2.34-53644 完全一致。

### 2. `sendSsoCmdReqByContend` 原始 OIDB — 服务侧拒绝

- OIDB `0xED3_1`（{uin, groupUin|friendUin, ext=0}，protobuf 字段号 1/2/5/6，NapCat
  `OidbSvcTrpcTcpBase` 外壳 cmd=1/subCmd=2/body=4/isReserved=12 与我们手写编码一致）。
- 二参数 NAPI 绑定（`wrapper.node 0x39e4440`）对第二参只接受
  string→`napi_get_value_string_utf8` / object→`napi_coerce_to_string` / number→int32，
  任何形式最终都是 UTF-8 文本。Buffer、latin1 字符串、hex 字符串全部返回
  `result:145 请求包解析失败`（内核在上线前解析 contend 失败）。

### 3. NT face 元素发送 — 被内核降级

- `sendMsg` 发送 `faceElement{faceType:5(Poke), pokeType:1, faceIndex:0}`（含/不含
  at 元素指向目标）→ `result:0` 接受，但内核把它降级为普通表情消息
  （`[表情0]`），不产生 poke。
- 真实 poke 的内核表示是 **msgType 5 灰条**，服务端下发的渲染 JSON：
  `items=[{type:"qq",uid:发起者},{type:"img",src:"...expression.jpg",jp:"...nudgeMall..."},{txt:"戳了戳"},{...被戳者}]`
  ——这是服务端事件描述，客户端无法通过消息元素反推构造。

### 4. 其它

- NT 内核 API 面（`NodeIKernelMsgService` 等类型定义）没有任何 poke 发送方法；
  NapCat 的 `group_poke/friend_poke` action 也只走 PacketApi（native hook），无内核回退。
- SnowLuma 架构（ptrace 注入 + RTTI 解析 MSFService）同样依赖已被移除的旧发送路径。

## 接收侧（可用）

`poke` notice 事件完整实现于 `src/core/runtime.ts` `emitGrayTip`：解析
`jsonGrayTipElement.jsonStr.items` 中的两个 uid，经 `profile.getUserSimpleInfo` 批量转 uin。

## 如果未来要恢复

1. 等 NapCat 更新支持 3.2.35+ 的 packet 后端（新发送路径的 RVA 进 `packet.json`），
   本仓库 `runtime.ts` 的 `initPacketHook` 已经能直接换 RVA 使用；
2. 或对新发送函数（`wrapper::KernelMsgService::sendSsoCmdReqByContend` 0x2f6a1ef 族尾部
   的 cmd→handler 分发器 `0x2e44b70`）继续逆向，找到新的 wire write 点。
