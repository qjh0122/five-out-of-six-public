# 音效现状诊断与改进方案 · audio-diagnosis-2026-11-20

> 日期：2026-11-20
> 域：音效 / 音频（负责人：雷鸣远）
> 性质：**诊断 + 方案档**，只读审计，未改任何生产代码、未生成音频资产、未发布。
> **取代：v1**（`docs/audio-redesign-spec-2026-11-20.md`）在「现状判定 / 参数口径 / 资产处置判定」三部分的结论；v1 的 §四 35 事件地图、§六 触发规则、§七 混音架构继续有效，本档**不整档作废**，是在其上补的听感与落地修订。
> 触发：线上 `20261120e` 用户实测反馈「音效很差，和预期差很多」。制作人给出的四种猜测（电子味 / 音量平衡 / 反馈弱 / BGM）**仅作为待验证假设**；本文所有判定均来自实际读到的代码与文件事实，不把猜测当证据。
> **用户拍板硬约束（本轮起生效，原样采信）**：① 音色难听刺耳；② 反馈感弱；③「不同场景的音效应该是有区分度的，但是现在我感受不到区分」。
> **风格靶子（用户原话）**：「同行的棋牌类游戏，比如微乐麻将，斗地主，微信小程序挖坑，三代等」。即**国内主流休闲棋牌小游戏**的听感——明快、脆、短、打点清楚、结果音有旋律动机；**不是**拟物沉浸、**不是**克制安静、**不是**电子科技风。
> 证据边界：**未试听任何音频文件、未做 iOS 真机、未做竞品 A/B 试听**。用户反馈是唯一的听感输入；下文「代码级确定」指结构缺陷可复算，「需听感复核」指方向建议须用户确认。

---

## 〇、取证口径（本轮实读事实）

| 项 | 本轮实测 |
|---|---|
| `pwa/js/sfx.js` | 401 行，逐行通读。`SYNTH_SPECS` **23 条**、`FILES` **6 条**、`SFX_NAMES` **5 条**、`PRIORITY` 21 条、`FAR_FIELD` 4 条 |
| 事件总数 | `SYNTH_SPECS` 与 `FILES` 的键并集 = **24 个实际音色条目**；其中 **只有 5 个有 mp3**（deal/select/submit/win/settle）+ 1 条 BGM，**18 个（75%）永远走纯振荡器合成** |
| `Sfx.play` 调用 | 全仓 **86 处**：`game.js` 58 / `accountView.js` 14 / `recordsView.js` 5 / `seatSheetView.js` 3 / `settleView.js` 3 / `achievementsView.js` 1 / `undoBar.js` 2 |
| 合成通路 | `sfx.js:189` 只 `createOscillator()` + `:190` 一个 `createGain()`，`:198` 直连 `c.destination`；**全仓再无第二个 `createGain`、无 BiquadFilter、无 Compressor、无 master bus** |
| 音量通路 | `sfx.js:328` mp3 一律 `a.volume = (far ? 0.5 : 1) * jitter(0.05)`；**规格 §四 给每个事件定的 0.18–0.80 音量表，一个都没进代码** |
| 解锁 | `game.js:5342-5343` 只绑 `touchstart` / `mousedown`；另在 `:3570` / `:3648` 显式调 `Sfx.unlock()` |
| 音频文件 | `ls -l` 实读：BGM 154,688 B；deal 2,239 / select 1,925 / submit 2,552 / win 12,113 / settle 26,010 B（与 v1 规格引用的帧头解析一致） |
| 版本 | `index.html:10` meta `app-version=20261120e`，`:1343` `sfx.js?v=20261120e` |
| SW | `sw.js:216-220` PRECACHE 只含 5 个旧命名 SFX；BGM 不进（该决策正确） |

### 〇·补　风格靶子：棋牌小游戏的音效共性，我们差在哪

> 下表的「共性特征」是从微乐麻将 / 斗地主 / 挖坑 / 三代这类国内主流休闲棋牌小游戏的通行音频做法归纳的**品类特征**，不是逐款试听结论（本轮未做竞品 A/B 试听，见 §八）。「我方现状」一栏全部可在本轮读到的代码中复核。

| 共性特征 | 竞品通行做法 | 我方现状（代码事实） | 差距性质 |
|---|---|---|---|
| **牌桌操作是「啪」的宽带瞬态** | 出牌 / 发牌 / 碰杠用短促硬瞬态（噪声主导，1–5 ms 起音），有塑料/木质的"打点"，60–150 ms 内收干净 | 18 个合成事件**全部**是单振荡器 sine/triangle + 频率滑音，无任何噪声瞬态（`sfx.js:189`）；`deal` 更是 520 Hz 下行滑音（`:60`） | 结构性缺失，不是调参问题 |
| **结果音是短旋律动机（jingle）** | 胡牌 / 胜利是 3–5 个音的固定短句，钟琴/木琴感，带尾音，0.8–1.5 s，一听就知道"赢了" | `win`=880 Hz 单音 0.9 s sweep 1.18；`champion_fanfare`=659 Hz 单音 1.1 s sweep 1.30；`achievement`=784 Hz 单音 0.8 s sweep 1.25（`:63/:80/:79`）——三个"大事件"是同一个「长三角波上行啾」 | 结果音无识别度，三者互相撞车 |
| **事件按频段分工，互不掩盖** | 操作在 1–4 kHz 瞬态区，主体在 300 Hz–1.2 kHz，结果音叠高频亮区 + 低频 body；频段错开所以同时响也不糊 | 全部事件挤在 420–1046 Hz（不到 1.3 个八度）、只有两种波形、无滤波（`sfx.js:59-83`；全仓无 BiquadFilter） | 区分度的物理前提不存在 |
| **音量层级一眼可辨** | 结果音最响、操作中等、UI 最轻，差 6–12 dB | 5 个 mp3 全以 `volume≈1.0` 播放（`:328`），synth 各自 0.10–0.32（`:60-82`），两套增益域从未校准 | P0-3 |
| **每个操作都有"力度"反馈** | 轻点轻响、重操作重响，音头硬、尾短、有 body | 零 attack（`:196` 直接 `setValueAtTime`）+ 无 body + 无瞬态 → 听感是"软绵绵的哔"，打点感弱 | P0-2 + P1-9 |
| **BGM 低存在感但不缺席** | 多为简单节奏床 / 五声动机，循环点干净，音量远低于 SFX | 9.67 s 无 gapless 循环 + 0.12 vs 1.0 的 17 dB 落差 + 硬 duck（P0-4/P0-5） | 存在感与品质双输 |

---

## 一、问题清单（按严重度排序）

