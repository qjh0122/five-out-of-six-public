# 音效与 UI 修复收口日志 · 2026-11-20

> 性质：**收口交付日志**。前实例在 B-L7 探针调试中陷入循环并已被停止；本轮只做「精确清理 + 收尾验证 + 落盘」，**未提交、未发布、未新增实施改动**。
> 工作区：`D:/Documents/WorkBuddy/six_out_of_five`
> 版本：`app-version 20261120d` / `sw v155`（由 c / v154 bump 而来）
> 依据规格：`docs/audio-redesign-spec-2026-11-20.md`（35 事件地图）、`docs/c7-c1-docclean-fix-log-2026-11-20.md`、`docs/a1-a2-fix-log-2026-11-20.md`

---

## 一、结论速览

| 项 | 结论 |
|---|---|
| 音效 35 事件接线 | **结构层完成**：6 个事件有真 mp3，新增/重定义事件均有确定 synth 兜底并在调用点接线，B 级按规格复用或有意静默。新资产**未生成**。 |
| B-L6-b 旁听文案 | **完成**：桌面顶栏与圆桌环两条渲染路径同一口径，旁听显示「旁听中 / —」。 |
| B-L7 间距回收 + halfCut 验收 | **未达标**：CSS 间距回收改动保留，但 390 竖屏导航卡在引导卡，无法走到结算页做 halfCut 验收；按范围锁停记录，不改探针判据。 |
| 调试残留 | **清零**：`game.js` 6 条 `DBG_*` 日志 + `tmp/probe-debug*.txt` 8 份输出已删除；全仓 `DBG_` 在源码/文档零命中。 |
| 范围外改动 | 逐项核查 11 个文件，**均可归因本轮任务，无可回滚项**；`onAddBot` / `canAddBot` / `setReady` 的门槛与流程未被改动。 |
| 验证 | `npm test` 178 文件 / 7409 断言 / 0 失败 / exit 0；`docs:check` 78/0；`probes:check` 44 条通过；`probe-first-paint 390 844` 12/12。 |

---

## 二、音效 35 事件接线完成情况

### 2.1 已接线的事件（逐项）

状态标记：**资产**＝`FILES` + `SFX_NAMES` 有真 mp3；**synth**＝`SYNTH_SPECS` 有确定音色、无 mp3 时由 WebAudio 兜底；**复用**＝借用既有事件的音色；**静默**＝规格裁定不出声。

