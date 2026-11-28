# Industrial Tactical Terminal — UI Design System

> 提炼自 KatheryneQQ Web Console（参考实现：[src/console/console.html](src/console/console.html)）。
> 本文档可直接复制到其他项目作为前端视觉规范，或作为 AI 辅助重构界面的设计上下文。

---

## 1. 设计哲学与视觉定位

- **美学参考**：终末地（Endfield）/ 莱茵生命（Rhine Lab）系近未来工业设备操作台与科研技术文档风格。
- **双主题策略**：
  - **默认亮色 — 工业白（Industrial White）**：冷灰白工程底色 + 纯白主面板 + 极淡图纸网格，清爽耐看、信息密度高，适合长时间驻留与监控操作。
  - **一键暗色 — 冷碳黑（Carbon Night）**：低饱和冷碳黑夜视终端，强对比、低眩光。
  - **终端高对比原则**：即便在浅色主题下，代码、JSON 检视器与实时日志终端区依然采用深色面板（`#12151c`），与浅色表单区形成鲜明的功能分区。
- **核心气质**：**锐利、克制、工程化、可读性优先**。通过精准的 `1px` 网格线、编号索引、字重层级与极克制的警戒黄锚点建立风格，而不是靠霓虹发光、玻璃拟态或高饱和渐变。

---

## 2. 色彩系统（Design Tokens）

将以下 CSS 变量直接放入项目根样式，通过切换 `html[data-theme="light" | "dark"]` 实现零闪烁主题切换：

```css
/* ==========================================================================
   Default: Industrial White (light)
   ========================================================================== */
:root {
  /* 背景与表面层级 */
  --bg: #e9ecf1;                         /* 画布冷灰底 */
  --bg-grid: rgba(18, 21, 26, 0.055);    /* 28px 工程图纸网格 */
  --surface: #f7f8fa;                    /* 侧边栏 / 面板顶栏 / 次级块 */
  --surface-2: #ffffff;                  /* 主卡片 / 表单控件 */
  --surface-3: #dfe4ec;                  /* 悬停底色 / 计数徽章 */

  /* 线条层级 */
  --line: #cdd3de;                       /* 标准 1px 边框 */
  --line-soft: #dde2eb;                  /* 内部弱分隔线 */
  --line-strong: #14171d;                /* 强调边框 */

  /* 文本层级 */
  --ink: #12151b;                        /* 主正文 / 标题 */
  --ink-2: #4b5464;                      /* 次级说明 / 导航默认态 */
  --ink-3: #838e9f;                      /* 编号 / 时间戳 / 弱辅助文字 */

  /* 品牌主点缀：警戒黄（严格控制在整屏视觉面积 < 5%） */
  --yellow: #f5c400;
  --yellow-hover: #ffcf14;
  --yellow-soft: rgba(245, 196, 0, 0.18);
  --yellow-ink: #12151b;

  /* 语义状态色 */
  --cyan: #0284c7;   --cyan-soft: rgba(2, 132, 199, 0.11);
  --green: #059669;  --green-soft: rgba(5, 150, 105, 0.12);
  --amber: #d97706;  --amber-soft: rgba(217, 119, 6, 0.13);
  --red: #dc2626;    --red-soft: rgba(220, 38, 38, 0.11);

  /* 代码 / 日志暗色终端区（浅色模式下保持深底） */
  --code-bg: #12151c;
  --code-line: #232936;
  --code-ink: #e4e9f2;
  --code-muted: #768196;

  /* 投影、字体与几何尺寸 */
  --shadow: 0 2px 10px rgba(18, 21, 27, 0.06);
  --font-sans: "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, SFMono-Regular, Consolas, monospace;
  --cut: 12px;
}

/* ==========================================================================
   Toggle: Carbon Night (dark)
   ========================================================================== */
html[data-theme="dark"] {
  --bg: #0c0e12;
  --bg-grid: rgba(255, 255, 255, 0.038);
  --surface: #13161d;
  --surface-2: #191d26;
  --surface-3: #222834;

  --line: #2a3140;
  --line-soft: #1f2430;
  --line-strong: #f5c400;

  --ink: #eef2f8;
  --ink-2: #9ba5b8;
  --ink-3: #636e82;

  --yellow: #f5c400;
  --yellow-hover: #ffd11a;
  --yellow-soft: rgba(245, 196, 0, 0.14);
  --yellow-ink: #0c0e12;

  --cyan: #38bdf8;   --cyan-soft: rgba(56, 189, 248, 0.13);
  --green: #34d399;  --green-soft: rgba(52, 211, 153, 0.13);
  --amber: #fbbf24;  --amber-soft: rgba(251, 191, 36, 0.13);
  --red: #f87171;    --red-soft: rgba(248, 113, 113, 0.13);

  --code-bg: #090b0f;
  --code-line: #1f2532;
  --code-ink: #e2e8f2;
  --code-muted: #687388;

  --shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
}
```

