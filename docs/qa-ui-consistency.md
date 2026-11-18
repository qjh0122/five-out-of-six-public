# UI 一致性整改全批验收报告（P0 8 项 + P1 13 项 + U4）

> 验收人：qa-lead（严过关，质量监管）· 2026-11-19
> 被验对象：工作区未提交改动（HEAD `66f53db` + P0/P1 两批整改）
> 验收方式：**只读核验 + 变异自证 + 关联回归**，未改任何产品代码、未 commit / push
> 未跑 `npm test`（按分工由制作人跑）、**未跑 `probe-ui-flow`**（避免抢端口）
> 取证工具：`tools/qa/mutate-verify.js`（本轮新建，可复用；逐字节还原 + SHA-256 证明）

---

## 〇、一句话结论

**22 项整改全部落地且守卫抓得住（我独立复现了 6 次红→绿）。不通过 0 项，但「守卫覆盖」有 1 处实测盲区，另有 1 处旧门禁口径没覆盖到的裸技术短语仍会直达玩家 —— 两项都不阻断本批交付，但需要在下一批补掉，否则「全绿」会再次掩盖真缺陷。**

---

## 一、验收条件（从整改目标反推）

| AC | 条件 | 判定方式 |
|---|---|---|
| AC-1 | P0 八项、P1 十三项 + U4，共 22 项改动**真的落在**对应文件:行号 | 逐条读源码 + grep 定位，不看日志复述 |
| AC-2 | 每项的守卫**断言的是真问题**，不是"文案改了" | 变异自证：改回问题状态 → 必须红 |
| AC-3 | 同时存在静态 HTML 与运行时 JS 覆写的项，**两处都改** | 分别 grep 静态值与 JS 字面量 |
| AC-4 | 新增守卫的期望值**硬编码**、不引用被测常量（自证不循环） | 读测试源码 |
| AC-5 | 豁免清单（圆角 13 / 氛围投影 3 / JS 注入 27）**每条仍在代码里**（僵尸检查真的会红） | 抽样变异：删掉一条豁免对象 → 必须红 |
| AC-6 | 共享功能未被误伤（涨跌双色阶 / UndoBar 5 秒 / 焦点栈 / 四态 / 离开房间直接退） | 跑关联回归套件 |
| AC-7 | P1 未把 P0 成果覆盖回去 | 逐项复核 P0 五个成果点 |
| AC-8 | 门禁**在执行链里**（不是写了没接进 `npm test`） | 核 CI 调用点 + 核跑批器扫描面 |

---

## 二、22 项逐条结论

四态：**通过 / 失败 / 部分 / 不适用**。证据列给的是**我自己打开看到的**行号（与日志所述行号有偏移，因为 P1 在其间插了行 —— 偏移不影响判断）。

### P0 批（8 项）

| # | 项 | 结论 | 证据（文件:行） | 我核了什么 |
|---|---|---|---|---|
| P0-1 | 冠军净胜两套答案 | **通过** | `css/style.css:3292` `.sc-net{font-size:var(--num-2)}`、`:3293-3295` up/down/flat 三态、`:3291` `.sc-name{var(--num-3)}`、`:3235` 名次表冠军 `var(--num-2)`；`js/settleView.js:676` `'sc-net ' + netCls(top.score)` | 同屏两处取值**同为 `var(--num-2)`=48px**，名字低一档 32<48，方向与名次表 28<48 一致；颜色不再金/涨跌两套 |
| P0-2 | 回放弹窗两个名字 | **通过** | `index.html:569` `<h2 id="replay-title">本局过程</h2>`；`:536` 按钮同名；`js/recordsView.js:129` aria`…这一局的牌面过程` | 静态标题 + 按钮 + JS 运行时 aria 三处同词；守卫另扫全 JS 字符串无「本场过程」 |
| P0-3 | `--text-main` 零定义 | **通过** | `css/style.css:31` `--text-main: #f5f0e6;`；4 处引用现 `:1032 / :3291 / :3361 / :3391` | **独立复核了值的合法性**：`html,body{color:#f5f0e6}` 在 `:156` —— 该 token 值确实等于改动前实际继承到的颜色，不是新造色 |
| P0-4 | 9 处裸外投影 | **通过** | 8 处 CSS：`:671 :1007 :1335 :1765 :1771 :2173 :3494 :4915`；1 处 JS：`js/cardView.js:199` `box-shadow:var(--elev-2)` | 逐处实读：全部只把**外投影层**换成 `var(--elev-*)`，`inset` 内描边/高光仍在前层（例：`:671` `inset 0 1px 0 …,var(--elev-1)`；`:1335` 两条 inset 在前 + `var(--elev-3)`） |
| P0-5 | 量词契约（把/局/场） | **通过** | 静态 `index.html:896` `当前 0 局战绩…`；运行时 `js/recordsView.js:637` `'共 ' + st.games + ' 局'`、`:638/:655` `列表近 N 局`、`:96` `最近 N 局`、`:1220` `N 局 · N 把`、`:1591` `N 局`、`:1819` `N 局战绩`、`:1875` 将清除 `N 局`战绩 | **重点核了"只改静态、运行时没改"这个假修复形态**：运行时 7 处实读全是「局」；两处刻意保留（`game.js:1073` 这一局你在旁边看 / `:3642` 这一把你不打）语义确实不同，保留成立 |
| P0-6 | 禁用词清零 | **通过** | `js/game.js:411` 起全部改写；`grep -rn '操作失败\|请求失败\|网络异常\|请稍后重试\|系统繁忙\|错误码 1023' pwa/js/*.js` → **仅 4 条命中且全在注释**（`game.js:358/409`、`recordsState.js:210`、`recordsView.js:528`）；`pwa/index.html` 0 条；`pwa/admin.html` 0 条 | 用**我自己的** grep（不是守卫的扫描器）复核：玩家可见面 0 命中，注释残留属正常（守卫剥离注释） |
| P0-7 | 净胜/净得分裂 | **通过** | `index.html:954` `<p id="rb-sub">本轮各家净胜</p>`；`js/settleView.js:592` `$('#rb-sub').textContent='本轮各家净胜'` | **静态与运行时同源**，两处都改 |
| P0-8 | `btn-hold` 进按钮体系 | **通过** | `index.html:528` `class="btn btn-ghost btn-hold hidden"`；`:469` 兄弟按钮本是 `btn btn-ghost` | 两条 `pressBusy` 分支（`[data-hold-next]` 与 `#btn-hold-off`）现在都在体系内 |

