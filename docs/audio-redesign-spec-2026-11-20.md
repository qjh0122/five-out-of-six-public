# 全游戏音景重新设计规格 · audio-redesign-spec-2026-11-20

> 日期：2026-11-20
> 域：音效 / 音频（负责人：雷鸣远）
> 性质：评估与设计档。**只出规格**——未改 `pwa/`、`server/` 生产代码，未提交，未发布。
> 范围：**全游戏音景（soundscape）**——已有独立资产的 6 种、共用别的音效的场景、走合成回退的场景、以及完全静默的场景，一律纳入地图。目标不是"能用"，是"符合优秀作品的标准"。
> 基线：`D:/Documents/WorkBuddy/six_out_of_five`；`pwa/js/sfx.js`、`pwa/assets/audio/`、`pwa/test/audio.test.js`、`pwa/sw.js`、`pwa/index.html` 及全部 `pwa/js/*.js` 事件流。

## 〇、基线事实与声明（先纠正口径）

**未试听 / 未真机声明**：本规格**没有试听任何音频文件**，也**没有 iOS 真机**。所有音色描述都是**目标规格**，不是对现有素材听感的评价；对现有文件的判定只依据**文件大小、时长/码率（引自 2026-11-18 音频域审计的帧头解析）、接线语义与设计覆盖**。文中凡涉及"好不好听"一律标「未试听」，凡涉及真机行为一律标「需真机」。**不编造真机结论，不编造听感结论。**

实测事实（本轮命令核对）：

| 项 | 实测结果 |
|---|---|
| `pwa/assets/audio/` 下 mp3 | 6 个：`bgm_room_loop.mp3`(154,688 B)、`sfx_deal.mp3`(2,239 B)、`sfx_select.mp3`(1,925 B)、`sfx_settle.mp3`(26,010 B)、`sfx_submit.mp3`(2,552 B)、`sfx_win.mp3`(12,113 B)。6 个文件头均为 `49443304`（ID3v2.4），**真实资产存在** |
| `sfx.js` 的 `FILES` | 6 项：deal / select / submit / win / settle / bgm（`sfx.js:16-23`） |
| `sfx.js` 的 `SFX_NAMES` | 5 项：deal / select / submit / win / settle（`sfx.js:24`） |
| `synth()` 回退表 | 7 项，第 7 项 `error`（200 Hz sawtooth / 0.15 s / gain 0.08，`sfx.js:97`）；**无对应 mp3** |
| `Sfx.play` 调用分布（全仓实测） | error **30** / select **25** / submit **7** / deal **5** / win **4** / settle **1** = 72 处 |
| **有 Sfx 调用的模块只有 5 个** | `game.js`(56)、`accountView.js`(14)、`recordsView.js`(5)、`settleView.js`(3)、`seatSheetView.js`(1)；`achievementsView.js`、`undoBar.js`、`emoji.js`、`records.js`、`roomStore.js`、`authStore.js` 等**全部 0 处**——这是"静默场景"的来源 |
| 音频工具链 | 本机 `ffmpeg` / `ffprobe` **均未安装**；Python 3.13 可用；`package.json` 的 `dependencies` / `devDependencies` 均为 `{}`（零依赖纯前端 PWA） |
| SW 预缓存 | `sw.js:194-198` 只含 5 个 sfx；BGM 刻意不进（`sw.js:199` 注明懒加载理由）——**这条决策正确，保留** |
| 开关 | `index.html:329` / `:424` 两处 `data-audio-toggle`；`sfx.js?v=20261120a`（`index.html:1343`） |

**纠正**：之前"error 30 处调用、0 个资产，全走 200Hz 合成"这句话里，**"全走"若被理解成整个音频系统全靠合成，是错的**——5 个高频 SFX + BGM 都是真 mp3；但 **error 这一个事件**确实是 30 处调用 / 0 资产 / 走 200Hz 合成，这部分事实成立。两件事不能混为一谈。

---

## 一、B2 重新分析：iOS BGM 首次播放风险

**原命题**：iOS Safari 上 BGM 首次 `play()` 发生在 `setTimeout(150ms)` 内、已脱离手势调用栈；`unlocked` 一次性标志导致被拒后永不重试，玩家整局无 BGM，唯一自救是手动关一次再开一次。

**判定：成立（代码级结构缺陷确定成立）；"iOS 必然拒绝 / 必然整局静音"的具体表现需真机验证，本文不编造真机结论。**

### 1.1 成立的代码级证据链（逐条可复核）

1. **BGM 元素从未在手势内 play 过**。`bgm` 在 `startBgm()`（`sfx.js:136`）内懒创建（`sfx.js:138`）；而 `startBgm()` 在解锁流程里唯一的首次调用点是 `sfx.js:132`，位于 `setTimeout(..., 150)`（`sfx.js:126`）的回调中。回调执行时已不在 `touchstart` / `mousedown` 的同步调用栈里（`game.js:5234-5235` 注册）。
2. **播放时元素是非静音的**。`sfx.js:141` 先 `bgm.muted = false`，`:142` 才 `bgm.play()`。手势内静音播放解锁的是 `SFX_NAMES` 那 5 个元素（`sfx.js:117-125`），**按元素算不给 BGM 背书**。
3. **被拒后没有重试路径**。`p.catch` 只吞掉异常并注释"被拦截则等下次手势"（`sfx.js:143`），但没有任何下次手势钩子；`unlock()` 开头 `if (unlocked) return`（`sfx.js:114`）且 `unlocked = true` 在任何播放尝试之前就置位（`:115`），后续所有 `touchstart` / `mousedown` 都被挡掉。`startBgm()` 全仓只有两个调用点（`:132`、`:186`），后者要求玩家手动把声音关掉再打开。
4. **现有测试照不到这条链**。`pwa/test/audio.test.js:69` 的假 `Audio.play()` 无条件返回 `Promise.resolve()`；`:89` 的 `setTimeout` stub 把定时器压进队列由 `flush()` 同步执行。测试 `:205-210` 断言"解锁后 BGM 在播"，但它的被除数是一个**永不拒绝的假对象**。测试全绿不能证明真机 BGM 起得来。

