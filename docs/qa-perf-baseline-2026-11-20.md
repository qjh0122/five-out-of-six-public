# QA 性能基线实测报告 · 六选五 PWA

- **日期**：2026-11-20
- **执行人**：质量监管负责人（qa-lead）
- **性质**：独立复算的实测数据，不改生产代码；结论建立在服务器侧计数 / 真浏览器 DOM / 协议帧数上，不引用被测常量本身做断言
- **配套可复用工具**（已落盘 `tools/qa/`，各自带 4/4 自验、含命中/不命中样本）：
  - `tools/qa/perf-sw-cache.js`（SW 版本串与缓存出口）
  - `tools/qa/perf-ws-sync.js`（房间同步帧数）
  - `tools/qa/perf-large-list.js`（大列表渲染耗时）

---

## 0. 运行环境（每次测量均在此环境）

| 项 | 值 |
|---|---|
| Node | v22.22.2 |
| OS | win32 x64，Windows 10.0.26200 |
| 浏览器 | Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，`--headless=new`，CDP 端口见各探针 |
| 静态/应用服务 | Node 零依赖 `http` 自建静态服务 + `server/index.js` 真服务端（临时 profile/seed，隔离仓库数据） |
| 测量口径 | 判据来自服务器实际收到的请求数 / MutationObserver 后的真实 DOM / WS 原始帧 JSON，均非探针自报数字 |

---

## 1. 可复用探针独立复跑（高风险探测的第一手数值）

### 1.1 采信矩阵（上游结论逐条复算）

本次「上游」= 探针脚本自带的 PASS/FAIL 自报；下表把**脚本自报的事实**与**我本机复跑的原始输出**逐条对照，并给出采信判定。
（技术架构总监的并行静态/动态审查结论尚未回传，其结论待并入时另起一行，此处不代填、不伪造。）

| # | 上游结论（脚本自报） | ① 我实际执行的命令 | ② 本机原始输出摘要 | ③ 采信判定 |
|---|---|---|---|---|
| 1 | 首屏防闪 12 项通过 | `node scripts/probe-first-paint.js 390 844` | `全部通过 / 通过 12 项，失败 0 项`；home=none、auth=flex、缩放 390/390、transform=matrix(0.52) | 采信·复现 |
| 2 | 动效 16 项通过 | `node scripts/probe-motion.js 1280 720` | `通过 16 项，失败 0 项`；令牌 120/200/320ms、焦点环 3px solid、60ms 内有可见按压变化、reduce→1e-05s | 采信·复现 |
| 3 | 牌型特写竖屏 21 项通过 | `node scripts/probe-big-fx.js 390 844` | `通过 21 项，失败 0 项`；12 粒子、fxBurst、组高 163px、无横向溢出 | 采信·复现 |
| 4 | 牌型特写横屏 21 项通过 | `node scripts/probe-big-fx.js 844 390` | `通过 21 项，失败 0 项`；fxBurstTight、组高 109px、scrollLeft=0 | 采信·复现 |
| 5 | 机型矩阵支持协议通过 | `node scripts/probe-devices.js --assert` | `ALL PASS iPhone 5 档 / 安卓 5 档 / 电脑 13 档`；记录 24/24 达标 | 采信·复现（见 1.2 测量注意事项） |

> **事实 / 归因分列**：以上 5 条的「事实」（脚本退出码、项数、DOM 数值）我已逐条复跑；「归因」（例如「无首帧闪烁」「无溢出」是否等于「用户手感达标」）不因脚本通过而自动采信——见第 5 节缺陷/保留项。

### 1.2 数值表