### P1 批（13 项 + U4）

| # | 项 | 结论 | 证据（文件:行） | 我核了什么 |
|---|---|---|---|---|
| P1-P6v | 结算页文字层收敛 | **通过** | `css/style.css:110-113` `--fs-1..4`；9 个选择器实读均走 `var(--fs-*)`：`.settle-go`(fs-4)、`.settle-recheck`(fs-3)、`.sr-hint`(fs-4)、`.settle-tip`(fs-4)、`.settle-ai-note`(fs-4)、`.sc-k`(fs-4)、`.sc-gap`(fs-4)、`.settle-reset-note`(fs-4)、`.settle-wait`(fs-3) | 同屏文字取值仅剩 20/24/28/32 四档，全在梯内；`--fs-*` 与 `--num-*` 语义分离（值刻意复用但 token 独立） |
| P1-P7v | 圆角四档 token | **通过** | `css/style.css:121-124` `--r-chip/card/modal/pill`；守卫报**取值种类 17**（原 21） | 11/14/18/26 四个漂移家族字面量归零；**僵尸检查我实测过**（见 §三·M6） |
| P1-P2 | 确认框严重度分级 | **通过** | `js/game.js:3085` 读 `opts.tone`、`:3087` 标题加「（不可撤销）」、`:3090` `toggle('btn-danger',danger)`、`:3091` `toggle('btn-primary',!danger)`；`js/accountView.js:521` `{busyText:'删除中…',secret:true,tone:'danger'}` | 双向 toggle（不是只加不摘）；反向核对「确认提交分组」调用**未**带 tone |
| P1-P3 | 删号密码框 Enter | **通过** | `js/game.js:3111` `sec.onkeydown = function(e)`、`:3115` `sec.onkeydown = null` | 属性赋值（不叠加）+ 非密码场景摘监听；`onConfirmOk` 自带 `confirmBusy` 连点闸 |
| P1-P4 | 昵称框 Enter 有预期 | **通过** | `index.html:359` `placeholder="输入昵称（回车创建房间）" enterkeyhint="go"` | 行为未改（仍是 Enter→建房），只加预期 —— 与日志取舍一致 |
| P1-P5i | 忙碌态一套视觉 | **通过** | `js/game.js:3147` `disabled=true; classList.add('is-busy')`、`:3154` 成对还原；`css/style.css:80` `--spin-period:800ms`、`:510` `animation:btnSpin var(--spin-period)`；`css/records.css:609` `rpSpin var(--spin-period)` | 两环同周期；确认键三态补齐 |
| P1-P6i | 结算页三颗次级按钮 | **通过** | `index.html:535` `btn btn-quiet btn-lg`、`:536` 同、`:539` `btn btn-quiet` | 与相邻 ghost 按钮形成"次级实体 / 幽灵"两级；`style.css` 过期注释已更新（守卫钉住新例子） |
| P1-P5c | 战绩/记录混用 | **通过** | `index.html:797` 先把本机战绩给你看、`:815` 清除战绩、`:896` 0 局战绩；`js/recordsView.js:1819` `N 局战绩将被删除`、`:1875` 将清除 N 局战绩 | 静态 + 运行时都改；「过程记录」「下载记录」是他义，保留正确 |
| P1-P6c | 开局动作四动词 | **通过** | `js/game.js:746` 马上开局、`:3689` 人齐就开局；`js/nextRoundHints.js:97` `点「开始下一局」就开局`；`index.html` 主按钮「开始下一局」不动、等人按钮「先别开牌」不动 | 「开局」= 状态提示线，「开牌」= 等人线，两条线各自统一，未互相污染 |
| P1-P7c | 万能「出了点问题」 | **通过** | `grep -rn '出了点问题\|稍后再试\|检查一下网络\|暂时进不去' pwa/js/*.js pwa/index.html` → **仅 1 条命中且在注释**（`game.js:357`） | 每条新文案都带具体动词（回房间/回首页/再点一次…），守卫逐条扫 |
| P1-P8c | AI 三叫法 | **通过** | `index.html:458` 补 AI、`:734` 含 AI、`:735` 不含 AI…不计入战绩与排行榜、`:853/:880` 不含 AI 对局；`js/recordsView.js:113/781`、`js/seatSheetView.js:292/376`、`js/stateMachine.js:1605`（补个 AI） | 「AI 队友 / AI 玩家 / 含人机 / 人机对局」在 HTML 与 JS 字符串里均为 0 |
| P1-P10c | 成就中文数字 | **通过** | `js/achievements.js:582` 第 1 局、`:585` 10 局、`:593` 100 局、`:601` 连赢 5 局、`:604/:615` 10 局 | 量词取「局」（与 P0 契约一致，不取派单举例的「场」）；牌张数「三张/五张」未误伤 |
| P1-P11c | aria-label 用字 | **通过** | `index.html:695` `aria-label="记录"`；`:363` `placeholder="6 位房间号" aria-label="6 位房间号"` | 全页无第二处「纪录」；placeholder 与 aria 同字 |
| U4 | `onHoldNext` 的 restore 防御 | **通过** | `js/game.js:3686` `if (!restore) return;`（`onHoldNext` 函数体内，`finally{restore()}` 之前） | 全站 `if (!restore) return;` 13 处 = `pressBusy` 调用 13 处，1:1 对齐 |