**为什么仍然标"需真机"**：iOS Safari 各版本对"用户已与页面交互后"的非手势 `play()` 放宽程度不同（sticky activation / 主屏 PWA / 静音开关状态都会影响），因此"首次必然被拒"是**高概率推断而非实测**。但第 3 条"一旦被拒就永久无重试"与浏览器版本无关，是纯粹的实现缺陷——**这一条足以单独判定命题成立**。

### 1.2 最小修法（规格建议，本轮不实施）

按依赖顺序 5 步，核心是**把 BGM 的创建与首次 play 搬进手势栈，并给拒绝留活口**：

1. `unlock()` 内在 `unlocked = true` 之后、150ms 定时器**之前**，若 `soundEnabled` 则创建 `bgm`（`makeAudio(FILES.bgm, true, BGM_VOL)`），置 `bgm.muted = true`，**同步调用 `bgm.play()`**。创建放在手势内而不放模块 init，是为了保留 `sw.js:199` 的懒加载决策（init 时创建会立刻下载 155KB）。
2. 用 Promise 完成态代替魔法数字：`p.then(() => { bgm.muted = false; })`；`p.catch(() => { armBgmRetry(); })`。**不要吞掉拒绝信号**。老浏览器 `play()` 返回 undefined 时直接 `bgm.muted = false` 视为成功。
3. `armBgmRetry()` 在 `document` 上挂一次性 `touchstart` / `mousedown`（capture，passive）监听，下次手势重跑第 1 步；成功后解绑。`unlocked` 只锁"解锁流程"，**不得锁 BGM 重试**。
4. 删除 `sfx.js:126-133` 的 150ms `setTimeout` 中的 `startBgm()`；SFX 的 `muted = false` 复原并入同一个 `then`。若必须保留定时器，它只能做清理，不能承载首次 `play()`。
5. 同一手势栈内顺手 warm 合成回退：`ensureCtx()` 且 `ctx.state === 'suspended'` 时 `ctx.resume()`。否则 error 的首次 synth 仍可能在非手势的 await/catch 上下文里静默（与 B3 相关）。

**真机验收清单（待执行，本轮未跑）**：iOS Safari 首次点击后 1s 内 BGM 起；模拟被拒后下一次点击能补起；关→开开关能起；从主屏 PWA 启动能起；静音拨杆拨下时**无声属系统行为**（见 §七·4）。

---

## 二、B3 重新分析：error 无资产、全走合成

**判定：不成立为"功能故障"；成立为"设计欠账"。结论：补资产 + 保留合成兜底，但不把它当 bug 上报。**

### 2.1 为什么不成立为故障

- `play('error')` 取 `audioPool['error'] === undefined`（`FILES`/`SFX_NAMES` 都不含 error），落到 `sfx.js:165` 的 `synth()`；`synth()` 的 `spec` 里**明确写了 error 一项**（`sfx.js:97`）。这是一条**有意实现、参数确定、可预测的降级路径**，不是漏接线导致的静默。相比"缺文件 → 404 → 无声"，它至少永远有反馈。
- 30 处调用是实测的，且分布合理：玩家主动点却被拦下（非法牌型、未填满、离线、请求失败）。在一个零依赖 PWA 里，为这种高频短反馈保留零字节的合成兜底，是**正确的工程选择**。
- 换句话说：**合成兜底是资产，不是缺口**。不该把它删掉。

### 2.2 为什么成立为设计欠账

- 参数不是设计决策，是回退表里剩下来的默认值：200 Hz sawtooth 是 6 条 synth spec 里唯一的低频锯齿，与 5 个 mp3 的短促明亮语汇不属于同一套声音语言；手机外放在 200 Hz 效率很低，gain 0.08 又再压一档。**「能响」不等于「听得懂」**。
- 无资产 = 无变体 = 无随机化。30 处调用共用一个音色、一个音高，而它恰恰是全系统最高频的反馈——这与"严格避免重复感"的要求正面冲突。
- 仓库里没有任何音频设计文档为这个 200 Hz 音色辩护；`docs/REVIEW.md:421` 反而把它列为问题。判为**欠账**，不判为**风格选择**。要算风格选择，至少得有音色理由 + 听感验收记录，现在两样都没有。
- 还有一条独立的兄弟风险：synth 用的 `AudioContext` 是懒创建的（`sfx.js:79-86`），`unlock()` 从未 warm 过它；30 处 error 里有相当一部分在 `await`/`catch` 之后（非手势上下文），首次可能 `suspended`。这一条归 B2 修法第 5 步，不归 error 资产本身。

### 2.3 处置

新建 `SFX_ALERT_error_v1..v3.mp3`：400–600 Hz 中频、下行小二度、0.12–0.18 s、目标 -10 dBFS、3 变体 + ±3% 随机。synth 兜底**保留**但参数上调到 `520 Hz / triangle / 0.12 s / gain 0.22`，使兜底与真资产的听感方向一致。**不扩大 error 覆盖面**：`docs/design-states-v1.md:193` 已裁定"加载/失败/离线四态不加音效"，只有"玩家主动点、被拦下"才播——这条边界不动。

---

## 三、声音基调（全音景的统一语法）

- **一句话**：一副牌桌上的**木、纸、短促金属**——所有声音都在讲"这一下落定了没有"。不用管弦、不用史诗鼓点，用近距离收音的干声。
- **情绪基线**：克制、清醒、略带赌桌的紧绷。BGM 是**低存在感的房间底噪**，不是主角；任何音效出来时它必须让位。
- **四条反差**（优秀作品与"有声音"的分界线）：
  1. **确认 vs 拦下**：submit / ready 闭合、上行；error / veto / split_timeout 下行、短促。闭眼也能分出"成了"还是"没成"。
  2. **赢 vs 输 vs 冠军**：现在夺冠、结算幕、战绩图导出共用 `win`，第 4 名和第 1 名听到的几乎一样。重做后 `win`＝"这一手漂亮"，`champion_fanfare`＝"整局冠军"，`lose`＝"落空"，三者不同音色；**按我的名次选，不按结算幕数选**。
  3. **操作 vs 状态**：操作音（deal/select/submit）跟着手指走；状态音（倒计时、轮到我、他人表情、成就）跟着事情走。当前 72 处调用**全部挂在操作上**，状态侧基本是聋的——这是"像点播系统而不是音频设计"的根因。
  4. **自我 vs 他人**：自己的动作音在近场（更干、更响）；他人的动作（入房、离房、提交、表情）在稍远处（低通、低 6 dB）。这是空间感最省的实现，不用上 3D 音频。