| 探针 | 视口/档 | 结果 | 关键实测值 | 退出码 |
|---|---|---|---|---|
| probe-first-paint | 390×844 | 12/12 | 首帧 home=none / auth=flex；舞台宽 390=视口；matrix(0.52)；boot 后宽不变（无缩放跳变） | 0 |
| probe-motion | 1280×720 | 16/16 | --dur 120/200/320ms；主按钮 378×69、transition=120ms；焦点环 3px solid + offset；60ms 内按压有变化；reduce→1e-05s | 0 |
| probe-big-fx | 390×844 | 21/21 | 粒子 12、动画 0.92s、延迟 0.18s、色 rgb(224,87,43)；组高 163px；横向 41~349/390 | 0 |
| probe-big-fx | 844×390 | 21/21 | fxBurstTight；组高 109px；横向 177~667/844；scrollLeft=0 | 0 |
| probe-devices --assert | 37 档 | ALL PASS | iPhone 5 档 / 安卓 5 档 / 电脑 13 档进桌；牌面≥39CSS px、表情≥44、昵称≥10.4、溢出≤0 全部达标 | 0 |

**测量注意事项（非产品缺陷，如实标注）**：`probe-devices` 机型矩阵里每行 flow 均为 `{"already":true}`——登录态在同一浏览器 profile 跨档复用，真正的「注册→建房→进桌」流程只在首档走过一次；后继各档量的是已进入牌桌的布局，这对**版式/溢出判据有效**，但不能据此声称「37 档都完整走通了进桌链路」。

---

## 2. 三个高风险点的三态结论

### 2.1 ① SW cache-first `?v=` 是否导致更新不生效 → **实测通过**

**方法**：自建静态服务把 `index.html` 的 `app-version` 与所有 `?v=` 在内存里替换成可控版本（不写磁盘），真 Edge + 真 SW。判据是**服务器实际收到的 `/js|css` 请求数**（网络出口），不是 CDP 事件。

| 阶段 | 服务器收到 /js\|css 请求 | 预期 | 判定 |
|---|---|---|---|
| A 冷启动（SW 接管） | 70 | >0 | — |
| B 同版本第 2 次打开 | 35 | 预热 `?v=` key | — |
| B2 同版本第 3 次打开 | **0** | 0（命中缓存） | ✅ |
| C 版本 bump 到 20261120qa | **35** | 全部 miss、重下新码 | ✅ |
| C2 新版本第 2 次打开 | 0 | 已被 C 预热 | — |
| D 新版本第 3 次打开 | **0** | 0（新版本也被缓存） | ✅ |

缓存内核对：带 `?v=` 的条目 70 条，证明后续 0 请求来自 Cache API 命中而非重定向。

**结论**：版本串 bump 会触发全部 35 个脚本/样式全量重下（新代码必达），稳定后同版本 0 网络请求。**更新生效机制成立。**

**附带观察（建议级，非缺陷）**：A 冷启动 70 笔 = 35 笔 PRECACHE 裸路径 + 35 笔带 `?v=` 版本化路径——两者是不同 cache key，首次 `?v=` 请求必然 miss，造成首次打开多下约一倍脚本。这是一次性开销，不是「更新不生效」；如后续优化首屏可考虑让 PRECACHE 直接写带 `?v=` 的 key。

**测量口径教训（写在这里防止下一轮复犯）**：
1. CDP `Network.requestWillBeSent` **不能**当网络出口判据——SW 用 Cache API 应答时同样发这个事件（我第一版据此误判为「异常」）。必须用服务器侧计数。
2. PRECACHE 写裸路径、HTML 引用带 `?v=`，首次版本化请求必然 miss；负向断言（0 请求）必须在预热之后测。

### 2.2 ② 房间状态同步：轮询风暴 / 重复请求 → **实测通过**

**方法**：真 `server/index.js` + 两个真 WS 客户端（真注册、真令牌、真建房入房）。判据是协议帧 JSON。

