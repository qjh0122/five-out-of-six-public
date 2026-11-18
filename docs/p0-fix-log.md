# P0 UI 一致性整改实施日志（2026-11-19）

> 基线：HEAD `66f53db`，线上 `20261119a` / sw `v151`。
> 实施范围：只改产品代码与对应测试守卫；4 份 `docs/ui-audit-*` / `ui-consistency-audit-*` 审查报告、`release-progress.md`、`INDEX.md`、memory 一律未动。
> 未 commit / 未 push；按要求**未跑 `npm test`**，只单跑受影响测试文件（数字见 §二），全量由制作人补跑。

---

## 一、八项逐项交付

### P0-1 · 冠军净胜两套答案

**改了什么**

- `pwa/css/style.css:3263-3267`：`.sc-name` 40px → `var(--num-3)`（32px）；`.sc-net` 30px 金色 → `var(--num-2)`（48px）+ 中性默认色；新增 `.sc-net.up/.down/.flat` 三态。
- `pwa/js/settleView.js:674-676`：冠军块净胜改为 `el('p', 'sc-net ' + netCls(top.score), …)`，颜色与名次表/战绩卡/排行榜共用 `netCls` 三态。
- 结果：名次表「名字 28 < 净胜 48」，冠军块「名字 32 < 净胜 48」，层级方向一致；同一个数只有一套字号和颜色。

**配套守卫**：`pwa/test/number-scale.test.js`
- `NUMERIC_SELECTORS` 补进 `.sc-net`（此前白名单漏它，30px 才一直没人管）；
- `[3]` 节新增：`font-size(.sc-net) === font-size(.settle-row.champion .settle-net)`、两者必须是 `var(--num-2)`、`.sc-name` 必须低一档 `var(--num-3)`、JS 必须走 `netCls(top.score)`、三种颜色规则各一条。

**变异自证**（`.sc-net` 改回 `30px` → 红，恢复 → 绿）：

```
=== RED: sc-net 30px ===
  FAIL  number-scale.test.js:177:3  ★★ 违规条数为 0  -> got 1 want 0  |  style.css .sc-net → 必须是 var(--num-*)，实际写的是 30px
  FAIL  number-scale.test.js:197:3  ★★ 冠军块净胜与名次表冠军 computed 取值同档（改回 30px 必须红）  -> got "30px" want "var(--num-2)"  |  30px vs var(--num-2)
  FAIL  number-scale.test.js:199:3  ★ 冠军块净胜走 T2  -> got "30px" want "var(--num-2)"
通过 53 项，失败 3 项
=== GREEN: restored ===
通过 56 项，失败 0 项
```

---

### P0-2 · 回放弹窗两个名字

**改了什么**

- `pwa/index.html:569`：`<h2 id="replay-title">本场过程</h2>` → 「本局过程」（按钮 `:536` 原本就是「本局过程」，不动按钮）。
- `pwa/js/recordsView.js:129`：aria-label 「这一场的牌面过程」→「这一局的牌面过程」。

**配套守卫**：`pwa/test/ui-copy-consistency.test.js [1]`——按钮/标题/aria-label 三处都断言，并扫描全部 JS 字符串里不得出现「本场过程 / 这一场的牌面过程」。

**变异自证**（标题改回「本场过程」→ 红，恢复 → 绿）：

```
=== RED: P0-2 弹窗标题改回本场 ===
  FAIL  ui-copy-consistency.test.js:90:3  ★★ 弹窗标题与按钮同名（改回「本场过程」必须红）
通过 19 项，失败 1 项
=== GREEN: P0-2 弹窗标题改回本场 restored ===
通过 20 项，失败 0 项
```

---

### P0-3 · `--text-main` 零定义

**改了什么**

- `pwa/css/style.css:28-31`：`:root` 补 `--text-main: #f5f0e6;`。值取现网 `body { color:#f5f0e6 }`（现 `:130`）实际继承色，语义是「深底主文字」；与纸面暖白 `--warm-white: #FFF7E8` 刻意不同，不复用后者。
- 原 4 处引用仍在（现 `:1004 / :3263 / :3333 / :3363`），现在有确定值，不再依赖继承偶然。