---

## 四、全游戏音频事件地图（35 个事件）

> **现状**四类：`独立资产` / `共用`（借别的事件音效）/ `合成回退`（200Hz synth）/ `静默`（无任何声音）。
> **级别**：`S`＝核心音景，高频且决定品质感，必须做精；`A`＝重要状态反馈，应有独立资产；`B`＝低频事件，复用或保持静默即可，**不值得单独做资产**。
> 音量 = `Audio.volume` 线性值（**前提：素材已归一化到 -1 dBFS 峰值**）；括号内为近似 dB。

| # | 事件（场景） | 现状 | 重新设计后（音色 / 时长 / 音量 / 变调） | 级别 |
|---|---|---|---|---|
| 1 | `deal` 发牌 / 入槽 / 撤牌 / 交换 | 独立资产（5 处） | 纸牌落桌、有重量；0.12–0.20 s；0.55（≈-5 dB）；±3% 随机，入槽 +3% / 撤牌 -3% 保留为语义音高 | **S** |
| 2 | `select` 选牌 / 全站 UI 点击 | 独立资产（25 处） | 轻、圆、无攻击性；0.06–0.10 s；0.35（≈-9 dB）；±4% 随机，3 变体，UI 与选牌分音量 | **S** |
| 3 | `submit` 提交 / 建房 / 报名下一局 | 独立资产（7 处） | 落定、盖章感；0.18–0.25 s；0.60（≈-4 dB）；固定 1.0，"确定"不该摇摆 | **S** |
| 4 | `win` 大牌型特写 / 结算幕 | 独立资产（4 处） | 明亮上扬短庆祝；0.8–1.2 s；0.75（≈-2.5 dB）；大牌型固定 1.12，其余按名次不按幕数 | **S** |
| 5 | `settle` 结算落定 | 独立资产（1 处） | 中性合账；由 1.85 s 缩到 0.8–1.2 s；0.50（≈-6 dB）；固定 | **S** |
| 6 | `bgm` 首页 / 房间 / 牌桌 / 结算全程床 | 独立资产 | 45–60 s，低频 pad + 稀疏弹拨，无主旋律；常态 0.12（≈-18 dB），结果音 duck 到 0.04 | **S** |
| 7 | `error` 玩家主动点却被拦下 | 合成回退（30 处） | 中频下行、明确不刺耳；0.12–0.18 s；0.65（≈-3.7 dB）；400–600 Hz，±3% + 3 变体 | **S** |
| 8 | `lose` 我未夺冠 / 这一局落空 | 静默 | 下行小二度 + 低通，不哀伤只"落空"；0.6–0.9 s；0.65；固定 | **S** |
| 9 | `countdown_tick` 开局 3-2-1 | 共用 `select`（`game.js:471`） | 节拍器逐拍收紧；0.08 s ×3；0.45；3/2/1 逐级 +2% | **A** |
| 10 | `countdown_go` 开局"开始" | 共用 `select(1.25)`（同上） | 短促放行；0.25 s；0.75；固定 | **A** |
| 11 | `split_tick` 分牌倒计时最后 5 秒 | 静默（`game.js:1745` 只写 DOM） | 迫近感、不是警报；0.06–0.08 s；0.40→0.55；1.0→1.08 逐秒升 | **A** |
| 12 | `split_timeout` 分牌超时 | 静默（`game.js:1747`） | 明确收尾；0.35 s；0.60；固定，同一轮只播一次 | **A** |
| 13 | `peer_submit` 他人提交 / 轮到我 | 静默（`updateSubmit` DOM-only） | 一记轻提醒；0.20 s；0.35；±2% | **A** |
| 14 | `room_enter` 他人入房 | 静默（房间 render） | 温和"有人来了"，稍远场；0.20 s；0.40；固定 | **A** |
| 15 | `room_leave` 他人 / 自己离房 | 静默（`game.js:3738`） | 轻微下沉；0.20 s；0.40；固定 | **A** |
| 16 | `ready` 准备 / 就位 | 静默（`doReady` `game.js:3601`） | 轻快确认；0.15 s；0.45；±2% | **A** |
| 17 | `veto` 否决解散提案 | 静默（`game.js:3795` 仅 hideModal） | 社交性"被挡回"，与 error 区分；0.25 s；0.55；固定 | **A** |
| 18 | `spectator` 旁听进入 / 退出 | 静默（`game.js:872/1062`） | 中性、低存在感；0.18 s；0.30；固定 | **A** |
| 19 | `emoji_receive` 收到他人表情 / 短语 | 静默（`playEmoji` `seatSheetView.js:920`） | 社交小铃，3 变体；0.12 s；0.35；±5% | **A** |
| 20 | `achievement` 成就解锁 | 静默（`achievementsView.js` 0 处 Sfx） | 仪式感、全站最亮的一下；0.6–0.9 s；0.75；固定 | **A** |
| 21 | `champion_fanfare` 我夺冠（结算 500ms 后） | 共用 `win`（`game.js:554`） | 独立短号角，与"大牌型"分层；0.9–1.3 s；0.80；固定 | **A** |
| 22 | `emoji_send` 我发送表情 | 静默（`seatSheetView.js:459-472`） | 复用 #19 降音量、高变调；0.10 s；0.28；1.06 | **B** |
| 23 | `hint_guide` 提示 / 引导出现 | 静默（`game.js:707` / guide modal） | 柔和云片、不打断阅读；0.25 s；0.30；±3% | **B** |
| 24 | `add_bot` 补 AI | 共用 `select`（`game.js:3629`） | 复用 `select(1.06)`，**不为它做资产** | **B** |
| 25 | `hold_toggle` 挂起 / 解除挂起 | 静默（`syncHoldTick` `game.js:1789`） | 复用 `ready(0.9)` / `ready(1.1)` | **B** |
| 26 | `hand_count_change` 把数变更 | 静默（`game.js:1006`） | 复用 `select(0.9)` | **B** |
| 27 | `dissolve_propose` 发起解散投票 | 共用 `submit`（`game.js:3773`） | 复用 `submit(0.95)` | **B** |
| 28 | `next_round_signup` 开始下一局报名 | 共用 `submit`（`game.js:3787/3798`） | 复用 `submit(1.0)` | **B** |
| 29 | `undo_bar` 撤销条出现 / 撤销 / 到期 | 静默（`undoBar.js` 0 处 Sfx） | 出现复用 `hint`、撤销复用 `select(0.9)`、到期**无声** | **B** |
| 30 | `records_export` 战绩图生成成功 | 共用 `win`（`recordsView.js:1024`） | **改复用 `select(1.12)`**——它不是胜利，不该占用 win 的语义 | **B** |
| 31 | `account_submit` 登录 / 改名 / 改密 | 共用 `submit`（`accountView.js:147/432`） | 复用 `submit`，无需独立资产 | **B** |
| 32 | `account_error` 表单提交失败 | 合成回退（`accountView.js` 6 处） | 同 #7 error，但音量 -3 dB，避免表单连错时刷屏 | **B** |
| 33 | `net_state` 断网 / 重连 / 恢复 | 静默（**有意**，`design-states-v1.md:193` 裁定） | **保持静默**，由顶部横幅与四态视觉承担 | **B** |
| 34 | `sound_toggle` 声音开关点按 | 静默（**有意**） | **保持静默**，只用图标/文案状态表达；"关了还响一下"是 bug 不是反馈 | **B** |
| 35 | `version_refresh` 版本更新重载 | 静默（**有意**，版本刷新流程裁定） | **保持静默**；重载本身是技术事件，不该有仪式音 | **B** |

