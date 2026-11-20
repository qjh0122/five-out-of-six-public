# 工具链假绿与 local 补 AI 门槛修复日志（2026-11-20）

基线：私库 HEAD `bdd433d`，工作区起始干净；公库 `da4cd19`（未动）。
范围纪律：未改 `pwa/css/**`、`server/**` 生产代码（只改 `server/test/**` 测试文件），未 commit / push / 发布，未重建 `tmp/`。
最终工作区：20 个已跟踪文件修改 + 3 个新增测试文件 + 本日志，无其他文件。

---

## 一、任务 A：`scripts/backlog-status.js` 零解析（假绿）— 已修

### 改动文件
| 文件 | 改动 |
|---|---|
| `scripts/backlog-status.js` | `parse()` 的 `split('\n')` → `split(/\r?\n/)`（行尾归一化，LF/CRLF 双正确）；新增 `--file <path>` 仅供守卫造临时负向样本，默认路径不变 |
| `pwa/test/backlog-status-guard.test.js`（新增，15 项） | 独立锚点断言 + CLI 正/负向断言 |

### 根因与修法
`docs/BACKLOG.md` 为 1763 行**全 CRLF**（裸 LF = 0，字节 69033）。旧 `split('\n')` 残留行尾 `\r`，`RE_ITEM` 的 `(.*)$` 吃不掉 → 命中 0 条 → `unknown = 0` → `--check` exit 0 的假绿。修后在 parse 入口归一化行尾，不改文档本身（遵守 C10：不用 python 改行尾）。

### 独立判据（不是解析器自己算的）
制作人给的「`grep -c '<!-- STATUS:'` = 49」经独立复算为 **50**：第 734 行是正文里的示例 `<!-- STATUS: … -->`，并非条目；其中 `…` 也不是合法状态值。因此条目锚点改用：

```
grep -c '^### ' docs/BACKLOG.md                 = 49   ← 条目数锚点
grep -c '<!-- STATUS: open'   docs/BACKLOG.md   = 2
grep -c '<!-- STATUS: closed' docs/BACKLOG.md   = 38
grep -c '<!-- STATUS: record' docs/BACKLOG.md   = 2
grep -c '<!-- STATUS: watch'  docs/BACKLOG.md   = 7    ← 分组和 2+38+2+7 = 49
grep -c '<!-- STATUS:'        docs/BACKLOG.md   = 50   ← 含第 734 行示例，不作为条目锚点
```

修后实跑：`BACKLOG 条目 49 条 / open 2 / closed 38 / record 2 / watch 7`，`--check` exit 0。

### 守卫覆盖
真实 CRLF 文档解析 49 条及四组计数、CLI 输出 49 条、干净文档 `--check` exit 0、同内容纯 LF 样本仍解析 49 条、CRLF 缺 STATUS 样本识别为 unknown 1 条且 `--check` exit 1。负向样本写入 `os.tmpdir()` 临时目录，`finally` 清理，绝不临时改动真实 BACKLOG.md。

---

## 二、任务 B：22 条恒真断言（假绿污染计数）— 已修

### 改动文件（15 个）
`scripts/test-harness.js`、`pwa/test/{leave-undo,next-round-gate-codes,resubmit,rules}.test.js`、`server/test/{ai-bot,dissolve-timeout,e2e,forfeit-timeout,gzip,hand-limit-room,hold-next,join-limit,join-settle,profile-save-fail,protocol-seam,split-reconnect}.test.js`、`pwa/test/constant-assert-guard.test.js`（新增，5 项）、`pwa/test/local-addbot-gate.test.js`（新增，9 项；team-lead 2026-11-20 追加裁定，归入 B 组守卫，见下）。

### harness 新方法
`ASSERT.note(msg)` 只打印 `  SKIP  <loc>  <msg>`，**不递增 pass/fail**；`ok/eq` 语义与调用点定位逻辑一字未改。`run-tests.js` 的 `parseCounts` 只认 PASS/FAIL 与汇总行，SKIP 天然不计分。

