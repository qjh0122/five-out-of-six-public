# 交互与按钮一致性审查（2026-11-19 · 20261119a 基线）

> 视角：前端交互设计 + 主程。**只审不改**：未改任何产品代码，未 commit / push，临时命令即用即弃。
> 基线：HEAD `66f53db`，工作区干净；线上 `20261119a` / `sw v151`（`pwa/sw.js:17`）。
> 本文件是**快照**：行号对应上面的 HEAD，之后改代码行号会漂，引用时请连同 HEAD 一起看。
> 与旧审计的关系：本文只审**交互与按钮**；视觉（光源/字号/颜色/间距）由并行的视觉审查负责。
> 已 QA 通过的「直接退」本身不再评判正确性，只审它与其它交互模式的一致性。

---

## 〇、判定

**按钮体系有语法，危险动作没有语法。**

`.btn` 的变体 × 尺寸是成套的，动效时长与焦点兜底已经被机检钉死，弹窗焦点进出是全套里最扎实的一块。
问题集中在两处：一是**有一类按钮没进这套体系**（`#btn-hold`），于是"点了有反应"这条契约在它身上静默失效；
二是**危险/重要动作按"谁改的时候顺手用了什么"分成了四种写法**，没有一条成文的分级规则——
确认框同时承载"每把都点的提交"和"删号"，同一张红实心"确定"按钮，全靠多出来的密码框做区分。

真问题 **6** 条，已知取舍 **7** 条，存疑需真机 **5** 条。没有一条是"整个交互重做"级别的，
最贵的改动是给确认框加一个语气档位。

---

## 一、现状基线（全部可复跑）

### 1.1 源码规模（本次审计范围）

```
$ wc -l pwa/index.html pwa/js/game.js pwa/js/modalKit.js pwa/js/undoBar.js \
       pwa/js/accountView.js pwa/js/recordsView.js pwa/js/settleView.js \
       pwa/js/seatSheetView.js pwa/css/style.css pwa/css/records.css pwa/css/emoji.css
 1479 pwa/index.html
 5404 pwa/js/game.js
  208 pwa/js/modalKit.js
  174 pwa/js/undoBar.js
  591 pwa/js/accountView.js
 1969 pwa/js/recordsView.js
 1227 pwa/js/settleView.js
 1182 pwa/js/seatSheetView.js
 5620 pwa/css/style.css
 1243 pwa/css/records.css
  476 pwa/css/emoji.css
```

### 1.2 机检守卫生（本次实跑，全部绿）

```
$ for t in design-tokens motion-tokens modal-a11y undo-bar room-actions-fit nickname-fit undo-wiring; do \
    node pwa/test/$t.test.js | grep -E '通过 [0-9]+ 项，失败|全部通过|项失败' | tail -1; done
design-tokens      通过 27 项，失败 0 项
motion-tokens      通过 32 项，失败 0 项
modal-a11y         通过 128 项，失败 0 项
undo-bar           通过 43 项，失败 0 项
room-actions-fit   通过 12 项，失败 0 项
nickname-fit       全部通过 —— 37 passed, 0 failed
undo-wiring        通过 42 项，失败 0 项
```

这七条绿的意义要读准：
- `motion-tokens` 绿 = **transition** 时长/缓动全走 `--dur-1/2/3` + `--ease-std/emph`，手写 0 条；它**刻意不管 animation**（`pwa/test/motion-tokens.test.js:15-16`）。
- `modal-a11y` 绿 = 17 个 `.modal` 的语义、开关入口、焦点栈、Tab 圈定、Esc 顺序都在；`#seat-sheet` 不在 `.modal` 清点内，自己带 Esc（`pwa/js/seatSheetView.js:1138-1140`）。
- `undo-bar` + `undo-wiring` 绿 = 撤销条状态机（覆盖/转后台/DOM 缺失/回调抛错）与接线都成立。
- **`room-actions-fit` / `nickname-fit` 都不测 44px 触摸尺寸**：前者测的是"文字不断行 + 容器可换行"（`pwa/test/room-actions-fit.test.js:52-76`），后者测的是名字缩字号的纯函数与接线（`pwa/test/nickname-fit.test.js:52-133`）。把它们当"触摸尺寸已机检"的证据是误读。

### 1.3 按钮体系现状