**地图统计**：35 个事件 = 独立资产 **6** + 共用 **8** + 合成回退 **2** + 静默 **19**（其中 3 项为设计裁定有意静默，**16 项需补**）。

---

## 五、分级与实施成本（制作人排期用）

| 级别 | 事件数 | 内容 | 建议资产量 | 为什么值得 / 为什么不值得 |
|---|---|---|---|---|
| **S · 核心音景** | 8（#1–8） | deal、select、submit、win、settle、bgm、error、lose | **13 个 SFX 文件（含变体）+ 1 条 BGM** | 一局里听到几十上百次，直接决定"像不像优秀作品"。变体与随机化全投在这一层 |
| **A · 状态反馈** | 13（#9–21） | 倒计时×2、分牌超时×2、他人进度、入离房、准备、否决、旁听、收到表情、成就、冠军 | **15 个 SFX 文件**（`emoji_receive` 3 变体，其余单件） | 中频但信息价值高：告诉玩家"时间/关系/损失"。缺了它们游戏是聋的 |
| **B · 低频简化** | 14（#22–35） | 发送表情、提示、补 AI、挂起、把数、解散、报名、撤销条、战绩导出、账号、网络、开关、版本 | **0 个新资产**（全部复用或有意静默） | 一局最多出现一两次；为它们单独做资产是产能浪费。例外：`records_export` 需要从 `win` 改成 `select`，是**语义修正**不是新增成本 |

**总量**：28 个 SFX 文件（含变体）+ 1 条 BGM。按 §八 的 96 kbps mono 规格，28 个短音效总量仍 **< 100 KB**，对首屏无实质压力；BGM 45–60 s / 64 kbps ≈ 360–480 KB，懒加载。**体积不是这次重做的理由，设计覆盖与信息传达才是。**

**实施顺序建议**：S 级 8 项（含 B2 解锁修复）→ A 级中"时间类"4 项（倒计时/超时，治静默超时）→ A 级余下 9 项 → B 级只做三处语义修正（补 AI / 解散 / 战绩导出）。

---

## 六、分层与触发规则

### 6.1 分层结构（每件音效的构成）

| 层 | 作用 | 适用事件 |
|---|---|---|
| **瞬态层**（0–20 ms） | 给"接触瞬间"——纸牌拍桌、按钮落定 | deal / select / submit / ready / countdown_go |
| **材质层**（20–120 ms） | 给"是什么东西"——纸、木、塑料、金属 | deal / select / error / veto / spectator |
| **情绪层**（80 ms–尾部） | 给"这一下意味着什么"——上扬/下行/余韵 | win / lose / settle / achievement / champion_fanfare / split_timeout |

规则：**瞬态层必须有，材质层可缺，情绪层只在结果类事件出现**。UI 音不要情绪层，否则连点会糊成一片。

### 6.2 可执行触发条件

```
发牌：  onDeal(i) 时 play('deal', pitch = 1 + 0.02*i)  // 逐张发牌用递升音高代替叠音
入槽：  play('deal', 1.03)       // 语义固定，保留现有调用点
撤牌：  play('deal', 0.97)       // 语义固定
错误：  仅当 "玩家主动点 && 被规则/网络拦下" 时播；
       设计状态为 静默类（加载/失败/离线四态）时 → 不播（沿用 design-states-v1.md:193）
倒计时：left <= 5 && left > 0 && document.hidden === false → 每秒一次 play('split_tick')
超时：  left === 0 → play('split_timeout')，且同一轮只播一次（用 roomId+handCount 去重）
结算：  按"我的名次"选 win / lose / settle；大牌型幕固定 win(1.12)；
       夺冠播 champion_fanfare（替换 game.js:554 的 win）；同一幕内只响一次
他人音：room_enter / room_leave / peer_submit / emoji_receive 一律 -6 dB（远场）；
       且同一秒内最多 1 次，防止多人同时动作时糊成一片
音量键：soundEnabled === false → play() 直接早退（现有 sfx.js:153 已正确，不许删）
```