> 严重度定义：**P0**＝直接决定「差」的主因，不修则任何调参都无效；**P1**＝明显拉低体感；**P2**＝打磨项 / 潜在风险。
> 维度列覆盖派单要求的七项：音色质感 / 音量与动态 / 反馈感与打击感 / BGM 存在感与品质 / 时机与同步 / 混音层次 / iOS 可用性。

### 1.1 P0 — 主因

| # | 维度 | 问题 | 代码证据（可复核） | 判定 |
|---|---|---|---|---|
| P0-1 | 音色质感 | **75% 的事件是「纯振荡器 + 频率滑音」的测试音**。user 说的「刺耳电子味」在代码层有确定来源：所有非资产事件都是单个 sine/triangle，唯一变化是 `sweep` 让频率指数滑到 0.82–1.30 倍——听感是「哔 / 啾 / 激光」，不是牌桌上的纸、木、短促金属。`deal` 的 `sweep:0.82` 是下行滑音，方向与「纸牌拍桌」完全相反。 | `sfx.js:59-83` 共 23 条 spec，所有 `type` 只有 `'sine'`/`'triangle'`；`:193-196` 只有 `setValueAtTime` + 可选 `exponentialRamp` 的频率包络；`:189` 只有 1 个 oscillator，无比噪、无滤波、无多振荡器叠加 | **代码级确定，且用户已明确确认「音色难听刺耳」**。竞品对照见 §〇·补；量化整改参数见 §4.4 |
| P0-2 | 音色质感 | **零 attack，每个合成音都带咔哒声**。`g.gain.setValueAtTime(gain, t)` 在 `t = c.currentTime` 把增益从 0 瞬间拉到满值——这是最典型的 pop/click 成因。连 25 处 `select` 兜底和 `error` 都是「硬起音」，外放时尤其刺。 | `sfx.js:188` `var t = c.currentTime`；`:196` `g.gain.setValueAtTime(gain, t)`，其后只有 `:197` 的指数衰减，**没有任何 ramp 到峰值的过程** | **代码级确定** |
| P0-3 | 音量与动态 | **规格的整张音量表没有落地，所有 mp3 都是 unity gain**。`select`（25 次、规格目标 0.35）和 `win`（规格目标 0.75）同样以 `volume≈1.0` 播放；本该最轻的 UI 点击和最响的结果音一样大。合成侧又各用 0.10–0.32 的独立 gain，两套增益域从未校准——「音量与平衡」的抱怨是结构问题，不是调一档总音量能解决的。 | `sfx.js:328`；对比 `audio-redesign-spec §四` 的逐事件音量列（0.18–0.80）在 `sfx.js` 中零命中；`:60-82` gain 0.10–0.32 只用于 synth | **代码级确定** |
| P0-4 | BGM 存在感与品质 | **9.67 秒循环 + `<audio loop>` 无 gapless**。MP3 不携带浏览器消费的 gapless 信息，每 ~9.7 秒一次接缝；同时 BGM `volume=0.12`（≈-18 dBFS）而 SFX 是 1.0（≈-1 dBFS），差 ~17 dB——iPhone 外放上 BGM 极易被听成「没有」或「只有一阵一阵的噪音」。 | `sfx.js:34` 单文件 `bgm_room_loop.mp3`、`:124-132` `makeAudio(..., loop=true)`、`:38` `BGM_VOL=0.12`；文件 154,688 B / 9.67 s（v1 帧头解析，本轮大小复算一致）；全仓无 `AudioBufferSourceNode.loopStart/loopEnd` | **代码级确定**；「听成没有」的程度需真机 |
| P0-5 | 混音层次 | **duck 是硬台阶，不是包络**。0.12 → 0.04 瞬间跳变、900 ms 后瞬间跳回；代码注释自己写着「attack 0.15 + hold 0.3 + release 0.6 的**粗粒度近似**」。每次结果音都把 BGM「掐一下再放开」，是明显的泵浦感，与「动态混音」的设计意图不符。 | `sfx.js:214-223`，`DUCK_HOLD_MS=900`（`:40`），`bgmVolume()` 直接赋值 `.volume`，无 `linearRampToValueAtTime` | **代码级确定** |

### 1.2 P1 — 明显拉低体感

| # | 维度 | 问题 | 代码证据 | 判定 |
|---|---|---|---|---|
| P1-6 | 时机与同步 / 混音层次 | **结果音在结算序列里叠成 3–4 层，且互相无互斥**。`settleView.js:506` 大牌型幕 `win(1.12)`，`:509` 首幕 `settle`，`:517` 后续幕再 `win`；同时 `game.js:560` 在结算屏出现 500 ms 后 `setTimeout` 播 `champion_fanfare` / `lose`。同一段 2 秒里可以有 win + settle + win + fanfare 同时响，全靠「同优先级不打断」硬扛。 | `settleView.js:499-518`、`game.js:546-560`；`PRIORITY` 中 win/settle/champion/lose 同为 1 级，`sfx.js:176` `if (v.level <= level) return` → 同级互不打断 | **代码级确定** |
| P1-7 | 混音层次 | **优先级打断只管合成声，不管 mp3**。`interruptBelow()` 只遍历 `activeVoices`（synth 声）；5 个真 mp3 播放时既不登记也不被停。所谓「优先级打断 + 混音」对最高频的真资产事件实际不生效。 | `sfx.js:165-181` `activeVoices` 只在 `synth()` `:200-201` 登记；`:323-334` 的 mp3 分支完全不触碰 `activeVoices` | **代码级确定** |
| P1-8 | 反馈感与打击感 | **3 变体对真资产无效，±3% 音高几乎听不出**。`nextVariant()` 算出的 `variant` 只传给 `synth()`（`sfx.js:191` 乘进频率），mp3 分支的 `rate` 只用 `pitch × jitter(0.03)`。±3% ≈ 半个半音，连点 `select` 的重复感基本没被治到；规格 §6.3 的「3 变体循环」在资产层是空转。 | `sfx.js:317` 算 variant；`:329` mp3 分支只设 `playbackRate = rate`；`:191` 仅 synth 用 variant | **代码级确定** |
| P1-9 | 反馈感与打击感 | **单一 Audio 元素抢占，连点会断音**。每个事件只有一个 `Audio`（`audioPool[name]`），重播靠 `a.currentTime = 0` 从头掐——前一次发声被硬截断，听感是「结巴」而非「连击」。 | `sfx.js:87` `var audioPool = {}`、`:136-142` 每名只建 1 个、`:326` `a.currentTime = 0` | **代码级确定** |
| P1-10 | 反馈感与打击感 | **最高频的负反馈 `error` 是 30 处调用 / 0 资产 / 0 变体的纯 520 Hz 三角波**。玩家「被拦下」这一高频动作，得到的只是一记短哔；没有任何下行二度、材质层或力度区分。 | `Sfx.play('error')` 在 `accountView.js` 6 处、`game.js` 23 处、`recordsView.js` 1 处（本轮 grep 计数，共 30）；`FILES`/`SFX_NAMES` 无 error；`sfx.js:65` 单条 spec | **代码级确定，且用户已明确确认「反馈感弱」**。量化整改参数见 §4.4 |
| P1-11 | 混音层次 | **远场只有 −6 dB 音量，没有低通**。规格 §三/§6.4 要求他人动作「低通 + 低 6 dB」；实现只在 `FAR_FIELD` 上把 gain/volume 乘 0.5，没有任何滤波——「自我 vs 他人」的空间分层没做出来，只是变轻了。 | `sfx.js:51-53`、`:192`、`:328`；全仓无 `createBiquadFilter`（本轮 grep 零命中） | **代码级确定** |
| P1-12 | 时机与同步 | **夺冠音固定在 `setTimeout(500)`，与画面事件不同栈**；若玩家在这 500 ms 内点走 / 切屏，声音仍会响在已经变了的画面上。倒计时的 1.02/1.04 递升音高又没进语义白名单，会被 ±3% 抖动冲掉（1.04 可能抖到 1.01）。 | `game.js:560`；`game.js:473-474` 传 1/1.02/1.04；`sfx.js:55` `SEMANTIC_PITCH = [1.12, 1.03, 0.97]` 不含它们，`:314-316` 因此仍加 jitter；`game.js:1790` 的 `1+(5-left)*0.02` 同理 | **代码级确定** |

