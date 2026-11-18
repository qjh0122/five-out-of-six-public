# QA 独立验收报告：离开房间改为直接退

- 验收对象：`pwa/js/game.js` 的 `onLeave` 改动（工作区未提交，HEAD `86c15e3`）
- 需求原话：「取掉离开房间确认的步骤，离开就直接退就行了」
- 验收人：严过关（qa-lead，独立验收，不改业务代码）
- 验收日期：2026-11-18
- 报告性质：**首轮验收**（无上轮缺陷，故不设「上轮缺陷状态」项）

---

## 一、验收条件与逐条结论（四态）

| # | 判据 | 结论 | 核心证据 |
|---|---|---|---|
| 1 | 点离开 → 直接回首页；`leaveRoom → cleanupRoom → showScreen('screen-home')` 直通，无 askConfirm / UndoBar.show / fetchRoomSnapshot | **通过** | `game.js:3709-3735`；真浏览器探针 [2]/[4]：`dialog:false, bar:false, screen:"screen-home", roomId:""` |
| 2 | 四入口共用 `onLeave`，`firstShown` 按可见性选按钮仍在 | **通过** | `game.js:1094`(旁听动态建钮)、`4564`、`4634`、`4639` 全绑 `onLeave`；`firstShown` 在 `3694-3700`，四候选在 `3713`；`ui.test.js:519/529` |
| 3 | 对局中离开仍算弃局；服务端记账一行未动 | **通过** | `server/hub.js:643-660`、`pwa/js/stateMachine.js:438-490`（`p.left=true` + `maybeEndGame` + `settleIfAllIn`）；`git diff --name-only` 无 server/stateMachine/roomStore |
| 4 | 断网 / 房间已删仍回首页，不弹「离开失败」 | **通过** | `game.js:3726-3729` 的 `.catch(function(){}).then(finish)`；`roomStore.js:734-751` 失败归一 `{ok:true}`；本 QA harness FAIL 模式实测 `CLEANUPS=1 SCREENS=screen-home REPORTS=0` |
| 5 | 连点 `leaveRoom ≤ 1`，双闸有效；变异自证红→还原→绿 | **通过** | 真浏览器探针 [5] 连点 6 次 `leaveCalls:1`；harness 去闸 `LEAVE_CALLS=6` 红；真实文件去闸后 `leave-undo 114/1`、`ui 358/1` 红，还原后 `115/0`、`359/0` 绿 |
| 6 | 离开相关测试无「确认框/撤销条/5 秒窗口仍存在」的假绿断言 | **通过** | 四文件逐段核查：所有相关断言均为**负向守卫**（`indexOf(...) < 0`、`!/(...)/`）；`leave-undo.test.js:48-56` 的 `SPEC.MSG_*`/5000ms 只喂给共享 UndoBar 组件状态机测试 C-1～C-5，不参与离开路径判定 |
| 7 | 全仓 grep：8 个离开撤销专属符号在生产代码应为 0 | **通过（有保留，见 N1）** | `pwa/js` = **0 处**；`pwa/css` = **1 处**（`style.css:3510`，位于 `/* … */` 注释内，不可执行）。**可执行代码 0 处** |
| 8 | 战绩清除 5 秒撤销完整，undo-wiring [1]–[5] 原样保留且单跑绿 | **通过** | `recordsView.js:1873 undoBar.show`；`game.js` 的 `#undo-act → UndoBar.undo()` 与 `UndoBar.flush('navigate')` 保留；`undo-wiring.test.js` 单跑 **42/0**；真浏览器 `probe-undo.js` **19/19**（5 秒内记录仍在、撤销有效、到点真清、隐藏不占位） |
| 9 | 退出登录 / 删号 / 不等了 的 confirm 仍可用 | **通过** | `accountView.js:440/508`、`game.js:1022/2836` 四处 `askConfirm` 仍在；`game.js` diff 中唯一被删的 `askConfirm` 行属于旧 `onLeave`（`308-322` 行反删），函数定义本体未动；见 N3 行号漂移说明 |
| 10 | 按「判据四条」自查新增守卫 | **通过（附 1 条建议 N2）** | 期望值独立（`occurrences(...,0)`、独立 SPEC 字面量，`LEAVE_CALLS` 硬编码 1/6 不引用被测值）；误伤已评估；负向计数齐备（`/askConfirm/` 为 0、去闸 `LEAVE_CALLS=6`、失败路径 `REPORTS=0`）；一致性+可达性经真浏览器与 harness 双证 |

---

## 二、全量实测数字（我自己跑的，非引用）

