# 音效改造 · 实施日志 #1 · audio-impl-1-fix-log

> 日期：2026-11-20
> 域：音效 / 音频（雷鸣远出方案，寇豆码实施，范可控裁定范围）
> 实施单：`docs/audio-impl-scope-1-2026-11-20.md`
> 参数唯一来源：`docs/audio-diagnosis-2026-11-20.md` §二 / §3.1 / §3.2 / §4.1 / §4.2 / §4.3 / §5.1 / §5.2
> 版本：`20261120e` → `20261120h`（sw `v156` → `v159`；f/v157 为第一次提交，g/v158 为区分度修订提交，h/v159 为 AC6b 守卫补修提交）
> **听感未验收**：本轮只保证结构改造到位，不宣称「好听」。用户真机试听后才算听感通过。

---

## 一、改动了什么（唯一功能改动文件 `pwa/js/sfx.js`）

### 1.1 结构修复（诊断 §七 第 1 步）

| 问题号 | 改法 | 参数来源 |
|---|---|---|
| P0-2 零起音 | 所有 gain 包络（瞬态层、每个材质/情绪 tone）统一 `setValueAtTime(0,t)` → `linearRampToValueAtTime(peak,t+A)` → `exponentialRampToValueAtTime(0.0001,t+A+D)`；A ≥ 2 ms。源码中已无 `setValueAtTime(gain, t)` 写法（连注释都清掉，避免全仓 grep 误报） | §4.1 硬规则 |
| P0-3 VOL 表未落地 | 新增 `VOL` 表逐事件线性 gain：deal 0.45 / select 0.32 / submit 0.50 / win 0.62 / settle 0.42 / error 0.38 / lose 0.50 / countdown_tick 0.30 / countdown_go 0.55 / split_tick 0.28→0.40 / split_timeout 0.42 / peer_submit 0.26 / room_* 0.28 / ready 0.34 / veto 0.40 / spectator 0.20 / emoji_receive 0.26 / emoji_send 0.20 / achievement 0.68 / champion_fanfare 0.70 / hint_guide 0.16（= UI 0.26 再低 4 dB）/ hold_toggle 0.34。mp3 分支不再 unity gain；合成分支同一张表 | §二、§3.1、§3.2、§3.3 |
| P0-5 duck 硬台阶 | BGM_VOL 0.12→**0.14**、DUCK_VOL 0.04→**0.05**；attack **120 ms**（20 ms 分步×6）、hold **900→250 ms**（期间不重置）、release **500 ms**（50 ms 分步×10）。`<audio>.volume` 不是 AudioParam，故用分步 `setTimeout` 逼近包络，**未**引入 `createMediaElementSource` | §5.2 表 |
| P1-6 结果音互斥 | `sfx.js` 内部 `shouldSuppress()` + `recent[]`：终局音 champion_fanfare / lose 2 s 内不重播且出现时停掉在响的 win；win 在终局音后 1.6 s 内及自身 1.6 s 内不再叠；settle 与 win 错开 ≥250 ms；error 抢占 60 ms 内的 select；远场同事件 1 s 内最多 1 次。**未改** `game.js:560` 与 `settleView.js:499-518` | §4.2 |
| P1-8 变体对合成无效 | `VARIANT_PROFILES` 三组「失谐量 / 滤波截止 / 瞬态 seed」=(0.985/0.85/101)、(1.0/1.0/202)、(1.015/1.18/303) 轮转；±3% 音高 / ±5% 音量抖动保留，语义音高不抖 | §4.3 |
| P1-11 远场只有音量 | 远场事件 gain ×0.5 **且** lowpass 压到 ≤1.2 kHz（材质层 BiquadFilter） | §4.2、§1.2 P1-11 |
| P1-12 语义音高被抖动冲掉 | `BRIGHTNESS_CUTOFF` 把 countdown / split_tick 的 1 / 1.02 / 1.04 / 1.06 / 1.08 映射到 2/3/4/4/4 kHz，**不改音高只改滤波亮度**；这些值不参与 ±3% 抖动。split_tick 音量同步按 0.28/0.32/0.36/0.40 递进（§3.2 的 0.28→0.40）。原 1.12/1.03/0.97 白名单保留 | §4.2、§3.2、P1-12 |
| P1-9 连点抢占 | 每事件 **2 个 Audio 元素**轮转（`POOL_SIZE=2`），替代 `a.currentTime=0` 硬掐。关闭开关时把池内所有元素 pause | §4.2 |
| §5.1 总线 | `masterGain 0.9 → DynamicsCompressor(threshold −12 / knee 6 / ratio 4 / attack 3 ms / release 120 ms) → destination`；老浏览器/测试假上下文无 compressor 时降级为 masterGain → destination，不抛错 | §5.1 |