**配套守卫**：`pwa/test/design-tokens.test.js [6]`——扫四个 CSS 文件的所有 `var(--x)`，必须命中 CSS 定义或**显式** JS 注入白名单（27 项：`--vp-h/--pt-scale/--ls-scale/--sa-*/--tap-min/--gt-h/--seat-*/--emo-*/--ss-origin/--slot-color/--slot-soft/--fx-color/--fx-ring/--hold/--tail-off/--nmw/--a/--d/--r/--pc`）。白名单每项都必须在 JS 源里找得到 `setProperty` 或内联 `--x:`，防止写成永不命中的免责声明。另有专门断言钉死 `#f5f0e6` 这个值。

**变异自证**（删掉定义 → 红，恢复 → 绿）：

```
=== RED: --text-main 定义被删 ===
  FAIL  design-tokens.test.js:268:3  ★★ 所有 var() 都能解析到 CSS 定义或 JS 注入白名单  -> got 1 want 0  |  --text-main
  FAIL  design-tokens.test.js:269:3  ★★ --text-main 在 :root 明确定义为现网继承色 #f5f0e6（删掉定义此条必须红）
通过 40 项，失败 2 项
=== GREEN: restored ===
通过 42 项，失败 0 项
```

---

### P0-4 · 9 处裸外投影

**改了什么**（就近取档，**保留第 1 层的 inset 边 / 状态环在前**）

| 位置（最终行号） | 原第 2/3 层 | 改为 |
|---|---|---|
| `style.css:643` | `0 8px 18px rgba(0,0,0,.16)` | `var(--elev-1)` |
| `style.css:979` | `0 18px 40px rgba(0,0,0,.28)` | `var(--elev-3)` |
| `style.css:1310` | 第 3 层 `0 18px 46px rgba(0,0,0,.34)` | `var(--elev-3)` |
| `style.css:1737` | `0 10px 22px rgba(0,0,0,.20)` | `var(--elev-2)` |
| `style.css:1743` | `0 10px 24px rgba(0,0,0,.4)` | `var(--elev-2)` |
| `style.css:2145` | `0 6px 14px rgba(0,0,0,.16)` | `var(--elev-1)` |
| `style.css:3466` | `0 12px 30px rgba(0,0,0,.42)` | `var(--elev-2)` |
| `style.css:4887` | `0 6px 18px rgba(15,43,34,.22)` | `var(--elev-1)` |
| `pwa/js/cardView.js:199` | JS 内联 `0 16px 32px rgba(0,0,0,.45)` | `var(--elev-2)` |

**配套守卫**：`pwa/test/design-tokens.test.js`
- `isElevation()` 由「只看第 1 层」改为**逐层** `layers(v).some(...)`：任一层具备「x=0、y>0、blur>0 且非 var/inset/氛围豁免」即违规；
- 显式豁免写进注释：`var(--elev-*)` / `var(--edge-*)`（已归位高度与纸边）、`inset ...`（内描边/内高光/色条）、`y=0`（状态环/发光）、`blur=0`（实体按钮下沿）、以及 3 条按字面值列出的带色氛围投影（绿 `0 4px 12px rgba(67,209,124,.24)`、金 `0 12px 24px rgba(245,193,92,.45)`、金 `0 4px 12px rgba(245,193,92,.35)`）；并断言这 3 条仍在 CSS 里，避免豁免变成僵尸白名单；
- 新增 `[7]`：扫全部 `pwa/js/*.js` 的 `box-shadow:` 内联字面量（此前 CSS 守卫根本不读 JS），要求 0 条裸外投影且 `cardView.js` 走 `var(--elev-2)`。

**变异自证**（第 2 层塞 `inset …, 0 10px 24px rgba(...)` → 红，恢复 → 绿）：

```
=== RED: inset + 第2层裸投影 ===
  FAIL  design-tokens.test.js:192:3  ★★ 没有一条外投影是手写字面量（全部来自 --elev-*）  -> got 1 want 0  |  style.css: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 10px 24px rgba(0, 0, 0, 0.4)
通过 41 项，失败 1 项
=== GREEN: restored ===
通过 42 项，失败 0 项
```

---

### P0-5 · 量词契约

**契约**：**把 = 单次发牌（含两轮）**，**局 = 建房到结束的一整场**。样板仍是 `pwa/admin.html:799/803`。