### 1.3 P2 — 打磨与风险

| # | 维度 | 问题 | 代码证据 |
|---|---|---|---|
| P2-13 | iOS 可用性 | 解锁只绑 `touchstart`/`mousedown`，无 `click`/`keyup` 兜底；任何在这两类事件之前触发的 `play()` 都被 `if (!unlocked) return` 静默丢弃。辅助输入 / 键盘操作路径下可能全哑。 | `game.js:5342-5343`；`sfx.js:310` |
| P2-14 | iOS 可用性 | 后台回前台后 `AudioContext` 可能被系统 interrupt；`synth()` 里的 `c.resume()` 在非手势上下文被拒时异常被吞（`:185`），首声可能静默。另 iOS 静音拨杆下 `<audio>` 与 WebAudio 都无声是系统行为，当前无任何视觉/触觉兜底（iOS Safari 亦无 `navigator.vibrate`）。 | `sfx.js:185`、`:294-295`；`game.js` 无 `visibilitychange` 音频处理 |
| P2-15 | 反馈感与打击感 | `hold_toggle` 在 `SYNTH_SPECS` 有条目但全仓无 `Sfx.play('hold_toggle')` 调用（实际走 `ready(0.9/1.1)`）——死条目；`countdown_tick` 等未登记 `PRIORITY`，默认 3 级，与同类计时音 `split_tick` 的 2 级不一致。 | `sfx.js:82` vs 本轮 86 处调用中零命中；`sfx.js:43-49` PRIORITY 21 条不含 countdown_tick |
| P2-16 | 混音层次 | 打开/关闭开关对 BGM 是硬 `pause()` / 硬起 `play()`，无淡入淡出；两处开关状态同步正确，但切换瞬间的 pop 仍在。 | `sfx.js:349-363` |
| P2-17 | 工程债（非听感） | 若按方案新增资产，`sw.js:216-220` 的 PRECACHE 只登记 5 个旧命名文件，新文件会走网络、离线态不响；新增事件也未进 `SFX_NAMES` 就不会在手势内预热，重演 error 的处境。 | `sw.js:216-220`；`sfx.js:36` |

### 1.4 七维覆盖核对

| 维度 | 对应问题号 |
|---|---|
| 音色质感 | P0-1、P0-2 |
| 音量与动态 | P0-3、P0-5、P2-16 |
| 反馈感与打击感 | P1-8、P1-9、P1-10、P2-15 |
| BGM 存在感与品质 | P0-4 |
| 时机与同步 | P1-6、P1-12 |
| 混音层次 | P0-5、P1-6、P1-7、P1-11 |
| iOS Safari 可用性 | P0-4（部分）、P2-13、P2-14 |

> **新增维度**：用户拍板的第三痛点「场景 / 事件区分度」不在首轮七维清单内，属本轮新发现，独立展开于 §1.5，不并入上表凑数。

### 1.5 专项展开：场景 / 事件区分度（用户第三痛点，独立维度）

**方法**：把 23 个 `SYNTH_SPECS` 音色条目（另有 1 条 BGM 单列，不参与此表）按「实际音源 + 频率 + 波形 + 时长 + gain + sweep」列出，再看有多少个**听感上可分辨的轮廓**。全部取自 `sfx.js:59-83`；其中 5 个同时有真 mp3，其 synth 兜底参数可判定，但 mp3 本身未试听，不能对这 5 个彼此的相似性下结论。18 个 **synth-only** 事件（23 减去 5 个双源事件）是线上区分度问题的主力。

| 事件 | 音源 | freq | 波形 | dur | gain | sweep | 轮廓标签 |
|---|---|---:|---|---:|---:|---:|---|
| `deal` | mp3 + synth | 520 | triangle | 0.14 | 0.22 | 0.82 | 短中频下行「啾」 |
| `error` | synth ×30 | 520 | triangle | 0.12 | 0.22 | 0.94 | 短中频微下行「啾」 |
| `veto` | synth | 480 | triangle | 0.25 | 0.22 | 0.86 | 中频下行「啾」 |
| `split_timeout` | synth | 420 | triangle | 0.35 | 0.24 | 0.88 | 中低频下行「啾」 |
| `submit` | mp3 + synth | 440 | triangle | 0.21 | 0.24 | 1.12 | 中频上行「啾」 |
| `lose` | synth | 440 | triangle | 0.75 | 0.26 | 0.89 | 长中频下行「呜」 |
| `ready` | synth | 680 | triangle | 0.15 | 0.18 | 1.08 | 短中高频上行「啾」 |
| `hold_toggle` | synth（**死条目，无调用**） | 680 | triangle | 0.15 | 0.18 | — | 与 ready 完全相同 |
| `countdown_go` | synth | 1046 | triangle | 0.25 | 0.30 | — | 短高频「叮」 |
| `win` | mp3 + synth | 880 | triangle | 0.90 | 0.30 | 1.18 | 长高频上行「呜」 |
| `champion_fanfare` | synth | 659 | triangle | 1.10 | 0.32 | 1.30 | 长中频上行「呜」 |
| `achievement` | synth | 784 | triangle | 0.80 | 0.30 | 1.25 | 长中高频上行「呜」 |
| `select` | mp3 + synth | 760 | sine | 0.08 | 0.14 | — | 短高频「嘀」 |
| `countdown_tick` | synth | 880 | sine | 0.08 | 0.18 | — | 短高频「嘀」 |
| `split_tick` | synth | 720 | sine | 0.07 | 0.16 | — | 短高频「嘀」 |
| `peer_submit` | synth | 620 | sine | 0.20 | 0.14 | — | 中频「咚」 |
| `room_enter` | synth | 560 | sine | 0.20 | 0.16 | 1.06 | 中频「咚」 |
| `room_leave` | synth | 520 | sine | 0.20 | 0.16 | 0.90 | 中频「咚」 |
| `spectator` | synth | 600 | sine | 0.18 | 0.12 | — | 中频「咚」 |
| `emoji_receive` | synth | 1046 | sine | 0.12 | 0.14 | — | 短高频「叮」 |
| `emoji_send` | synth | 1046 | sine | 0.10 | 0.11 | — | 短高频「叮」 |
| `hint_guide` | synth | 700 | sine | 0.25 | 0.12 | — | 中高频「嘀」 |
| `settle` | mp3 + synth | 660 | sine | 0.95 | 0.20 | 0.94 | 长中频下行「呜」 |