**汇总：通过 22 / 失败 0 / 部分 0 / 不适用 0。**

> 说明：P0-5 与 P1-P5c 的**代码**已完全达标，但它们的守卫对部分运行时节点无覆盖（见缺陷 D-1）。这记为**守卫缺口**，不记为项失败 —— 因为「项」的验收对象是实现，不是守卫，而实现我逐处读过了。

---

## 三、变异自证（6 次真做，含逐字节还原证明）

工具：`tools/qa/mutate-verify.js`（本轮新建，落盘在 `tools/qa/`，下轮直接复用）。
**工具自验前置**：变异前先要求原文片段在文件内**恰好命中 1 次**，否则拒绝执行（防止"改错地方还以为验过了"）；还原写回的是**原始 Buffer**，不是重新拼的字符串；还原后比对 SHA-256。

### M1 · P0-4 isElevation 逐层判定（旧分类器盲区）

把 `.entry` 的第 2 层从 `var(--elev-1)` 换回裸投影 `0 10px 24px rgba(0,0,0,0.4)`（`inset` 仍在前）：

```
=== 变异用例 p0-4-second-layer ===
变异前 SHA-256：79a29f91c48fabbab2d913a977cbd22fee617a2c45d2f79fc1be14c3bc082973
--- RED（问题状态）---   exit=1  通过 58 项，失败 1 项
  FAIL  design-tokens.test.js:192:3  ★★ 没有一条外投影是手写字面量（全部来自 --elev-*）  -> got 1 want 0
        |  style.css: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 10px 24px rgba(0, 0, 0, 0.4)
--- 还原 ---  还原后 SHA-256：79a29f91…c3bc082973   SHA-256 逐字节一致 ✓
--- GREEN（还原后）---  exit=0  通过 59 项，失败 0 项
```

**结论**：旧分类器只看第 1 层时这条会被漏放；现在逐层 `some()` 抓得住。P0-4 的"逐层"是真的。

### M2 · P0-4 的 JS 半边（"只改 CSS 不管 JS"的假修复形态）

`cardView.js:199` 改回 `box-shadow:0 16px 32px rgba(0,0,0,0.45)`：

```
--- RED ---  exit=1  通过 57 项，失败 1 项
  FAIL  design-tokens.test.js:296:3  ★★ JS 内联样式没有裸外投影  -> got 1 want 0  |  cardView.js: box-shadow: 0 16px 32px rgba(0,0,0,0.45)
  FAIL  design-tokens.test.js:297:3  ★ cardView.js 的飘牌走 --elev-2
还原后 SHA-256：f43f411a…b14643  逐字节一致 ✓ · GREEN 59/0
```

**结论**：新增的 `[7]` 真的读了 JS 源，不是只扫 CSS。日志所说"此前 CSS 守卫根本不读 JS"的缺口已闭合。