| # | 事件 | 实现 | 接线点 / 说明 |
|---:|---|---|---|
| 1 | `deal` | 资产 + synth | 原有 5 处接线保留 |
| 2 | `select` | 资产 + synth | 全站 UI 点击 / 选牌 |
| 3 | `submit` | 资产 + synth | 提交 / 建房 / 报名 |
| 4 | `win` | 资产 + synth | 仅表示「这一手漂亮」，不再承担夺冠与导出 |
| 5 | `settle` | 资产 + synth | 结算落定；去掉按幕数递升的假音高 |
| 6 | `bgm` | 资产 | 首次 `play()` 搬进手势栈；拒绝后挂一次性手势重试；`BGM_VOL 0.12` / `DUCK_VOL 0.04`；保持懒加载、不进 PRECACHE |
| 7 | `error` | **synth** | 520 Hz triangle / 0.12 s / gain 0.22 + 3 变体 ±3%（原 200 Hz sawtooth 已替换）；无 mp3 |
| 8 | `lose` | **synth** | `game.js` 按「我的名次」选 `champion_fanfare` / `lose`，不再按结算幕数 |
| 9 | `countdown_tick` | **synth** | `game.js` 3/2/1 从 `select` 拆出独立事件 |
| 10 | `countdown_go` | **synth** | 同上，「开始」独立事件 |
| 11 | `split_tick` | **synth** | 分牌倒计时最后 5 秒逐秒一记；按 `roomId:handCount:round:ends` 去重 |
| 12 | `split_timeout` | **synth** | 同一轮只响一次；按去重键与已触发键双锁 |
| 13 | `peer_submit` | **synth** | 订阅回调前后快照比对；1 秒节流；远场 -6 dB |
| 14 | `room_enter` | **synth** | 同上（新玩家进入）；远场 -6 dB |
| 15 | `room_leave` | **synth** | 他人离房（快照比对）+ 自己离房（显式接线）；远场 -6 dB |
| 16 | `ready` | **synth** | `setReady` **成功后**才响；挂起/解除复用变调 |
| 17 | `veto` | **synth** | 否决解散走 `veto`，同意解散仍走 `submit` |
| 18 | `spectator` | **synth** | 进入 / 退出旁听，只在状态翻转时响，不随每次 render 重复 |
| 19 | `emoji_receive` | **synth** | `seatSheetView.js` 真正显示该条表情时才响 |
| 20 | `achievement` | **synth** | `AV.announceUnlock()` 会话内计数比较；首次打开只记数不响 |
| 21 | `champion_fanfare` | **synth** | 夺冠号角，结算 500 ms 后按名次触发 |
| 22 | `emoji_send` | **synth** | 复用 emoji 音色 / 1.06 变调；自己发的不再重复响 |
| 23 | `hint_guide` | **synth** | 引导出现 + 撤销条出现 |
| 24 | `add_bot` | 复用 `select` | 原有接线保留 |
| 25 | `hold_toggle` | 复用 `ready` | 挂起 0.9 / 解除 1.1，由状态翻转触发而非每秒 tick |
| 26 | `hand_count_change` | 复用 `select(0.9)` | 把数变更 |
| 27 | `dissolve_propose` | 复用 `submit` | 原有接线保留 |
| 28 | `next_round_signup` | 复用 `submit` | 原有接线保留 |
| 29 | `undo_bar` | 复用 `hint_guide` / `select(0.9)` | 出现 / 撤销；到期静默 |
| 30 | `records_export` | 复用 `select(1.12)` | 由 `win` 改为 `select`，语义修正 |
| 31 | `account_submit` | 复用 `submit` | 原有接线保留 |
| 32 | `account_error` | 复用 `error` | 原有 6 处接线保留 |
| 33 | `net_state` | **静默（有意）** | 决策保留，视觉横幅承担 |
| 34 | `sound_toggle` | **静默（有意）** | 决策保留 |
| 35 | `version_refresh` | **静默（有意）** | 决策保留 |

### 2.2 架构落地（v155）

- `pwa/js/sfx.js`：音色表按实测口径 **23 条 synth（`SYNTH_SPECS`）+ 6 条资产（`FILES`）= 29 表项，事件名并集 24**（`PRIORITY` 21 / `FAR_FIELD` 4 是属性表，不是音色条目）；优先级打断、BGM duck、远场 -6 dB（`FAR_FIELD`）、3 变体 + ±3% 音高抖动 / ±5% 音量抖动、语义音高固定白名单、B2 手势内首播 + 拒绝重试。
- 接线文件：`game.js`、`settleView.js`、`recordsView.js`、`seatSheetView.js`、`achievementsView.js`、`undoBar.js`。
- `pwa/assets/audio/` 仍只有原有 6 个 mp3：`bgm_room_loop` / `sfx_deal` / `sfx_select` / `sfx_submit` / `sfx_win` / `sfx_settle`。

### 2.3 新资产未生成的原因（如实记录）

本机 **ffmpeg / ffprobe 均未安装，且未获授权做系统级安装**；项目 npm `dependencies` / `devDependencies` 均为空，不引入运行时依赖。因此规格中建议的 28 个 SFX + 新 BGM 一个都没有生成，新增事件全部依赖 synth 兜底。
技术债已闭合：`sfx.js` 头注释原引用不存在的 `docs/audio-assets-todo.md`，现改为指向资产待办唯一真源 `docs/audio-redesign-spec-2026-11-20.md` §九 / §十一（2026-11-20 QA 最终验收 D3）。「38 个音色条目」无法从代码复现，对外口径统一为实测 **23 synth + 6 资产 = 29 表项（事件名并集 24）**（D2）。

---

## 三、B-L6-b（旁听文案）完成