| 项 | 实测 | 预期 | 判定 |
|---|---|---|---|
| A 候场房静置 8s，A 收到 room 广播帧 | **0** | 0（无状态变化不该有广播） | ✅ |
| A 候场房静置 8s，B 收到 room 广播帧 | **0** | 0 | ✅ |
| B 单次 rename：A/B 各收到 room 帧 | **1 / 1** | 收敛在 1~3 | ✅ |
| B 单次 rename：A 收到 ok 回包 | **1** | 1（无重复请求） | ✅ |
| 心跳形态 | 协议层 PING（pong 不计入 room 帧），30s 级 | 非秒级状态广播 | ✅ |

**结论**：无轮询风暴（闲置零广播）、无重复请求（一次动作一条 ok、广播收敛到 1 条/人）。静态交叉核对：`pwa/js/roomStore.js` 的 ws 实现只有 30s 心跳，无周期性 `getRoom`/`peekRoom` 调用；本地演示模式的 500ms `setInterval` 只读 localStorage 的 touch 键、不发网络请求，不构成网络风暴。

### 2.3 ③ 大列表渲染（recordsView / seatSheetView）是否可测量卡顿 → **实测通过**

**方法**：真浏览器加载真实 `recordsView.js` + `gameUtils.js`，注入合成记录，跑真实 `renderRecordRows`，MutationObserver 后量真实 DOM 行数。每个点预热后跑 5 次取最小值（滤掉 JIT/GC 噪声）。上界取 records.js 规格注释的 `LIMIT=200`。

| 记录数 | 渲染耗时（5 次最小） | 实际 .rp-row | 判据 |
|---|---|---|---|
| 10 | 0 ms | 10 | 行数契约 OK |
| 50 | 0.2 ms | 50 | 行数契约 OK |
| 200 | 0.6 ms | 200 | 行数契约 OK |

- 负向断言：先塞 1 条旧行再 `renderRecordRows([])` → 残留 **0** 行（容器正确清空，无脏行）。
- 手算阈值：每点 < 16.7ms（1 帧）视为无感知卡顿，三点全过。
- 亚毫秒级**不做严格单调断言**（0.7 vs 0.3ms 是 JIT 预热噪声，不是缩放结论）。

**结论**：200 条上限内渲染 0.6ms，无 measurable 卡顿；行数契约与「无残留」负向断言均成立。`seatSheetView` 的表情/短语网格固定 13+8 项、表情飞行节点上限 6，不构成长列表风险。

---

## 3. 边界与异常覆盖

| 编号 | 场景 | 覆盖方式 | 结果 |
|---|---|---|---|
| B1 | SW 版本不一致（HTML 新 / JS 旧） | 版本 bump 全量重下实测 2.1 | 通过 |
| B2 | SW 断网兜底版本校验 | `pwa/test/version-refresh.test.js` 在 `npm test` 自动纳入（目录扫描），6 组行为样本含「旧版缓存必须丢弃」 | 由门禁覆盖（见 §4） |
| B3 | 房间闲置无状态变化 | 静置 8s 零广播实测 2.2 | 通过 |
| B4 | 单次动作是否被放大成多次广播 | rename 1 ok + 1 广播/人实测 2.2 | 通过 |
| B5 | 大列表清空后残留 | renderRecordRows([]) 残留 0 行实测 2.3 | 通过 |
| B6 | 大列表超上限 | records.js `LIMIT=200` 写入即裁剪（`list.length=LIMIT`），探针按 200 上界测 | 静态核对通过 |

---

## 4. 门禁是否在执行链里（硬性核验）