### 6.3 随机化与重复疲劳（替换现有写死常量）

- **变体轮转**：3 变体循环 + 随机起始索引；同一事件连续 10 次，音高与音色不完全一致。
- **实时抖动**：每次 `play()` 现算 pitch × (1 ± 0.03)、volume × (1 ± 0.05 dB)，**不再由调用点写死**。例外：大牌型 1.12、入槽 1.03、撤牌 0.97 这三类**语义化音高**保留固定值。
- **节流**：同一事件 500 ms 内最多 2 次；第 3 次起强制换变体并 -2 dB。这直接治"连点 select 结巴"。
- **元素池**：每个事件 2–3 个 `Audio` 元素轮转，替代 `sfx.js:158` 的 `a.currentTime = 0` 抢占（抢占会掐掉前一次，听感是断的）。

### 6.4 优先级与打断

| 级别 | 事件 | 规则 |
|---|---|---|
| 0 · 阻断 | error / veto / split_timeout | 可打断任何 1–3 级；自身不被打断；触发 BGM duck |
| 1 · 结果 | win / lose / champion_fanfare / achievement / settle / countdown_go | 可打断 2–3 级；触发 BGM duck |
| 2 · 操作 | deal / submit / ready / split_tick | 可打断 3 级；不 duck |
| 3 · 环境/社交 | select / hint / spectator / emoji_* / peer_submit / room_* | 不打断同级；被 0–2 级抢占；远场 -6 dB |
| 4 · BGM | bgm | 永远最低，只让位，不发声抢占 |

---

## 七、混音架构

### 7.1 总线与目标响度

```
MASTER  ── 目标 -1 dBTP ceiling（防止多声叠加削波）
 ├─ SFX_BUS   目标峰值 -6 dBFS（champion_fanfare / achievement 为最响）
 │   ├─ ACTION   deal / submit / ready / countdown_go
 │   ├─ UI       select / hint / spectator / room_*      （比 ACTION 低 4 dB）
 │   ├─ ALERT    error / veto / split_tick / split_timeout
 │   └─ RESULT   win / lose / settle / achievement / champion_fanfare
 └─ BGM_BUS    常态 -18 dBFS（Audio.volume ≈ 0.12），duck 时 -28 dBFS（≈0.04）
```

- **相对关系**：BGM 必须始终低于最轻的 SFX 至少 8 dB。当前 BGM 0.22 / SFX 1.0 的关系大致合理，但 mix 里没有 duck，庆祝时会分心。
- **Ducking**：0/1 级事件触发 BGM 从 0.12 → 0.04，attack 0.15 s / hold 0.3 s / release 0.6 s；2/3 级不 duck。
- **淡入淡出**：开关切换对 BGM 做 0.2 s 淡入淡出，避免 `sfx.js:177` 的硬切 pop。
- **素材归一化**：所有交付文件自身峰值归一化到 -1 dBFS；**不要把响度责任推给 `Audio.volume`**（iOS Safari 上程序化音量受系统音量封顶）。

### 7.2 BGM 结构建议

| 项 | 规格 |
|---|---|
| 长度 | **45–60 s**（现 9.67 s 太短，是最大重复疲劳源） |
| 内容 | 72–84 BPM，4 小节动机 ×4 = 16 小节；低频 pad + 稀疏弹拨，**无主旋律线**——牌类游戏玩家会停留很久，旋律会先烦人 |
| 循环点 | 落在小节线且波形过零点；首尾各留 0.5 s 相同 ambient tail |
| 循环实现 | 首选 WebAudio `AudioBufferSourceNode.loopStart/loopEnd`；若继续用 `<audio loop>` + MP3（浏览器不消费 Xing/LAME gapless 信息），**必须做首尾 20–30 ms 静音拼接的假 gapless**，否则每 10 秒一次接缝 |
| 音量 | 常态 0.12（≈-18 dB）；结算页淡到 0.06；0/1 级事件 duck 到 0.04 |
| 场景切换 | 首页 / 房间 / 牌桌 / 结算**共用同一条 bed，不切歌**。切换点在状态抖动时会产生二次启动风险；要情绪变化就用 volume/filter，不要换源 |
| 缓存 | 继续**不进 PRECACHE**（保留 `sw.js:199` 的决策），首次手势后懒加载 |

### 7.3 首次手势解锁的正确实现

要点（伪码语义，非可直接粘贴的实现）：

```
unlock() 在手势回调内同步执行：
  1. unlocked = true
  2. ensureCtx(); if (ctx.state === 'suspended') ctx.resume()   // 为 synth 兜底解锁
  3. 所有已在 FILES/SFX_NAMES 登记的元素 muted 状态下各 play() 一次
  4. 若 soundEnabled：创建 bgm（手势内，保留懒加载）→ muted=true → play()   ← 关键差异
       p.then(() => bgm.muted = false)
       p.catch(() => armNextGestureRetry())     // 不吞信号
  5. 不再用 150ms setTimeout 承载首次 play()
armNextGestureRetry()：挂一次性 touchstart/mousedown 监听，下次手势重跑第 4 步，成功后解绑
```

**禁止**：把 `unlocked` 当成"BGM 已成功播放"；`p.catch` 里只写注释不挂重试；在模块 init 时创建 BGM（会破坏懒加载）。**新增所有 S/A 级事件都必须同时登记进 `FILES` 与 `SFX_NAMES`**——否则它们不会在手势内被预热，重演 error 的处境。

### 7.4 静音开关语义（保持现有决策，不要回退）

- `setSoundEnabled` 是**声音总开关**（BGM + 全部 SFX + synth 兜底），不是 BGM 开关。`sfx.js:8-11`、`:151-153`、`:176-184` 的修复是对的，**规格明确保留**。
- 关：暂停 BGM + 掐掉所有正在响的 SFX + `play()` 早退；开：恢复 BGM（若未解锁则等下一次手势）。
- 界面两处（`index.html:329/424`）状态同步，`aria-label="声音"` 保持不变；对局页若要加开关，复用同一套逻辑，**不要引入第二套"背景音乐"开关**。
- **iOS 硬件静音拨杆**：`<audio>` 与 WebAudio 在 iOS Safari 上受系统静音开关约束，**拨下时无声是系统行为，不是 bug**。不要试图绕过它；关键是给出视觉/震动反馈，让玩家知道操作已被接收。文案上要区分"系统静音中"与"游戏内声音关闭"。

