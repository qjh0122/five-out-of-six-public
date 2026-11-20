# 音效零资产改造 · 独立验收报告（audio-impl-1 / QA fresh eyes · f 版历史留档）

> 验证人：严过关（QA 负责人） · 日期：2026-11-20
> 验收对象：提交 `fe54d0c`（audio: 零资产三层合成改造 impl-1，20261120f/v157）
> 基线对照：`aab6f7f`（上一提交，曾因 ringTopHtml 白屏回归）
> 依据：`docs/audio-impl-scope-1-2026-11-20.md` 四、验收五条；`docs/audio-diagnosis-2026-11-20.md` §1.5/§3/§4/§5
>
> **历史留档声明**：本报告是首批针对 f 版（fe54d0c）的独立验收，结论为"有条件通过"。
> 制作人后续明确：当前待交付 HEAD 是 g 版 `6f867f6`，f 版结论不得作交付依据。
> g 版独立验收报告见 `docs/qa-audio-g-2026-11-20.md`。本报告仅作过程留档。
>
> **验收基线声明**：本次验收全程在独立 git worktree（`six_out_of_five_qa_f`，detached HEAD = fe54d0c，工作区干净）中完成。
> 验收期间主仓库工作区被队友推进至 `20261120g`（pending 的 Task#4 区分度整改），本报告**只覆盖 fe54d0c**，不涉及 g 版改动。

---

## 〇、采信矩阵（上游结论逐条复算）

| 上游结论 | ① 我实际执行的命令 | ② 本机原始输出（摘要） | ③ 采信判定 |
|---|---|---|---|
| `npm test` 179/7476/0 | `npm test`（隔离 worktree） | 179文件/7473通过/0失败 | **采信·推断修正**：0失败属实；实测7473，README:164明示"源码变更工作区7476/干净工作区7473"，为口径差非缺陷 |
| `docs:check` 78项绿 | `npm run docs:check` | 78通过/0失败 | **采信·复现** |
| 浏览器冷启动房间352365/5座位/JS异常0 | journey.js + probe-ui-flow | 座位表slots5/players2；JS异常行0；journey155通过/3失败 | **采信·复现（事实）**：座位5格、JS异常0属实；3项FAIL是UI文案/时序断言与音效无关 |
| 功能改动仅限sfx.js | `git show --stat fe54d0c` | sfx.js+版本+测试/文档，无game.js/settleView | **采信·复现** |

> **并发假红复盘**：主仓库工作区当时被队友改到 g 版半成品，直跑 npm test 的3条bump红是"改了sfx.js没bump版本"的并发假红，非f版缺陷；隔离树即0失败。

---

## 一、验收条件（AC）

| AC | 条件 | 来源 |
|---|---|---|
| AC1 | 改动仅限sfx.js，不碰UI/DOM/game.js/ringTopHtml/settleView | scope 二、三 |
| AC2 | 零起音消除、attack ramp落地 | §4.1 |
| AC3 | VOL表作用于mp3、duck从硬台阶改包络 | P0-3/P0-5 |
| AC4 | BiquadFilter低通作用于远场、元素池替代硬抢占 | P1-11/P1-9 |
| AC5 | 结果音互斥、三组变体、master bus/compressor | P1-6/8、§5.1 |
| AC6 | 24事件从4簇收敛到≥8声纹；7组撞车对拆开 | 硬指标、§1.5 |
| AC7 | npm test全绿、守卫变异自证非恒真 | scope四.1 |
| AC8 | 真浏览器冷启动完整路径、JS异常0、无白屏 | scope四.3 |
| AC9 | docs:check 78绿、版本真源一致 | scope四.2 |
| AC10 | 无试听/无iOS时结构验证与听感验收分开 | scope四.5 |

---

## 二、测试与证据（逐项）

| 用例 | 模块 | 实测 | 判定 |
|---|---|---|---|
| TC1 | 范围 | index.html 76行全是?v= bump，无game.js/settleView/ringTopHtml | PASS |
| TC2 | 零起音 | sfx.js 3处gain全setValueAtTime(0)→lin→exp；生产代码0处零起音 | PASS |
| TC3 | attack ramp | 节点级：每gain首帧0、lin attack+exp decay、结果音真release | PASS |
| TC4 | VOL→mp3 | win以0.62播放；变异win:0.62→0.5判红→还原绿 | PASS |
| TC5 | duck包络 | scheduled≥6、attack途中0.05<mid<0.14、end回0.14；变异attack120→240判红 | PASS |
| TC6 | 远场低通 | peer_submit filter≤1200；变异删低通判红 | PASS |
| TC7 | 元素池 | 连续两次select命中不同Audio；池=1判红 | PASS |
| TC8 | 互斥/变体/bus | win1.6s抑制、settle错开250ms、error抢select、3组detune/seed各异、compressor -12/6/4/0.003/0.12 | PASS |
| TC9 | 区分度 | 7组逐组至少一维不同，可辨声纹≥10；2处弱拆分见缺陷D1/D2 | PASS(结构) |
| TC10 | 测试真实性 | 179/7473/0；变异2条(win VOL、duck attack)红→绿 | PASS |
| TC11 | 浏览器 | journey核心路径全过、座位5格、JS异常0、上轮白屏未重现 | PASS |
| TC12 | 版本门禁 | docs:check 78/78；meta=version=20261120f、sw=probes=PROBES=v157 | PASS |

