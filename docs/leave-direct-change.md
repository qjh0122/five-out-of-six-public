# 离开房间改为直接退 —— 改动说明（v1）

基线：HEAD `86c15e3`，工作区干净起改；本轮**就地修改、未提交、未推送**。
需求原话：「取掉离开房间确认的步骤，离开就直接退就行了」。

---

## 一、实现范围与依赖

**范围**：只摘掉「离开房间」这一条使用线 —— confirm 弹窗、5 秒撤销条、为确认文案服务
的 `fetchRoomSnapshot()` 网络核对、以及全部离开撤销专属状态/函数。服务端 `leaveRoom`
（弃局记账、人数不足结算）一行未动，对局中离开仍按弃局记入战绩。

**依赖边界（本轮明确不碰）**：

- `UndoBar` 组件本体（`pwa/js/undoBar.js`）：战绩清除仍在用，只摘掉「离开房间」这个调用方。
- `askConfirm` 本体（`game.js`）：退出登录 / 删号（`accountView.js:440/508`）、不等了
  （`game.js:1022/2836`，改前为 1026/2840，因删前部符号上移 4 行）仍在用。
- `RoomStore.peekRoom`（`roomStore.js`）：作为通用只读 API 保留；只是 `game.js` 不再调用它。
- 设计/QA/BACKLOG/release-progress 等文档：由制作人汇编，本轮未改。

---

## 二、系统实现方案

### 2.1 `onLeave()`（职责 → 数据结构 → 关键流程 → 对外接口）

- **职责**：点任一「离开房间」入口 → 直接退房并回首页；无确认、无撤销、无网络核对；
  断网 / 房间已删也照常回首页，不把人卡在房间里。
- **数据结构**：只新增 `var leaveInFlight = false;`（一个布尔在途标记）。
  **没有**第二个计时器、没有第二个状态机、没有快照变量。
- **关键流程**：
  1. `if (!state.roomId || leaveInFlight) return;` —— 连点第一道闸。
  2. `firstShown(['btn-leave-spectator','btn-leave','btn-leave-game','btn-back-room'])`
     选玩家真正点的那颗 → `pressBusy(btn, '离开中…')`；`if (!restore) return;` 是第二道闸。
  3. `leaveInFlight = true`，先捕获 `leaveRoomId / leaveMyId`（`finish()` 里会清空 state）。
  4. `Promise.resolve(RoomStore.leaveRoom(...)).catch(function(){}).then(finish)`：
     `catch` 吞掉断网 / 房间已删（沿用 roomStore「退房尽力而为」语义，不弹「离开失败」）。
  5. `finish()`：`leaveInFlight = false` → `restore()` → `cleanupRoom()` → `showScreen('screen-home')`。
     成功与同步抛两条路径共用这一个 `finish()`（同步抛先 `reportBug('onLeave', e)` 再 `finish()`）。
  6. 移除了原来的 `blockedOffline()` 拦截：断网时也要能直接退（验收判据要求仍能回首页；
     `ws.leaveRoom` 自身已把请求失败归一成 `{ok:true}`）。
- **对外接口**：无变化，仍是四个按钮共用的 `onLeave` 点击处理函数。

### 2.2 移除的撤销专属符号（全部从 `pwa/js/game.js` 消失）

| 类别 | 符号 |
| --- | --- |
| 文案常量 | `LEAVE_MSG_MID`、`LEAVE_MSG_IDLE`、`LEAVE_UNDO_MSG`、`LEAVE_IRREVOCABLE` |
| 状态变量 | `leaveConfirmSnap`、`lastRoomMeta`、`lastScreenId` |
| 函数 | `fetchRoomSnapshot()`、`anchorLeaveBarOnSettle()`、`setLeaveOrigin()`、`leaveMustCommitNow()`、`markLeaveIrrevocable()`、`doLeave()` |
| 其它 | `attachRoom` 订阅回调里的 P1–P4 守卫分支；`showScreen` 里给屏级锚点记录 id 的赋值；resize 时重算结算屏锚点的监听；`UndoBar.flush('room-changed')`；`data-undo-origin` 写入 |

