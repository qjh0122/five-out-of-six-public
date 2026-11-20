# 六选五 PWA 性能审查报告（2026-11-20）

- **日期**：2026-11-20
- **审查人**：技术架构（柯桥良）
- **范围**：`pwa/` 前端 + `sw.js` 缓存 + `roomStore.js`/`server` 同步链路；只读诊断，**未改生产代码**
- **基线**：工作区 HEAD `9edb104`（`?v=20261119b`，SW `weile-liuxuanwu-v152`）
- **方法**：静态阅读 + 一次性真浏览器 CDP 测量；测量脚本 `scripts/probe-perf-once.js`（新增，非生产），原始数值 `tmp/perf-measure-2026-11-20.json`
- **严重度口径**：P0=阻断/线上事故级；P1=明显可感知、应在本轮排期；P2=优化/加固

> **口径声明**：下文「已实测」只指本轮 `node scripts/probe-perf-once.js` 的输出；「静态推断」指从源码/渲染模型推导、未经真机验证。两者严格分开，不互相替代。

---

## 1. 实测环境与测量口径（已实测）

| 项 | 值 |
|---|---|
| 浏览器 | Edge（Windows），`--headless=new --disable-gpu`，390×844 @2x |
| 服务 | 本地 Node 静态服务（**无 gzip、无网关延迟**），`?mode=local` 免登录态 |
| 轮次 | ① 首次访问 ② 同 profile 温启动（SW 已接管）③ CPU 4× 降速 + SW 温启动 |
| 局限 | headless 的 rAF 不呈真机帧率；网络时间不能代表生产网关；**CDP TaskDuration 跨导航出现负值，已弃用该字段** |

### 首屏与资源实测数据

| 指标 | 首次访问 | SW 温启动 | CPU 4× 温启动 |
|---|---:|---:|---:|
| FCP | **96 ms** | **52 ms** | **132 ms** |
| DCL（defer 脚本执行完） | 86 ms | 73 ms | 178 ms |
| load | 211 ms | 190 ms | 311 ms |
| 资源请求数 | 47 | 46 | 46 |
| 传输总量（本地未压缩） | **1,880,185 B** | **92,586 B** | 92,586 B |
| 其中脚本传输 | 799,614 B（31 个） | 0 B（31 个全命中缓存） | 0 B |
| 主线程 longtask（>50 ms） | 0 | 0 | 0 |
| `#btn-create` 点击处理器绑定时刻 | 81.4 ms | 69.3 ms | **156.9 ms** |
| DOM 节点数（首页） | 700 | 696 | 696 |
| JS 异常 | 0 | 0 | 0 |
| 规则弹窗开合 rAF 间隔（中位 / p95） | 16.7 / 16.7 ms | 16.7 / 16.7 ms | 16.7 / 16.7 ms |

**关键观察（已实测）**：
1. SW cache-first 生效：温启动脚本/样式/音频/图片传输均为 0，缓存条目 67→102（`tmp/perf-measure-2026-11-20.json` `sw.caches.entries`）；**但温启动仍发出 1 条 92,586 B 的 `/index.html` fetch**，即全部网络流量。
2. 首次访问 1.88 MB 传输中，除首屏脚本外还包含 SW `install` 的 60+ 条预缓存（`pwa/sw.js:96-197, 199-230`）。
3. 本机 4× CPU 降速下 DCL 178 ms、可交互绑定 156.9 ms；这是**本地缓存 + 无网关延迟**的最乐观条件，不代表弱网首访。

**静态体积（已实测，zlib gzip level 6）**：`index.html` 引用的 32 个脚本 + 3 个样式 = **1,373,745 B 原始 / 520,738 B gzip**；`index.html` 自身 92,286 B / 32,289 B gzip。单文件最大：`game.js` 292,124 B → 107,956 B gzip；`style.css` 231,319 B → 80,160 B gzip。

---

## 2. 问题清单

### P1-1 · 首屏同步脚本过多：32 个脚本 + 3 份样式在 DCL 前全部执行