**结论：23 个条目（含 5 个 mp3 双源）几乎全部塌缩成 4 个轮廓簇**——① 短高频「嘀/叮」（select / countdown_tick / split_tick / countdown_go / emoji_receive / emoji_send / hint_guide，7 个）；② 短中频「啾」（deal / error / veto / split_timeout / submit / ready，6 个；死条目 hold_toggle 与 ready 逐项相同）；③ 长中频上行「呜」（win / champion_fanfare / achievement / lose，4 个）；④ 中频「咚」（peer_submit / room_enter / room_leave / spectator，4 个）；余下 settle 为长中频下行「呜」，自成一簇但仍与③同语汇。竞品同等数量的事件通常有 8–10 个可辨声纹（出牌、发牌、碰、杠、胡、自摸、倒计时、轮到你、结算、提示）。**用户说「感受不到区分」，在代码层是必然结果，不是主观偏差。**

**具体撞车对（听感上几乎同一个音）**：

| 撞车组 | 参数重合点 |
|---|---|
| `deal` ↔ `error` | 同为 **520 Hz / triangle / gain 0.22**，只差时长 0.14 vs 0.12 s、sweep 0.82 vs 0.94；兜底路径下几乎无法分辨——而 error 有 30 处调用 |
| `select` ↔ `split_tick` | 760 vs 720 Hz sine、0.08 vs 0.07 s、gain 0.14 vs 0.16——几乎同一声 |
| `countdown_go` ↔ `emoji_receive` ↔ `emoji_send` | 同为 1046 Hz，只差波形（triangle/sine）与 0.10–0.25 s 时长 |
| `room_enter` ↔ `room_leave` ↔ `peer_submit` ↔ `spectator` | 全部「中频 sine、0.18–0.20 s」，频率只差 560/520/620/600 Hz |
| `ready` ↔ `hold_toggle` | 680 Hz / triangle / 0.15 s / gain 0.18 逐项相同 |
| `win` ↔ `achievement` ↔ `champion_fanfare` ↔ `lose` | 全是「长 triangle + 大跨度 sweep」；三件大喜事和一件落空共用同一语汇，与 v1 §三 想要的三向反差相反 |
| `error` ↔ `veto` ↔ `split_timeout` ↔ `submit`(synth) | 420–520 Hz triangle，区别只在 sweep 方向与时长 |

**场景层**：首页 / 房间 / 牌桌 / 结算**共用同一条 BGM**（v1 §7.2 的决策，保留）。这意味着**场景之间的听觉区分 100% 压在 SFX 上**；而 SFX 又塌成 4 个轮廓簇，且竞品常见的「房间安静 / 牌桌紧凑 / 结算释然」氛围层我们完全没有。场景区分度差是**结构性的双重缺口**：床不分层 + 事件不分层。

**资产层诚实边界**：5 个真 mp3 未试听，无法判定它们彼此是否撞车；但 ① 三个最小资产（deal 2.2 KB / select 1.9 KB / submit 2.5 KB）波形极简，承载独立声纹的余地有限；② error 30 处**永远**走 synth；③ 任一资产加载失败即落上表的撞车兜底。因此区分度问题不因「有 5 个 mp3」而缓解。

---

## 二、声音基调（修订版）

**按用户拍板，基调从 v1 的「克制、清醒、赌桌紧绷」调整为国内主流休闲棋牌小游戏的听感**：明快、脆、短、打点清楚、结果音一响就知道"赢了"。明确**不是**拟物沉浸（不追求真实牌桌的环境细节）、**不是**克制安静（不让低存在感的房间底噪当主角）、**不是**电子科技风（禁止纯振荡器滑音当最终音色）。v1 的「木、纸、短促金属」只保留"短、干、近距离收音"这一半，删掉"克制"。

本轮四条口径：

1. **先消灭「电子哔」，再谈情绪**。任何单个正弦/三角 + 频率滑音都不许作为最终音色出现。纯功能音至少要「瞬态噪声 + 一个主体音 + 低通」三层；结果音至少要「两音以上的音程 + 自然衰减尾」。这正是竞品「啪 / 叮 / 叮叮叮」语汇与本作「哔——啾」语汇的分界线。
2. **区分度是一等目标，不是附加题**。24 个事件必须收敛到**至少 8 个可辨声纹**；按上表 4 簇的现状，需要新增的是「频段分工 + 波形分工 + 音程/节奏轮廓」三个维度，不是把频率再挪几十 Hz。
3. **闭眼可辨的六类**：成了（submit/ready 上行闭合）、没成（error/veto 下行短促）、这一手漂亮（win）、我赢了整局（champion）、我落空（lose）、时间到（split_timeout）。当前六类里有四类共用同一种振荡器语汇。
4. **BGM 是床不是主角，但床必须存在**。9.67 秒的短循环 + 17 dB 的音量落差，让它既像噪音又不像音乐；先解决「接缝」与「可闻度」，再谈情绪。

**整体音量基准（线性 gain，素材先归一化到 −1 dBFS）**：结果音 0.60–0.70；操作音 0.40–0.50；UI 音 0.24–0.32；提示/状态音 0.28–0.40；远场一律 ×0.5 并加 1.2 kHz 低通；BGM 0.14（≈−17 dBFS），duck 到 0.05。

---

## 三、声音清单（逐事件改进方案）

> **音量**为改进后的目标 `Audio.volume` / WebAudio master gain 线性值（素材按 −1 dBFS 归一化）。
> **ADSR** 单位 ms，写成 `A/D/S/R`；one-shot 的 S=0，即总时长≈A+D。
> **资产策略**：`真`＝必须换真实资产；`合`＝WebAudio 合成即可做好，**不需要资产**；`留`＝现有资产保留。