**改了什么**

- `pwa/index.html:668`（`0 场`→`0 局`）、`:697`（单场最高→单局最高）、`:702/:706`（胜负平记录的 `场`→`局`）、`:713/:720`（最近 10 场→局，含 aria-label）、`:896`（当前 0 场记录→局）；`:728`「共 0 局」保持。
- 关键：**运行时覆写这些节点的 JS 也必须改**，否则只改静态 HTML 是假修复：
  `pwa/js/recordsView.js:96`（趋势 aria-label）、`:637-638`（共 N 局 / 列表近 N 局）、`:654-655`（含 AI 的 N 局）、`:847`（场次→局数）、`:955`（分享图 `第 N 场` 实为单把 → 第 N 把）、`:1220`（整场→整局）、`:1591`（榜单 N 局）、`:1819` / `:1875`（清除 N 局记录）。
- `game.js:1073`「这一局你在旁边看」与 `:3642`「这一把你不打」**刻意保留不改**：前者描述整局旁听状态，后者描述单次发牌退出，正是契约的两个不同语义，不是漂移。
- `pwa/test/ui.test.js:312-333`：把断言里的「单场最高」口径同步为「单局最高」（仅文案，断言数不变）。

**配套守卫**：`ui-copy-consistency.test.js [2]`——扫 HTML 可见文本（剥 HTML 注释）与全部 JS 字符串，同一统计口径出现「最近 N 场 / 单场最高 / 共 N 场 / 列表近 N 场 / N 场记录 / 第 N 场」即红；同时断言静态与运行时两处都写「局」、「一把两轮」契约样板在、两处刻意保留的把/局文案都在。

**变异自证**（静态「共 0 局」改回「共 0 场」→ 红，恢复 → 绿）：

```
=== RED: P0-5 静态量词改回场 ===
  FAIL  ui-copy-consistency.test.js:100:3  ★ 战绩列表静态空态写「共 0 局」
  FAIL  ui-copy-consistency.test.js:104:3  ★★ HTML 可见文案里同一战绩口径不再出现「场」  -> got 1 want 0  |  /共\s*\d+\s*场/
通过 18 项，失败 2 项
=== GREEN: P0-5 静态量词改回场 restored ===
通过 20 项，失败 0 项
```

---

### P0-6 · 禁用词清零

**改了什么**（统一按 `design-states-v1.md §②-b`：说清后果与下一步动词）

- `pwa/js/game.js:411/1027/3641/3661`：`'操作失败'` → `'这步没成功，房间没变化，再点一次'`；`:4939`：`'网络异常，稍后再试。'` → `'成就列表没读上来，回首页再点一次「成就」重读。'`。
- 审查只列了 5 处，但规格口径是「任何玩家可见位置」，因此把其余玩家可见 JS 字符串一并清零：`pwa/js/accountView.js:87/516`、`authStore.js:95`、`recordsView.js:808/820/1862`、`roomStore.js:614`、`seatSheetView.js:323`，文案分别说明「账号信息没变 / 战绩还在 / 数据还在 / 房间没变化 / 关掉面板重新打开」等后果与具体动词。
- `pwa/admin.html:504/667` 是后台非玩家可见，顺手改掉（「连不上后台服务 / 用户状态没变」）。
- 注释里的「请求失败 / 网络异常 / 操作失败」不是玩家可见文案，保留不动——这正由守卫的注释剥离来验证。

**配套守卫**：新增 `pwa/test/ui-copy-consistency.test.js [3]`——自带带引号字符串扫描器（跳过单行/块注释），扫描 `pwa/js/*.js` 所有字符串，禁用词表 `操作失败|请稍后重试|网络异常|请求失败|系统繁忙|错误码 1023` 命中数必须为 0；后台 `admin.html` 明确不在扫描面。扫描器先自测：注释里的禁用词不算、字符串里的算、普通文案不误伤；并要求扫到 >300 条字符串，防止「没扫到」伪装成「没命中」。

**变异自证**（把 `'操作失败'` 塞回 `game.js` 字符串 → 红，恢复 → 绿）：