### M3 · P0-3 删掉 `--text-main` 定义

```
--- RED ---  exit=1  通过 57 项，失败 2 项
  FAIL  design-tokens.test.js:268:3  ★★ 所有 var() 都能解析到 CSS 定义或 JS 注入白名单  -> got 1 want 0  |  --text-main
  FAIL  design-tokens.test.js:269:3  ★★ --text-main 在 :root 明确定义为现网继承色 #f5f0e6
还原后 SHA-256：79a29f91…c3bc082973  逐字节一致 ✓ · GREEN 59/0
```

**结论**：两条判据分工正确 —— 一条守"引用完整性"（对任何悬空变量生效），一条守"锚点 + 值"（防止用别的变量糊过去）。

### M4 · P1 文案回潮「清除记录」

```
--- RED ---  exit=1  通过 56 项，失败 2 项
  FAIL  ui-copy-consistency.test.js:136:3  ★★ 清除按钮写「战绩」（改回「清除记录」必须红）
  FAIL  ui-copy-consistency.test.js:140:3  ★★ HTML 可见文案里没有「记录」指战绩数据  -> /清除记录/
还原后 SHA-256：61d1005f…02710e23  逐字节一致 ✓ · GREEN 58/0
```

### M5 · U4 删掉 `onHoldNext` 的 restore 防御

```
--- RED ---  exit=1  通过 38 项，失败 2 项
  FAIL  interaction-consistency.test.js:227:3  ★★ 每处 pressBusy 调用后都有 if(!restore) return（12/13）  -> got 12 want 13
  FAIL  interaction-consistency.test.js:229:3  ★★ 唯一漏网的 onHoldNext 已补齐
还原后 SHA-256：d215afa1…8c41940d  逐字节一致 ✓ · GREEN 40/0
```

**结论**：这条守卫是"计数对齐"型（13=13），不是"文件里存在某字符串"型 —— 删一处就掉数，不会假绿。

### M6 · 圆角几何豁免的**僵尸检查**（豁免表会不会腐化成免责声明）

把 `style.css:2049` 的 `border-radius: 28px 28px 0 0`（该值全站仅此一处）换成 `var(--r-modal)`：

```
--- RED ---  exit=1  通过 58 项，失败 1 项
  FAIL  design-tokens.test.js:355:3  ★★ 几何豁免清单没有僵尸条目  -> got 1 want 0  |  28px 28px 0 0
还原后 SHA-256：79a29f91…c3bc082973  逐字节一致 ✓ · GREEN 59/0
```

**结论**：豁免表**确实**做了僵尸检查，且检查会红 —— 13 项几何豁免每条都必须在 CSS 里还活着。同理，`design-tokens:253`（JS 注入 27 项）与 `:278`（氛围投影 3 条）是同一套数据驱动写法，我读了实现，机制相同。

### 还原证明（总计）

| 文件 | 变异前 = 还原后 SHA-256 |
|---|---|
| `pwa/css/style.css` | `79a29f91c48fabbab2d913a977cbd22fee617a2c45d2f79fc1be14c3bc082973` |
| `pwa/js/cardView.js` | `f43f411a46fa37a306e341aa3dfeaa90b87deaa3c80fea49dfb82eccafb14643` |
| `pwa/index.html` | `61d1005f11f8ad30dc8b54f988a8c69cb7d44d8708669e0befe9aef102710e23` |
| `pwa/js/game.js` | `d215afa161d61559f6538e525db12e3a1761e21f3a3149a54c3349e48c41940d` |
| `pwa/js/recordsView.js` | `30fc66aaef3f9a6d09a87dde6be9e51c94c663eb3ea6bc319e9ee0d95dbcd29f` |

`git status --short` 复核：改动集合 = 原 36 项 + 我新增的 `tools/qa/mutate-verify.js`，**产品代码零漂移**；`docs/` 下 4 份审查报告与 2 份实施日志未被触碰。

---

## 四、断言质量审查（本项目文化重点）

### 4.1 硬编码 / 不引用被测常量 —— **通过**

逐条读源码确认：`--num-*` 六档值、`--r-*` 四档值、`--fs-*` 四档、`--spin-period: 800ms`、`--text-main: #f5f0e6` **全部是测试里写死的字面量**，没有 `const X = require('./style.css')` 或反向读被测变量来比。典型反例写法本可偷懒（"读 token 值再和 token 值比"），实际没有。

`number-scale [5]` 还专门有一条负向断言 `ok(!t1Compare.test(...), '几何采集器/断言块里没有 == T1（不钉被测常量）')` —— 这条是"防自己偷懒"的元断言，值得保留。

### 4.2 分类器/提取器自测 —— **通过（5/5 文件都有）**