---

## 八、音频规格与命名

### 8.1 技术规格（分平台）

| 项 | 短音效（SFX） | BGM |
|---|---|---|
| 母版 | WAV 44.1 kHz / 16-bit / **mono** | WAV 44.1 kHz / 16-bit / stereo（若单声道则更省） |
| 交付格式 | **MP3 44.1 kHz / 96 kbps mono** | **MP3 44.1 kHz / 64–96 kbps mono**（可选 AAC `.m4a` 供 iOS，但需改 loader → 本轮不做） |
| 为什么 MP3 | iOS Safari 兼容最稳；现有 `new Audio(src)` 单 src 结构零改动；OGG 在 Safari 不可靠，需 `<source>` 多源回退（未接线） | 同左；`<audio loop>` 的 gapless 限制见 §7.2 |
| 峰值 | 归一化 -1 dBFS | 归一化 -1 dBFS，播放时由 `Audio.volume` 降到 -18 dBFS |
| 预算 | 28 个 SFX 总量 **< 100 KB**，全部进 PRECACHE | 45–60 s × 64 kbps ≈ **360–480 KB**，**懒加载不进 PRECACHE** |
| 移动端取舍 | 短音效压缩常驻内存（PRECACHE）；>1 s 的结果音可考虑解码后池化 | 长音乐流式播放；不要整段 decode 进内存 |

### 8.2 命名规范

```
SFX_<类别>_<名称>_<变体>.mp3
  类别：ACTION / UI / ALERT / RESULT / SOCIAL / ROOM
  变体：v1 / v2 / v3
  例：SFX_ACTION_deal_v1.mp3, SFX_ALERT_error_v2.mp3, SFX_RESULT_champion_v1.mp3

BGM_<场景>_loop_v<版本>.mp3
  例：BGM_room_loop_v2.mp3
```

旧文件名（`sfx_deal.mp3` 等）不再新增变体；新命名一次性切换，避免两套名字并存。**版权/署名信息另存 `docs/ATTRIBUTION.md`，不写进文件名。**

---

## 九、资产三列对照表（全量 35 个事件）

> 状态标记：✅ 已接（FILES 有 + SFX_NAMES 有 + play 有）/ ⚠️ 未接线 / ❌ 缺失（无资产）/ ➖ 复用不新增 / 🔇 有意静默。

| 规格项 | 资产文件（建议命名） | 接线点（`sfx.js` 的 FILES / play 调用点） |
|---|---|---|
| [S] 发牌 deal | `SFX_ACTION_deal_v1..v3.mp3`（重做） | `FILES.deal` ✅；`play`：`game.js:1174/2154/2420/2705/2743` ✅ |
| [S] 选牌/UI select | `SFX_UI_select_v1..v3.mp3`（重做） | `FILES.select` ✅；`play` ×25 ✅ |
| [S] 提交 submit | `SFX_ACTION_submit_v1.mp3`（保留） | `FILES.submit` ✅；`play` ×7 ✅ |
| [S] 胜利 win | `SFX_RESULT_win_v1.mp3`（重做） | `FILES.win` ✅；`play` ×4（`game.js:554`、`settleView.js:506/515`、`recordsView.js:1024`）⚠️ 需拆出 champion/records |
| [S] 结算 settle | `SFX_RESULT_settle_v1.mp3`（重做） | `FILES.settle` ✅；`play` ×1（`settleView.js:509`）✅ |
| [S] BGM | `BGM_room_loop_v2.mp3`（重做） | `FILES.bgm` ✅；`startBgm()` `sfx.js:136` ← `:132`/`:186` ⚠️ **接线方式缺陷（B2）** |
| [S] 错误 error | `SFX_ALERT_error_v1..v3.mp3` ❌ **缺失** | `FILES`/`SFX_NAMES` **无**；`play('error')` ×30 → `sfx.js:165` synth ❌ |
| [S] 我输了 lose | `SFX_RESULT_lose_v1.mp3` ❌ **缺失** | `settleView.js:499-516` 无按名次分支 ⚠️ **未接线** |
| [A] 开局倒计时 tick | `SFX_UI_countdown_tick_v1.mp3` ❌ **缺失** | 借 `play('select')` `game.js:471` ⚠️ 未接线 |
| [A] 开局倒计时 GO | `SFX_RESULT_countdown_go_v1.mp3` ❌ **缺失** | 借 `play('select',1.25)` `game.js:471` ⚠️ 未接线 |
| [A] 分牌倒计时 tick | `SFX_ALERT_split_tick_v1.mp3` ❌ **缺失** | `tickSplitTimer()` `game.js:1745` ⚠️ 未接线 |
| [A] 分牌超时 | `SFX_ALERT_split_timeout_v1.mp3` ❌ **缺失** | `game.js:1747` ⚠️ 未接线 |
| [A] 他人提交进度 | `SFX_SOCIAL_peer_submit_v1.mp3` ❌ **缺失** | `updateSubmit` DOM-only ⚠️ 未接线 |
| [A] 他人入房 | `SFX_ROOM_enter_v1.mp3` ❌ **缺失** | 房间 render / `onJoin` `game.js:3556` ⚠️ 未接线 |
| [A] 他人离房 / 我离房 | `SFX_ROOM_leave_v1.mp3` ❌ **缺失** | `onLeave` `game.js:3738` ⚠️ 未接线 |
| [A] 准备/就位 ready | `SFX_ROOM_ready_v1.mp3` ❌ **缺失** | `doReady` `game.js:3601-3614` ⚠️ 未接线 |
| [A] 否决解散 veto | `SFX_ALERT_veto_v1.mp3` ❌ **缺失** | `game.js:3795` 仅 hideModal ⚠️ 未接线 |
| [A] 旁听切换 | `SFX_ROOM_spectator_v1.mp3` ❌ **缺失** | `game.js:872/1062` ⚠️ 未接线 |
| [A] 收到表情 | `SFX_SOCIAL_emoji_v1..v3.mp3` ❌ **缺失** | `playEmoji()` `seatSheetView.js:920` ⚠️ 未接线 |
| [A] 成就解锁 | `SFX_RESULT_achievement_v1.mp3` ❌ **缺失** | `achievementsView.js` 0 处 Sfx ⚠️ 未接线 |
| [A] 夺冠号角 | `SFX_RESULT_champion_v1.mp3` ❌ **缺失** | `game.js:554` 现为 `win` + 500ms ⚠️ 语义错配 |
| [B] 发送表情 | ➖ 复用 `SFX_SOCIAL_emoji_v*.mp3` | `sendEmojiNow` `seatSheetView.js:459-472` ⚠️ 未接线（降音量调用） |
| [B] 提示/引导 | ➖ 复用 `SFX_UI_select_*`（降音量） | `game.js:707` / guide modal ⚠️ 未接线 |
| [B] 补 AI | ➖ 复用 `SFX_UI_select_*` | `game.js:3629` 已接（select） |
| [B] 挂起/解除 | ➖ 复用 `SFX_ROOM_ready_*` | `syncHoldTick` `game.js:1789` ⚠️ 未接线 |
| [B] 把数变更 | ➖ 复用 `SFX_UI_select_*` | `game.js:1006/1009` ⚠️ 未接线 |
| [B] 发起解散 | ➖ 复用 `SFX_ACTION_submit_*` | `game.js:3773` 已接（submit） |
| [B] 报名下一局 | ➖ 复用 `SFX_ACTION_submit_*` | `game.js:3787/3798` 已接（submit） |
| [B] 撤销条 | ➖ 复用 `SFX_UI_hint/select` | `undoBar.js` 0 处 Sfx / `game.js:4594` ⚠️ 未接线 |
| [B] 战绩图导出 | ➖ **改复用** `SFX_UI_select_*`（不再用 win） | `recordsView.js:1024` 现为 `play('win')` ⚠️ 语义错配 |
| [B] 账号提交 | ➖ 复用 `SFX_ACTION_submit_*` | `accountView.js:147/432` 已接（submit） |
| [B] 账号失败 | ➖ 复用 `SFX_ALERT_error_*`（-3 dB） | `accountView.js:144/297/374/429/516/548` 已接（synth） |
| [B] 网络状态 | 🔇 无资产（有意静默） | `game.js:5248/5252/5355` 仅视觉横幅 ✅ 决策保留 |
| [B] 声音开关 | 🔇 无资产（有意静默） | `game.js:3239-3240`；`index.html:329/424` ✅ 决策保留 |
| [B] 版本刷新 | 🔇 无资产（有意静默） | 版本校验/重载流程 ✅ 决策保留 |
| — | 上述 28 个 SFX（不含 BGM）需登记 SW | `sw.js:194-198` 现只有 5 个 ⚠️ **未接线** |