```
=== RED: 禁用词回到玩家可见字符串 ===
  FAIL  ui-copy-consistency.test.js:118:3  ★★ 玩家可见 JS 字符串里禁用词命中 0（后台 admin.html 不在扫描面）  -> got 1 want 0  |  操作失败 ← 操作失败
通过 19 项，失败 1 项
=== GREEN: restored ===
通过 20 项，失败 0 项
```

---

### P0-7 · 净得分裂

**改了什么**：`pwa/js/settleView.js:592` 与 `pwa/index.html:954` 的「本轮各家净得」→「本轮各家净胜」（静态值与 JS 覆写值同源，避免只改一处）。

**配套守卫**：`ui-copy-consistency.test.js [4]`——静态 `p` 与 JS 覆写字符串都断言「净胜」，并在 HTML 与全部 JS 字符串里扫描孤例「净得」=0。

**变异自证**（JS 覆写值改回「净得」→ 红，恢复 → 绿）：

```
=== RED: P0-7 净胜改回净得 ===
  FAIL  ui-copy-consistency.test.js:127:3  ★★ JS 覆写值也写「净胜」
  FAIL  ui-copy-consistency.test.js:129:3  ★★ 玩家可见字符串里没有孤例「净得」  -> got 1 want 0  |  本轮各家净得
通过 18 项，失败 2 项
=== GREEN: P0-7 净胜改回净得 restored ===
通过 20 项，失败 0 项
```

---

### P0-8 · btn-hold 进按钮体系

**改了什么**

- `pwa/index.html:528`：`<button id="btn-hold" class="btn-hold hidden">` → `class="btn btn-ghost btn-hold hidden"`。四态（`:active` / `[disabled]` / `.is-busy` / focus）继承 `.btn` + `.btn-ghost`。
- `style.css:3394-3420` 的 `.next-row .btn-hold` 尺寸/虚线覆盖**保留**（特异性高于变体，视觉不变）；横屏覆盖也保留。
- 核对 `game.js:3657-3658`：`pressBusy` 目标确实是 `document.querySelector('[data-hold-next]') || $('#btn-hold-off')`，而 `settleView.js:1151-1158` 把 `data-hold-next` 写在 `#btn-hold` 上——两个分支现在都带 `.btn`（`#btn-hold-off` 原本就是 `btn btn-ghost`）。未改这段逻辑（U4 的 `if (!restore) return` 缺口属交互 P1，不在本批）。

**配套守卫**：新增 `pwa/test/button-busy-wiring.test.js`——通用静态扫描 `game.js` 全部 13 处 `pressBusy` 调用（含变量目标回溯到 `var btn = …`、`firstShown([...])`、三元分支，以及 `[data-hold-next]` → `#btn-hold` 的映射校验），每个目标必须带 `.btn` 或自行定义 `:active`/`[disabled]`/`.is-busy` 三态；分类器先自测（齐全放行 / 只有 `:active` 判红 / 找不到按钮判红）。

**变异自证**（`#btn-hold` 改回裸类 → 红，恢复 → 绿）：

```
=== RED: P0-8 btn-hold 去掉 .btn ===
  FAIL  button-busy-wiring.test.js:108:3  ★★ 每个 pressBusy 目标都有 .btn 或自有三态（btn-hold 改回裸类必须红）  -> got 1 want 0  |  #btn-hold 既没有 .btn，也没有自定义 :active/[disabled]/.is-busy 三态
  FAIL  button-busy-wiring.test.js:117:5  ★ #btn-hold 带 btn
  FAIL  button-busy-wiring.test.js:117:5  ★ #btn-hold 带 btn-ghost
通过 13 项，失败 3 项
=== GREEN: P0-8 btn-hold 去掉 .btn restored ===
通过 16 项，失败 0 项
```

---

## 二、单跑数字（全部 exit 0 / 失败 0）