### 色彩使用比例建议
- **中性底色与表面**（`--bg` / `--surface` / `--surface-2`）：占 **85%+**
- **中性文字与细线**（`--ink*` / `--line*`）：占 **10%**
- **警戒黄**（`--yellow`）：**< 5%**，仅用于品牌徽标、主按钮（CTA）、当前激活导航条、聚焦内框线、登录舞台关键锚点。
- **语义色**（绿/青/琥珀/红）：仅用于状态指示、事件分类标签、KPI 左侧 `3px` 色条与日志级别高亮。

---

## 3. 标志性几何语言与视觉母题

### 3.1 零圆角 + 45° 切角（Chamfered Corners）
所有容器、按钮、输入框、开关、分段标签均保持 **`border-radius: 0`**（仅状态指示点使用圆形）。
关键面板、品牌标识与主按钮采用 `clip-path` 45° 切角，并用 `::after` 补齐被裁切处的斜边描线：

```css
/* 面板右上 12px 切角 */
.panel {
  position: relative;
  background: var(--surface-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.panel.cut {
  clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, 0 100%);
}
.panel.cut::after {
  content: "";
  position: absolute; top: 0; right: 0; width: var(--cut); height: var(--cut);
  background: linear-gradient(45deg, transparent 47%, var(--line) 48%, var(--line) 54%, transparent 55%);
  pointer-events: none;
}

/* 品牌徽标 / 登录壳体：对角双切角 */
.brand-mark {
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
```

### 3.2 工程底网格（Blueprint Grid）
全页画布叠加 `28px × 28px` 极低透明度网格，强化图纸/仪器面板感而不干扰正文阅读：

```css
body {
  background-color: var(--bg);
  background-image:
    linear-gradient(to right, var(--bg-grid) 1px, transparent 1px),
    linear-gradient(to bottom, var(--bg-grid) 1px, transparent 1px);
  background-size: 28px 28px;
}
```

### 3.3 细斜纹警戒带（Hazard Stripe）
仅以 `3px–4px` 极细饰条出现在侧栏顶部、模态框顶部或登录面板侧栏顶部，切忌大面积铺设：

```css
.hazard-bar {
  height: 4px;
  width: 100%;
  background: repeating-linear-gradient(-45deg, var(--yellow) 0 7px, #12151b 7px 14px);
}
.hazard-bar.thin { height: 3px; }
```

### 3.4 编号化信息架构（Index Coding）
- **一级导航**：采用 `01`、`02`、`03` 两位数等宽编号；选中项左侧加 `inset 3px 0 0 var(--yellow)` 指示条，并将编号块转为黄底黑字反白。
- **页面顶栏路由标识**：`01 // SYS`、`02 // STREAM`、`03 // EXEC`（黄底黑字等宽徽章 + 中文粗体页面标题）。
- **面板顶栏三段式结构**：
  `[反色短代码徽章（如 TELEMETRY / INFO）]` + `[中文主标题]` + `[右对齐等宽大写英文副标]`。
  浅色主题下代码徽章为黑底白字，暗色主题下切换为黄底黑字。

---

## 4. 字体与排版规范

| 用途 | 字体族 | 尺寸 / 行高 | 样式要点 |
| :--- | :--- | :--- | :--- |
| 正文基准 | `--font-sans` | `13.5px / 1.55` | 抗锯齿 `-webkit-font-smoothing: antialiased` |
| 页面主标题 | `--font-sans` | `15px–19px`，`800` | 微紧凑字距 `-0.01em` ~ `0.02em` |
| 面板标题 | `--font-sans` | `13px`，`700` | 搭配等宽编号徽章使用 |
| 表单标签 / 分组头 | `--font-mono` | `10px–11px`，`700` | `text-transform: uppercase; letter-spacing: 0.06em–0.12em` |
| KPI 数值 | `--font-mono` | `22px`，`800` | 强制 `font-variant-numeric: tabular-nums` 防抖动 |
| 代码 / 日志 / ID | `--font-mono` | `12px / 1.55–1.6` | 启用 `tabular-nums`，允许用户自由框选复制 |

> **核心混排原则**：中文说明、标题、按钮文案用无衬线保证易读性；编号、版本号、ID、时间、指标数值、英文代号用等宽字体制造工业仪器感。

---

## 5. 基础组件规范