### 13 处改为真实条件断言
| 位置 | 改为 |
|---|---|
| `server/test/dissolve-timeout.test.js:131` | 断言 `a.socket/b.socket` 存在且 `readyState === 1` |
| `server/test/e2e.test.js:143` | 同上（两个客户端） |
| `server/test/forfeit-timeout.test.js:130` | 同上 |
| `server/test/hand-limit-room.test.js:106` | 同上 |
| `server/test/hold-next.test.js:115` | 同上 |
| `server/test/join-limit.test.js:103` | 同上 |
| `server/test/join-settle.test.js:118` | 同上（三个客户端 a/b/c） |
| `server/test/ai-bot.test.js:137` | 用 `err1`：未满员补第三个 AI 应 `!err1` |
| `server/test/ai-bot.test.js:210` | 用 `myProf.profile` 与 `settledNow` 两个条件同时成立 |
| `server/test/ai-bot.test.js:226` | 断言 `room.phase === WAITING` |
| `server/test/profile-save-fail.test.js:75` | 断言构造函数返回 `bad` 实例（catch 分支仍 `ok(false)`） |
| `server/test/protocol-seam.test.js:240` | 接住 `mateJoin` 回包并断言 `ok !== false` |
| `server/test/split-reconnect.test.js:156` | 接住 `rec` 回包并断言 `ok !== false` |

### 9 处改为 SKIP 留痕（没有客观条件可判，不能删留痕也不计分）
`pwa/test/leave-undo.test.js:342`（AC-NB-15 几何归 CI 探针）、`next-round-gate-codes.test.js:272`（不变量已由上面 5 场景断言，去掉重复计分）、`resubmit.test.js:157`、`rules.test.js:227`、`server/test/e2e.test.js:230/249/265`、`gzip.test.js:119/149`。

### 守卫
`pwa/test/constant-assert-guard.test.js` 递归扫描 `pwa/test/**` 与 `server/test/**` 全部 `.test.js`（实测 178 个文件），断言恒真调用数为 0。正则由片段拼装，源码与注释均不含可被自己命中的字面量，避免自判红。`git grep -nE 'ok\(true|eq\(true' -- 'pwa/test/**' 'server/test/**'` 实测为 0 条。

**追加裁定守卫（team-lead 2026-11-20 指示，归入 B 组）**：`pwa/test/local-addbot-gate.test.js`（9 项）把「门槛是保护性的」固化为可复跑断言——① 源码扫描：canAddBot 仍带 `getMode()==='ws'` 门槛；② 行为抽取执行：ws + 房主 + WAITING 可见、local 同条件隐藏、非房主/满员仍隐藏；③ 真跑 `local.addBot()` 仍返回 `ok:false` 且文案如实。守卫注释按裁定原文写明：**要删门槛必须先把 `hub._autoBots` 的客户端路径补齐，否则死按钮+开局卡死**。将来误删门槛会立刻红。

### 计数同步（以实测为准，未手算填）
README.md 与 docs/release-progress.md 当前状态卡已同步到 **178 文件 / 7409 断言 / 0 失败**。历史 QA / perf 文档中的旧数字作为历史段保持不动。

---

## 三、任务 C：`?mode=local` 补 AI 死门槛 — 核实结论：**不能删，已保留**

### 核实证据链
1. `pwa/js/roomStore.js:310-313` 本地实现是硬桩：`addBot: function () { return { ok: false, error: '本地演示模式不支持 AI 补位' }; }` —— local 模式**根本不存在可用的本地模拟玩家补位路径**。
2. `pwa/js/**` 全目录 `isBot` 引用只用于显示（头像 🤖、座位样式、战绩过滤、投票 quorum 排除），**没有任何客户端 bot 自动出牌代码**；真正的 bot 驱动在 `server/hub.js:1308 _autoBots()`，依赖服务端定时器与 `submitGroups`。
3. 若只删 `pwa/js/game.js:758` 的 `&& RoomStore.getMode() === 'ws'`：local 下按钮会出现且可点 → `onAddBot()` → `RoomStore.addBot()` 返回 `ok:false` → 弹「本地演示模式不支持 AI 补位」。即把「按钮不显示」变成「点了报错的死按钮」；即便强行让 bot 入房，它也永不提交分组，开局就卡死。