### 1.2 三层合成（诊断 §七 第 2 步）

- **瞬态层**：短噪声 `AudioBufferSourceNode`（seed 决定伪随机序列）→ bandpass（区间取 §3.1/§3.2 的 1.2–3.5 kHz 附近，select/veto 收窄）→ gain 2 ms 起 / 8–12 ms 落。全部 one-shot 都有，零资产。
- **材质层**：1–2 个 oscillator + BiquadFilter lowpass（1.2–4 kHz，远场 1.2 kHz）+ 独立 gain 包络。
- **情绪层**：结果音 2–4 音同材质音程 + 第二段 `linearRamp` 到 sustain + 指数真 release（win 350 ms / settle 400 ms / lose 480 ms / achievement 500 ms / champion 650 ms）。

### 1.3 逐事件音色参数取自诊断哪一节

| 事件 | 实际参数 | 章节 |
|---|---|---|
| deal | 140 Hz thud + 8 ms 带通噪声，**删除下行 sweep 0.82**；A/D = 3/90 ms，vol 0.45 | §3.1 |
| select | 760 Hz sine + 3 ms 噪声，lowpass 3 kHz 砍尖刺；2/55 ms，vol 0.32 | §3.1 |
| submit | 440→495 Hz（sweep 1.125，≤小二度方向）；3/160 ms，vol 0.50 | §3.1 |
| win | 880 Hz + 1.25 / 1.5 三音同材质，6/180 ms，S 0.45，R 350 ms，vol 0.62 | §3.1 |
| settle | 300 Hz 低木/纸夹，4/240 ms，S 0.35，R 400 ms，vol 0.42，lowpass 1.2 kHz | §3.1 |
| error | **560→520 Hz**（sweep 0.929）下行小二度 + 第二振荡器轻微失谐 1.006 + 2 ms 噪声；3/120 ms，vol 0.38 | §3.1 |
| lose | 440→415 Hz（sweep 0.944）下行小二度 + lowpass 1.2 kHz + 两音；8/220 ms，S 0.4，R 480 ms，vol 0.50 | §3.1 |
| countdown_tick / go | 880 Hz 短音 + 亮度递进 2→4 kHz；1046 Hz + 1.5 五度叠音；vol 0.30 / 0.55 | §3.2 |
| split_tick / timeout | 720 Hz + 逐秒提亮（不用锯齿）；timeout 420 Hz 下行三度 + 低通；vol 0.28→0.40 / 0.42 | §3.2 |
| peer_submit / room_enter / room_leave | 与 submit 同材质 / 温和来人 / 轻微下沉，全部远场低通；vol 0.26 / 0.28 / 0.28 | §3.2 |
| ready / veto / spectator | 两音上行小三度（1.189）/ 中低音闷低通 900 Hz / 中性低存在感；vol 0.34 / 0.40 / 0.20 | §3.2 |
| emoji_receive / send | 社交小铃，send 升调 1174 Hz 且降音量；receive 走远场；vol 0.26 / 0.20 | §3.2 |
| achievement / champion_fanfare | 3 音上行 + 空间尾（R 500 ms）/ 4 音号角，sine 主体+triangle 叠音与 win 不同音色（R 650 ms）；vol 0.68 / 0.70 | §3.2 |
| hint_guide / hold_toggle | 复用 select / ready 的 ADSR，音量再低 4 dB / 保留静态条目 | §3.3 |

---

## 二、测试与门禁结果