| 项目 | 命令 | 结果 |
|---|---|---|
| 全量基线 | `npm test > /tmp/qa_npm_test.log 2>&1; echo NPM_EXIT=$?` | **NPM_EXIT=0**；`文件 171 个，通过 171 个，失败 0 个`；`断言 7140 项通过，0 项失败，耗时 123.6s` |
| 状态标签说明 | — | 后台任务状态栏显示 `failed`，但命令自报 `NPM_EXIT=0`，日志全绿；按团队约定采信 `NPM_EXIT` |
| 六个核心单测 | 逐文件 `node pwa/test/<f>` | leave-undo `115/0`、undo-wiring `42/0`、ui `359/0`、peek-room-client `21/0`、undo-bar `43/0`、leave-settle `35/0` → 合计 **615/0**，与上游说明一致 |
| 语法 | `node --check` × 7 个改动 JS | **7/7 OK**（game.js、4 test、2 probe） |
| 真浏览器·离开 | `node scripts/probe-leave.js 390 844` | `PROBE_EXIT=0`，**19 项通过 / 0 失败** |
| 真浏览器·撤销 | `node scripts/probe-undo.js 390 844` | `PROBE_UNDO_EXIT=0`，**19 项通过 / 0 失败** |

> ⚠️ **「全绿 ≠ 能玩」已处理**：本次不止跑静态/单测，真 Edge（headless + CDP）从注册→建房→点离开走通全流程，无调试钩子驱动（页面内 spy 只计数、不触发动作）。剩余限制：headless 非真人手录屏，「顺手」这一主观判据未做人工录屏；本改动是单次点击退房，未引入连续操作序列，风险低。

---

## 三、采信矩阵（上游结论逐条复算，事实与归因分列）

| 上游结论 | ① 我实际执行的命令 | ② 我本机原始输出（摘要） | ③ 采信判定 |
|---|---|---|---|
| 「`npm test` 被沙箱拦截，无法实测全量」(改动说明 §5.7) | `npm test > /tmp/qa_npm_test.log 2>&1; echo NPM_EXIT=$?` | `NPM_EXIT=0`；171 文件 / 7140 断言 / 0 失败 | **采信·推断修正**：沙箱未拦截，实测可完成；文档该条已过期（见 N3） |
| 「6 文件小计 615 项 / 0 失败」(§5) | 6 次 `node pwa/test/<f>` | 115/42/359/21/43/35，全 0 失败 = 615 | **采信·复现**（事实成立） |
| 「node --check 7/7」(§5.1) | for 循环 7 文件 `node --check` | `OK` ×7 | **采信·复现** |
| 事实：「连点 6 次 leaveRoom ≤ 1」 | `node scripts/probe-leave.js 390 844`；harness × 6 | 探针 `leaveCalls:1`；harness 有闸 `LEAVE_CALLS=1` | **采信·复现** |
| 归因：「因为 leaveInFlight + pressBusy 双闸」 | 去闸变异：真实文件替换 `if (!state.roomId || leaveInFlight) return;` → `if (!state.roomId) return;`；harness 用去闸副本 | 项目测试 `114/1`、`358/1` 红；harness `LEAVE_CALLS=6` 红；还原后全绿 | **采信·复现**：归因也被独立证伪测试覆盖，非仅「重跑看数字对」 |
| 「服务端弃局记账一行未动」(§1/§2.1) | `git diff --name-only` + 读 `hub.js:643-660`、`stateMachine.js:438-490` | diff 仅 8 个前端文件（+ 并发的 3 个 docs）；无 server/stateMachine/roomStore | **采信·复现** |
| 「真浏览器探针未跑（无 Edge）」(§5.8/§6.4) | 检查 Edge 路径 + 跑两个探针 | Edge 存在；probe-leave `19/19`、probe-undo `19/19` | **采信·推断修正**：环境具备，已补跑（见 N3） |

---

## 四、变异自证原始输出（红 → 还原 → 绿）

### 4.1 项目测试：真实文件去闸 → 红

操作：临时把 `pwa/js/game.js` 的 `if (!state.roomId || leaveInFlight) return;` 换成 `if (!state.roomId) return;`（用 trap 保证还原），`node --check` 通过后跑对应测试。

```
MUTATED_REAL_FILE
MUTATED_SYNTAX_OK
RED_LEAVE_EXIT=1
RED_UI_EXIT=1
=== red leave-undo FAIL lines ===
  FAIL  pwa/test/leave-undo.test.js:235:3  D-2 ★ 入口用 leaveInFlight 短路，连点只发一次 leaveRoom
通过 114 项，失败 1 项
=== red ui FAIL lines ===
  FAIL  pwa/test/ui.test.js:543:1  ★ 在途标记防连点，leaveRoom 最多发一次
通过 358 项，失败 1 项
```