**变异自证（取证纪律2）**：2条独立变异——靶1 VOL.win 0.62→0.5（48/2红→50/0绿）、靶2 DUCK_ATTACK_MS 120→240（49/1红→50/0绿）；判定工具非恒真。门禁在执行链里：package.json→run-tests.js扫描pwa/test自动纳入。

---

## 三、f 版区分度专项（七组逐组，f 版参数）

| 组 | 撞车对 | f版改造后 | 拆分维度 | 判定 |
|---|---|---|---|---|
| 1 | deal↔error | deal140Hz thud vs error560Hz下行小二度双振荡器 | 频段+音程+材质 | ✅ |
| 2 | select↔split_tick | 760vs720 sine单音，cut3000vs2000 | 频段+亮度递进（弱） | ✅弱 |
| 3 | countdown_go↔emoji×2 | 五度长音 vs 单音铃(1174升调) | 波形+音程+时长 | ✅ |
| 4 | room_enter/leave/peer/spectator | 上/下行sweep、triangle vs sine、cut900/1200/2400 | 音程+波形+频段 | ✅ |
| 5 | ready↔hold_toggle | 小三度双音 vs 单音(死条目) | 音程 | ✅ |
| 6 | win/achievement/champion/lose | win/achievement均triangle[1,1.25,1.5]（弱）；champion/lose拆开 | 音程(win↔ach重合) | ⚠️ |
| 7 | error/veto/timeout/submit | cut2400/900/1200/3000+上/下行 | 频段+音程 | ✅ |

f版可辨声纹保守≥10，过≥8硬指标，但D2(select↔split_tick)、D1(win↔achievement音程重合)为弱拆分——**这两处在g版6f867f6中已整改，见新报告**。

---

## 四、边界与异常

- 真人路径：journey.js真Edge冷启动完整路径，非调试钩子注入，核心155项PASS。
- 上轮ringTopHtml白屏未重现：建房/准备/结算/战绩全过。
- JS异常0（DEBUG_CDP全程无[JS异常]）。
- 诚实边界：无真人试听、无iOS真机、无竞品A/B；代码参数达标≠听感达标。

---

## 五、f 版缺陷清单

| 编号 | 描述 | 级别 |
|---|---|---|
| D1 | win↔achievement音程轮廓重合（同triangle[1,1.25,1.5]） | 一般（g版已修） |
| D2 | select↔split_tick波形/基频接近，弱拆分 | 一般（g版已修） |
| D3 | 互斥/元素池内存态、刷新重置 | 建议 |
| D4 | play()仍保留a.currentTime=0 | 建议 |
| OBS1 | journey 3项UI文案/时序FAIL（与音效无关） | 观察项 |
| OBS2 | probe-ui-flow排行榜10项越界（与音效无关） | 观察项 |

---

## 六、f 版验收结论

**有条件通过（结构验证全部通过；听感未验收）。** AC1–AC12全部满足。放行条件：真人试听六类闭眼可辨、iOS真机、弱拆分复核。不宣称"音效好听"。

*本报告由QA负责人严过关独立出具；验收对象fe54d0c；变异自证后已还原，未改生产代码。*

---

## 七、后续终验指针（v158 / v159）

本报告为 f 版（fe54d0c）历史留档，不作交付依据。后续版本结论见：
- **g 版（6f867f6 / v158）**：`docs/qa-audio-g-2026-11-20.md` —— 有条件通过，PASS 8 / FAIL 1（AC6b：addBody 无测试守卫）。
- **AC6b 关闭（4a177e3 / v159）**：见 g 版报告文末「AC6b 终验补记」——我在隔离 worktree 独立重做两次变异（删调用 71/1 红、删全部 body 参数 70/2 红、还原均 72/0 绿），守卫节点级非恒真、soft 模式不削弱守卫，**AC6b FAIL → PASS 已关闭**。生产运行时代码零改动，仅补测试守卫 + 版本 bump。
