# 官方 QQ 下载链路分析（含签名）

QQ Linux 官方下载页（`https://im.qq.com/index/#/linux`）的下载不是直接 GET CDN 文件：
未签名的 `qqdl.gtimg.cn` 请求一律返回 **403**。安装器复刻了页面的签名流程。

## 页面流程

1. SPA 加载版本配置：
   `GET https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json`
   （旧版静态页用 `.../rainbow/linuxConfig.js` JSONP，内容相同）
   → `{ Linux: { version, updateDate, x64DownloadUrl{deb,appimage,rpm}, ... } }`
2. 点击下载时，SPA 先调用**同源签名接口**，再把返回的签名 URL 塞进隐藏 iframe
   （`sandbox="allow-downloads"`）触发浏览器下载。

## 签名接口

```
POST https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign
Content-Type: application/json
x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}

{"url":"https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_x86_64_01.AppImage"}
```

响应：

```json
{"retcode":0,"data":{"url":"https://qqdl.gtimg.cn/...AppImage?sign=6304329e...&t=1795341760"}}
```

- 失败（超时 10s / retcode≠0 / 无 data.url）时页面回退使用原始 URL——此时 CDN 返回 403。
- `sign` 为十六进制签名，`t` 为签名时间戳；下载时必须原样带上。

## 实测结论（本机）

| 请求 | 结果 |
|---|---|
| 未签名 URL（任意 Referer/UA/Cookie/代理/边缘 IP） | 403（Lego Server, Return Directly） |
| 调用签名接口后 URL | 200/206，ELF 魔数正确，完整下载 272MB |
| 签名参数缺失或过期 | 403（需重新签名） |

Referer 只在页面语境下有意义；决定性因素是 `sign` 参数。

## 安装器实现

`src/installer/qqfetch.ts`：

1. `resolveQQRelease()` — 解析官方版本元数据（含备用地址）
2. `signQqUrl(url)` — 调用上表签名接口；失败自动回退原始 URL 并打日志
3. `download()` — 下载前先签名，流式写入、进度日志、`>20MB` + ELF 校验
4. `downloadQQ()` — `--appimage-extract` 自解包（无需 FUSE），缓存于
   `KATHERYNE_QQ_DOWNLOAD_DIR`（默认 `~/.local/share/katheryneqq/qq/`）

环境变量覆盖：`KATHERYNE_QQ_DOWNLOAD_URL`（镜像地址，签名失败会回退原地址）、
`KATHERYNE_QQ_DOWNLOAD_DIR`、`KATHERYNE_QQ_CONFIG_URL`。