`lastScreenId` 全仓 grep 只剩这三个用途，随锚点一起删；`lastRoomMeta` 只服务 P4 判据，一并删。

### 2.3 共享代码保留判断（哪些没动、为什么）

| 共享代码 | 保留理由 | 谁还在用 |
| --- | --- | --- |
| `UndoBar` 单例 / 注入 / `flush('navigate')` / `#undo-act` 点击 | 战绩清除的 5 秒撤销仍完整依赖它 | `recordsView.js`、`game.js:showScreen` |
| `askConfirm` 本体 | 退出登录 / 删号 / 不等了等 confirm 仍依赖 | `accountView.js:440/508`、`game.js:1022/2836`（改前 1026/2840） |
| `RoomStore.peekRoom` | 通用只读 API；删除它是范围外改动且会打断 `peek-room-client.test.js` | 现无生产调用方，测试仍守其回包契约 |
| `firstShown` / `pressBusy` / `reportBug` | 直接退仍要「点了有反应」+ 连点保护 + 兜底 | 本轮 onLeave 继续使用 |
| `undoBar.js` 里 `'room-changed'` 的 reason 注释 | 仅为文档注释，`flush(reason)` 对该字符串无特殊行为；改它会动共享组件，本轮不夹带 | 见「技术债」 |

---

## 三、工程组织（改动文件清单）

| 文件 | 改动 |
| --- | --- |
| `pwa/js/game.js` | `onLeave` 重写为直接退；删掉上表全部撤销专属符号与 P1–P4 订阅分支、resize 锚点分支 |
| `pwa/css/style.css` | 删掉 `[data-undo-origin="leave"]` 的屏级锚点规则及其注释；保留 `.undo-bar` 基础锚点与 `.compact-v .undo-act` 触摸尺寸规则 |
| `pwa/test/leave-undo.test.js` | 撤销接线断言改为「直接退」正向/负向守卫（D-1～D-4）；UndoBar 组件状态机测试保留并改名 C-1～C-5；策略引导 AC-NB-14～18 / §4.2 原样保留 |
| `pwa/test/undo-wiring.test.js` | 第 [6] 段从「离开是撤销条第二调用方」改为「直接退，UndoBar 只剩战绩清除」；[1]–[5] 战绩接线断言原样保留 |
| `pwa/test/ui.test.js` | 离开入口/firstShown 断言保留；confirm 文案、`fetchRoomSnapshot`、`核对中…` 等断言改为删除后的负向守卫；退出登录/删号 confirm 断言保留 |
| `pwa/test/peek-room-client.test.js` | 仅更新过期叙述与断言标签（API 契约本身不变） |
| `scripts/probe-leave.js` | 从「读确认框文案」改为「直接退 + 无 confirm/撤销条 + 连点 leaveRoom ≤ 1」真浏览器探针 |
| `scripts/probe-undo.js` | 删除离开撤销的 [6]–[10] 段与页面内 spy；战绩清除 [1]–[5] 完整保留 |
| `docs/leave-direct-change.md` | 本文件（新增） |

CSS 锚点说明：删除的是**原本给房间 / 对局 / 结算三屏共用的** `[data-undo-origin="leave"]`
覆盖规则（`bottom:300px / max-width:92% / padding-left:20px`）；因为 `game.js` 已不再写
`data-undo-origin`，该规则无写入方。战绩清除用的基础 `.undo-bar`（`bottom:300px`）**未改**；
结算屏原先由 `anchorLeaveBarOnSettle()` 现算的锚点随功能一并消失，没有新增替代锚点。

---

## 四、资产接入清单

本轮无美术 / 动画 / 音效 / 字体资产变更，无需资源引用或场景组织改动。

| 资产类型 | 来源角色 | 接入方式 | 验证点 |
| --- | --- | --- | --- |
| DOM 节点 `#undo-bar` | 前端既有 | 保留共享节点，只删使用线 | `pwa/index.html` 中仍恰好 1 处；战绩清除 5 秒撤销仍绿 |
| CSS 锚点规则 | 前端既有 | 删除离开专属覆盖规则 | 源码 grep 无 `data-undo-origin`；基础 `.undo-bar` 规则未动 |

---

## 五、构建步骤（每步可独立验证）