`pwa/index.html` 中 `class="…btn…"` 共 24 种组合：变体 6 种（`btn-primary` / `btn-secondary` / `btn-ghost` / `btn-quiet` / `btn-danger` / 裸 `btn`）、
尺寸/修饰 4 种（`btn-lg` / `btn-sm` / `btn-mini` / `btn-submit`）、上下文修饰 2 种（`on-light` / `is-done`）。
体系本身是成套的：基座 `pwa/css/style.css:432-479`，变体 `:482-549`，尺寸 `:551-564`，暖白弹窗变体 `:4592-4596`，焦点兜底 `:4769-4784`。

```
$ grep -oE 'class="[^"]*\bbtn\b[^"]*"' pwa/index.html | sort | uniq -c | sort -rn
```

`pressBusy()`（`pwa/js/game.js:3266-3289`）是全站统一的忙碌态入口，13 处调用；
它同时给 `disabled` + `is-busy` 类 + `dataset.busy` 闸 + 文案替换，并在 `finally` 还原。
13 处中 12 处带 `if (!restore) return;`，唯一例外见【存疑 U4】。

### 1.4 危险/重要动作的四种现行写法

| 模式 | 用例 | 代码位置 | 机检 |
|---|---|---|---|
| 直接执行（双闸 + 忙碌态） | 离开房间（4 入口共用） | `pwa/js/game.js:3707-3735` | `leave-undo.test.js` D-1~D-4 / `undo-wiring.test.js` [6] |
| 延迟 5 秒 + 撤销 | 清除战绩（唯一调用方） | `pwa/js/recordsView.js:1867-1890` + `pwa/js/undoBar.js:91-133` | 43 + 42 项绿 |
| 通用确认框 | 确认提交分组 / 不等他 / 退出登录 / 删号 | `pwa/js/game.js:2836-2840, 1022-1028`；`pwa/js/accountView.js:440, 508-522` | `modal-a11y.test.js` |
| 专用确认弹窗 | 解散投票、爆点拦截、清除战绩的二次确认 | `pwa/js/game.js:3737-3762, 2862-2874`；`records-clear-modal` | `ui.test.js` / `leave-settle.test.js` |

---

## 二、七维度逐条结论

| # | 维度 | 结论 | 分类 | 关键证据 |
|---|---|---|---|---|
| 1 | 按钮体系一致性 | 主体系统一（6 变体 × 4 尺寸），但有 1 颗按钮完全在体系外（`#btn-hold`），另有 3 颗裸 `.btn` 与同屏 ghost 按钮构成"功能同类、皮肤两套" | 【真问题】P1 / P6 | `index.html:528, 535-536, 539, 546-547`；`style.css:432-479, 3389-3415` |
| 2 | 状态完整性 | `active` / `disabled` / `focus-visible` / `loading` 四种态主体系齐全；`disabled` 都真禁用（未发现只画灰的 `.disabled` 类使用）；缺口集中在确认框只换文字不转圈、体系外按钮四态皆无 | 【真问题】P1 / P5 | `style.css:453-479, 4769-4784`；`game.js:3122-3124, 3266-3289`；`accountView.js:131-132, 424` |
| 3 | 点击反馈与动效节律 | 按旧审计结论执行到位：实体按钮 `translateY`、卡片/图标 `scale`、行换底色——三种物体三种反应，是语法不是混乱。transition 时长已收敛到 3 档且机检 0 违规；animation 的手写时长是刻意豁免。残留：两个"加载环"周期不同（0.7s / 900ms） | 【已知取舍】K1 / K2；【真问题】P5 | `style.css:453-456, 478, 3507, 4754-4763`；`records.css:609` |
| 4 | 危险动作模式一致性 | 四种模式并存，且**没有成文的分级规则**：确认框同时服务"每把都点"的提交和删号，确定键同一张红实心按钮；直接退/撤销/确认三种保护的强弱与后果严重度不单调。`UndoBar` 现在只有一个调用方，跨调用点一致性问题已不存在，但残留一条无调用方的 reason 注释 | 【真问题】P2；【存疑需真机】U3；【已知取舍】K3/K5 | `game.js:2836-2840, 3080-3100`；`accountView.js:508-522`；`index.html:1162-1174`；`undoBar.js:140` |
| 5 | 表单与输入 | 标签/占位符/长度限制大体齐：`nickname-input` 有 `<label>`、`room-input` 有 `inputmode="numeric"` + `aria-label`、密码框都有 `autocomplete`。不一致在 Enter 语义：5 个输入框绑了 Enter，删号密码框没绑；首页昵称框的 Enter 会直接建房 | 【真问题】P3 / P4 | `index.html:286-298, 357-364, 1168, 1184, 1252-1255`；`game.js:4877-4878, 5022-5023, 5072-5073, 5115-5119` |
| 6 | 键盘可达与触摸尺寸 | 弹窗键盘链路是全套最强的一块：焦点栈、Tab 圈定、Esc 优先级、返回键关闭全在且 128 项守卫绿；`seat-sheet` 自带 Esc。触摸尺寸靠 `--tap-min = max(88, ceil(44/scale))` 跟随缩放，但 `room-actions-fit` / `nickname-fit` 两测试**不覆盖**它；撤销条在 320 档只补到 ≈41 CSS px（R14 明示接受 40 判据） | 【已知取舍】K7；【存疑需真机】U1 / U2 | `modalKit.js:34-49, 110-170`；`game.js:4278, 5128-5185`；`style.css:3513-3515, 4754-4784` |
| 7 | 交互反馈闭环 | 四态规格 `design-states-v2.md` 与接线守卫一致：加载 0 按钮 / 失败 2 / 离线 1 / 空 1，`aria-live` 分级；错误三级沿用 v1。异步动作普遍有 `pressBusy` 即时回执；缺口在确认框忙碌态与解散投票的反馈不对称 | 【真问题】P5；【存疑需真机】U5 | `design-states-v2.md:40-57, 83-85`；`states-wiring.test.js:124-149`；`game.js:3737-3762` |