| 测试文件 | 改动前 | 改动后 | 说明 |
|---|---:|---:|---|
| `design-tokens` | 27 | **42** | +15：逐层分类自测 9、var() 完整性 4、氛围/JS 内联 2（含前置） |
| `number-scale` | 48 | **56** | +8：`.sc-net` 白名单使原违规消失 + 新增同档/三态断言 |
| `ui-copy-consistency` | 不存在 | **20** | 新增：文案四域 |
| `button-busy-wiring` | 不存在 | **16** | 新增：pressBusy 目标 |
| `modal-a11y` | 128 | 128 | 按要求回归，未改 |
| `ui` | 359 | 359 | 只同步文案断言措辞 |
| `settle-crown` | 27 | 27 | 冠军块行为回归 |
| `prev-result` | 70 | 70 | 涨跌双色阶回归（未被改坏） |
| `records` / `records-replay` / `records-ai` / `records-quota` | 51 / 30 / 44 / 15 | 同左 | 战绩文案/数据回归 |
| `settle` / `states` / `replay` / `replay-handno` / `hold-left-text` / `hold-next` | 30 / 125 / 32 / 54 / 11 / 55 | 同左 | 相关行为回归 |

- 本批可核对的断言净增：**+59**（`design-tokens` +15、`number-scale` +8、两个新文件 +36）。没有空断言；每条新增断言都参与了至少一次红→绿变异自证。
- 全量基线（171 文件 / 7140 断言 / 0 失败）由制作人补跑 `npm test` 后更新；本环境按要求不跑全量。
- `node --check`：所有改过的 `.js`（含两个新测试文件）全部通过。
- `git diff --check`：通过。4 份审查报告仍为未跟踪、内容未动。

---

## 三、我做的判断与取舍

1. **冠军净胜的颜色：选涨跌三态，不选金色。**
   金色只保留给「冠军」这个荣誉语义（`.sc-k` 标题、金色边框与底色）。净胜是数据：名次表、战绩卡、排行榜都已经走 `netCls` 的 `up/down/flat`，让冠军块也走同一套，才真正做到「同一个数一套答案」。反过来把名次表冠军行改成金色，会让那一行的净胜脱离全站三态口径，等于为一块牌区再开一个颜色分支。代价是冠军区的数字从金变红（冠军基本为正）；换来的是数据语义统一，且完全不碰两套涨跌色阶（`prev-result.test.js` 70 项保持绿）。
2. **量词的两处保留项。** `game.js:1073`「这一局你在旁边看」= 整局旁听；`:3642`「这一把你不打」= 单次发牌退出。二者不是同一统计口径，按契约刻意保留，并写进守卫断言，防止后来者「顺手统一」把它们改错。
3. **禁用词的扫描边界。** 口径取审查汇编 §四.1 的全域严格解（任何玩家可见位置都算不合格），所以除 `game.js` 5 处外把其余玩家可见 JS 字符串也清零；注释、后台页 `admin.html` 不计入扫描面（后台两处仍然改了）。扫描器按字符串字面量提取，不用简单 `grep`，否则注释里的「请求失败」会造成假红。
4. **投影豁免清单。** 按字面值豁免三条带色氛围投影（绿/金/金），理由是它们表达状态而非高度；不按颜色通配，避免把未来的裸黑投影也放过去；并断言三条仍在 CSS 中，防止豁免变成僵尸。`var(--elev-*)`、`var(--edge-*)`、`inset`、状态环（y=0）、按钮下沿（blur=0）属于造型豁免，全部写进测试注释。`var()` 完整性方面，JS 注入变量用**显式 27 项白名单**并要求每项在 JS 源里可追到，不采用「没定义就放行」。
5. **改动顺序与风险控制。** 先落 CSS/JS 修复，再补守卫，最后逐条变异自证；每处投影只换外投影层，inset 边/状态环一律留在前层，观感变化限于「浮起高度归档」。未动 `probe-ui-flow`、未动缩放体系、未引入新依赖。

---

## 四、怎么跑起来 / 后续

```bash
cd <仓库根>
node pwa/test/design-tokens.test.js
node pwa/test/number-scale.test.js
node pwa/test/ui-copy-consistency.test.js
node pwa/test/button-busy-wiring.test.js
node pwa/test/modal-a11y.test.js
# 制作人补跑全量：npm test
```

**已知技术债 / 未做**：本批只处理 P0 八项；审查报告的 P1（危险动作分级、删号 Enter、确认框忙碌态、结算页裸 `.btn`、战绩/记录混用、成就中文数字等）未动。横竖屏结算页的实际像素观感未跑真浏览器探针，按分工由制作人补跑两档 `probe-ui-flow`。U4（`onHoldNext` 漏 `if (!restore) return`）属交互 P1，本批按范围不改。