| 文件 | 自测节 | 我核了什么 |
|---|---|---|
| `design-tokens` | `[2]` 17 条分类器自测（含"inset 在前、裸投影在第 2/3 层必须判违规"3 条） | 真阳性/真阴性都给样本 |
| `number-scale` | `[0]` 字面量被抓 / token 放行 / 正文选择器不误伤 / 角标只许 16px | 4 向都覆盖 |
| `ui-copy-consistency` | `[0]` 注释里的禁用词不算 / 字符串里的算 / 普通文案不误伤 / 前置"扫到 >300 条字符串" | 解决"没命中 ≠ 扫描器瞎了" |
| `interaction-consistency` | `[1]` `needsDanger()` 两向自测；`[5]` 变体计数 | ✓ |
| `button-busy-wiring` | `[0]` 三态齐全放行 / 只有 `:active` 判红 / 找不到按钮判红 / 带 `.btn` 放行 | 4 向都覆盖 |

**并且我自己另外做了 6 次外部变异**（§三）—— 这比自测更强，因为变异打的是真文件。

### 4.3 豁免清单僵尸检查 —— **通过（3 张表都有，且实测会红）**

| 豁免表 | 条数 | 僵尸检查 | 我的验证 |
|---|---:|---|---|
| 圆角几何豁免 `GEOMETRY_ALLOW` | 13 | `design-tokens:354-355` 每条必须在 CSS 里还命中 | **M6 实测红** ✓ |
| 带色氛围投影 `ATMOSPHERE` | 3 | `design-tokens:277-278` 三条字面值必须仍在 CSS | 读到实现；三条实测在 `style.css:1673/1806/4713`，且**归属选择器与注释一致**（`.slot-point.best` / `.card-wrap.selected .card` / `.av-cell.is-on`）✓ |
| JS 注入白名单 `JS_INJECTED` | 27 | `design-tokens:252-253` 每项必须能在 JS 源找到 `setProperty('--x'` 或内联 `--x:` | 读到实现，且断言为 `eq(stale.length,0)`（会红）✓ |

三张表**都不是免责声明**。

### 4.4 "文案说唯一、断言只证明至少一处" —— **发现 2 处（D-5）**

这是本项目出过 D-2 教训的形态，必须点名：

| 位置 | 断言 | 问题 |
|---|---|---|
| `ui-copy-consistency:143` | `ok(allStrings.some(s => s.indexOf('本机战绩已清除') >= 0), '★ 两种回执收敛成「本机战绩已清除」')` | 说明串写的是**两种**回执，断言只证明**至少一处**。若第二种回执被改回「已清除这台设备上的记录」，靠 `:141` 的 badJs 兜（该 badJs 里确实列了这条），所以**当前不假绿**，但断言本身与说明串不匹配 |
| `ui-copy-consistency:119` | `ok(allStrings.some(s => s.indexOf('账号数据没读上来') >= 0 || s.indexOf('没读上来') >= 0))` | "具体动词文案已落地" 只证明一处存在，不证明清单里每条都带动词。（`:171-175` 的 `rewrites`+`noVerb` 才是真正逐条判的，所以实际覆盖住了，但 `:119` 这条本身是弱断言） |

### 4.5 守卫覆盖盲区 —— **发现 1 处实测盲区（D-1，本轮最重要的一条）**

`ui-copy-consistency [2]`（量词）与 `[5]`（战绩/记录）里，**运行时量词的正确性**只靠"带数字的正则" + 少量正面断言：

```js
// :105  —— 需要字面数字才会命中
/最近\s*\d+\s*场|单场最高|共\s*['"]?\s*\d+\s*场|列表近\s*\d+\s*场|\d+\s*场记录|第\s*\d+\s*场/
```

而真正的运行时量词是**拼出来的**：`'共 ' + st.games + ' 局'` —— 里面没有字面数字。于是只有 `#rp-list-count` 这个节点被 `:107` 的正面断言钉住，**其余运行时节点一个都没被钉**。

我用**盲区探针**证明了这一点（把 `recordsView.js:1819` 的「局战绩」改回「场战绩」）：

```
--- 问题状态（期望绿=盲区探针）---  exit=0  通过 58 项，失败 0 项  (没有 FAIL 行)
→ 盲区确认：守卫对此变异无反应（此节点无断言覆盖）
还原后 SHA-256：30fc66aa…dbcd29f  逐字节一致 ✓
```

同理，`'最近 ' + labels.length + ' 局（左旧右新）'`（`:96`）、`'将清除 ' + n + ' 局' + '战绩'`（`:1875`）等节点，改回「场」也不会红。

**当前代码是对的（我逐处读过），所以这不是功能缺陷**；但它意味着下一轮若有人"只改一半"，守卫不会说话 —— 正是本批要根除的形态，只是从"代码层"挪到了"守卫层"。

---

## 五、误伤评估（共享功能必须仍完整）