结论：门槛是**保护性**的，删除它没有可运行路径支撑。按任务书「由制作人决定」的分支，已就此发消息请 team-lead 拍板，推荐保留。

**team-lead 裁定（2026-11-20，事实链更正记录）**：保留门槛，C 不改生产 JS。team-lead 明确纠正了上一轮自己的误判——上一轮只 grep 到 `roomStore.js:311` 函数存在、**没读 310-313 的实现**，因而误判成「local 路径可用」；读完实现后采信本轮结论。此案符合项目已有的**误伤评估**判据：按该判据改实现会引入死按钮 + 开局卡死，判据作废，因此不改实现。裁定原文：**要删门槛必须先把 `hub._autoBots` 的客户端路径补齐，否则死按钮+开局卡死**。另一种选项（把 `hub._autoBots` 的 AI 出牌逻辑移植到客户端以补齐 local 路径）属于新增生产逻辑，范围大于本轮三项修复，若将来要做应另开工单。

### 本轮实际改动（只加守卫，不动生产 JS）
`pwa/test/local-addbot-gate.test.js`（新增，9 项；按裁定归入 B 组守卫，见 §二）。不是「断言字符串消失」，而是既扫源码确认门槛仍在，也把真的 `canAddBot` 表达式从 game.js 抽出、注入 stub 后执行：
- ws + 房主 + WAITING → 可见（保证没弄坏现有联机）
- local + 同条件 → 隐藏（保护性门槛仍在）
- local + 非房主、ws + 满员 → 仍隐藏（权限/容量门槛没被模式判断顶掉）
- 真跑 `local.addBot()` → `ok:false` 且文案如实说明不支持 AI

`pwa/js/game.js` 未修改（变异自证中的改动已 SHA 校验还原）。

---

## 四、任务 D：版本 bump — 按 team-lead 裁定取消

team-lead 2026-11-20 裁定：**不做版本 bump**。理由：A/B 只改 `scripts/` 与 `*.test.js`，不碰 `pwa/js`、`pwa/css`、`pwa/index.html`，不触发 P1-4 门禁。版本保持 `20261120a` / sw `v153`；本轮不发生 bump，故不记录任何 bump 前后值。

版本门禁 `scripts/lib/version-gate.js` 的 `SOURCE_PATHS` 仅含上述三个路径，本轮三者均未改；`npm run docs:check` 的 P1-4 门禁 78/78 全绿。README 与状态卡的断言计数同步属事实源同步，不是版本 bump。

---

## 五、验收命令与实测结果

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test` | 文件 178 个 / 通过 178 / 失败 0；断言 **7409** 通过 / 0 失败；127.6s | 0 |
| `npm run docs:check` | 78 项通过，0 失败（含 P1-4 bump 门禁） | 0 |
| `npm run probes:check` | 台账 44 条，磁盘 44 个探针，CI 跑 5 个 | 0 |
| `node scripts/backlog-status.js` | 49 条；open 2 / closed 38 / record 2 / watch 7 | 0 |
| `node scripts/backlog-status.js --check` | 干净文档 | 0 |
| `node scripts/probe-first-paint.js 390 844` | 12/12 全绿 | 0 |
| `node scripts/probe-online-smoke.js 'http://127.0.0.1:3000/' 390 844` | 13 通过 / 2 失败 | 1（见下） |

与 README / release-progress 状态卡核对：178 / 7409 / 0 三数一致（追加门槛固化断言后的复跑实测值）。

### 未测项
`probe-online-smoke` 的**线上部署版未测**（无部署地址与 sharecode）。本地服务版本已实跑：13/15 通过，2 条 FAIL 均为「manifest href 带 sharecode」「声明带码 favicon」——本地 URL `http://127.0.0.1:3000/` 无网关口令，这两条是网关专属判据，不是本轮改动引入的回归。

