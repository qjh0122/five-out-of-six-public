# 工具链假绿与 local 门槛修复 — 独立验收报告（2026-11-20）

验收人：qa-lead（严过关） ｜ 基线：HEAD `bdd433d` ｜ 对象：主程序三项修复 A/B/C ｜ 性质：**首轮独立验收，过程审**

> 标尺：team-lead 任务书。方法：**独立复算 + 逐处读码 + 变异重做**，不采信上游自报结论作为证据。
> 动作预算：Bash 18 次（≤30），未 commit / push / 发布，未留下任何生产代码改动（game.js SHA 与 HEAD 一致）。

---

## 一、验收条件（从任务书反推）

| AC | 可验证条件 | 判定口径 |
|---|---|---|
| AC1 | 13 处"真实断言"逐处引用上下文真实变量/回包，且旧实现坏掉时转 false | 通过 / 假绿 |
| AC2 | 9 处 SKIP 只打印不递增 pass/fail；实测 7409 不含 SKIP | 实验 + 源码双证 |
| AC3 | 第 734 行是正文示例，条目锚点 = 49；49/2/38/2/7 与独立 grep 一致；`--check` 正负向 | 独立复算 |
| AC4 | C 门槛守卫是行为级（抽真表达式注入 stub），覆盖四场景 + 真跑 local.addBot；按裁定保留门槛 | 读码 + 行为 |
| AC5 | 生产文件零越界；game.js SHA == HEAD；3 新测试文件在 npm test 链上 | git + SHA + 链核 |
| AC6 | README / release-progress 状态卡计数与实测一致，历史段保留旧数 | 逐字核对 |

---

## 二、测试用例与逐处实测证据

### AC1 — 13 处真实断言逐处判定表（本节为核心）

| # | 位置 | 断言条件（实测引用） | 旧实现坏掉会 false？ | 判定 |
|---|---|---|---|---|
| 1 | `server/test/dissolve-timeout.test.js:131` | `!!a.socket && !!b.socket && a.socket.readyState===1 && b.socket.readyState===1` | 是（连接失败即 false） | **通过** |
| 2 | `server/test/e2e.test.js:143` | 同上（a/b 两客户端） | 是 | **通过** |
| 3 | `server/test/forfeit-timeout.test.js:130` | 同上 | 是 | **通过** |
| 4 | `server/test/hand-limit-room.test.js:106` | 同上 | 是 | **通过** |
| 5 | `server/test/hold-next.test.js:115` | 同上 | 是 | **通过** |
| 6 | `server/test/join-limit.test.js:103` | 同上 | 是 | **通过** |
| 7 | `server/test/join-settle.test.js:118` | `!!a.socket && !!b.socket && !!c.socket && 三者 readyState===1` | 是（三客户端任一断即 false） | **通过** |
| 8 | `server/test/ai-bot.test.js:137` | `!err1`（`err1` 来自 `try{await me.request('addBot')}catch(e){err1=e.message}`） | 是（拒绝补 AI 则 err1 非 null） | **通过** |
| 9 | `server/test/ai-bot.test.js:210` | `!myProf.profile && !settledNow`（两真实变量，`settledNow = !!(room && phase===SETTLED && !voided)`） | 是（已结算则 false） | **通过**※ |
| 10 | `server/test/ai-bot.test.js:226` | `!!room && room.phase===SM.PHASE.WAITING` | 是（room 空或 phase 漂移即 false） | **通过** |
| 11 | `server/test/profile-save-fail.test.js:75` | `ok(!!bad)`，`bad = new ProfileStore({file:坏路径,…})`；`catch` 分支为 `ok(false)` | 是（构造函数抛异常走 catch→false） | **通过**※ |
| 12 | `server/test/protocol-seam.test.js:240` | `!!mateJoin && mateJoin.ok !== false`（接住真 `joinRoom` 回包） | 是（回包失败即 false） | **通过** |
| 13 | `server/test/split-reconnect.test.js:156` | `!!rec && rec.ok !== false`（接住真 `reconnect` 回包） | 是（重连失败即 false） | **通过** |

**结论：13/13 无假绿，未发现 `ok(true,...)` / `ok(!!恒真常量,...)` / 断言恒成立表达式。**