- `pwa/js/game.js` 的 `renderTopBar()` 顶部统一算出 `spectating` / `meLabel` / `meScoreText` / `meTitle`，桌面顶栏与圆桌座位环**共用同一组变量**，避免只改一处。
- 旁听态：标签「旁听中」、分数「—」、title 写「· 旁听中 ·」；正常态逐字保持原样。
- `animateScore()` 对 `me.benched` 跳过滚动，防止数字把「—」写回去。
- 未改座位环结构、未改 CSS 字号/造型。

---

## 四、B-L7 判定「未达标」（范围锁停记录）

- **改动**：`pwa/css/style.css` 只收名次行间距（12→7 设计 px）、结算提示与尾注间距、冠军块边距与内边距；不改字号、按钮造型、结构。**改动保留**。
- **判定**：**未达标**。
- **根因**：`probe-ui-flow` 在 390 竖屏卡在引导卡导航 —— 对局·分牌与对局·交换两步 `[nav] 没走到这一屏`，`[交换] FAIL 槽里不足两张牌`；结算推进 180 步仍未进结算（`[warn] 180 步仍未进结算`），**因此无法到达结算页验收 halfCut**。
- **实测失败构成**（`tmp/probe-ui-flow-390-v155b.txt`，前实例留存）：`FAILED 23 项` = 1 项拖拽互换失败 + 22 项 `out` 越界（战绩页 12 / 排行页 10）；另有软问题 22 条、半行硬切 1 条。22 项越界发生在已到达的战绩/排行屏，不能全部算作交换失败的直接后果，但**结算屏确实没被审到，结论不能算通过**。
- **处置**：按范围锁停在记录，**不修改探针判据**，不改 `roomStore.js` 门槛、不改 `onAddBot` / `setReady` 流程去迎合探针。前实例为追这个问题在 `game.js` 加的调试日志已全部回滚（见 §五）。
- **本轮未跑 `probe-ui-flow`**（制作人明确禁止；B-L7 已判未达标）。

---

## 五、调试残留清理与范围外改动核查（逐项）

### 5.1 已清理

1. `pwa/js/game.js` 6 条调试日志全部删除：
   - `console.log('[DBG_RENDERROOM]', ...)`（原 :757）
   - `console.log('[DBG_ADDBOT]', ...)`（原 :765）
   - `console.log('[DBG_READY]', ...)`（原 :3697，制作人点名项）
   - `console.log('[DBG_BOT_ENTER]', ...)`（原 :3709）
   - `console.log('[DBG_BOT_BUSY]', ...)`（原 :3713）
   - `console.log('[DBG_BOT]', ...)`（原 :3717）
   - 复核：`grep -rn "DBG_" pwa scripts docs README.md` **零命中**；`game.js` 内 `console.log` **零命中**。
2. `tmp/probe-debug.txt`、`probe-debug2.txt` … `probe-debug8.txt` 共 8 份探针调试输出删除；其余 `tmp/` 证据文件（C7/C1 基线、npm-test、first-paint、probe-ui-flow-390 三份等）保留。
3. `scripts/probe-ui-flow.js:121/124` 的 `DEBUG_CDP` 分支：按制作人裁定**保留** —— 只增加 `Runtime.exceptionThrown` / `Runtime.consoleAPICalled` 日志输出，不改任何判据或计数。

### 5.2 核查后保留（无范围外改动可回滚）

| 文件 | 改动内容 | 归因 |
|---|---|---|
| `pwa/js/undoBar.js` | 2 处 `Sfx.play`（hint_guide / select 0.9） | 音效接线 |
| `pwa/js/recordsView.js` | `win` → `select(1.12)` | 音效语义修正 |
| `pwa/js/seatSheetView.js` | 2 处 emoji 音效 | 音效接线 |
| `pwa/js/achievementsView.js` | `announceUnlock` | 音效接线 |
| `pwa/js/settleView.js` | 去按幕数递升音高 | 音效接线 |
| `pwa/css/style.css` | 5 处间距回收 | B-L7 范围 |
| `pwa/test/start-countdown.test.js` | 断言改 `countdown_tick` / `countdown_go` | 音效接线配套 |
| `pwa/test/perf-p1-guard.test.js` | SW cache 桩补 `match` | C7 |
| `pwa/test/backlog-status-guard.test.js` | 49→44 / watch 7→2 | 文档清理 |
| `docs/perf-review-2026-11-20.md` | 「不修」裁决替换建议条目 | 文档清理 |
| `pwa/js/game.js` | 音效接线 + B-L6-b + 6 条调试日志（已删） | 本轮范围 |