### 5.1 按钮（Buttons）
- **默认按钮**：`1px solid var(--line)`、`--surface-2` 背景，悬停时边框加深至 `--ink`，按下 `translateY(1px)`。
- **主操作按钮（`.btn.primary`）**：`--yellow` 底色 + `--yellow-ink` 加粗文字（`800`）+ 右上 `8px` 45° 切角。
- **危险按钮（`.btn.danger`）**：红色文字 + 淡红混合边框，悬停亮起 `--red-soft` 底色与实红框。
- **暗色反白按钮（`.btn.dark`）**：`--ink` 底色 + `--surface-2` 文字，用于次级强操作。

### 5.2 表单控件与聚焦态
- 输入框与下拉框：直角 `1px solid var(--line)`、`padding: 7px 10px`。
- **聚焦态**：摒弃模糊外发光，使用锐利双线框：
  ```css
  input:focus, select:focus, textarea:focus {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--yellow);
  }
  ```
- **开关（Switch）**：`34px × 18px` 直角槽 + `12px × 12px` 方形滑块；开启后槽底变 `--yellow`、边框变 `--ink`、滑块变碳黑。
- **分段切换器（Segmented Control）**：共享外框的无间隔等宽按钮组，激活态浅色为黑底白字、暗色为黄底黑字。
- **滑块（Range）**：使用 `accent-color: var(--yellow)`，搭配 `label | slider | 等宽数值` 三列对齐。

### 5.3 状态胶囊（Status Pills）与脉冲点
- 结构：`[7px 圆形状态点] + [等宽状态码]`，采用浅语义底色（`--green-soft` 等）+ `color-mix` 半透明语义边框。
- 仅**在线 / 运行中**态为状态点附加 2 秒扩散光环动画（`pulseRing`），其余静态状态不加动画，避免视觉噪音。

### 5.4 KPI 指标卡
- `4` 列等宽网格（`<=1080px` 降为 `2` 列），直角 `1px` 边框 + 左侧 `3px` 语义竖条（`.accent` 黄 / `.green` 绿 / `.cyan` 青）。
- 纵向三行：`10px` 大写等宽标签 → `22px` 粗体等宽数值 → `11px` 单行省略副信息。

### 5.5 语法高亮检视器与日志盒
- 背景恒定 `--code-bg`，边框 `--code-line`，字体 `12px --font-mono`。
- JSON 配色：
  - Key：`#7dd3fc`（冰青）
  - String：`#86efac`（薄荷绿）
  - Number：`#fde047`（柔黄）
  - Boolean：`#f9a8d4`（粉紫）
  - Null：`#94a3b8`（冷灰）
- 日志级别：`warn` 使用 `#fbbf24`，`error` 使用 `#f87171`，辅助行使用 `--code-muted`。

### 5.6 模态框与通知（Modal & Toast）
- **Modal**：半透明暗遮罩 + `backdrop-filter: blur(4px)`；弹窗主体顶部加 `3px` 细警戒带 + 标准三段式 `.panel-head`。
- **Toast**：固定右上角，反色深底（`--ink`）+ 左侧 `4px` 状态竖条（默认黄 / 成功绿 / 错误红），`150ms` 右侧滑入。

### 5.7 战术取景框（QR / 扫描 / 立绘准星）
- 二维码框四角（或左上/右下对角）使用 `16px × 16px` 的 `2px solid var(--yellow)` L 形定位角标。
- 立绘展台内层叠加极淡细线框与对角 `+` 校准十字标记（`.mascot-reticle`）。

---

## 6. 页面骨架与典型布局模式

### 6.1 主工作区 App Shell
- **左侧导航栏（`236px` 粘性全高）**：
  1. `4px` 警戒带
  2. 品牌徽标区（切角方块 + 等宽主副标）
  3. 分组编号导航列表（可滚动）
  4. 底部当前账号/节点摘要卡片
  5. 页脚（版本号弹窗入口 + 运行环境摘要 + 明暗主题切换按钮）
- **顶部状态条（`54px` 粘性吸顶）**：
  - 半透明背景 `color-mix(in srgb, var(--surface-2) 86%, transparent)` + `backdrop-filter: blur(8px)`
  - 左侧：移动端菜单键 + 黄色路由编号徽章 + 页面主标题
  - 右侧：实时链路状态胶囊 + 系统阶段状态胶囊
- **主内容区**：最大宽度 `1420px`，页面切换带 `160ms` 轻微上浮淡入动画（`translateY(4px) -> 0`）。

### 6.2 独立未认证登录舞台（Login Stage）
未登录时不暴露杂乱的空工作区，而是展示居中 `860px` 双切角登录壳体：
- 左侧 `320px` 恒定深碳黑品牌信息栏（`#12151b` + 警戒带 + `// STATUS` 等终端元信息 + 可选低透明度立绘水印）；
- 右侧主操作区（分段切换多种认证方式 + 独立主题切换按钮）。