- **证据（静态）**：`pwa/index.html:1326-1376`（32 条 `defer` 脚本）、`:189-191`（3 份 CSS）、`:245-246`（preload）；`pwa/sw.js:139-142` 明确记录「game.js 是同步 IIFE，任何一个模块 404 整页白屏」。
- **证据（已实测）**：首屏引用资源 gzip 520,738 B；4× CPU 温启动 DCL 178 ms、按钮绑定 156.9 ms。
- **影响**：非首屏模块（战绩/回放/结算/成就/座位面板）与启动链路一起解析执行；弱网 + 中低端机上 DCL 会显著劣于本环境的 178 ms。
- **建议**：按「启动必需 / 首次进入房间才需要 / 战绩与后台才需要」三档拆加载。第一批候选：`recordsView.js`(99,709 B)、`settleView.js`(70,596 B)、`seatSheetView.js`(65,736 B)、`achievements.js`(44,391 B) —— 合计约 280 KB 原始。保持 `game.js` 同步 IIFE 与其全局依赖顺序不变，用受控的延迟 `<script>` 注入并按 `?v=` 保持一致。
- **预期收益（估算，需实测验证）**：首屏 JS 体积有望下降约 30–40%，中低端 DCL 相应下降；**拆分边界必须先由主程序验证**（`Ach.accumulate()` 在结算时调用、`recordsView.create()` 在启动时的依赖），不能按文件名猜。
- **风险**：中 —— 全局 IIFE 的加载顺序/竞态；`sw.js` 预缓存清单要同步调整，否则离线时缺模块静默降级。

### P1-2 · 每次打开都全量重抓 `index.html` 做版本自检，温启动 100% 网络流量来自这里

- **证据（已实测）**：三轮 `resources.byType.fetch` 均为 1 条、92,586 B；温启动总传输 92,586 B，脚本传输 0 B。
- **证据（静态）**：`pwa/index.html:1433-1449` 每次执行 `fetch(withSharecode('/index.html'), {cache:'no-store'})` 并读取全文做正则比对；`:1407` 每 90 秒再查一次；`:1408-1409` 切回前台再查一次。
- **影响**：SW 缓存把 35 个资源降到 0 请求，却被这 1 条全量 HTML 请求吃掉全部流量；网关冷启动首字节曾实测 3.18 s（`pwa/sw.js:32-37` 注释），该请求同样受此影响。
- **建议**：把版本探针收敛为极小端点（如 `/version.json` 仅含 `{v}` 或导航响应头 `X-App-Version`），一条 `<1 KB` 请求替代 92 KB HTML；保留 `sessionStorage` 防重复 reload 与 403 兜底。90 秒轮询改为仅在 `visibilitychange` + 长连接重连时检查。
- **预期收益（已实测的上限）**：温启动网络从 92,586 B 降到 <1 KB（约 **99% 下降**）；`no-store` 取消后网关压力同步下降。
- **风险**：低-中 —— 新增端点需与网关 `sharecode` 规则对齐；服务端未就绪前保留原 HTML 比对作为 fallback。

### P1-3 · 等待态无限 `box-shadow` 动画持续触发重绘（静态推断，该状态未实测）

- **证据（静态）**：`pwa/css/style.css:1291` `.st-thinking .opp-avatar { animation: seatWait 2s ... infinite }`，`:1292-1295` 的 `@keyframes seatWait` 在 `box-shadow` 上做 0→4px 扩散；`:1947` `.pulse-dot` `animation: pulse 1.2s infinite`，`:1949-1952` 同样动画 `box-shadow` 到 14px。`pwa/js/game.js:2086` 确认等待提交时会插入 `.pulse-dot`。
- **证据（已实测的边界）**：本轮 rAF 采样只覆盖首页与规则弹窗（均为 16.7 ms / 60 fps），**未覆盖「等待其他玩家提交」状态**，不能用它证明这里没问题。
- **影响**：`box-shadow` 是 paint 属性，不是 transform/opacity 合成属性；等待态越久（对手掉线、别人思考）持续重绘越明显，低端机可能伴随卡顿与耗电。
- **裁决（2026-11-20）**：收益小（零实测 + 视觉改动需美术对齐），**不修**；建议条目已删除，证据与「未覆盖等待态」的边界保留。

### P1-4 · SW cache-first 依赖手工 `?v=` bump，缺少「资源版本一致性」发布门禁