| 共享能力 | 要求 | 我实际跑到 | 结论 |
|---|---|---|---|
| 涨跌双色阶（浅底深绿 4.5:1） | `prev-result` 70 | **70 / 0 失败** | 未破 ✓ |
| 冠军块行为 | `settle-champion` 48 | **48 / 0 失败** | 未破 ✓ |
| 冠军块渲染 | `settle-crown` 27 | **27 / 0 失败** | 未破 ✓ |
| UndoBar 5 秒撤销 | `undo-bar` 43 | **43 / 0 失败** | 未破 ✓ |
| Undo 接线 | `undo-wiring` 42 | **42 / 0 失败** | 未破 ✓ |
| 弹窗焦点栈 / 键盘 | `modal-a11y` 128 | **128 / 0 失败** | 未破 ✓ |
| 四态 | `states` 125 | **125 / 0 失败** | 未破 ✓ |
| 四态接线 | `states-wiring` — | **109 / 0 失败** | 未破 ✓ |
| 离开房间直接退（未被回退） | `leave-undo` / `leave-settle` / `peek-room-client` | **115 / 35 / 21，全 0 失败** | 未回退 ✓ |
| 文案/数据回归 | `ui` 359 · `records` 51 · `records-ai` 44 · `records-replay` 30 · `records-quota` 15 | 全部与日志同数、0 失败 | 未破 ✓ |
| 其它受影响 | `no-silent-catch` 46 · `bust-block` 28 · `emoji-scale` 55 · `hold-next` 55 · `room-actions-fit` 12 · `next-round` 109 · `hand-limit-memory` 20 | 全部 0 失败 | 未破 ✓ |

**误伤结论：无。**

---

## 六、跨批一致性（P1 有没有把 P0 覆盖回去）

| P0 成果 | 当前状态 | 结论 |
|---|---|---|
| `.sc-net` 三态 + `var(--num-2)` | `style.css:3292-3295` 在位 | 保留 ✓ |
| `--text-main` 定义 | `style.css:31` 在位（M3 反证：删了会红） | 保留 ✓ |
| `btn-hold` 带 `.btn` | `index.html:528` 在位 | 保留 ✓ |
| 量词「局」 | P1 的 P10（成就）改成「局」，与 P0 契约同向 | 加强 ✓ |
| 两个 P0 新守卫 | `button-busy-wiring` 16 项未改、`design-tokens` 由 42 扩到 59 | 保留并扩展 ✓ |

另外核了"规则改动有没有引入新的文案说 A 实际 B"：`no-silent-catch.test.js` 的三条旧句断言是**同步换成新句**（diff 见 `:167/:184` 两处），不是删成描述性文字 —— 断言仍在钉字面值，钉得住。

---

## 七、缺陷清单（本批新增 / 遗留，均不阻断）

| 编号 | 描述 | 复现步骤 | 级别 | 建议处理 |
|---|---|---|---|---|
| **D-1** | 运行时量词/名词节点无守卫覆盖：`recordsView.js:1819/96/1875` 等处改回「场」守卫仍绿（盲区探针已证） | `node tools/qa/mutate-verify.js probe-runtime-quantifier` | **一般** | 把 `[2]/[5]` 的扫描器从"匹配带数字的整句"改为"取所有字符串里紧邻量词的终点字"，或对每个运行时节点补一条正面断言。退回给：主程序（守卫侧） |
| **D-2** | 裸技术短语仍直达玩家：`roomStore.js:567/577/691` 的 `连接超时`/`连接失败`/`请求超时` 经 `catch → {ok:false,error:e.message}` → `flashRoomError` → `flash()` 显示，既无后果也无动词 | 断网 → 点「准备」→ 8 秒后 toast 显示「请求超时」 | 建议 | 这三句不在 `BANNED` 表内，所以 `ui-copy [7]` 报"0 条万能文案"仍绿。建议补进扫描面并改成"这一步没送到服务器，回房间看一眼再点一次"。退回给：主程序（文案侧） |
| **D-3** | `interaction-consistency:194` 的渲染态豁免僵尸检查只覆盖 2 条中的 1 条（只查 `readyBtn`/`已就位 ✓`，不查 `updateSubmit`） | 删掉 `updateSubmit` 里 `disabled=true` 的渲染态 → 守卫不会红 | 建议 | 豁免表补一条"每条豁免函数仍存在"的遍历断言。退回给：主程序 |
| **D-4** | `design-tokens:112` 注释称"模糊半径**与不透明度**都随高度增大"，但断言只算 blur（`:137-138`），不透明度未验 | 把 `--elev-3` 的 alpha 调成 0.10（比 elev-2 的 0.34 小）→ 仍绿 | 建议 | 要么补 alpha 递增断言，要么把注释改成只承诺 blur。退回给：主程序 |
| **D-5** | 2 处"至少一处"型弱断言（见 §4.4） | 见 §4.4 | 建议 | 把 `some` 改成对具名节点逐条断言。退回给：主程序 |
| **D-6** | `p1-fix-log.md` 自陈"`design-states-v1.md` 等规格文档也未改"，但工作区 `docs/design-states-v2.md` 已改（新增 D10 + offline 行同步为「本机战绩」，mtime 01:29 晚于日志 01:25）。内容**是对的**（把日志 §技术债 1 那条分歧闭环了），但日志与工作区不一致 | `git status --short` / `git diff docs/design-states-v2.md` | 建议 | 日志回填一句"期间已同步 design-states-v2.md（D10）"。退回给：主程序 |
| **D-7** | `design-tokens:111` 把"x 偏移不为 0"整类豁免（注释写作"斜影不按高度管"），于是 `1px 8px 22px rgba(0,0,0,.3)` 这种裸投影可绕过守卫 | 往任一规则塞 `box-shadow: 1px 8px 22px rgba(0,0,0,.3)` → 守卫仍绿 | 建议 | 豁免收窄为「x=0 且 y=0」（真正的四向光环），斜影不豁免。当前代码无此类用法，故只是守卫漏洞 |
| **D-8** | `.settle-name` 的 28px 仍是字面量，未走 `--fs-2`（28px）；`TEXT_SELECTORS` 9 条不含它 | `grep -n "settle-name" style.css` → `font-size: 28px` | 建议 | 补进 `TEXT_SELECTORS` 或改 `var(--fs-2)`。数值在梯内，只是 token 采用率少一处 |