- 重点复核：`onAddBot` / `canAddBot` / `setReady` **没有**被前实例改动门槛或流程；`onAddBot` 仅剩原有逻辑，`setReady` 仅新增成功后的 `Sfx.play('ready')`。超范围改动 **0 项**。
- `roomStore.js` 门槛维持上一轮裁定，本轮未触碰。

---

## 六、版本 bump 与验证数值

### 6.1 版本真源（6 处）

| 真源 | 新值 |
|---|---|
| `pwa/index.html` meta `app-version` | `20261120d` |
| `pwa/index.html` 全部本地 `?v=` | `20261120d`（meta 外 37 处，合计 38 处命中） |
| `pwa/sw.js` `CACHE_NAME` | `weile-liuxuanwu-v155` |
| `pwa/version.json` | `{"v":"20261120d"}` |
| `scripts/probes.json` `version` | `v155` |
| `docs/PROBES.md` | 由 `npm run probes:doc` 重生成，头部 `v155` / 44 条 |
| `docs/release-progress.md` 状态卡 | `20261120d` / sw `v155` |

`README.md` 与状态卡的「7409（源码变更工作区）/ 7406（干净工作区），78 / 75 项」双值表述**按要求保留**，未改回单一值。

### 6.2 验证（每项一次，均在清理与 bump 之后）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test` | **178 文件 / 7409 断言 / 0 失败**（124.6 s） | 0 |
| `npm run docs:check` | **78 项通过 / 0 失败**（含 bump 门禁、版本一致性、?v= 一致） | 0 |
| `npm run probes:check` | **44 条通过**（ci 7 / manual 17 / oneshot 20；2 条 advisory 警告：1 条未记绿、20 条 oneshot） | 0 |
| `node scripts/probe-first-paint.js 390 844` | **12/12 通过**，0 失败 | 0 |
| `npm run probes:doc` | 重新生成 `docs/PROBES.md`，44 条 | 0 |

未跑：`probe-ui-flow`（按禁令，B-L7 已判未达标）。任一验证若有失败本应只修到绿——本次四项**无失败**，未做额外打磨。

---

## 七、未测项与诚实声明

**未测**：音效试听（一个文件都没听）、iOS 真机、安卓真机、线上 smoke、BGM 循环听感、B-L7 结算 halfCut 几何验收、本轮 `probe-ui-flow`。

**声明**：本轮**未做资产试听，iOS 真机未测**。工程层只保证**结构、接线、兜底、门禁**到位——35 事件有确定的触发点与确定性音色、文件缺失时有可预测的反馈、音效总开关与缓存门禁不被破坏。**「符合优秀作品标准」属于主观/真机验收范畴，须由用户验收后判定**，本日志不代用户下这个结论。

**未提交、未发布**：所有改动留在工作区，等待制作人/用户裁决。

---

## 八、QA 放行条件闭合（2026-11-20 · 主程序）

> 依据：`docs/qa-final-2026-11-20.md` §五 D1–D4 与 §六放行条件 2/4。
> 本段只闭合 D1–D4 与计数口径；放行条件 1（iOS 真机 / 试听验收）与条件 3（B-L7 维持未达标）**不在本轮闭合范围**，未冒认。

### 8.1 D1（必须）：B2 拒绝路径接进 `npm test` 门禁 —— 已闭合