※ 两处观察项（不计缺陷，建议后续优化表达，见第五节 QA-02）：
- #9 进入该 `else` 分支的前提已是 `!myProf.profile`，故该子条件在分支内恒真；但整体依赖可变的 `settledNow`，**非假绿**。
- #11 `new` 操作符语义保证 `!!bad` 为真，该条本身恒真；其有效性来自 `catch { ok(false) }` 兜底（"构造不抛异常"确被验证），**非假绿**。

### AC2 — 9 处 SKIP 不计分（源码 + 实验双证）

- 源码：`scripts/test-harness.js:57-59` `note()` 只 `console.log('  SKIP  …')`，明确不计数；`scripts/run-tests.js:46-52` `parseCounts` 只认 `通过 N 项，失败 M 项` 与 `PASS`/`FAIL` 行，SKIP 天然忽略。
- 9 处位置全为 `ASSERT.note(...)`：e2e 231/250/266、gzip 119/149、next-round-gate-codes 272、leave-undo 342、resubmit 157、rules 227。逐个 Grep 命中，无一处是 `ok(true)`。
- **独立实验**（临时改动已完全还原）：
  | 状态 | `leave-undo.test.js` 单文件结果 |
  |---|---|
  | 原状（SKIP 留痕） | `SKIP …:342` 打印；`通过 114 项，失败 0 项` |
  | 把该处 SKIP 改成 `ok(true,'QA-EXPERIMENT')` | 该行变 `PASS`；`通过 115 项，失败 0 项` |
  | 还原后 | 回到 114；`grep -c QA-EXPERIMENT = 0`；`git diff` 仅保留原预期的 `ok(true)→ASSERT.note` 改动 |
- 差值 **+1** 证明 SKIP 确实不计入 pass/fail；终测 7409 不含这 9 处。

### AC3 — 解析器与锚点独立复算

实读 `docs/BACKLOG.md:734`：`> **每条标题下面都有一行 `<!-- STATUS: … -->`，那是状态的唯一权威口径**（v109 加的）。` —— 确为正文示例，`…` 非合法状态值。**制作人的纠正成立，`<!-- STATUS:` = 50 不能作条目锚点。**

独立 `grep -c`（未经解析器）：

| 模式 | 独立 grep | 解析器输出 | 一致 |
|---|---|---|---|
| `^### ` | 49 | 条目 49 | ✓ |
| `<!-- STATUS: open` | 2 | open 2 | ✓ |
| `<!-- STATUS: closed` | 38 | closed 38 | ✓ |
| `<!-- STATUS: record` | 2 | record 2 | ✓ |
| `<!-- STATUS: watch` | 7 | watch 7 | ✓ |
| `<!-- STATUS:` | 50（含示例） | — | ✓ 解释成立 |

分组和 2+38+2+7 = 49 = 条目数。`node scripts/backlog-status.js` exit 0；`--check` 真实文档 exit 0。**负向**：自建 CRLF 缺 STATUS 样本 → `unknown 1 条`，`--check` exit 1（print 动作本身 exit 0，符合实现）。样本置于临时目录，未触碰真实 BACKLOG.md。

### AC4 — C 门槛守卫行为级核验

`pwa/test/local-addbot-gate.test.js`：不是字符串扫描。第 42 行用正则从 `game.js` **抽出真 `canAddBot` 表达式**，第 59-61 行 `new Function('isOwner','room','nextWait','StateMachine','RoomStore','CONFIG', 'return ('+M[1]+')')` **注入 stub 后执行**，实测四场景：

| 场景 | 期望 | 实测 |
|---|---|---|
| ws + 房主 + WAITING | 可见 | true ✓ |
| local + 同条件 | 隐藏 | false ✓ |
| local + 非房主 | 隐藏 | false ✓ |
| ws + 满员 | 隐藏 | false ✓ |

第二段从 `roomStore.js` 抽出真 `addBot` 硬桩并执行 → `ok:false`、文案含"不支持 AI 补位" ✓。