---

## 八、采信矩阵（上游结论逐条复算）

| 上游结论（原文摘要） | ① 我实际执行的命令 | ② 我本机跑出的原始输出（摘要） | ③ 采信 |
|---|---|---|---|
| 「`npm test` → 文件 174 / 断言 7305 / 失败 0」 | `node -e "readdirSync 计数"`（未跑全量） | `pwa/test 115` / `server/test 59` → **合计 174** ✓ | **采信·部分复现**：文件数复现；7305 未覆盖（未跑全量） |
| 「P0 净增 +59 → 7199；P1 净增 +106 → 7305」 | 算术 + 单跑 5 个守卫文件 | 15+8+20+16=**59** ✓；11+17+38+40=**106** ✓；实测 `design-tokens 59 / number-scale 67 / ui-copy 58 / interaction 40 / button-busy 16` 与两批终值**逐一相等** | **采信·复现** |
| 「`design-tokens` 42 / `number-scale` 56 / `ui-copy` 20 / `button-busy` 16（P0 后）」 | 同上一行反推 | 与 +59 自洽 | **采信·推断修正**（未逐轮回跑，用终值 + 净增双向校验） |
| 「回归 `prev-result` 70 / `settle-champion` 48 / `undo-bar` 43 / `undo-wiring` 42 / `modal-a11y` 128 / `states` 125」 | 逐个 `node pwa/test/<f>.test.js` | 70/48/43/42/128/125，全部 `失败 0 项` | **采信·复现** |
| 「P0-4 九处裸投影已归位到 `--elev-*`」 | `grep -n box-shadow` + 逐处 `sed` 实读 | 8 处 CSS + 1 处 JS 全部只剩 `var(--elev-*)` 作外投影层；行号普遍 +28（P1 插行所致），**内容对得上** | **采信·复现（含行号修正）** |
| 「9 处变异自证均红→绿」 | 未逐条重跑（预算内只抽 6 条），但用**同一工具同型变异**自证了 4 类最容易假绿的 | 见 §三 | **未覆盖**（其余 3 条只读日志，未复跑）—— 但类覆盖成立 |
| 「`--text-main` 值取现网 `body` 实际继承色」**（事实）** | `grep -n "color: #f5f0e6" style.css` | `:156 html, body { color: #f5f0e6 }` | **采信·复现** |
| 「所以四处的显示色不变」**（归因）** | 读 `:156` 的继承链 | `html,body` 均 `#f5f0e6`，`:root` 是 `html` 的父级 → 原继承值即 `#f5f0e6`，新 token 同值 → 观感不变 | **采信·复现**（事实与归因**分别**算过） |
| 「冠军区数字从金变红，因为 `netCls` 正数是 `up`」**（归因）** | 读 `settleView.js:676` + `style.css:3293/3229` | `netCls(top.score)` → `up` → `var(--up-red)`；冠军基本为正 → 实际呈红 | **采信·复现** |
| 「P1 未动规格文档」 | `git status --short` | `M docs/design-states-v2.md`（+D10） | **不采信**（事实不符，见 D-6） |
| 「4 份审查报告 / `release-progress.md` / `INDEX.md` 未动」 | `git status --short` | 4 份审查报告均为 `??`（未跟踪）；`release-progress.md`/`INDEX.md` 不在改动列表 | **采信·复现** |
| 「未跑 `npm test`、未 commit」 | `git log --oneline -3` | HEAD 仍 `66f53db` | **采信·复现** |