- **做法**：采用方案 (a)。把 `tools/qa/audio-b2-wiring.js` 的「可配置拒绝 BGM 的假 Audio + 假 document + 初始 suspended 的假 AudioContext + 判定器自验」迁入 `pwa/test/audio.test.js`，新增 `firstPlayBeforeFlush()` / `bootB2()` / `b2RejectPathTests()` 共 **11 条断言**（该文件 44 → 55），随 `npm test` 自动执行。QA 工具原文件保留，`node tools/qa/audio-b2-wiring.js` 仍可独立复跑（21/21）。
- **覆盖**：判定器自验 3 条（2 命中 1 不命中，防「判据恒真」）；首次 BGM `play()` 在同步手势栈内（flush 前）、首播 `muted=true`、fulfilled 后取消静音、同栈 `ctx.resume()`；首次 play 被拒 → `touchstart` + `mousedown` 一次性监听已挂 + `retryArmed/retryCount` 上报 → 下次手势补播成功（此时 `unlocked` 已置位，证明它没挡重试）。
- **汇总时序**：音频测试的汇总行移进 async main，在 B2 段 `await` 之后打印；否则 `run-tests.js` 会先读到旧计数，又是一次假绿。

### 8.2 变异自证（硬要求）—— 红 → 绿

| 阶段 | 操作 | SHA-256（`pwa/js/sfx.js`，命令输出原文） | `node pwa/test/audio.test.js` |
|---|---|---|---|
| 变异前 | D2/D3 注释改完、B2 断言已接 | `0e3e1b17901d5be194ab536ac4a882a8c79e23f3bf2bce02ed402ddef43423ff` | 55 通过 / 0 失败，EXIT=0 |
| 注入错误 | 注掉 `startBgmInGesture()` 的 catch 里 `armBgmRetry();` 一行 | `a6e91a4f67d78ca839201045e717459b75814ad983ad8d540db790d25d401af1` | **52 通过 / 3 失败，EXIT=1**（红在「重试监听未挂」「retryArmed 未上报」「下次手势未补播」） |
| 还原 | 精确恢复该行，不夹带任何改进 | `0e3e1b17901d5be194ab536ac4a882a8c79e23f3bf2bce02ed402ddef43423ff`（与变异前逐字一致） | 55 通过 / 0 失败，EXIT=0 |

> 结论：新断言**确实能红**，不是恒真摆设；SHA 取自命令输出，未用 git 回滚、未夹带其他改动。

### 8.3 D2 / D3 / D4 —— 均已闭合

- **D2**：`pwa/js/sfx.js` 头注释与本文 §2.2 统一为实测口径 **23 synth + 6 资产 = 29 表项（事件名并集 24）**；`PRIORITY 21 / FAR_FIELD 4` 明确标注为属性表，不计音色条目，不再落 38 这个对不上的数。
- **D3**：`sfx.js` 头注释对不存在的 `docs/audio-assets-todo.md` 的引用已删除，改为指向真实存在的 `docs/audio-redesign-spec-2026-11-20.md` §九 / §十一；本文 §2.3 的技术债条目同步改为「已闭合」。
- **D4**：`docs/REVIEW.md` §4.2 item9（iOS BGM）标注「代码已修（v155，见 audio-redesign-spec §1.2）、待真机验收」，并写明原「先真机复现再改」不再重复排期；剩余 P1 是**验收**不是改码。

### 8.4 验证数值（本轮实跑）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test` | **178 文件 / 178 通过 / 0 失败；断言 7420 通过 / 0 失败**（125.0 s；= 基线 7409 + D1 迁入 11） | 0 |
| `npm run docs:check` | 78 项通过 / 0 失败 | 0 |
| `node tools/qa/audio-b2-wiring.js` | 21/21 通过 | 0 |
| `node scripts/probe-first-paint.js 390 844` | 12/12 通过 | 0 |
| `node pwa/test/audio.test.js`（变异前 / 还原后） | 55/0 | 0 |
| `node pwa/test/audio.test.js`（注入错误后） | **52/3** | **1** |

`README.md:164` 与 `docs/release-progress.md:48` 的双值表述同步为 **7420（源码变更工作区，含 doc-consistency 78 项）/ 7417（干净工作区，75 项）**：前者实测，后者按同一 +11 增量推算（未另造干净工作区实跑，如实标注）。

**遗留（不在本轮闭合范围）**：放行条件 1（iOS Safari BGM/error 真机与试听）未执行；条件 3（B-L7 维持「未达标」）不变。本轮**未提交、未发布**。