---

## 三、问题清单（按玩家可感知程度排序）

### 【真问题】

#### P1 · `btn-hold`「等人」在按钮体系外，按压回执与忙碌态静默失效

- **证据**
  - `pwa/index.html:528`：`<button id="btn-hold" class="btn-hold hidden" type="button" …>` —— **没有 `.btn`**。
  - `pwa/css/style.css:3389-3405`：`.next-row .btn-hold` 自带静态样式，但整块**没有 `:active`、没有 `[disabled]`、没有 `.is-busy`**（对照 `.btn` 基座 `:453-479`）。
  - `pwa/js/game.js:3658`：`pressBusy(btn, on ? '挂起中…' : '开牌中…')` 会加 `is-busy` 类；而转圈规则是 `.btn.is-busy::after`（`style.css:469`），禁用变灰是 `.btn[disabled]`（`:458`）——两个选择器都要求 `.btn`，在这颗按钮上**都不匹配**。
  - 同一动作的另一入口 `pwa/index.html:469` 的 `#btn-hold-off` 却是 `class="btn btn-ghost"`：功能同族、皮肤两套。
  - `pwa/js/settleView.js:1150-1158` 只给它写 `data-hold-next`，从未补 `.btn`。
- **玩家感知**：结算页房主唯一专属动作，按下去没有任何物理回执；挂起的 3 分钟里在途只有一行文字变化，既没有转圈也没有禁用变灰——正是旧审计 §2.3 反对的"点了没反应"手感。
- **建议改法**：把 `.btn-hold` 从"独立按钮"改成"`.btn` 上的修饰类"（`class="btn btn-ghost btn-hold"`），尺寸覆盖留在 `.next-row .btn-hold`，四态立刻继承；或最小改动：在 `:3405` 后补 `.btn-hold:active`、`.btn-hold[disabled]`、`.btn-hold.is-busy::after` 三条，抄 `.btn-ghost` 的值。再加一条守卫：**任何传给 `pressBusy()` 的选择器，其元素必须带 `.btn` 或自行定义 `:active`/`[disabled]`/`.is-busy` 三态**。
- **复跑**：`grep -n 'class="btn-hold"' pwa/index.html`；`sed -n '3389,3416p' pwa/css/style.css`；`grep -n 'is-busy' pwa/css/style.css`。

#### P2 · 确认框没有严重度分级：删号与"每把都点"共用同一张确定按钮