### 4.2 还原 → 绿

```
=== GREEN restore check: leave-undo ===
通过 115 项，失败 0 项        G1_EXIT=0
=== GREEN restore check: ui ===
通过 359 项，失败 0 项        G2_EXIT=0
=== game.js sha256 (must equal pre-mutation backup) ===
f24639db5c71dbe43c378071881889fb03f56df8fc69208316cec8564132d984 *pwa/js/game.js
```

### 4.3 运行时行为变异（我自建 harness，非纸面推断）

项目里的「连点」断言全部是**源码正则**，没有一条真正执行 `onLeave` 并数调用次数；故另建 harness：从 game.js 抽出**真实 onLeave 源码**，在 `vm` 中注入假 DOM / `RoomStore.leaveRoom` spy，连点 6 次。`MODE=fresh` 模拟渲染重建按钮节点（旁听离开钮在 `game.js:1087` 的 render 路径里动态创建）。

```
=== A REAL gate+fresh x6 expect 1 ===
MODE=fresh FAIL=false LEAVE_CALLS=1 CLEANUPS=1 SCREENS=screen-home REPORTS=0
HARNESS_RESULT=GREEN expected=1 actual=1            A_EXIT=0
=== B REAL gate+stable x6 expect 1 ===
MODE=same  FAIL=false LEAVE_CALLS=1 CLEANUPS=1 SCREENS=screen-home REPORTS=0
HARNESS_RESULT=GREEN expected=1 actual=1            B_EXIT=0
=== C MUTATED no-gate+fresh x6 expect 1 → RED ===
MODE=fresh FAIL=false LEAVE_CALLS=6 CLEANUPS=6 SCREENS=screen-home×6 REPORTS=0
HARNESS_RESULT=RED   expected=1 actual=6            C_EXIT=1
=== E REAL offline reject (leaveRoom Promise.reject) ===
MODE=fresh FAIL=true  LEAVE_CALLS=1 CLEANUPS=1 SCREENS=screen-home REPORTS=0
HARNESS_RESULT=GREEN expected=1 actual=1            E_EXIT=0
```

工具自验（判据 2）：4 个已知答案样本中 A/B/E 为命中（应绿、实绿），C 为不命中（应红、实红），**4/4 通过**；C 的 `LEAVE_CALLS=6` 与 D 组「去闸副本按 6 计数」实测一致，证明工具确实在数真实调用而非空跑。首次运行曾因 harness 漏注入函数外的 `var leaveInFlight` 导致 `ReferenceError`（工具自身故障，非产品缺陷），已修正并重跑，上方为修正后结果。

### 4.4 真浏览器冷启动路径（补上游未跑项）

```
[2] 等待中点「离开」→ 直接退，无 confirm / 无撤销条
{"dialog":false,"bar":false,"screen":"screen-home","roomId":"","leaveCalls":1,"busyText":"离开中…","busyDisabled":true}
[4] ★ 对局中点「离开」→ 直接退（弃局由服务端记账，本端不弹确认）
{"dialog":false,"bar":false,"screen":"screen-home","roomId":"","leaveCalls":1,"busyText":"离开中…","busyDisabled":true}
[5] 连点离开 → leaveRoom 调用次数 ≤ 1
{"dialog":false,"bar":false,"screen":"screen-home","roomId":"","leaveCalls":1}
PASS ★★ 连点 6 次，leaveRoom ≤ 1
通过 19 项，失败 0 项
```

---

## 五、误伤评估与缺陷清单

### 缺陷 / 建议

| 编号 | 描述 | 级别 | 处理建议 |
|---|---|---|---|
| N1 | `pwa/css/style.css:3510` 注释中出现 `data-undo-origin`。生产代码**可执行部分为 0**，但该注释使字面 grep 不为 0（判据 7 若按字面读则不通过） | **建议** | 若团队要求「grep 严格为 0」，删这一行注释即可，无任何行为影响；否则保留 |
| N2 | `leave-undo.test.js:234` 的断言文案写「在途标记**只有一处定义**」，但断言本体只是 `/var leaveInFlight = false;/`，只证明「至少有一处」，不证明唯一。属于断言标签过强，未来出现第二处定义会假绿 | **建议** | 改用 `occurrences(GAME, 'var leaveInFlight = false;') === 1` |
| N3 | `docs/leave-direct-change.md` §5.7 / §5.8 / §6.4 记「npm test 被沙箱拦截无法实测」「无 Edge 无法跑探针」，本环境实测均不成立（171/7140/0 + 两个探针 19/19） | **建议** | 由制作人更新改动说明的验证状态，避免后来者误以为全量基线缺失 |
| N4 | `game.js` 的 `askConfirm` 实际行号为 `1022/2836`，任务单/改动说明写的是 `1026/2840`（差 4 行，因本轮删掉文件前部符号导致行号上移）。四处调用本身均保留，非功能缺陷 | **建议** | 更新文档行号引用 |