- **证据（静态）**：`pwa/index.html:30,189-191,245-246,1326-1376` 共 37 处 `?v=20261119b`；`pwa/sw.js:342-378` 对同 URL 永久 cache-first；`pwa/sw.js:283-300` 记录了真实的混版本事故（旧 `drawJoker` 不认小王 → 玩家以为是规则没区分大小王）。
- **证据（静态）**：`scripts/check-docs.js:94-106` 只校验「状态卡片版本号 == `index.html` 首个 8 位版本 == `sw.js` 的 CACHE_NAME」，**不校验每个 `<script src>` / `<link href>` 的 `?v=` 是否等于 `app-version`**；也不校验 `pwa/js`、`pwa/css` 有变更时必须 bump。
- **影响**：漏 bump 一次，已访问用户会长期跑旧 JS（cache-first + 同 URL），且现有 CI 不会红；属于「不崩但行为错」的高成本缺陷。
- **建议**：在 `scripts/check-docs.js` 增加两条门禁：① 所有带 `?v=` 的本地资源引用必须等于 `meta[name=app-version]`；② `pwa/js|pwa/css|pwa/index.html` 有改动时，本次提交的 `app-version` 与 SW `CACHE_NAME` 必须变化（可用 `git diff --name-only` 判定）。卡点：发版前 `npm test` / CI，判定者：CI + 主程序，不达标则禁止发布。
- **预期收益**：把「漏 bump → 用户永久旧代码」从人工记忆变成机械门禁。
- **风险**：低 —— 只加检查，不改运行时。

### P2-1 · 常驻 500 ms localStorage 轮询

- **证据（静态）**：`pwa/js/roomStore.js:148-158` 模块初始化即 `setInterval(..., 500)`，无条件 `ST.readJson(LS_TOUCH, null)`；即使本地演示/离线/无房间也在跑。另有 `BroadcastChannel` (`:118-133`) 与 `storage` 事件 (`:135-146`) 两条通知路径。
- **影响**：每秒 2 次存储读取 + JSON 解析，页面常开时持续唤醒主线程；量级小，但属于可消除的固定成本。
- **裁决（2026-11-20）**：收益小（微秒级、不发网络、已有两条事件兜底），**不修**；建议条目已删除，证据保留。

### P2-2 · 战绩/回放列表无虚拟化，`content-visibility` 未使用

- **证据（静态）**：`pwa/js/records.js:63` `LIMIT = 200`、`:372` 保留最近 200 条；`pwa/js/recordsView.js:100-139` 逐行 `createElement` 并为「看回放」逐行绑定 listener；`:1612` 排行榜一次性 `innerHTML` 写入 top50（`:1548` 注释）；CSS 四个文件中 `content-visibility` / `contain:` 均为 0 处。
- **说明**：逐行 listener 随 `innerHTML=''` 一起被丢弃（`:102`），**未发现监听器泄漏**；159 处 `addEventListener` / 0 处 `removeEventListener` 大多在初始化路径，不构成泄漏证据。
- **影响**：200 行 × 约 5 个子节点，低端机一次渲染可能落在 100 ms 量级（**静态推断，未实测战绩页 200 行场景**）。
- **裁决（2026-11-20）**：收益小（200 行实测 0.6 ms，原担忧被证伪），**不修**；建议条目已删除，实测边界保留。

### P2-3 · 登录页两块 520/600 px 大范围 `filter: blur(46px)`

- **证据（静态）**：`pwa/css/style.css:4423-4440`，`pwa/index.html:256-257`；页面首屏即存在，但**非动画**。
- **影响**：静态模糊只付一次栅格化成本，登录页属冷启动路径，低端机首帧可能有额外光栅化；优先级低于 P1。
- **裁决（2026-11-20）**：收益小（一次性栅格化、仅登录首帧），**不修**；建议条目已删除，证据保留。

### P2-4 · `will-change: transform` 常驻在所有 `.card-wrap`

- **证据（静态）**：`pwa/css/style.css:1798-1801`，配合 `.card-wrap` 的 `transition: transform`；一屏 6–8 张牌。
- **影响**：常驻图层提升带来显存占用；本场景牌数少，收益/代价接近平衡，不建议立即大改。
- **裁决（2026-11-20）**：收益小（一屏 6–8 张牌、无内存压力实测、报告原作者不建议改），**不修**；建议条目已删除，证据保留。

---