- **证据**
  - `pwa/js/game.js:2836-2840`：每把一次 `askConfirm('确认提交分组？', …)`；`pwa/js/game.js:1022-1028`：`askConfirm('不等 … 了？', …)`。
  - `pwa/js/accountView.js:508-522`：删号走同一个 `askConfirm`，只多传 `{ busyText:'删除中…', secret:true }`。
  - `pwa/index.html:1162-1174`：三者共用同一个 `#confirm-modal`，确定键永远是 `<button id="btn-confirm-ok" class="btn btn-primary">确定</button>`（`:1170`），没有 tone 切换。
  - 项目里**有** danger 变体（`style.css:543-549`），但只用在水面入口：`index.html:503`「结束本局」、`index.html:1207`「删除账号与战绩」，反而**没用在最后那道确认上**。
  - 已有的缓解：删号要输密码（`game.js:3088-3096`）、默认焦点给"取消"（`index.html:1173`）。所以不是零保护，而是**决策按钮本身没有语气**。
- **玩家感知**：确认疲劳。每把都见的红底"确定"和删号时的红底"确定"长得一样，真正区分危险的只剩一个输入框——玩家学会的"一路点确定"习惯正好在最重要的一次生效。
- **建议改法**：`askConfirm(title, desc, onOk, opts)` 增加 `opts.tone`；`'danger'` 时给 `#btn-confirm-ok` 换 `.btn-danger`（或专门的实心危险变体）并把标题前的图标/文案加上不可逆提示；删号与解散类调用传 `tone:'danger'`。补一条静态守卫：`opts.secret===true` 的调用点必须同时带 `tone:'danger'`，防止以后漏传。
- **复跑**：`grep -rn 'askConfirm(' pwa/js`；`sed -n '1162,1174p' pwa/index.html`。

#### P3 · 删号密码框不支持 Enter，与其余 5 个输入框不一致

- **证据**：绑了 Enter 的输入框共 5 处 —— `game.js:4877-4878`（rename）、`:5022-5023`（auth-pass）、`:5072-5073`（pwd-new）、`:5115-5116`（room-input）、`:5118-5119`（nickname-input）。
- `pwa/js/game.js:3087-3096` 在需要密码时把焦点主动挪到 `#confirm-secret`（`index.html:1168`），却**没有**给这个输入框绑 `keydown`。
- **玩家感知**：键盘/开关控制用户走到删号最后一步，输完密码按 Enter 没反应；必须再 Tab 一次才到确定。和前面四个表单"输完回车就走"的肌肉记忆相反。
- **建议改法**：在 `askConfirm` 里给 `sec` 挂一次 `keydown`：`if (e.key === 'Enter') { e.preventDefault(); onConfirmOk(); }`，`onConfirmOk` 自带 `confirmBusy` 与空密码拦截（`game.js:3109-3121`），无需额外防连点。
- **复跑**：`grep -n "e.key === 'Enter'" pwa/js/game.js`。

#### P4 · 首页昵称框的 Enter 直接建房，容易与"保存昵称"混淆

- **证据**
  - `pwa/index.html:357-361`：`<label for="nickname-input">昵称</label>` + `<input id="nickname-input" maxlength="8" placeholder="输入昵称">`，紧邻 `btn-create`（`:361`）。
  - `pwa/js/game.js:5118-5120`：`$('#nickname-input').keydown` → `if (e.key === 'Enter') onCreate();`。
  - `pwa/js/game.js:5123-5125`：每次 `input` 事件已经把昵称持久化了 —— 用户有充分理由认为 Enter 只是"确认昵称"。
  - 对比 `room-input` 的 Enter → `onJoin()`（`:5115-5116`）：这是输入框与相邻按钮的直觉映射；昵称框的相邻按钮语义是"建房"，映射本身成立，但对一个标着"昵称"的字段是意外。
- **玩家感知**：改个昵称顺手回车，直接开出一个房间并跳转，别人可能已经进来了。
- **建议改法**：最小成本是给出预期——`placeholder` 改成「输入昵称（回车创建房间）」或加 `enterkeyhint="go"`；更保守的做法是昵称框 Enter 只 `blur()`，把建房留给显式点击。二选一即可，关键是别让当前行为没有提示。
- **复跑**：`sed -n '357,365p' pwa/index.html`；`sed -n '5115,5125p' pwa/js/game.js`。