| 项 | 结果 |
|---|---|
| `npm test`（本次以等价入口 `node scripts/run-tests.js` 实跑） | **179 文件 / 7498 断言 / 0 失败**。基线 178 文件 / 7426 断言 → **断言数不降，净增 72**（h 版新增 5 条 addBody 守卫） |
| `pwa/test/audio.test.js`（原有） | 55 项全绿，含 B2 拒绝路径门禁 11 项；开关语义 / 迁移 / 老 API 别名未回归 |
| `pwa/test/audio-impl-1.test.js`（新增） | **72 项全绿**。8 条静态判据 + 6 条动态判据 + 7 组撞车对与声纹计数 + 5 条 addBody 节点守卫全部做**变异自证**：真源绿、单点改坏红、还原绿；判据自身也有极性自验（不是恒真） |
| `node scripts/check-docs.js`（含 version-gate） | **78 项全绿**，[9] 源码变更 ⇒ app-version / SW CACHE_NAME 双 bump 通过 |
| `node tools/qa/audio-b2-wiring.js`（独立工具，不在 npm test） | B2 段 8 项全绿；**[2]/[3] 段 4 项红**：工具内写死 v155 的 `error=520Hz/gain 0.22` 且假 AudioContext 无 `createBufferSource` / `createBiquadFilter` / `linearRampToValueAtTime`。属过期测试替身，本轮允许文件清单不含 `tools/qa/`，未改，列为后续项（见 §五） |
| 静态自证 | `pwa/js/sfx.js` 全仓 grep：`setValueAtTime(gain, …)` 生产代码 **0 处**；`createBiquadFilter` **3 处**（瞬态带通 1 处 + 材质低通 2 处） |

### 2.1 版本真源同步（bump 全清单）

`pwa/index.html` meta `app-version` 与全部 37 条本地 `?v=`、`pwa/sw.js` `CACHE_NAME`、`pwa/version.json`、`scripts/probes.json` version、`docs/PROBES.md`（`node scripts/probes.js --write` 生成）、`docs/release-progress.md` 当前状态卡、`README.md` 测试计数。

---

## 二·补、区分度修订（制作人转达的硬目标，修订版 §二 / §1.5）

**基调口径**：按修订版 §二，目标是国内主流休闲棋牌小游戏的「明快、脆、短、打点清楚、结果音一响就知道赢了」；不是拟物沉浸、不是克制安静、不是电子科技风。本轮实现用「噪声瞬态 + 主体振荡器 + lowpass + 低频 body + 音程动机」表达，不使用纯振荡器滑音当最终音色。

**声纹计数**：按「频段 / 波形 / 音程 / 节奏」四个硬轴 + cutoff / sweep / 空间 / body 四个辅助轴分类，`Sfx.audioMap()` 实测 **20 种可辨声纹**（现状基线 4，硬目标 ≥8）。判据在 `pwa/test/audio-impl-1.test.js` 里，把所有 spec 塌成 `win` 后计数掉到 1 → 红，还原 → 绿。

### §1.5 七组撞车对静态对照表（每组至少一项硬轴不同）