## 3. 已核查但未列为问题的项（避免误诊）

| 项 | 结论 | 依据 |
|---|---|---|
| SW 陈旧/混版本（当前版本） | **未发现现行错配**：37 处 `?v=20261119b` 与 `meta app-version` 一致，SW `v152` 与台账 `probes.json` 有 `check-docs.js:148-151` 守卫。风险在「漏 bump」的流程，见 P1-4 | `pwa/index.html:10`；`pwa/sw.js:17`；`scripts/check-docs.js:94-106,148-151` |
| 网络请求模式 | 实时同步走 WS（`/ws` 不被 SW 拦截，`sw.js:323-324`）；30 s 协议层 ping（`roomStore.js:420-431`、`hub.js:178,333-352`）；无 HTTP 轮询。唯一轮询是房间存储兜底的 500 ms（P2-1） | `pwa/js/roomStore.js:408-431,495-501`；`server/hub.js:79-115,316-352`；`server/ws.js:69-77` |
| 服务端周期任务 | 10 分钟限流表清理（`.unref()`）、档案异步 flush（`server/profile.js:285-292`），未见可归为 P1 的热路径 | `server/index.js:427-435`；`server/profile.js:285-293` |
| 事件监听器泄漏 | 未发现：逐行 listener 随节点整体替换回收；WS 重连监听器挂在 socket 上随连接释放 | `pwa/js/recordsView.js:102,131-134`；`pwa/js/roomStore.js:564-585` |
| 首屏闪屏/缩放跳变 | 已有专门探针 `probe-first-paint.js`，台账记 v129 起 12/12 绿；本轮未重跑，不把它当本轮实测结论 | `docs/PROBES.md:56,106` |

---

## 4. 未实测项（交主程序/QA 在对应阶段验证）

> 格式：`验证问题 / 预期结论 / 验证方法（一句话） / 由谁在哪个阶段验证`。**本轮未执行，不写结论数值。**

1. **弱网 + 中低端真机的首访 DCL/FCP** / 预期：显著高于本地 4× CPU 的 178 ms，但需量化 / 方法：在真机上用 DevTools 4G 预设 + 4× CPU 跑同一测量脚本 / 由 QA 在发版前验证。
2. **拆分非首屏模块后的实际首屏收益** / 预期：JS gzip 从 520 KB 下降 / 方法：拆前后各跑 `node scripts/probe-perf-once.js` 对拍 / 由主程序在实施阶段验证（2026-11-20 前置门未过，C1 保留待办）。
3. **`/version.json` 探针在网关下的可用性** / 预期：带宽成本 <1 KB 且 403 时可回落 / 方法：线上带 `sharecode` 请求该端点并观察 fallback 分支 / 由主程序在阶段5 验证。

---

## 5. 未做项与可复跑命令

- 未做：线上地址冒烟、真机弱网、服务端并发压测、A/B 回归。
- 未做原因：本轮动作预算与「只诊断不改生产代码」约束；等待态动画与战绩满列表已于 2026-11-20 判「删」，不再属于待实测项。
- 可复跑（均为只读脚本，不写 `pwa/` / `server/`）：

```bash
cd D:/Documents/WorkBuddy/six_out_of_five
node scripts/probe-perf-once.js          # 本轮新增：首屏/资源/longtask/帧间隔，结果写 tmp/
node scripts/probe-motion.js 390 844      # 既有：动效与 reduced-motion
node scripts/probe-first-paint.js         # 既有：首帧防闪
node scripts/run-probes.js records states # 既有：战绩页/四态（串行，勿并行跑探针）
```

---

## 6. 结论与推进顺序

- **P0：0 条**。没有发现线上阻断级性能缺陷。
- **P1：4 条**（首屏脚本体量、温启动 HTML 重抓、等待态重绘动画、SW 版本门禁）；**P2：4 条**。
- **最值得先改的一项**：**P1-2 版本自检改为轻量端点**。理由：改动面最小（一处 fetch + 一个服务端只读端点），收益被本轮实测直接钉死（温启动 92,586 B → <1 KB），且不触碰 IIFE 依赖顺序，风险最低。
- 其次按 P1-4（门禁，防回归）→ P1-3（等待态 paint）→ P1-1（模块拆分，收益最大但风险最高）推进。