---

## 十、现有 6 个资产逐一处置（全部「未试听」）

| 文件 | 已知规格（帧头解析，非本轮重测） | 处置 | 理由（不依赖听感） |
|---|---|---|---|
| `bgm_room_loop.mp3` | 154,688 B / 9.67 s / 44.1 kHz / 128 kbps / stereo | **重做**（旧文件废弃） | 9.67 s 循环 + MP3 `<audio loop>` 无 gapless = 最大重复疲劳源；文件名说 room 但实际全场景播 |
| `sfx_deal.mp3` | 2,239 B / 0.18 s / 44.1 kHz / 96 kbps | **重做**（3 变体） | 高频动作仅 1 变体、变调由调用点写死；极小体积意味着极简波形，不足以承载纸牌材质层 |
| `sfx_select.mp3` | 1,925 B / 0.16 s / 44.1 kHz / 96 kbps | **重做**（3 变体 + UI/选牌音量分层） | 全站最高频（25 次），多数调用点无 pitch 参数 → 恒定 1.0，重复感最重 |
| `sfx_submit.mp3` | 2,552 B / 0.21 s / 44.1 kHz / 96 kbps | **保留** | 7 次调用、语义清晰、时长合适，无重做必要；把产能让给缺失事件 |
| `sfx_win.mp3` | 12,113 B / 0.86 s / 44.1 kHz / 112 kbps | **重做**（拆 win / lose / achievement / champion） | 一件资产承担四种语义，其中"战绩图导出"根本不是胜利；且输赢无声音区分 |
| `sfx_settle.mp3` | 26,010 B / 1.85 s / 44.1 kHz / 112 kbps | **重做**（缩至 0.8–1.2 s） | 全仓仅 1 处调用却是最长 SFX；结算幕切换时会与 `win` 叠 |

> **未试听 ≠ 音质差**。上表没有任何"现素材难听/好听"的判断；处置理由是**时长、体积、调用频次、语义覆盖**四项可核实事实。真要否定某个音质结论，必须先补一次正式试听并记录。

---

## 十一、资产来源与可复跑验证

### 11.1 推荐来源（按优先级）

| 来源 | 许可 | 注意事项 |
|---|---|---|
| **Kenney.nl**（Interface Sounds / Card & Casino 类包） | **CC0** | 首选：无需署名、可商用。下载后仍按 §8.1 重采样/转码。 |
| **Freesound.org** | 逐条不同：CC0 / CC-BY / CC-BY-NC | **必须逐条看 License 字段**。CC-BY → 在 `docs/ATTRIBUTION.md` 记作者、链接、许可、修改说明；**CC-BY-NC 不可用于任何商业用途**，默认不采。 |
| **Pixabay Sounds / Mixkit** | 各自免费许可 | 通常免署名，但禁止原样转售/打包分发；**以下载当日许可页为准并存档截图**。 |
| **OpenGameArt.org** | 逐条不同（多为 CC0 / CC-BY） | 过滤 CC0；同样逐条核对。 |
| **工具生成**（ffmpeg lavfi / Python 合成） | 产物为自制，无第三方采样许可 | 适合 error / 倒计时 / 分牌 tick 这类纯功能性音与占位；**BGM 不建议纯正弦合成**，听感必然像测试音。 |
| **用户自备** | 由提供方声明 | 需书面确认可商用与可修改，再按 §8.1 归一化。 |