1. **语法**：`node --check` 全部 7 个改动 JS（`game.js`、4 个 test、2 个 probe）→ 本轮 7/7 通过。
2. **核心单测**：`node pwa/test/leave-undo.test.js` → 115 项 / 失败 0。
3. **接线单测**：`node pwa/test/undo-wiring.test.js` → 42 项 / 失败 0。
4. **UI 单测**：`node pwa/test/ui.test.js` → 359 项 / 失败 0。
5. **快照 API 单测**：`node pwa/test/peek-room-client.test.js` → 21 项 / 失败 0。
6. **组件回归**：`node pwa/test/undo-bar.test.js`（43/0）、`node pwa/test/leave-settle.test.js`（35/0）→ 均绿。
7. **全量**：`npm test`（等于 `node scripts/run-tests.js`）—— ✅ **已由制作人与 QA 分别补跑实测**：
   `NPM_EXIT=0`、**171 文件 / 7140 断言 / 0 失败**（制作人 121.9s、QA 123.6s，两次一致）。
   早期「本环境沙箱拦截、无法实测」的记述已被推翻，见下方「验证状态订正」。
8. **真浏览器探针**：`node scripts/probe-leave.js 390 844`（直接退 + 连点计数）、
   `node scripts/probe-undo.js 390 844`（战绩清除撤销回归）—— ✅ **QA 已实跑**：edge 存在，
   两个探针各 **19/19 通过**；冷启动从注册→建房→点离开走通全流程。早期「无 Edge 未跑」
   的记述已作废。

**验证状态订正（2026-11-18，制作人）**：本文件 §5.7 / §5.8 / §6.4 曾记「npm test 被沙箱拦截」
「无 Edge 无法跑探针」——那是实施当时的沙箱环境结论，在制作人与 QA 环境均不成立。
全量 171/7140/0 与两探针 19/19 均已实测，详见 [`qa-leave-direct.md`](./qa-leave-direct.md) §二/§三。
保留原记述是为了不篡改过程，但其「无法实测」结论**已失效**，不得再被引用为「基线缺失」。

**当前可核对的单测小计**：上述 6 个文件合计 **615 项断言 / 0 失败**
（115+42+359+21+43+35）；全量基线以第 7 步的 171/7140/0 为准。

---

## 六、技术债与风险

1. ~~**全量基线缺失**~~ **已闭环（2026-11-18）**：制作人与 QA 各补跑一次，
   均 `NPM_EXIT=0` / 171 文件 / 7140 断言 / 0 失败。断言数比基线 7133 **增加 7 项**
   （而非预期下降）——新增的是连点闸与负向守卫，不是撤销残留。原「沙箱拒绝」记述见 §5 订正。
2. `pwa/js/undoBar.js:140` 仍留有 `'room-changed'` 的 reason 注释，现已无调用方 —— 纯注释，
   不影响行为；本轮不动共享组件，下轮可单独清理。
3. `scripts/probe-undo.js` 的 ws 服务启动代码（`startApp`/`waitApp`）随 [6]–[10] 删除后失去用途，
   暂保留以免夹带进程收尾改动；已在文件头注明，下轮可单独清理。
4. ~~`scripts/probe-leave.js` 未真机运行~~ **已闭环**：QA 用真 Edge 实跑 19/19（等待中/对局中
   均 `dialog:false, bar:false, screen:screen-home`，连点 6 次 `leaveCalls:1`）。同拍忙碌态
   `busyText:"离开中…" / busyDisabled:true` 已实测，无不同步。
5. `RoomStore.peekRoom` 现在没有生产调用方，属于「为将来保留的只读 API」；
   `peek-room-client.test.js` 继续守其回包形状，若后续确认彻底不用可一并删除 API + 测试。
6. 设计/QA/BACKLOG/release-progress 中仍有大量「离开撤销」描述，本轮按分工由制作人汇编。
7. 重试提示：连点保护是 `leaveInFlight` + `pressBusy` 双保险，断网走 `.catch()` 吞错；
   若后续发现「断网时按钮一直忙碌」，检查 `RoomStore.leaveRoom` 的 Promise 是否永不 settle。