### 3.1 S 级（决定品质感）

| 事件 | 现状 | 音色方向 | ADSR | 目标音量 | 资产策略 |
|---|---|---|---|---|---|
| `deal` 发牌/入槽/撤牌 | 2.2 KB mp3 + 下行滑音 synth | 6–12 ms 粉噪瞬态（带通 1.2–3.5 kHz）＋ 140 Hz 短 thud 给桌面重量；**去掉下行 sweep**；入槽/撤牌只改亮度不改音高以外的语义 | 3 / 90 / 0 / 0 | 0.45 | **真**（3 变体）；无资产时用「噪声+低通+thud」合成兜底，不再用纯三角波 |
| `select` 选牌 / 全站 UI | 1.9 KB mp3；25 处调用 | 圆润轻点击，2–4 ms 噪声瞬态 + 单音 880 Hz 以下；砍掉 3 kHz 以上尖刺；UI 与选牌分音量 | 2 / 55 / 0 / 0 | UI 0.26 / 选牌 0.32 | **合 或 真**（P2）；WebAudio 做「噪声瞬态+短音」完全能达标，不必迷信资产 |
| `submit` 提交/建房/报名 | 2.5 KB mp3 | 落定盖章感：瞬态 + 440→495 Hz 小幅上行（**上行不超过小二度**），固定不摇摆 | 3 / 160 / 0 / 0 | 0.50 | **留**（现资产可用，只改音量与变体轮转） |
| `win` 大牌型 / 每幕结果 | 12 KB mp3，承担 4 种语义 | 明亮上扬短庆祝，2–3 音同材质（木琴/拨弦），**不再覆盖夺冠与导出** | 6 / 180 / 0.45 / 350 | 0.62 | **真**（3 变体，与 champion 同材质但更短） |
| `settle` 结算落定 | 26 KB / 1.85 s，全仓仅 1 处 | 中性合账，一记低木/纸夹，缩到 0.8–1.2 s；**与 win 错开至少 250 ms** | 4 / 240 / 0.35 / 400 | 0.42 | 真（P2）或把现资产截短使用 |
| `bgm` 全程底床 | 9.67 s mp3 loop | 45–60 s，72–84 BPM，低频 pad + 稀疏弹拨、**无主旋律**；首尾各 0.5 s 相同 ambient tail；循环点落小节线过零点 | A 200 / D — / S — / R 200（淡入淡出） | 0.14，duck 0.05 | **真（P0）**：纯振荡器合成 pad 一定像测试音，这条必须用真资产 |
| `error` 被拦下 | 30 处 synth，520 Hz 三角波 | 中频下行小二度（如 560→520），两振荡器轻微失谐 + 2 ms 噪声瞬态；**3 变体 + ±3%** | 3 / 120 / 0 / 0 | 0.38 | **合**：功能性提示，改进后的 WebAudio 足够好。**本档修订 v1 §2.3 的「必须补 error 资产」——产能投给 BGM/结果音** |
| `lose` 我落空 | synth 440 Hz 下行 | 下行小二度 + 1.2 kHz 低通，不哀伤，只「落空」；与 win 材质相同、走向相反 | 8 / 220 / 0.4 / 480 | 0.50 | **真（P1）**；无资产时至少改成两音 + 低通合成 |

### 3.2 A 级（信息价值高，WebAudio 全部可做）

| 事件 | 音色方向 | ADSR | 目标音量 | 资产策略 |
|---|---|---|---|---|
| `countdown_tick`（3/2/1） | 节拍器逐拍收紧：主体 880 Hz 短音，逐拍把低通从 2 kHz 提到 4 kHz（**不用音高表达递进**，避开白名单问题） | 2 / 70 / 0 / 0 | 0.30 | 合 |
| `countdown_go` | 放行：1046 Hz + 五度叠音，一记短促上行 | 3 / 220 / 0 / 0 | 0.55 | 合 |
| `split_tick` 最后 5 秒 | 迫近感不是警报：720 Hz 短音 + 逐秒提亮，不用锯齿 | 2 / 60 / 0 / 0 | 0.28→0.40 | 合 |
| `split_timeout` | 明确收尾：420 Hz 下行三度 + 低通，同一轮只响一次 | 4 / 300 / 0 / 0 | 0.42 | 合 |
| `peer_submit` 他人提交 | 一记轻提醒，与自己的 submit 同材质、低通 + 远场 | 3 / 160 / 0 / 0 | 0.26（再 ×0.5 远场） | 合 |
| `room_enter` / `room_leave` | 温和「有人来了」/ 轻微下沉，远场低通 | 4 / 170 / 0 / 0 | 0.28（×0.5） | 合 |
| `ready` | 轻快确认，两音上行小三度 | 3 / 120 / 0 / 0 | 0.34 | 合 |
| `veto` | 社交性「被挡回」，与 error 区分：中低音 + 闷低通，不刺 | 4 / 210 / 0 / 0 | 0.40 | 合 |
| `spectator` | 中性低存在感 | 4 / 150 / 0 / 0 | 0.20 | 合 |
| `emoji_receive` / `emoji_send` | 社交小铃，3 变体；发送版降音量升调；远场低通只作用于 receive | 2 / 100 / 0 / 0 | 0.26 / 0.20 | 合 |
| `achievement` | 全站最亮的一下，3 音上行 + 空间尾 | 8 / 200 / 0.5 / 500 | 0.68 | 真（P2）；合也远好于现状单音 |
| `champion_fanfare` | 独立短号角 3–4 音，**与 win 不同音色**，结算后 300 ms 且与幕内 win 互斥 | 10 / 240 / 0.6 / 650 | 0.70 | **真（P1）** |

### 3.3 B 级（复用，不新增资产）

`add_bot`→`select`；`hold_toggle`→`ready(0.9/1.1)`；`hand_count_change`→`select(0.9)`；`dissolve_propose`/`next_round_signup`/`account_submit`→`submit`；`records_export`→`select(1.12)`（保留 v155 的语义修正）；`undo_bar`→`hint_guide`/`select(0.9)`；`account_error`→`error`（−3 dB）；`net_state`/`sound_toggle`/`version_refresh` 保持有意静默。**`hint_guide` 的音量必须比 UI 点击再低 4 dB**，否则引导出现时会打断阅读。

---

## 四、分层与触发规则（落地参数）

### 4.1 三层结构（每个音都要有瞬态）