#### P5 · 忙碌态有两套视觉：确认框只换文字，两个加载环还不同周期

- **证据**
  - 全站入口 `pressBusy()`：`game.js:3266-3289`，`btn.disabled = true` + `classList.add('is-busy')` + 文案；`style.css:468-479` 给转圈（`animation: btnSpin 0.7s linear infinite`，`:478`）。
  - `game.js:3122-3124`（确认框确定键）：只有 `btn.disabled = true; btn.textContent = confirmBusyText;`，**没有 `is-busy`** —— 删号"删除中…"那几秒没有转圈。
  - `game.js:3266` 之外的手写忙碌态：`accountView.js:131-132, 424` 有 `is-busy` ✓；`recordsView.js:1834` 只有 `disabled`（但弹窗已关，影响低）。
  - 第二个加载环：`records.css:609` `animation: rpSpin 900ms linear infinite` —— 同为"正在处理"，周期 900ms 与 0.7s 不同。
- **玩家感知**：同一件事"在等我"，有的按钮转圈有的只会变字；战绩页转圈速度和按钮转圈速度不一样，串起来读不出"这是同一个系统的同一种状态"。
- **建议改法**：把 `onConfirmOk` 的忙碌态也走统一入口或至少补 `btn.classList.add('is-busy')`；把 `0.7s` / `900ms` 收敛成一个 token（如 `--spin-period: 800ms`），两处都引用。加一条守卫：所有 `async` 点击处理函数里出现 `disabled = true` 时必须同时出现 `is-busy` 或 `pressBusy`。
- **复跑**：`grep -rn "is-busy\|disabled = true" pwa/js | head -30`；`grep -rn 'Spin [0-9]\|spin [0-9]' pwa/css`。

#### P6 · 结算页三颗次级按钮裸用 `.btn`，与相邻 ghost 按钮皮肤不同

- **证据**
  - `pwa/index.html:535-536`：`btn-share`「生成战绩图」、`btn-replay`「本局过程」都是 `class="btn btn-lg"`；`:539`：`btn-records`「查看战绩」是 `class="btn"`。三者都落到 `style.css:444-447` 的**兜底**背景 `rgba(255,255,255,0.14)` + 实体下沿 `:450`。
  - 同一区域的 `pwa/index.html:546-547`：`btn-sit-out`「这把不打」、`btn-back-room`「离开房间」是 `.btn btn-ghost`（透明 + 白描边 + 无投影）。
  - `pwa/index.html:531-533` 的注释明确说"四个都是看一眼的事，不是主操作"，并且是为了解决"一个结算页堆了 5 个按钮三种样子"才重排的——结果仍是三种样子（实心主 / 裸实体 / 描边幽灵）。
  - `style.css:444` 的兜底注释还以"首页「加入房间」就是 `class="btn btn-lg"`"举例，但 `pwa/index.html:364` 现在已是 `btn btn-quiet btn-lg`：注释过期，裸 `.btn` 已不再有被声明的设计意图。
- **玩家感知**：同一排里"查看战绩"看着像可以按下陷的实体键，"这把不打"看着像轻量的文字链；二者其实都是次级动作，层级读不出来。
- **建议改法**：给 `:535/536/539` 一个明确变体（要实体次级就 `.btn-quiet`，要轻量就 `.btn-ghost`），让"变体 = 语义"重新成立；顺手更新 `style.css:444` 的过期注释。加一条静态守卫：`class="btn…"` 的组合中必须含且只含一个变体类。
- **复跑**：`grep -nE 'class="btn"|class="btn btn-lg"' pwa/index.html`。

### 【已知取舍】（刻意如此，不建议改）