按制作人裁定验收：**保留门槛、不 bump、不补 local 路径**（补齐属新增生产逻辑，另开工单）——不判 C 为未修。`roomStore.js:310-313` 硬桩 + `hub.js:1308 _autoBots()`（服务端定时器 + `submitGroups` 驱动，客户端无 bot 出牌路径）证据链闭合：删门槛只会造"点了报错的死按钮 + 开局卡死"。

### AC5 — 越界检查

- `git diff --name-only`：20 个跟踪文件全部落在 `README.md`、`docs/`、`scripts/`、`pwa/test/`、`server/test/`。**`pwa/js/**`、`pwa/css/**`、`server/**` 生产文件一个未改。**
- `game.js` SHA：工作区 `d215afa161d61559f6538e525db12e3a1761e21f3a3149a54c3349e48c41940d` == `git show HEAD:pwa/js/game.js` 同值；`git diff -- pwa/js/game.js` 为空。主程序变异自证时临时改过又还原——**独立确认已彻底还原**。
- 3 个新增测试文件均在 `pwa/test/`，`scripts/run-tests.js:31-43` 扫描两测试目录自动纳入；实测 **178 文件**（= 175 原有 + 3 新增），全部跑过（三守卫单跑亦全绿）。

### AC6 — 计数事实源

`README.md:164`、`docs/release-progress.md:48` 当前状态卡与 `docs/tooling-and-localbot-fix-log-2026-11-20.md` 均写 **178 文件 / 7409 断言 / 0 失败**（local 守卫 9 项），历史段保留 175/7383 旧数并注明"较上一状态卡"——写法正确，三处与本机独立实测 7409 一致。原 QA-01（曾差 1）已由主程序修正、经我复核关闭，见文末「复核补记」。

---

## 三、边界与异常 / 复跑数字

### 复跑（本机原始输出摘要）

| 命令 | 本机实测 | 退出码 | 与主程序自报 |
|---|---|---|---|
| `node scripts/run-tests.js`（即 `npm test`） | 178 文件 / 178 通过 / 0 失败；**断言 7409 通过 / 0 失败 / 126.0s** | 0 | 三处事实源均已同步为 7409，一致（主程序终测 127.6s，耗时差属环境波动） |
| `node scripts/check-docs.js`（docs:check） | 78 项通过 / 0 失败 | 0 | 一致 |
| `node scripts/probes.js --check` | 台账 44 / 磁盘 44 / CI 5 | 0 | 一致 |
| `node scripts/probe-first-paint.js 390 844` | 12/12 全绿 | 0 | 一致 |
| `node scripts/backlog-status.js` | 49 / open2 / closed38 / record2 / watch7 | 0 | 一致 |
| `node scripts/backlog-status.js --check` | 干净文档 | 0 | 一致 |

**一次环境性失败已排除**：首轮 `npm test` 得 177/178、7383 断言，`auth-guard.test.js` 报 `EADDRINUSE 0.0.0.0:3211`。诊断 `netstat` 显示 3211 无 LISTENING、仅 TIME_WAIT 残留（会自然消退）；单跑 `auth-guard.test.js` = 26 项全绿，7383+26=7409。判定为**瞬时端口冲突，非代码缺陷**。其余两次我方参数误用（把参数并进引号导致 MODULE_NOT_FOUND）已纠正重跑，非项目问题。

### 门禁是否在执行链上（纪律 4）

- `npm test` = `node scripts/run-tests.js`（`package.json:9`），扫描目录式纳入，新增测试不可能"写了没挂上"。README 明确该链含 doc-consistency 78 项、backlog-status-guard 15 项、constant-assert-guard 5 项、local-addbot-gate 9 项。
- `docs:check` 的 P1-4 bump 门禁②（`check-docs.js:314-333`）先查工作区 `pwa/js|css|index.html`，无变更则回退比较 HEAD commit。本轮工作区无源码变更，门禁检查的是 HEAD `bdd433d` 自身（已合规 bump），故 78 全绿合理；**本轮无源码变更，不产生新 bump 义务**。日志"版本未改 + 门禁全绿"两句不矛盾。

### 判定工具自验（纪律 2）