| 层 | 实现 | 适用 |
|---|---|---|
| 瞬态层 0–12 ms | WebAudio：短噪声 buffer（`AudioBufferSourceNode`）过 bandpass 1.2–3.5 kHz，gain 包络 2–4 ms 起、8–12 ms 落。**这是治 P0-1/P0-2 的关键，且不依赖任何 mp3** | 全部 one-shot |
| 材质层 10–120 ms | 1–2 个振荡器 + 一个 BiquadFilter（lowpass 1.2–4 kHz）；远场事件把截止频率压到 1.2 kHz | deal/select/error/veto/room_* |
| 情绪层 80 ms–尾 | 两音以上音程 + `linearRampToValueAtTime` 的真 release；只在结果类出现 | win/lose/settle/achievement/champion/split_timeout |

**硬规则**：任何 one-shot 的 gain 必须 `setValueAtTime(0, t)` → `linearRampToValueAtTime(peak, t + A)`（A ≥ 2 ms）→ `exponentialRampToValueAtTime(0.0001, t + A + D)`。**禁止** `setValueAtTime(gain, t)` 的零起音写法。

### 4.2 触发与去重（修订 v1 §6.2）

```
发牌：   onDeal(i) → play('deal')，逐张用 80 ms 间隔的 element pool，不再靠音高递升
语义音高：只保留 1.12（大牌型）/ 1.03（入槽）/ 0.97（撤牌）三项白名单；
         倒计时与 split_tick 的递进改用滤波亮度，不再传 1.02/1.04/1.06/1.08
结果音： 同一结算序列只播一次「按我名次」的结果音（champion_fanfare / lose）；
         大牌型幕的 win 在特写起手同帧播；幕间 win 与之互斥（同一 1.6 s 内不叠）
         settle 与任何 win 错开 ≥250 ms
倒计时： 与 num.textContent 更新在同一同步栈（现状已正确，保留）
error：  与 select 加 60 ms 互斥窗口；error 抢占并取消同帧 select
他人音： 统一远场 = gain ×0.5 + lowpass 1.2 kHz；同一秒最多 1 次（现状节流保留）
节流：   同一事件 500 ms 内最多 2 次，第 3 次起强制换变体并 −2 dB
元素池： 每事件 2–3 个 Audio 轮转，替代 a.currentTime=0 的硬抢占
```

### 4.3 变体与随机化

- 真资产事件：每事件 3 变体循环 + 随机起始索引；**3 变体必须是不同录音**，不是 ±3% 变调。
- 合成事件：3 组「失谐量 / 滤波截止 / 瞬态 seed」组合轮转，等价于音色变体；±3% 音高 / ±5% 音量抖动保留。
- 语义音高（1.12 / 1.03 / 0.97）不抖动；其余全部现算。

### 4.4 针对「刺耳」与「反馈感弱」的量化整改参数（用户硬约束）

#### A. 刺耳：六个来源逐个量化

| 来源 | 现状参数（代码） | 改为 |
|---|---|---|
| 零起音咔哒 | `g.gain.setValueAtTime(gain, t)`，`t = c.currentTime`（`sfx.js:188/196`） | 主体音 `setValueAtTime(0,t)` → `linearRampToValueAtTime(peak, t+A)`；**A：UI/操作 4–8 ms，结果音 8–12 ms，噪声瞬态 1–2 ms** |
| 频率滑音过大 | deal `sweep 0.82`（≈−340 cents）、champion `1.30`（+454 cents）、achievement `1.25`（+422 cents）——「啾」的主因 | UI / 操作音**取消 sweep**；结果音 sweep ≤1.06（±100 cents），改由 **2–3 音音程**（如 G4–C5–E5，间隔 90–120 ms）表达情绪 |
| 无滤波 | 全仓 0 个 `BiquadFilter` | 所有 one-shot 串 `lowpass`，**cutoff：UI/操作 3.5–4 kHz（Q=0.7）；结果音 6 kHz；远场 1.2 kHz**；5 kHz 以上加 high-shelf −6 dB |
| 高频瞬态过亮 | mp3 1.9–2.6 KB 极短波形，高频 click 无控制 | 噪声瞬态 `bandpass`，**center 1.2–3.5 kHz、Q=0.8–1.2**，禁止 >4 kHz；瞬态峰值占单音总峰值 40–60% |
| 峰值无上限 | synth gain 0.10–0.32 直连 `c.destination`，无 compressor | **masterGain 0.9 → DynamicsCompressor（threshold −12 dB / knee 6 / ratio 4 / attack 3 ms / release 120 ms）**；单音 peak ≤0.70 |
| 多声叠加削波 | 同级不打断，结算可叠 3–4 声（P1-6） | 结果音互斥 + 元素池 + 500 ms 节流（§4.2） |

#### B. 反馈感弱：按"力度层级"给打点参数

| 层级 | 瞬态层 | 主体层 | body / 尾 | 总时长 | peak |
|---|---|---|---|---:|---:|
| 轻 UI（`select` / hint） | 1–2 ms 噪声，bandpass 2–3.5 kHz，瞬态 peak 0.25 | 880 Hz sine，A 4 ms / D 50 ms，lowpass 3.5 kHz | 无 | 60–90 ms | 0.26 |
| 操作（`deal` / `submit` / ready） | 2 ms 噪声，bandpass 1.2–3 kHz，瞬态 peak 0.45 | 300–600 Hz triangle，A 5 ms / D 100 ms，lowpass 2.5 kHz | **140 Hz sine × 30 ms / gain 0.25**（桌面重量） | 120–200 ms | 0.45–0.50 |
| 阻断（`error` / `veto` / timeout） | 2 ms 噪声，瞬态 peak 0.35 | 560→520 Hz 两个振荡器**失谐 ±4 cents**，lowpass 1.5 kHz，A 4 ms / D 110 ms | **180 Hz × 25 ms** | 120–180 ms | 0.38 |
| 结果（`win` / champion / achievement） | 3–5 ms 噪声，瞬态 peak 0.50 | **3 音音程**（G4–C5–E5 或 C5–E5–G5，间隔 90–120 ms），木琴/钟琴式 A 6 ms / D 180 ms | **100–160 Hz × 60 ms** + release **300–600 ms**（feedback delay 混响可合成） | 0.8–1.3 s | 0.62–0.70 |
| 时间提示（`split_tick`） | 1 ms click，peak 0.20 | 720 Hz sine，A 3 ms / D 60 ms；**逐秒把 lowpass 从 2 kHz 提到 4 kHz**（不用音高递进） | 无 | 70 ms | 0.28→0.40 |

> 以上参数在 WebAudio 里用 `OscillatorNode` + `AudioBufferSourceNode`（噪声）+ `BiquadFilterNode` + `GainNode` 四件套即可实现，**不需要任何 mp3**。这是本轮「无 ffmpeg + 不授权安装」约束下的主路径。

---

## 五、混音架构

### 5.1 总线与响度