**授权硬规则**：① 任何非 CC0 素材入库前必须有 `ATTRIBUTION.md` 条目；② 不采 NC / ND 许可；③ 许可页截图按来源+日期存 `docs/licenses/`；④ 不把下载来的 mp3 原样改名当自制资产。

### 11.2 零依赖 PWA 的接线方案与复跑命令

**本机实测：`ffmpeg` / `ffprobe` 均未安装；Python 3.13 可用；项目 npm 零依赖。** 生成路线是"一次性安装生成工具（不进项目 runtime 依赖）"或直接下载素材；运行时仍然**零依赖、单 `new Audio(src)`**。

```bash
# 一次性安装生成工具（Windows，仅用于产资产，不写入 package.json）
winget install Gyan.FFmpeg
# 或： scoop install ffmpeg

mkdir -p /tmp/lxw-audio && cd /tmp/lxw-audio

# 发牌：粉噪瞬态 + 带通，做纸片感（v1）
ffmpeg -f lavfi -i "anoisesrc=color=pink:duration=0.14:seed=7" \
  -af "highpass=f=900,lowpass=f=5200,afade=t=in:st=0:d=0.003,afade=t=out:st=0.025:d=0.11,volume=1.2" \
  -ar 44100 -ac 1 -c:a libmp3lame -b:a 96k SFX_ACTION_deal_v1.mp3

# error：中频三角波下行（v1）；改 seed/频率 3 次即得 v2/v3
ffmpeg -f lavfi -i "sine=frequency=520:duration=0.15" \
  -af "afade=t=in:st=0:d=0.004,afade=t=out:st=0.02:d=0.13,volume=0.5" \
  -ar 44100 -ac 1 -c:a libmp3lame -b:a 96k SFX_ALERT_error_v1.mp3

# BGM 占位床（仅验证循环与接线，不作为最终音乐资产）
ffmpeg -f lavfi -i "sine=frequency=110:duration=60" -f lavfi -i "sine=frequency=164.81:duration=60" \
  -filter_complex "[0][1]amix=inputs=2,lowpass=f=1200,afade=t=in:st=0:d=2,afade=t=out:st=58:d=2,volume=0.25" \
  -ar 44100 -ac 1 -c:a libmp3lame -b:a 64k BGM_room_loop_v2.mp3
```

无 ffmpeg 时的替代：Python 标准库 `wave` + `math` 生成 WAV 母版，再转 MP3；或 `pip install lameenc` 在临时虚拟环境直接编码（**不装进项目**）。

### 11.3 如何验证新 mp3 能接线

1. **文件层**：`od -An -tx1 -N4 <file>` 应输出 `49 44 33 04`；大小落在 §8.1 预算内。
2. **命名/FILES 层**：`grep -rho "Sfx\.play('[a-z_]*'" pwa/js | sort | uniq -c | sort -rn` 列出所有事件名，逐一确认在 `sfx.js` 的 `FILES` 有键、文件存在、**且 `SFX_NAMES` 含该项**（否则解锁流程不会预热它——`error` 就是现在的反例）。
3. **缓存层**：新增 SFX 必须同步登记到 `sw.js:194-198`；BGM 保持不进 PRECACHE。
4. **浏览器层**：DevTools Network 看 200 而非 404；Console 无 `NotAllowedError: play() failed`；`Sfx.isUnlocked() === true`；开关关后 `play()` 不产生网络/播放记录。
5. **真机层（待执行）**：iOS Safari 按 §1.2 清单走一遍；安卓 Chrome 验证首次手势解锁与后台回前台后的 BGM 状态。**本轮均未执行，不报结论。**
6. **建议新增的门禁（规格，不实施）**：静态测试断言"每个 `Sfx.play(name)` 字面量都同时存在于 FILES、SFX_NAMES 与磁盘文件"，并断言解锁代码里 `startBgm()` 不在 `setTimeout` 回调内。这类守卫能同时防住 error 欠账和 B2 回潮。

---

## 十二、验收要点

1. **信息传达**：闭眼能分清"成了 / 没成 / 我赢了 / 我输了 / 我是冠军 / 时间到了"六类事件；手机外放 50% 音量下 `error` 明确可闻（B3 核心验收）。
2. **重复疲劳**：同一动作连做 10 次，音高与音色不完全一致；连点 select 3 次不出现"结巴"；BGM 连听 3 分钟听不出接缝。
3. **iOS**：首次用户手势后 BGM 起；若首播被拒，下一次手势能补起；开关语义与现在一致（关=全静音）。**必须真机验，代码级推断不算通过。**
4. **完整性**：§九 三列对照表中每个 S/A 级事件都有资产与接线点；B 级的三处语义修正（补 AI / 解散 / 战绩导出）已落地。
5. **资产合规**：每个非 CC0 文件都有 `ATTRIBUTION.md` 条目与许可截图；无 NC / ND 素材。

## 十三、证据边界

- 未试听任何音频；未做真机；未起服务；未改生产代码；未跑浏览器。
- 时长/码率引自 `docs/review/2026-11-18/06-audio.md` 的帧头解析（本机无 ffprobe，本轮未重测），文件存在与 ID3 头为本轮实测。
- B2 的判定是**代码级结构判定**；"iOS 必然静音"未被实测，不作结论。
- B3 的判定是**设计完成度判定**；200 Hz 合成音"难听"与否未试听，不作听感结论。
- 事件地图来自代码实读：72 处 `Sfx.play` + 0-Sfx 模块（achievementsView / undoBar / emoji / 房间 / 结算 / 网络流程）；接线点位置是建议，实施前需由主程序复核。

---

*本规格由音效总监雷鸣远出具，2026-11-20。本文档是设计交付物，不构成对生产代码的修改授权。*