**阻断 / 严重 / 一般：0 项。**

### 共享功能完整性

- UndoBar 组件本体、注入、`#undo-act` 绑定、`flush('navigate')` 全在；`recordsView.js:1873` 仍 `undoBar.show`。真浏览器 `probe-undo.js` 19/19：5 秒窗口、撤销、到点清除、隐藏不占位全绿。
- `askConfirm` 本体（`game.js:3080`）与退出登录/删号/不等了三处调用全在，diff 未触及。
- `RoomStore.peekRoom` 保留（生产无调用方，测试守契约），`peek-room-client.test.js` 21/0。

### 三条手感判据

| 判据 | 结论 | 证据 |
|---|---|---|
| 操作响应 | **通过** | 真浏览器探针同拍读到 `busyText:"离开中…"`、`busyDisabled:true`；非「点了没反应」 |
| 消除时机 | **通过（本改动无延迟对象）** | 撤销条在离开路径已删除，探针 `bar:false`；服务端弃局记账独立由 `leave-settle.test.js` 35/0 覆盖 |
| 穿模 | **不适用** | 本次改动不触及移动/碰撞逻辑 |

---

## 六、工作区还原证明

验收开始时基线（HEAD `86c15e3`）：8 个已改文件 + `docs/leave-direct-change.md` 未跟踪。

验收结束时：

```
=== final workspace status ===
 M docs/BACKLOG.md          ← 并发改动，非本 QA 所改
 M docs/INDEX.md            ← 并发改动，非本 QA 所改
 M docs/PLAN.md             ← 并发改动，非本 QA 所改
 M pwa/css/style.css
 M pwa/js/game.js
 M pwa/test/leave-undo.test.js
 M pwa/test/peek-room-client.test.js
 M pwa/test/ui.test.js
 M pwa/test/undo-wiring.test.js
 M scripts/probe-leave.js
 M scripts/probe-undo.js
?? docs/leave-direct-change.md
=== game.js diff stat ===
 pwa/js/game.js | 276 ++++++------------------------------------  (1 file, 28 insertions(+), 248 deletions(-))
=== game.js sha256 ===
f24639db5c71dbe43c378071881889fb03f56df8fc69208316cec8564132d984   ← 与变异前备份逐字节一致
=== HEAD ===
86c15e321136b09b726c4fdb590ddc9c2c5fffaf                          ← 未变
```

说明：

1. 我为变异自证创建的临时文件（`qa-mutation-harness.tmp.js`、`qa-mutated-game.tmp.js`、`qa-game-backup.tmp.js`、`qa-game-backup2.tmp.js`、`qa-red-*.log`、`qa-probe-*.log`）**已全部删除**，最终 `git status` 中无残留。
2. 变异前后的 `game.js` SHA-256 完全相同，diff 统计仍为基线时的 `276 行 / 28+ 248-`。
3. 验收期间 `docs/BACKLOG.md`、`docs/INDEX.md`、`docs/PLAN.md` 被**其他成员并发修改**（内容为给「离开撤销」条目标注 2026-11-18 撤需求，属制作人汇编工作，见任务背景 §一）。我未触碰这三个文件，也未回滚它们 —— 它们不是我的改动，不应由我撤销。除这三个并发文档外，工作区与验收开始时一致。
4. 未做 `git commit` / `git push`。

---

## 七、总体结论

**通过。**

- 用户原话「取掉离开房间确认的步骤，离开就直接退就行了」在**真浏览器**中成立：等待中与对局中均不弹确认、不弹撤销条，直接回首页且 `roomId` 清空；连点 6 次 `leaveRoom` 仅 1 次。
- 服务端弃局记账未动，共享 UndoBar / askConfirm 未误伤；全量 171 文件 / 7140 断言 / 0 失败。
- 无阻断、严重、一般级缺陷；4 条**建议**级（N1–N4），不阻塞交付，建议制作人顺手处理 N3（改动说明里两条「无法实测」已过期）。
- 残留限制：headless 真浏览器而非真人录屏，「顺手」主观判据未人工确认；本改动为单次点击，风险低。