```
MASTER（WebAudio 侧：masterGain 0.9 → DynamicsCompressor
        threshold -12 dB / knee 6 / ratio 4 / attack 3 ms / release 120 ms → destination）
 ├─ SYNTH_BUS  error / countdown_* / split_* / room_* / peer_submit / emoji_* / hint / ready / veto ...
 ├─ 资产音效由 <audio> 播放，无法直接进 WebAudio 总线：
 │    → 用逐事件 VOL 表 + 2–3 元素池 + 结果音互斥实现同等控制
 │    → 若后续要统一总线，需 createMediaElementSource，但会引入 iOS 手势/上下文风险，本轮不建议
 └─ BGM_BUS   <audio loop> volume 0.14，duck 0.05
```

- **素材归一化**：所有新交付文件自身峰值 −1 dBFS。**不要把响度责任推给 `Audio.volume`**——同一部手机上不同事件的差值必须由 VOL 表控制，不能靠素材各自的随机电平。
- **通道分工要诚实**：`interruptBelow` 目前只管 synth（P1-7）。修正版要么把 mp3 也登记进 activeVoices 并可停止，要么明确「资产层不做打断，只做互斥 + 元素池」，不要留下「有优先级但不管主音源」的中间态。

### 5.2 Duck 与淡变（替换 `sfx.js:214-223` 的硬台阶）

| 动作 | 现状 | 改为 |
|---|---|---|
| BGM duck | 0.12 → 0.04 瞬间 | `linearRampToValueAtTime(0.05, t+0.12)`（attack 120 ms） |
| hold | 固定 900 ms | 250 ms，期间不再重置 |
| release | 0.04 → 0.12 瞬间 | `linearRampToValueAtTime(0.14, t+0.50)`（500 ms） |
| 开关切换 | 硬 pause / 硬 play | BGM 200 ms 淡出 / 淡入后再 pause / play |

### 5.3 iOS Safari 专项

1. `unlock()` 除 `touchstart`/`mousedown` 外，补 `click` 与 `keyup` 各一次（capture、passive、once），并保留 `openCreateModal` / 加入房间处的显式调用。
2. `visibilitychange` → 回前台时**不自动** `ctx.resume()`；挂到下一次用户手势里做一次性 resume，避免系统拒绝后静默吞异常。
3. iOS 静音拨杆下无声属系统行为，不绕过；在开关图标旁用文案区分「系统静音中」与「游戏内声音关闭」，并给关键结果音配视觉反馈（ iOS Safari 无 `navigator.vibrate`，不要依赖震动）。
4. BGM 保持懒加载、不进 PRECACHE（v1 决策正确）；但首手势到 BGM 起声之间会有 1–2 s 空窗，可用一次极轻的 `room_enter` 类合成音填补「已响应」的感觉——**不要**用长音填。
5. 新增资产必须同时进 `FILES` + `SFX_NAMES` + `sw.js` PRECACHE；缺任何一处都会重演 error（无预热）或离线静默。

---

## 六、音频规格与命名

### 6.1 技术规格

| 项 | SFX | BGM |
|---|---|---|
| 交付 | MP3 44.1 kHz / 96 kbps / mono | MP3 44.1 kHz / 64–96 kbps / mono |
| 峰值 | −1 dBFS 归一化 | −1 dBFS 归一化，播放时降到 0.14 |
| 时长 | 0.06–1.3 s（结果音 ≤1.3 s） | 45–60 s，首尾 0.5 s 同 ambient tail |
| 缓存 | 全部进 PRECACHE（短音压缩常驻） | 懒加载，不进 PRECACHE |
| 循环 | 不循环 | `<audio loop>` 时首尾各 20–30 ms 静音拼接做假 gapless；更优是 `AudioBufferSourceNode.loopStart/loopEnd`（本轮不改架构） |

命名沿用 v1 §8.2：`SFX_<类别>_<名称>_<变体>.mp3` / `BGM_<场景>_loop_v<版本>.mp3`。旧 5 个文件名不再新增变体；版权信息写 `docs/ATTRIBUTION.md`，不写进文件名。

### 6.2 最小资产清单（文件名 ｜ 用途 ｜ 时长 ｜ 音色要求 ｜ 优先级）

| # | 文件名 | 用途 | 时长 | 音色要求 | 优先级 |
|---|---|---|---|---|---|
| 1 | `BGM_room_loop_v2.mp3` | 首页/房间/牌桌/结算全程底床 | 45–60 s | 72–84 BPM，低频 pad + 稀疏弹拨，**无主旋律**；首尾可无缝拼接；−1 dBFS | **P0** |
| 2 | `SFX_ACTION_deal_v1..v3.mp3` | 发牌 / 入槽 / 撤牌 | 0.12–0.20 s | 6–12 ms 纸片噪声瞬态 + 140 Hz 桌面 thud，干、近场；3 条为不同录音 | **P1** |
| 3 | `SFX_RESULT_champion_v1.mp3` | 我夺冠 | 0.9–1.3 s | 3–4 音上行短句，木琴/拨弦/钟琴，温暖不刺耳，自然衰减尾 | **P1** |
| 4 | `SFX_RESULT_win_v1..v3.mp3` | 大牌型 / 幕结果 | 0.8–1.2 s | 明亮上扬短庆祝，与 champion 同材质但更短更轻 | **P1** |
| 5 | `SFX_RESULT_lose_v1.mp3` | 我落空 | 0.6–0.9 s | 下行小二度 + 低通，不哀伤；与 win 材质相同、走向相反 | **P1** |
| 6 | `SFX_RESULT_achievement_v1.mp3` | 成就解锁 | 0.6–0.9 s | 全站最亮的一下，铃/铃声簇 + 空间尾 | P2 |
| 7 | `SFX_UI_select_v1..v3.mp3` | 选牌 / 全站 UI | 0.06–0.10 s | 圆润轻点击，无 3 kHz 以上尖刺 | P2（可用改进合成顶替） |
| 8 | `SFX_RESULT_settle_v1.mp3` | 结算落定 | 0.8–1.2 s | 中性合账，一记低木/纸夹；替换现 1.85 s 长音 | P2 |

**明确不须要资产的**：`error`、全部倒计时/超时、room_*、peer_submit、ready、veto、spectator、emoji_*、hint_guide、hold_toggle。这些用 §4.1 的三层合成能做得比现在好得多；把产能投到 BGM 与结果音上，收益高一个数量级。

### 6.3 无 ffmpeg / 不授权系统安装时的取得路径