---

## 六、变异自证（临时改坏 → 守卫红 → SHA 还原 → 复跑绿）

SHA 来自 `sha256sum` 命令输出，未手打；每组还原后 SHA 与改前完全一致。

### A 组 — backlog CRLF 解析
- 目标文件 `scripts/backlog-status.js`
- 改前 SHA `d898e5ece35a4f868b590eb3de41934296767dc8790424e9ada5b7d94adc7842`
- 变异 SHA `98088ba6794c0bc189f3d38be00ad799f6581070428100923d7ea097f19fe574`（改回 `split('\n')`）
- 守卫红：`backlog-status-guard.test.js` 6 通过 / 9 失败，exit 1（缺 STATUS 负向、--check exit 1 等全红）
- 还原 SHA `d898e5ece35a4f868b590eb3de41934296767dc8790424e9ada5b7d94adc7842` ✓
- 复跑绿：15 通过 / 0 失败，exit 0

### B 组 — 恒真断言零容忍
- 目标文件 `pwa/test/backlog-status-guard.test.js`（临时追加一条恒真调用）
- 改前 SHA `3b88fdd8f560fd941a6cb21a502f7900cde021711e252faa741184612042ae25`
- 变异 SHA `fe9b296269105fb70a4b7974416f280a9a16c907009aaa1132cece10be22ae23`
- 守卫红：`constant-assert-guard.test.js` 4 通过 / 1 失败，exit 1（精确定位 `backlog-status-guard.test.js:101`）
- 还原 SHA `3b88fdd8f560fd941a6cb21a502f7900cde021711e252faa741184612042ae25` ✓
- 复跑绿：5 通过 / 0 失败，exit 0

### B 组附 — local 补 AI 门槛固化守卫（按 team-lead 裁定归入 B 组）
- 目标文件 `pwa/js/game.js`（临时删掉 `&& RoomStore.getMode() === 'ws'`）
- 改前 SHA `d215afa161d61559f6538e525db12e3a1761e21f3a3149a54c3349e48c41940d`
- 变异 SHA `cc4bb52a647409d1fe95e67734dc87ec59c3c98196a3ea68c222f64cfd23f562`
- 守卫红：`local-addbot-gate.test.js` 7 通过 / **2 失败**，exit 1 —— 源码扫描断言（仍带 getMode 门槛）与行为断言（`local + 同条件 → 补 AI 隐藏` 期望 false 得到 true）同时红
- 还原 SHA `d215afa161d61559f6538e525db12e3a1761e21f3a3149a54c3349e48c41940d` ✓
- 复跑绿：9 通过 / 0 失败，exit 0

**变异自证组数：3 组（A / B / B 附），全部红→绿且 SHA 一致。**

---

## 七、遗留与裁定收口
1. **任务 C 已裁定**：保留门槛、不改生产 JS；「要删门槛必须先把 `hub._autoBots` 的客户端路径补齐，否则死按钮+开局卡死」已写进守卫注释与 §三。若将来真要补齐 local AI 出牌路径，另开工单。
2. **任务 D 按裁定取消**：不做版本 bump，版本保持 `20261120a` / sw `v153`；本日志不记录 bump 前后值。README / 状态卡的计数同步是事实源同步，不是版本 bump。
3. 线上部署版 `probe-online-smoke` 未测（缺地址 / sharecode）。
4. 新增的 3 个测试文件都在 `pwa/test/*.test.js`，不属于 `scripts/probe-*.js`，`probes.json` 台账无需登记；`probes:check` 实测 44/44 绿。