| # | 取舍 | 依据 |
|---|---|---|
| K1 | 三种按压语法并存（实体 `translateY(6px)` / 幽灵 `translateY(2px)` / 撤销条 `scale(0.96)` / 行换底色） | 旧审计 v135 已改判"三种物体三种反应是语法不是混乱"；`ui-audit-2026-11-07.md:75-77, 199`；`style.css:453-456, 3507` |
| K2 | `prefers-reduced-motion` 用 `0.01ms` 而非 `none`，保留 `transitionend` 让收尾逻辑不卡住 | `style.css:4749-4763`；`motion-tokens.test.js:228-238`，32/0 绿 |
| K3 | 离开房间直接退：`leaveInFlight` + `pressBusy` 双闸、断网吞错照常回首页 | `game.js:3707-3735`；QA `qa-leave-direct.md` 两探针 19/19；本轮按要求不重审其正确性 |
| K4 | 「已就位 ✓」带 `disabled` 但用淡绿"已完成"而非灰底 | `style.css:496-505`，注释说明了"灰底会让人以为按钮坏了" |
| K5 | 战绩清除用"5 秒后执行、期间可撤销"而非"执行后回滚" | `undoBar.js:10-18`；`recordsView.js:1869-1872` |
| K6 | 危险入口（删号 / 结束本局）用描边 danger 而非实心，弱化误触 | `index.html:503, 1207`；`style.css:543-549` —— 是常见的"降级破坏入口"做法，不宜按"红=危险"硬改 |
| K7 | 弹窗全部 17 个 + seat-sheet 都接进焦点栈 / Tab 圈定 / Esc 链 | `modal-a11y.test.js` 128/0；`modalKit.js:34-49, 110-170`；`game.js:5128-5185` |

### 【存疑需真机】

| # | 存疑点 | 证据 / 需验证什么 |
|---|---|---|
| U1 | 按钮全站无 `:hover` 态 | 全 CSS 只有 4 处 `:hover`，且全在结算行（`style.css:3188-3192, 5183-5184`），`.btn` 基座 `:432-479` 没有。触屏上 `:hover` 会粘住不散，去掉是合理的；但旧审计记载桌面档 1280×720 / 728×348 真在用，需在桌面档确认缺少悬停反馈是否构成问题。 |
| U2 | 撤销键在 320 档的实际热区 | `style.css:3513-3515`：88 设计px ≈38 CSS px，只给紧凑竖屏补到 96 设计px ≈41 CSS px；R14 注释明示用的是"40 触摸判据"而非 44。需真机量 320×568 与横屏 728×348 的实际物理像素。 |
| U3 | 撤销条唯一锚点 `bottom:300px` 在横屏是否压内容 | `style.css:3467-3472`；`:3509-3512` 说明离开用的屏级锚点已随直接退移除，只剩按战绩页调的 300px。战绩页 390×844 有 QA 覆盖，横屏/结算屏没有本轮证据。 |
| U4 | `onHoldNext` 是唯一漏掉 `if (!restore) return;` 的 `pressBusy` 调用 | `game.js:3658`：`var restore = btn ? pressBusy(...) : function () {};`，最后 `:3666` `finally { restore(); }`。若 `pressBusy` 因已在途返回 `null`，`finally` 会 `TypeError`。正常二次点击被 `disabled` 挡住，所以现网难复现；但与其他 12 处写法不一致，需构造"弹窗委托 + 广播重绘"路径真机确认。 |
| U5 | 解散投票的反馈与发起解散不对称 | `game.js:3741` 发起走 `pressBusy(btn,'提交中…')` + `Sfx.play('submit')`；`:3755-3762` 投票只 `hideModalEl('dissolve-modal')` 后 `await`，无忙碌态也无成功音。弹窗消失本身就是回执，所以是否算问题取决于真机上"点了同意 → 弹窗消失 → 界面多久才变"的间隔。 |

---

## 四、与旧审计 B2 / B3 的对照