1. **免费下载（BGM 与结果音首选）**：`Kenney.nl`（Interface Sounds / Card & Casino 包，**CC0**、免署名可商用，直接给 mp3）；`Freesound.org` 逐条只看 CC0 或 CC-BY（CC-BY 记入 `docs/ATTRIBUTION.md`；**CC-BY-NC / ND 一律不采**）；`Pixabay Sounds` / `Mixkit` 按下载当日许可页存档截图。/*.ogg 谨慎——Safari 对 OGG 支持不可靠，优先下 mp3。
2. **代码合成（功能音与占位）**：本机 Python 3.13 可用。用标准库 `wave` + `math` 生成 WAV 母版（粉噪瞬态 + 双振荡器 + 指数衰减，即 §4.1 的三层），再用 `python -m pip install --target /tmp/lxw-audio-tools lameenc` 在临时目录编码为 MP3——**不写入 `package.json`、不改系统 PATH、不装系统级 ffmpeg**。纯正弦 BGM 不要走这条路，听感必然像测试音。
3. **用户自备**：由提供方书面声明可商用、可修改，再按 §6.1 归一化与命名。适合用户已有心仪音效库的情形。
4. **不采的路**：下载 mp3 原样改名当自制资产；用 `MediaRecorder` 在浏览器里导出 webm/opus 当交付格式（Safari 兼容性不可靠）。

### 6.4 WebAudio 合成能不能做出「棋牌小游戏质感」？（诚实边界）

不迷信资产，也不硬撑合成。按事件分三档：

| 档 | 事件 | 结论 |
|---|---|---|
| **合成完全够，且比现有 mp3 更 clean** | 出牌/发牌的「啪」、`select`、`error`、倒计时滴、`split_tick`/`timeout`、`room_*`、`peer_submit`、`ready`、`veto`、`spectator`、`emoji_*`、`hint_guide` | **可以**。用 §4.4 的「噪声瞬态 + 主体振荡器 + lowpass + body」四件套，能做出微乐/斗地主那类明快硬打点；不受 ffmpeg 约束、零下载、包络可精确控制。**这一档不必等资产，直接合成即可。** |
| **合成能做出形，但质感有上限** | `win` / `champion_fanfare` / `achievement` / `lose` 的短旋律动机 | **部分可以**。3 音音程 + 包络 + 反馈延迟混响，能做出"赢了"的识别度，远好于现在的单音啾；但音色偏电子/卡通，**达不到真人采样钟琴/木琴的暖尾**。若用户验收后认为"还是不像微乐/斗地主"，这一档必须换真资产（P1）。 |
| **合成达不到，别硬撑** | BGM（45–60 s 有情绪的音乐床）、牌桌氛围层 | **不可以**。纯振荡器 pad 必然像测试音。这条只能用真资产（P0）或保持无 BGM；不要为了「零资产」硬合成一条音乐。 |

**总判断**：在「无 ffmpeg + 不授权系统安装」约束下，**优先 WebAudio 合成可达方案是可行的**，且对本次三个痛点里的「刺耳」「反馈感弱」「区分度」都能直接起效（区分度靠频段/波形/音程分工，不靠买素材）。唯一必须外部取得的是 **BGM（P0）**；其次是结果音 jingle（P1，合成验收不过再买）。把产能全部投给这两类，其余 20+ 事件走合成——把钱花在 error / 倒计时 / 入房提示上是浪费。

---

## 七、实施顺序与验收要点

**建议顺序**（每步都可独立回滚，且不需要先有资产）：
1. **零资产、纯代码**：修 P0-2（attack ramp）、P0-3（VOL 表）、P0-5（duck 包络）、P1-6（结果音互斥）、P1-8（变体轮转对合成生效）、P1-11（远场低通）。这一步就能把「电子哔 + 咔哒 + 没有层次」消掉大半。
2. **新增合成层（棋牌质感的真正落点）**：按 §4.4 的噪声瞬态 + BiquadFilter + body，把所有 one-shot 升级为三层；error / 倒计时 / 分牌 / room_* 一并改；把 §1.5 列出的**七组撞车对按频段/波形拆开**——这是让「场景有区分度」起效的最小动作。
3. **P0 资产**：BGM 45–60 s 真资产 + 无缝循环；deal ×3；champion / win ×3 / lose。
4. **P2 资产与打磨**：achievement / select ×3 / settle 截短；开关淡变、解锁兜底、SW PRECACHE 同步。

**验收要点**（用户可感知，不是代码门禁）：
1. **风格靶**：与微乐麻将 / 斗地主那类听感对照，结果是「明快、脆、短、打点清楚」的棋牌小游戏音，不是测试音 / 电子哔；请用户按这个靶子判，不要按「有没有声音」判。
2. **区分度靶**：手机外放 50% 音量，闭眼能分清「成了 / 没成 / 这一手漂亮 / 我赢了整局 / 我落空 / 时间到」六类；并随机抽 10 个事件，能说出至少 8 种不同声纹（现状只有 4 种）。
3. 任意音**起音无咔哒**；同一动作连做 10 次，音高与音色不完全一致；连点 select 不结巴。
4. BGM 连听 3 分钟听不出接缝；结果音出现时 BGM 是「柔和让位」而不是「被掐掉」。
5. iPhone Safari：首次手势后 BGM 起；被拒后下一手势补起；关→开开关有声且有淡变；静音拨杆下有明确视觉状态。**必须真机验，代码级推断不算通过。**

---

## 八、证据边界

- 本轮只读 `pwa/js/sfx.js`、全部 `Sfx.play` 调用点、`sw.js`、`index.html` 版本号、三份 2026-11-20 文档；**未改任何代码、未生成资产、未起服务、未跑浏览器**。
- 文件时长/码率沿用 v1 引用的帧头解析（本机无 ffprobe），本轮只复算了文件大小；「9.67 s 循环」的结论建立在 v1 解析值上。
- **未试听任何音频、未做 iOS 真机、未做竞品 A/B 试听**。§〇·补 的「共性特征」是从品类通行做法归纳，不是对微乐麻将 / 斗地主 / 挖坑 / 三代的逐条听测结论；P0-1 的「刺耳」判定基于代码构造（零起音 + 单振荡器滑音 + 无滤波），且**用户已明确确认该痛点**。所有音色方向建议须经用户/制作人试听确认后才进入资产生产。
- 制作人首轮四猜：「音色刺耳电子味」在代码层得到支持（P0-1/P0-2）；「音量与平衡」得到支持（P0-3/P0-5）；「反馈感弱」得到支持（P1-8/9/10）；「BGM 或时机不对」得到部分支持（P0-4 确定，P1-12 的时机问题独立成立）——**这四条是从代码独立复算出来的，不是复述猜测**。
- 用户拍板的三条硬约束与上述复算一致；其中「场景区分度」已在 §1.5 展开为独立维度并给出七组具体撞车对——这是首轮四猜里**没有被覆盖**的新增问题，属于本轮新发现。

---

*本诊断由音效总监雷鸣远出具，2026-11-20。只诊断与出方案，不构成对生产代码的修改授权。*