### 门禁是否真的在执行链里（硬性）

| 门禁 | 是否被调用 | 证据 |
|---|---|---|
| 3 个新守卫文件 | **是（自动，无需手工挂）** | `scripts/run-tests.js:31-43` **扫描目录** `pwa/test` + `server/test`，`/\.test\.js$/` 全收 —— 不存在"忘了挂进去"这个失败模式（该文件头注释正是为修这个坑写的） |
| CI 是否跑 `npm test` | **是** | `.github/workflows/test.yml:46-49` `- name: 全量测试` → `npm test > /tmp/t.log` |
| 「能红集」双门禁 | **是，且当前绿** | CI `:80` `redset:selftest`、`:83` `redset:check`；我实跑 `npm run redset:check` → `能红记录校验：12 项通过，0 项失败`、`EXIT=0`（本批改了 `style.css`/`game.js`，双端哈希未失效） |

> 注：3 个新守卫文件**未登记进 `docs/red-set.json`**（该文件本批未改）。`redset:check` 只判记录完整性与集合包含，不要求"每个断言都入册"，所以不红；但这也意味着"能红集"这个项目的机器化变异留痕**没有覆盖**本批新增的 240 条断言 —— 本批的变异自证仍只活在两份 md 里。属**流程建议**，不列缺陷。

---

## 九、验收结论

### 判定：**通过（有条件通过 —— 2 条条件均为不阻断的下一批整改项）**

**不通过（阻断）项：0。**
**失败项：0。** 22 项逐条实读源码 + 6 次独立变异自证，全部达标。

**条件（不阻断本批，但必须排进下一批）：**

1. **补齐 D-1 的守卫盲区**：运行时量词节点（`recordsView.js:96/1819/1875` 等）目前无断言覆盖，我实测改回「场」仍绿。本批代码是对的，但下一轮"只改一半"不会被发现 —— 这正是本批要根除的形态。
2. **D-2 补进禁用词扫描面**：`请求超时`/`连接超时`/`连接失败` 仍以裸技术短语直达玩家，`ui-copy [7]` 的"0 条万能文案"因此是**口径内为真、口径外为假**。

### ⚠️ 本报告的证据边界（必须显式声明）

**我只做了静态核验 + 断言级变异自证，没有人在真浏览器里玩过。**

- 未跑 `probe-ui-flow`（按分工由制作人跑两档），因此以下**全部未验**：
  - **操作响应**（按键→画面延迟、跟不跟手）—— 静态断言测不出"顺手"；
  - **消除时机**（动作后 N 帧该对象是否消失）—— 本批虽未动时序，但 U4 改的正是 `pressBusy` 返回后的控制流，**二次点击时的"按钮卡在忙碌态"必须真机复验**；
  - **穿模**（本批未动坐标/碰撞，风险低，但圆角与字号改动会影响 `.settle-go` 箭头在 12px 宽容器里的 20px 字形，**需真浏览器确认不出界**）。
- 「全绿 ≠ 能玩」：本批 22 项里，**凡是"观感"类（字号并档、圆角 1~2px、按钮层级、转圈节奏）都只能靠真机截图判终局**。日志自己也承认"观感终局以真浏览器为准"，我同意并把这一点写进结论，而不是把它藏进"通过"。
- **真人路径（冷启动 → 不点任何钩子 → 走到第一个决策点）本轮无人执行**。制作人若尚未跑，本批**不具备"可交付"的完整证据**，请勿把本报告的"通过"读成"可以上线"。

### 交付建议

- 本批可以进入提交流程：22/22 达标、共享功能零误伤、P0 成果零回退、门禁都在执行链里且能红。
- 但**"可交付"与"可上线"要分开**：本报告只能支持前者。上线前需要 1 份真人试玩录屏（含：结算页两档朝向、按「等人」后的按钮忙碌态、断网时的 toast 文案）。

---

## 十、复跑方式

```bash
# 变异自证（含逐字节还原与 SHA-256 证明）
node tools/qa/mutate-verify.js --list
node tools/qa/mutate-verify.js p0-4-second-layer
node tools/qa/mutate-verify.js p0-4-js-inline
node tools/qa/mutate-verify.js p0-3-text-main
node tools/qa/mutate-verify.js p1-clear-records
node tools/qa/mutate-verify.js u4-hold-restore
node tools/qa/mutate-verify.js zombie-radius-allow
node tools/qa/mutate-verify.js probe-runtime-quantifier   # 盲区探针（期望绿=盲区存在）

# 五个守卫
node pwa/test/design-tokens.test.js        # 59
node pwa/test/number-scale.test.js         # 67
node pwa/test/ui-copy-consistency.test.js  # 58
node pwa/test/interaction-consistency.test.js  # 40
node pwa/test/button-busy-wiring.test.js   # 16

# 门禁在不在执行链里
npm run redset:check
```