| 门禁 | 是否在链 | 证据 |
|---|---|---|
| `pwa/test/version-refresh.test.js`（防旧 JS） | ✅ 在 `npm test` | `scripts/run-tests.js` 扫描 `pwa/test/`、`server/test/` 全部 `*.test.js`，无需手动挂载 |
| `probe-motion.js`（动效） | ✅ 在 CI | `.github/workflows/test.yml:260` `node scripts/probe-ci.js scripts/probe-motion.js` |
| `probe-devices.js --assert`（机型矩阵） | ⚠️ 有 npm script 未确认入 CI | `package.json:13` `"probe:devices"`；test.yml 未检索到该命令 |
| `probe-first-paint.js`（首屏防闪） | ❌ 不在任何门禁 | package.json 引用数 0，test.yml 未检索到；本轮仅手动复跑 |
| `probe-big-fx.js`（牌型特写） | ❌ 不在任何门禁 | package.json 引用数 0，test.yml 未检索到；本轮仅手动复跑 |
| 本轮三个 `tools/qa/perf-*.js` | ❌ 基线测量工具，非门禁 | 独立运行 `node tools/qa/<name>.js`，未接入 npm test（设计如此：一次性/按需基线，不占 push 反馈时间） |

> 说明：`probes-manual.yml` 夜间跑 17 条 manual 探针（不挂 push）。首屏/特写两探针若在其中属于「有日期的答案」而非「阻断门禁」；本轮不将其计为已设防。

---

## 5. 缺陷清单

| 编号 | 描述 | 复现步骤 | 级别 | 建议处理 |
|---|---|---|---|---|
| D1 | `probe-first-paint` / `probe-big-fx` 两个体验探针未接入任何自动门禁，12+21+21 项通过只代表「本轮手动跑过一次」，不代表后续版本受保护 | 查 `package.json` scripts 与 `.github/workflows/test.yml`，均无这俩探针 | 建议 | 若纳入发版门禁，按 `probe-motion` 的 `probe-ci.js` 方式加一条；否则在探针台账明确标注 manual/oneshot 并由夜间流程覆盖 |
| D2 | 首次打开脚本请求翻倍（35 裸路径 PRECACHE + 35 版本化路径） | 冷启动清空 SW 缓存后打开，服务器侧计数 `/js|css` 为 70 | 建议 | 仅为一次性开销；如优化首屏可让 PRECACHE 写带 `?v=` 的 key（需评估离线兜底 matchSameVersion 的兼容） |

> 未发现阻断 / 严重 / 一般级别的性能缺陷。`{"already":true}` 属测量注意事项（§1.2），不计缺陷。

---

## 6. 验收结论

**有条件通过**（条件见下）。

- 用户诉求是「review 游戏性能」。本轮对 5 个可复用探针做了独立复跑（全绿），对三个高风险点做了自建工具的可复现实测（均通过，且工具带 4/4 自验），结论建立在服务器侧计数 / 真 DOM / 协议帧上。
- 三个高风险点三态结论：**① 实测通过 / ② 实测通过 / ③ 实测通过**；无「异常」、无「无法实测」项。
- **条件**：D1 两条体验探针尚未进入自动门禁——它们的「通过」是本轮一次性快照，不保证后续版本。若本次 review 的目的是「确认当前版本性能」，结论成立；若目的是「保证后续不退化」，需先处理 D1。
- **边界声明**：以上均为 headless 浏览器 + 自建服务的自动化实测。按我的验收纪律须明确写出——**本轮没有人从冷启动地址栏真人试玩走完整链路**（`probe-devices` 跨档复用登录态，见 §1.2），自动化全绿只证明「没崩、指标达标」，不单独证明「手感好用」。手感类主观项建议主理人补一次真人试玩签核。

---

## 附：复现步骤（一键）

```bash
cd D:/Documents/WorkBuddy/six_out_of_five
# 四个可复用探针（均已在本环境跑通）
node scripts/probe-first-paint.js 390 844
node scripts/probe-motion.js 1280 720
node scripts/probe-big-fx.js 390 844
node scripts/probe-big-fx.js 844 390
node scripts/probe-devices.js --assert

# 三个高风险点自建工具（先自验再实测；退出码 0 = 通过）
node tools/qa/perf-sw-cache.js       # ① SW 版本串
node tools/qa/perf-ws-sync.js        # ② 房间同步
node tools/qa/perf-large-list.js     # ③ 大列表渲染
```