| 撞车组 | 现状重合点 | 改造后 A | 改造后 B（含后续） | **分离的硬轴** | 参数来源 |
|---|---|---|---|---|---|
| `deal` ↔ `error` | 520 Hz / triangle / 0.22 | deal：140 Hz triangle + 8 ms 粉噪，**无 sweep**，cut 1.2 kHz（SUB 低频「啪」） | error：560→520 Hz 小二度 + ±4 cents 双振荡器 + 180 Hz×25 ms body，cut 1.5 kHz（LOW「阻断」） | **频段**（SUB vs LOW）+ 波形失谐 | §3.1 + §4.4 B |
| `select` ↔ `split_tick` | 760/720 Hz sine、0.08/0.07 s | select：760 Hz 单点击「嘀」，2/55 ms | split_tick：720 Hz **同音双连击（25 ms）** + 逐秒亮度 2→4 kHz | **节奏**（one vs quick） | §3.2 + §1.5 |
| `countdown_go` ↔ `emoji_receive` ↔ `emoji_send` | 全 1046 Hz | countdown_go：1046 Hz **五度长音**（1–1.5，220 ms） | receive：1046 Hz **二音铃簇 1–1.26** + 远场；send：**1318 Hz**（再升小三度）同铃簇、更轻 | **波形**（triangle vs sine）+ **音程**（1.50 vs 1.26）+ **频段**（receive 1046 vs send 1318） | §3.2 + §1.5 |
| `room_enter` ↔ `room_leave` ↔ `peer_submit` ↔ `spectator` | 全「中频 sine、0.18–0.20 s」 | enter：560 Hz **上行两音 1–1.26**；leave：520 Hz **下行两音 1–0.84** | peer_submit：440 Hz triangle 上行盖章（与 submit 同材质）；spectator：**300 Hz 低频**低存在感、cut 900 Hz | **音程方向** + **波形**（sine vs triangle）+ **频段**（LOW vs SUB） | §3.2 + §1.5 |
| `ready` ↔ `hold_toggle` | 逐项相同 | ready：680 Hz 上行小三度保留 | **hold_toggle 条目整体删除**（§3.3 明确实际走 `ready(0.9/1.1)`），`audioMap()` 不再暴露撞车幽灵 | 消除重复条目 | §3.3 + §1.5 |
| `win` ↔ `achievement` ↔ `champion_fanfare` ↔ `lose` | 全「长 triangle + 大跨度 sweep」 | win：880 Hz triangle **1–1.25–1.5**（60 ms）+ 100 Hz body，带窗 6 kHz | achievement：1046 Hz sine **1–1.5–2 铃簇**（45 ms）+ 6 kHz；champion：659 Hz **四音号角 1–1.125–1.25–1.5**（70 ms 慢间隔）+ 120 Hz body；lose：440 Hz **下行小二度 + 1.2 kHz 闷低通** | **频段** + **波形** + **音程**（1.50 / 2.00 / 四音 / 下行）+ **节奏**（60 / 45 / 70 ms） | §3.1 + §3.2 + §4.4 B + §1.5 |
| `error` ↔ `veto` ↔ `split_timeout` ↔ `submit` | 420–520 Hz triangle，只差 sweep / 时长 | error：560→520 小二度 **失谐双音** + 180 Hz body，cut 1.5 kHz | veto：480 Hz **单 sine + 900 Hz 闷低通** + 180 Hz body；split_timeout：420 Hz **下行三度两音（90 ms）**、无 sweep；submit：440→495 Hz **上行** + 140 Hz body、cut 3 kHz | **波形**（triangle+detune vs sine）+ **音程**（小二度 vs 三度 vs 上行）+ **节奏** | §3.1 + §3.2 + §4.4 B + §1.5 |

**§4.4 新增量化参数的落地**：结果音 cutoff 6 kHz、UI/操作 3–3.5 kHz、阻断 1.5 kHz；body 层 140 Hz×30 ms（操作）/ 180 Hz×25 ms（阻断）/ 100–160 Hz×60 ms（结果）；瞬态层仍为 §4.1 的 2–12 ms。ADSR、VOL 表、duck 包络按制作人裁定**未改动**。所有 body / tone 的 gain 同样走 `0 → linearRamp → exponentialRamp`，零起音禁令未被绕过。

**静态自证**：上述 7 组在 `pwa/test/audio-impl-1.test.js` 中逐组跑同一判据，先断言真源分离，再把该组除首个之外的 spec 全改成首个（模拟撞车）断言必须判红，还原后判绿；另加「全部塌成 win 后声纹数 <8」的计数判据。

---

## 二·补2、AC6b 守卫补修（QA 第二轮独立验收 D1'）

**缺口复现**：QA 在隔离 worktree 实测——删掉 `pwa/js/sfx.js` 的 `addBody(c, bus, t, spec.body, peak, nodes);` 调用，或删掉全部 6 处 spec 的 `body: {...}` 参数后，`pwa/test/audio-impl-1.test.js` 仍 67/0 全绿。§4.4 B 的核心新增（100–180 Hz body 层，给打点重量）没有任何行为守卫，属于「删了无感」的假覆盖。

**新增守卫**（`pwa/test/audio-impl-1.test.js` ⑦ 段，5 条断言）：
1. 期望值 `EXPECTED_BODY_HZ` 写死在测试里（submit 140 / win 100 / error 180 / lose 100 / veto 180 / champion_fanfare 120 Hz），**不读被测源的 `spec.body`**——否则删参数时期望值跟着一起消失，判据自我调整而假绿，正是 QA 复现的那类缺口。
2. `bodyOscCount(app, name, hz)` 在 fake AudioContext 的 node 记录里找 `kind==='osc'` 且首个 `frequency` 调用为精确 body 频率的节点，做**节点级行为检查**，不是静态读源码。
3. `bodyGuard(src)` 把 `var a = nextPoolElement(name);` 临时替换为 `var a = null;`，强制 submit / win（有真 mp3）也走 synth 通路，否则这两个事件不会生成 body 节点；该改写对真源与变异源一视同仁。
4. 对照组：deal / select / countdown_tick 无 body，不应出现这些精确频率的 oscillator。
5. 双变异镜像自证 +「源码恰好 6 处 body 参数」前提断言，防止误删锚点造成假绿。