| 旧审计项 | 当时结论 | 本轮复核（2026-11-19） | 判定 |
|---|---|---|---|
| B2 · 时长 7→3 档 | 22 条 transition 的 9 种时长 → `--dur-1/2/3`（120/200/320），手写 0 条 | `motion-tokens.test.js` 32/0 绿；`style.css:451` 等全走令牌；手写时长只在 animation（刻意豁免） | ✅ 保持 |
| B2 · 按压回执"三种是混乱" | v135 自我更正：三种物体三种反应，是语法；B2 只动时长不动手势 | 本轮同意该更正；`.btn` 实体 `translateY(6px)`、幽灵 `2px`、撤销条 `scale(0.96)` 各自成类。**唯一缺口是 `#btn-hold` 根本没进这套语法**（P1） | ✅ 保持 + 补一处漏网 |
| B2 · `:focus-visible` 补到 100% | 11 条手写白名单 → 反向兜底，`button` / `[role=button]` / `[tabindex]` / `a`，权重 (0,1,1) | `style.css:4769-4784` 仍是反向兜底，`modal-a11y` 128/0；`#btn-hold` 因为本身就是 `<button>`，焦点环由 `button:focus-visible` 覆盖（这点没问题） | ✅ 保持 |
| B2 · reduced-motion 只覆盖 5 处（旧审计自纠：这句是错的） | 是 4 块，其中一块是 `*` 全局兜底，覆盖本来 100% | `style.css:4754-4763` 的 `*` 兜底带 `!important`，同时关 animation / transition / scroll-behavior | ✅ 旧更正成立 |
| B3 · 可撤销 | 计划"清除记录 / 离开房间改执行 + 5 秒撤销"；v136 先做清除，且改延迟执行 | 离开房间已按用户要求改直接退（K3），`UndoBar` 只剩战绩清除一个调用方；其状态机 43 项 + 接线 42 项绿 | ⚠️ 计划已分叉，但属明确需求变更，不是回潮 |
| B3 · 四态 | 空 / 加载 / 失败 / 离线各有可识别视觉，加载零按钮 | `design-states-v2.md:40-57` 为现行规格，`states-wiring.test.js:124-149` 断言按钮数签名 0/2/1/1 与 `aria-live` 分级 | ✅ 保持 |
| B3 · 错误分级 | 可重试 / 不可恢复 / 静默三类，文案与动作不同 | `design-states-v2.md:83-85` 沿用 v1 §② 未改判；接线守卫绿 | ✅ 保持 |
| B3 · 数字层级 / 等待可见 / 策略引导 | 前两项已落地，策略引导仍欠 | 前两项不在本次交互审查范围；策略引导（`guide-modal`）在 Esc 链与 Tab 圈定内，未见交互层问题 | ➖ 范围外 |

**结论**：B2 基本全部保持，没有回潮；B3 的"可撤销"一项因产品需求从"离开撤销"改为"直接退"而分叉，**该分叉是明确的、已 QA 的需求变更，不按设计债记账**。本轮 6 条真问题里，P1 是 B2"按压回执全覆盖"在新增按钮上的漏网，其余 5 条是 B3 之后新出现的模式一致性问题，不是旧计划没做完。

---

## 五、取证限制

1. **未做真人可用性测试**，也未开真浏览器。所有"玩家感知"是基于源码、既有 QA 文档与机检守卫的推断，不是实测结论。
2. **触摸尺寸没有本轮机检证据**。`room-actions-fit` / `nickname-fit` 守的是文字排版与名字缩字号，不是 ≥44px；`--tap-min` 的实际物理像素依赖 `probe-ui-flow` / `probe-room-actions` 一类 CDP 探针，本轮未跑。U2 / U3 必须真机确认。
3. **未跑 `npm test` 全量**（14978 字节的 `ui.test.js` 等未逐项执行），只跑了与上七个维度直接相关的 7 个守卫文件；全量基线仍以 `leave-direct-change.md §5.7` 的 171 文件 / 7140 断言 / 0 失败为准。
4. **CRLF 影响跨行静态匹配**：`game.js` 是 CRLF（`core.autocrlf=true`），静态断言需写 `\r?\n`，否则"没匹配到"会伪装成"代码没写"（`modal-a11y.test.js:123-125` 有详述）。本报告行号按 Read 工具输出的逻辑行。
5. **危险动作分级的"应有形态"没有现行规范文件**：`design-states-v2.md` 覆盖四态/数字/错误三级，不覆盖"什么动作该确认、什么该直退"。P2 的判断依据是项目内部的一致性（同一弹窗承载不同严重度 + 已有 danger 变体未复用），不是外部规范；若产品侧已有未落盘的口径，应以产品口径为准复核 P2。
6. **残留的过期文案**：`pwa/index.html:1166` `#confirm-desc` 的静态默认值仍是「确定离开房间？」——`askConfirm` 每次都会覆写它，所以玩家看不到，但它是直接退改动后的文字残留；`pwa/js/undoBar.js:140` 的 `'room-changed'` reason 注释已无调用方。两者都不影响行为，本轮不改，一并记录避免被当成新 bug。
7. 本报告只交付审查结论，**未修改任何产品代码、未提交、未推送**；无临时脚本落盘。