- 用于"全仓恒真断言为 0"的正则 `\b(?:ok|eq)\(\s*true\b`：构造 5 个已知答案样本（2 命中 / 3 不命中，含边界 `trueValue`）自测 **5/5 通过**；全仓 Grep 搜索 0 命中，与 `constant-assert-guard.test.js` 自测 5/5 绿一致。
- 三个新守卫实测项数：backlog-status-guard **15**、constant-assert-guard **5**、local-addbot-gate **9**。
- 从真实命中样本抽 3 个回原文人工复核：本轮 Grep 全仓命中为 0（工具 B 组变异自证中主程序给出 `backlog-status-guard.test.js:101` 一处，属人为放回，已还原），故无"真实命中"可抽，如实标注 N/A。

---

## 四、变异自证独立重做（≥2 组，未复用上游脚本与结论）

| 组 | 变异动作 | 变异 SHA | 守卫红（原始输出） | 还原 SHA | 复跑绿 |
|---|---|---|---|---|---|
| **A** backlog CRLF | `split(/\r?\n/)` → `split('\n')` | `98088ba6…`（与日志一致） | 解析器退化为 **0 条**；守卫 **6 通过/9 失败**，exit 1；命中"expect 49, got 0""缺 STATUS --check expect 1, got 0" | `d898e5ec…` == 改前 ✓ | 15/0, exit 0 |
| **C** local 门槛 | 删 `&& RoomStore.getMode() === 'ws'`（我方独立改法，SHA 与日志不同） | `69440df0…` | 守卫 **7 通过/2 失败**，exit 1；`local + 同条件 → 隐藏 expect false, got true`、`canAddBot 源码仍带门槛` 红 | `d215afa1…` == 改前 == **HEAD** ✓，`git diff` 空 | 9/0, exit 0 |

两组均完整走"改坏 → 守卫红 exit 1 → SHA 校验还原 → 复跑绿"。C 组特别核验 `game.js` 工作区 SHA 与 HEAD 逐字一致，未留生产代码改动。

---

## 五、缺陷清单

| 编号 | 描述 | 复现步骤 | 级别 | 建议处理 |
|---|---|---|---|---|
| QA-01 | ~~计数事实源少报 1 条（7408 / local 守卫 8 项）~~ **已修复并经独立复核关闭**：三处事实源现均为 7409 / 9 项 | `Grep '7408\|7409'` 三文件 + Read release-progress.md:48 | **已关闭** | 见文末「复核补记」。原缺陷属少报、不影响绿灯可信度 |
| QA-02 | 两处断言表达易误读为恒真：`ai-bot.test.js:210` 的 `!myProf.profile` 在所在 else 分支恒真（整体靠 `settledNow` 可变而非假绿）；`profile-save-fail.test.js:75` 的 `ok(!!bad)` 因 `new` 语义恒真（有效性靠 `catch→ok(false)`） | 逐处读码 | **建议** | 未来重构时改为直白条件；本轮不阻塞（已判定非假绿） |

**设计主张不同（不计缺陷）**：任务 C 保留门槛、不补 local 路径——按制作人裁定验收，不计缺陷。

---

## 六、验收结论（三态）

**结论：通过**（原「有条件通过」的唯一条件已满足并复核关闭）。

- 通过项：AC1（13/13 真实断言，0 假绿）、AC2（SKIP 不计分实验成立）、AC3（49 锚点纠正成立、正负向齐备）、AC4（C 门槛行为级、按裁定保留）、AC5（生产文件零越界、game.js SHA 与 HEAD 一致、178 文件链完整）、AC6（三处事实源 7409 与实测一致）、变异 A/C 两组独立重做红→绿且 SHA 还原。
- 上轮唯一条件：修正 QA-01（7408→7409、8 项→9 项）**已完成并经独立复核关闭**，见文末「复核补记」。QA-02 为建议项，不阻塞。
- 阻塞项：**无**。

> **取证边界声明**：本轮为工具链 / 测试基建修复验收，全部证据来自自动化门禁、逐处读码与变异重做；**没有真人试玩路径，也没有实际渲染帧**。按职责必须显式声明：本轮结论只证明"守卫没被假绿污染、门槛守卫能抓到删除、解析器不再返 0"，**不等于玩法手感达标**。手感三判据（操作响应 / 消除时机 / 穿模）与真人路径自证不属于本轮改动范围，不在本报告判定内。