**harness 修正**：`replace()` 加第四参数 `soft`，仅供变异①使用——锚点已被「外部变异生产源」提前消耗时原样返回，避免外部改坏生产源时镜像变异抛错中断、拿不到完整红计数；其余变异点仍走严格模式（锚点漂移当场抛错）。

**外部变异红绿实测**（真改 `pwa/js/sfx.js` 后跑全文件，不是字符串镜像）：

| 场景 | 实际断言计数 | 失败断言 |
|---|---|---|
| 真源 | 通过 72 / 失败 **0** | — |
| 变异①删 `addBody(...)` 调用 | 通过 71 / 失败 **1** | `★ 6 个带 body 事件合成时都多出一个 100–180 Hz 低频 oscillator`（573 行，expect 6 got 0） |
| 还原 | 通过 72 / 失败 **0** | — |
| 变异②删全部 6 处 body 参数 | 通过 70 / 失败 **2** | 同上守卫 + `前提：源码里恰好 6 处 body 参数`（597 行，expect 6 got 0） |
| 还原 | 通过 72 / 失败 **0** | — |

两轮变异后均用备份文件还原，`git diff -- pwa/js/sfx.js` 为空，生产源与 HEAD 完全一致；**本轮只改测试文件，没有改任何运行时行为**。

**D2' 决策：保持 `unique >= 8`，不把「20」写成交付承诺。**
理由：实施者的 `sigOf()` 声纹分类与 QA 独立 oracle（`tools/qa/audio-distinctness-oracle.js`，自验 4/4、实测四硬轴 21 / 完整轮廓 22）不是同一把尺，两边数字不可直接对齐；把生产测试硬门槛从 8 收紧到 20，等于把测试绑死在某一版分类实现上，是脆弱断言，将来加一个事件或改一个辅助轴就会误红。硬目标原文是「至少 8 个可辨声纹」，生产测试锁 ≥8 已覆盖承诺；20 / 21 / 22 作为自报值与 QA 独立交叉验证的证据保留在本日志，不作为测试断言。

---

## 三、真浏览器冷启动冒烟

- 命令：`DEBUG_CDP=1 ONLY="390×844" SHOT_DIR=tmp-shots/audio-impl-1 node scripts/probe-ui-flow.js --shots`（第二条无 `--shots` 复跑取完整日志，日志 `tmp-shots/audio-impl-1/probe.log`）。
- 实跑链路：引导卡 → auth → home → 建房弹窗 → **准备中 → 对局·分牌 → 对局·交换 → 已提交 → 结算** → 战绩 → 排行 → 规则 → 账号，全部屏都到达。
- **JS 异常 0**：`DEBUG_CDP=1` 全程 `Runtime.exceptionThrown` 日志中 `[JS异常]` 0 条。
- 人工看图核对（不是只看断言）：
  - `iOS竖_390_844_准备中.png`：房间号 **352365**，5 个座位（机器人1/2/3/4 + 我）全部可见，「准备」按钮在位，无白屏。
  - `iOS竖_390_844_对局_分牌.png`：同一房间号 352365、5 座位可见，6 张手牌与三条分牌槽可见。
  - `iOS竖_390_844_结算.png`：本局结束标题、冠军（机器人3 +59）、5 人名次与按钮全部可读，无白屏；无上一轮 `ringTopHtml` 缺 `meTitle` 回归。
  - 区分度修订（g/v158）后**重跑**同一探针：日志 `tmp-shots/audio-impl-1-g/probe.log`，全链路仍到达、准备 / 分牌 / 结算屏均 `问题 0`、`[JS异常]` 仍 0 条；看图 `iOS竖_390_844_准备中.png` 房间号 **329500**、5 座位齐全、无白屏。排行屏仍是同一批既有 10 项越界。
  - h/v159（AC6b 守卫补修）后**再重跑**同一探针：日志 `tmp-shots/audio-impl-1-h/probe.log`，引导卡 → auth → home → 建房弹窗 → 准备中 → 对局·分牌 → 对局·交换 → 已提交 → 结算 → 战绩 → 排行 → 规则 → 账号全链路到达，各游戏屏均 `问题 0`，`[JS异常]` grep 计数 **0 条**。人工看图：`iOS竖_390_844_准备中.png` 房间号 **241714**、5 座位（机器人1/2/3/4 + 我）齐全、准备按钮在位、无白屏；`iOS竖_390_844_结算.png` 本局结束 / 冠军机器人3 +38 / 名次与按钮齐全，无顶部标题缺失回归。探针总失败 42 项，全部是战绩 / 排行屏**既有越界**（f/g 版为 10 项，本次浏览器 profile 复用导致战绩屏出现历史数据、越界元素增多），另有 2 条既有半行硬切（结算 96% / 规则 82%）；与音效 / 测试改动无关——本轮 `pwa/js/sfx.js` 的 `git diff` 为空，运行时代码零改动。