### 6.3 典型业务页模板
1. **总览页（Overview）**：顶部实体名片条 + 4 列 KPI 网格 + 中部双栏（端点快拷卡片 / 实时 SVG 信号折线图与分类占比条）。
   - **可选看板娘 / 视觉展台双形态**：未配置立绘时，自动铺满为纯工业遥测蓝图布局（一等公民默认态，无空位）；配置立绘后，平滑切换为 `minmax(0, 1fr) 330px` 右侧粘性战术展台，或全局右下角渐隐背景水印（`mask-image` 左侧羽化避免遮挡正文）。
2. **实时流监控页（Master-Detail）**：左 `1.15fr` 增量事件列表（默认隐藏高频心跳，新条目短暂淡黄闪烁 `evFlash`，选中项左侧 `3px` 黄条）+ 右 `0.95fr` 粘性暗底 JSON 检视器 + 上下文快捷跳转按钮。
3. **接口 / 指令工作台（Catalog + Playground）**：左 `270px` 可搜索分组目录（激活项黄底黑字）+ 右侧参数模板编辑器（`Ctrl+Enter` 执行）+ 响应高亮区 + 本地历史记录。
4. **系统配置页**：Segmented 切换「可视化表单（2 列网格） / JSON 源码」双视图，底部/顶栏提供「保存」与「保存并重启」。

---

## 7. 动效、实时性与响应式规范

### 7.1 动效克制原则
- 所有过渡控制在 `80ms–200ms`，禁止弹跳（bounce）或夸张弹性曲线。
- 页面入场：`160ms ease-out`，`4px` 纵向位移。
- Toast 入场：`150ms ease-out`，`10px` 横向位移。
- 新事件高亮：`700ms ease-out` 从 `--yellow-soft` 淡出至透明。

### 7.2 实时数据渲染铁律
- 实时事件流与终端日志必须采用 **SSE / WebSocket 增量 DOM 插入**（`prepend` / `append` + 上限裁剪），**严禁**定时整块 `innerHTML` 全量替换，否则会打断用户的文本框选复制、滚动位置和选中详情。

### 7.3 响应式断点
- **`<= 1080px`（平板 / 窄桌面）**：双栏分屏（总览双形态、Master-Detail、Playground、配置双列）折叠为单列；KPI 网格从 4 列降为 2 列；粘性右侧栏恢复静态流。
- **`<= 820px`（移动端）**：左侧导航栏切换为 `fixed` 抽屉菜单（默认 `translateX(-100%)`，顶栏显示汉堡按钮 + 半透明遮罩）；登录舞台隐藏左侧深色装饰栏仅保留认证表单。

---

## 8. 迁移避坑清单（Do's & Don'ts）

| 应该做（Do） | 严禁做（Don't） |
| :--- | :--- |
| 坚持 `0px` 圆角，只在关键卡片和主 CTA 使用 45° 切角 | 不要混用 `8px`/`12px` 圆角或大弥散 Soft UI 阴影 |
| 默认使用工业白亮色主题，并提供一键暗色切换 | 不要把深色模式做成纯黑 `#000` 配高饱和荧光绿 |
| 将警戒黄面积控制在 5% 以内作为视线锚点 | 不要大面积铺设黄色卡片背景或黄色大段文字 |
| 代码/日志区在浅色模式下也保持暗底高对比 | 不要使用赛博朋克霓虹发光、扫描线闪烁或紫粉渐变 |
| 中文用无衬线 + 编号/数值/状态用等宽 `tabular-nums` | 不要全文等宽或全文全大写导致中文阅读疲劳 |
| 为可选插画/看板娘设计一等公民的无图工业态 | 不要在没有立绘时留下空白占位框或残缺布局 |

---

## 9. 快速复用提示词（AI Migration Prompt）

在新项目中需要快速落地本风格时，可直接附带本文件并发送以下指令：

> 请严格遵循 `DESIGN.md` 中的「Industrial Tactical Terminal」设计规范实现/重构本项目前端界面：
> 1. 复用文中的双主题 CSS 变量，默认工业白（`data-theme="light"`），支持一键切换冷碳黑（`data-theme="dark"`）；
> 2. 坚持零圆角 + 关键面板/主按钮 45° 切角 + `28px` 极淡工程底网格 + `3px–4px` 克制警戒带；
> 3. 采用 `01 //` 编号导航、三段式面板头、暗底代码/日志区、`tabular-nums` 等宽数值；
> 4. 严禁引入大圆角、霓虹发光阴影、花哨渐变或整块 `innerHTML` 定时重绘。