---

## 附录 — 采信矩阵（上游结论逐条复算，事实与归因分列）

| 上游结论 | ① 我实际执行的命令 | ② 我本机原始输出（摘要） | ③ 采信判定 |
|---|---|---|---|
| 【事实 A1】`<!-- STATUS:` = 50，第 734 行为示例，条目锚点 `^### ` = 49 | Read BACKLOG.md:728-741；`grep -c '^### '` 等 6 式 | 49 / 2 / 38 / 2 / 7 / 50；第 734 行确为 `<!-- STATUS: … -->` 示例 | **采信·复现** |
| 【归因 A2】旧 `split('\n')` 致 CRLF 文档解析 0 条 → `--check` 假绿 | 变异：`split(/\r?\n/)`→`split('\n')`；`node scripts/backlog-status.js` | `BACKLOG 条目 0 条`；守卫 6/9 exit 1 | **采信·复现**（因果经变异证实，非仅重跑数字） |
| 【事实 B1】13 处改为真实条件断言 | 逐处 Read 13 文件对应行 | 13/13 引用真实变量/回包；0 处 `ok(true` | **采信·复现** |
| 【归因 B2】恒真清零使计数真实，总数 7409 | `node scripts/run-tests.js`；Grep `(ok|eq)\(\s*true\b` | 恒真 0 命中（正则自验 5/5）；实测 **7409**，三处事实源已同步 | **采信·复现**（原 7408 少报已修正，QA-01 关闭，见补记） |
| 【事实 B3】9 处 SKIP 不计分 | Read harness/run-tests；单文件 +1 实验 | SKIP 打印不计数；改断言后 114→115 | **采信·复现** |
| 【事实 C1】门槛是保护性，不能删 | Read 守卫 + local-addbot-gate 行为 + game.js/roomStore/hub 证据；C 组变异 | 行为级四场景齐；删门槛守卫 7/2 exit 1 | **采信·复现** |
| 【事实 D1】版本未 bump 但 docs:check 78 全绿 | `node scripts/check-docs.js`；Read check-docs.js:314-333 | 78/78 exit 0；门禁回退检查 HEAD commit | **采信·复现**（本轮无源码变更，无新 bump 义务） |

---

## 复核补记（2026-11-20，应 team-lead 数字更正请求）

**范围**：仅复核三处计数事实源是否与终测 7409 一致；**其余 AC 与变异结论沿用首轮实测，未重跑、未改判**。本补记为首轮报告的增量修订，不是新一轮验收。

### 逐条实测证据（AC6 复算）

| 事实源 | ① 命令 | ② 本机原始输出摘要 | ③ 判定 |
|---|---|---|---|
| README.md | `Grep '7408\|7409' README.md` | `:164` → `178 个文件 / 7409 条断言，约 128 秒 … local 补 AI 门槛守卫 9 项`；**无 7408** | **一致** |
| docs/release-progress.md | `Grep` + `Read :48` | `:48` → `**178 文件 / 7409 断言 / 0 失败** … local-addbot-gate.test.js 9 项`；历史段 175/7383 保留 | **一致** |
| docs/tooling-and-localbot-fix-log | `Grep '7408\|7409'` | `:73` 7409、`:111` 断言 **7409**/127.6s、`:119` `178 / 7409 / 0 三数一致`。`:149` 的 `7408` 是变异 SHA `cc4bb52a…e74` 的片段，**非计数残留** | **一致** |

### 上轮每条缺陷当前状态

| 缺陷 | 上轮状态 | 本轮状态 |
|---|---|---|
| QA-01 计数少报 1 | 一般 / 待修 | **已修复**（三处均 7409，与独立实测 7409 吻合）→ **关闭** |
| QA-02 两处断言表达易误读 | 建议 | 未处理，仍为建议，不阻塞 |

### 本轮新增缺陷

无。

### 可交付判定

**通过，无阻塞项。** 原「有条件通过」的唯一条件已闭合；报告正文中的 QA-01、AC6、复跑表与结论已同步修订，全文无遗留 7408 计数主张。