- 探针结论：f/g 版 `FAILED 10 项 {"out":10}`，h 版 `FAILED 42 项 {"out":42}`，但**均集中在排行榜 / 战绩屏**（`rp-nav` / `rp-title` / `rank-scroll` / `records-*` 等越界），核心游戏流程屏（准备 / 分牌 / 交换 / 已提交 / 结算）始终 `问题 0`、`[JS异常]` 始终 0 条，与音频无关；`docs/audio-and-ui-fix-log-2026-11-20.md` §实测失败构成已记录 v155b 同样有「排行页 10 项越界」，属**既有问题**。结算屏本次审计 `问题 0`，仅既有半行硬切登记。

---

## 四、资产与调用点边界（确认未越线）

- 未生产 / 下载 / 新增任何音频资产；`FILES` 仍 5 SFX + 1 BGM，`SFX_NAMES` 未变，`sw.js` PRECACHE 未动。
- 未改 `game.js` 的 DOM / `ringTopHtml` / `renderTopBar`、`settleView.js` 幕序列、任何 UI 渲染代码；`game.js:560` 的 `setTimeout(500)` 与 `settleView.js:499-518` 业务代码原样。
- 未引入 `createMediaElementSource`、未建 master bus 之外的音频图、未用 `AudioBufferSourceNode.loopStart/loopEnd`。
- 未动 `package.json`，未装任何依赖。

---

## 五、未做项与原因 / 技术债

| 项 | 原因 / 归属 |
|---|---|
| BGM 45–60 s 真资产、无缝循环；deal×3；champion / win×3 / lose；achievement / select×3 / settle 截短 | 范围单 §二明确推迟到第 3/4 步，等用户试听本轮后再定；本轮零资产 |
| 「3 变体必须是不同录音」（§4.3 对真资产的要求） | 本轮无资产。mp3 事件只用元素池 + profile.detune 做**近似变体**，不等同 3 条不同录音，不冒充达标 |
| BGM 开关 200 ms 淡入淡出、解锁补 `click`/`keyup`、SW PRECACHE 同步 | 诊断 §七第 4 步（P2 打磨），不在本轮第 1/2 步；且开关淡变若提前做会破坏 audio.test.js「点关闭立刻 pause BGM」的既有行为契约 |
| iOS 真机（静音拨杆 / interrupt 恢复 / 首手势后 BGM 起） | 本机无真机；诊断 §8 明确「代码级推断不算通过」，列为真机验收项 |
| 听感验收（六类闭眼可辨、无咔哒、BGM 无接缝） | **未做，不宣称好听**。需用户手机外放 50% 音量实测 |
| 独立工具 `tools/qa/audio-b2-wiring.js` 的 4 项红 | 过期 v155 期望 + 假 AudioContext 缺新方法；不在本轮允许修改文件清单，建议下一轮单独更新测试替身（不影响 `npm test`） |
| 排行屏 10 项越界、结算半行硬切 | 既有 UI 问题，本轮禁改 UI，未处理 |
| `countdown_tick` 未登记 PRIORITY（P2-15，默认 3 级与 split_tick 2 级不一致） | P2 打磨项，第 4 步归属；本轮未扩大范围 |

---

## 六、交付物

- `pwa/js/sfx.js`（唯一功能改动）
- `pwa/test/audio-impl-1.test.js`（新增 72 项行为守卫 + 变异自证）
- 版本真源 7 处 + 状态卡 / README 计数
- 本文档
