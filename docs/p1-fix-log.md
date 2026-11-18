# P1 UI 一致性整改实施日志（2026-11-19）

> 基线：P0 完成态（工作区 `66f53db` + P0 未提交改动）。
> 实施范围：只改产品代码与对应测试守卫；4 份 `docs/ui-audit-*` / `ui-consistency-audit-*` 审查报告、`release-progress.md`、`INDEX.md`、memory 一律未动；`design-states-v1.md` 等规格文档也未改。
> 未 commit / 未 push；按要求**未跑 `npm test`**，只单跑受影响测试文件（数字见 §二），全量由制作人补跑。
> P0 成果全部保留并逐条复核：`.sc-net` 三态、`--text-main` 定义、`btn-hold` 的 `.btn`、量词「局」、两个 P0 新守卫均在位且绿。

---

## 一、13 项 + U4 逐项交付

### 视觉域

#### P6 · 同屏文字层字号收敛

**改了什么**
- `pwa/css/style.css:105-113`：`:root` 新增文字层阶梯 `--fs-1..4 = 32/28/24/20px`，取值刻意复用 numeric 中间四档（`var(--num-3/u1/4/u2)`），语义分离：文字引用 `--fs-*`，数字引用 `--num-*`；注释写入与 `--dur-*`/`--ease-*` 同款的「想加档先改文档」纪律。
- 结算页同屏文字层 9 个选择器从字面量改走阶梯：`:3214 .settle-go` 22→`fs-4`、`:3245 .settle-recheck` 24→`fs-3`、`:3260 .sr-hint` 22→`fs-4`、`:3264 .settle-tip` 20→`fs-4`、`:3269 .settle-ai-note` 20→`fs-4`、`:3286 .sc-k` 22→`fs-4`、`:3296 .sc-gap` 22→`fs-4`、`:3300 .settle-reset-note` 20→`fs-4`、`:3304 .settle-wait` 24→`fs-3`。
- 30px 的那一档（`.sc-net`）已在 P0-1 归位为 `var(--num-2)`，本批不重复改；40px 的 `.sc-name` 也已在 P0 归位为 `var(--num-3)`。

**配套守卫**：`pwa/test/number-scale.test.js [6]`——四档 token 值 + 纪律注释断言；9 个文字层选择器 must-be-`var(--fs-[1-4])`；22/30px 归零；并把两处**刻意保留**的梯外值写进断言：`settle-rank.is-bot` 的 30px（头像字母随直径走，是几何值）、`.sp-title` 的 40px（旁听卡另有 `.ls` 横屏缩放档）。

**变异自证**（`.sr-hint` 改回 `22px` → 红，恢复 → 绿）：
```
=== RED ===
  FAIL  number-scale.test.js:323:3  ★★ 9 个文字层选择器全部走 --fs-*  -> got 1 want 0  | .settle-recheck .sr-hint → 22px
  FAIL  number-scale.test.js:332:3  ★★ 22px/30px 在文字层归零  -> got 1 want 0
通过 65 项，失败 2 项
=== GREEN ===  通过 67 项，失败 0 项
```

**取舍（保守，不硬压）**：
- 只收敛**结算页同屏文字层**。全站仍存在其它 px 字号档（13/15/17/19/21/26/27/34/36/38/42 等），它们分散在旁听卡、横屏 `.ls` 档、安装提示、角标等**不同屏/不同密度**，不是同一屏的散档；逐屏并档会动到缩放体系，超出本批范围。
- `.sp-title`(40)/`.sp-tip`(26)/`.ls .sp-*`(15/18/26) 整组保留：横屏只有 390 高，旁听卡三行字挤满，40→32 会把标题压没；审计 §六.4 也标注过需截图才能判，静态并档风险大于收益。
- `.settle-pos` 角标 16px 沿用 P0 number-scale 的 `BADGE_EXEMPT`（24×24 圆心放不下 24px 字），不是文字层。
- 22px→20px 而不是 28px：这一档全是「提示/标签/箭头」，语义上比正文 `.settle-recheck`(24) 低一档，并到 20 保持层级方向；并到 28 会反超正文。

#### P7 · 圆角四档 token

**改了什么**
- `pwa/css/style.css:115-124`：`:root` 新增 `--r-chip:12px` / `--r-card:16px` / `--r-modal:24px` / `--r-pill:999px`，注释按「这是什么形状」而非「哪个屏幕」分档，并写入「想加档先改文档」。
- 4 个 CSS 文件共 **84 处**近重复/主流圆角归一到 token：11→12、14→16、18→16、12→chip、16→card、24→modal、999→pill、26→28；emoji 气泡 `calc(18px * --emo-k)` 的基准值换成 `calc(var(--r-card) * --emo-k)`。圆角取值种类 **21 → 17**。

**配套守卫**：`pwa/test/design-tokens.test.js [8]`——四档 token 值；分类器自测（token/几何原语放行，14px/现编 17px 抓红）；漂移家族 11/14/18/26 字面量归零；显式几何豁免清单（0 / 50% / inherit / 3/6/8/10/20/28/32/48px / `28px 28px 0 0` / calc 那一条）**逐项必须在 CSS 里还有一处**，防止清单腐化成免责声明；取值种类 ≤17；四个 token 都被真引用（非纸面 token）。

**变异自证**（`.card-box.drop-swap` 改回 `14px` → 红，恢复 → 绿）：
```
=== RED ===
  FAIL  design-tokens.test.js:353:3  ★★ 圆角只取 --r-* 或显式几何豁免  -> style.css: 14px → 非法圆角：14px
  FAIL  design-tokens.test.js:356:3  ★★ 圆角取值种类从 21 收敛到 ≤17（现 18）
通过 57 项，失败 2 项
=== GREEN ===  通过 59 项，失败 0 项
```

**取舍（观感明显变化处）**：
- 审查建议的字面判据是「圆角只准取 `--r-*` 或 50%/inherit」。本批**没有把这条判据硬套到全站**：`3/6/8/10/20/28/32/48px` 与 `28px 28px 0 0` 是既成的角标/圆形/纸卡/半屏上沿形状，强行并进四档会肉眼可见地改版（最典型：`28px→24px` 影响 6 张纸卡、4px 的圆角差在并排时很明显；`28px 28px 0 0` 是顶部半屏的造型，不能压成一个值）。这些值以**具名豁免清单**保留，且每条都做了「僵尸检查」（必须仍在 CSS 里）。
- `18→16` 而不是 `18→20`：18px 的 4 处里 3 处是内容块（撤销条、说明框、局数格），与 card 语义一致；取 16 保持卡片语言统一。1px~2px 的差在 0.52 scale 下 < 1 物理像素。

### 交互域

#### P2 · 确认框严重度分级

**改了什么**
- `pwa/js/game.js:3085-3088`：`askConfirm` 读 `opts.tone`；`danger` 时 `title + '（不可撤销）'`，`#btn-confirm-ok` 从 `.btn-primary` 切到 `.btn-danger`（`toggle` 双向，非 danger 会恢复）。
- `pwa/js/accountView.js:521`：删号调用传 `{ busyText:'删除中…', secret:true, tone:'danger' }`。

**配套守卫**：`pwa/test/interaction-consistency.test.js [1]`——调用点提取器（括号/引号配平）先自测；扫全部 4 处 `askConfirm`，凡 `secret:true` 必带 `tone:'danger'`；实现侧四要素（读 tone / 换 danger / 恢复 primary / 标题提示）；反向断言「每把都点的确认提交分组」仍用默认语气。

**变异自证**（删掉 `tone:'danger'` → 红，恢复 → 绿）：
```
=== RED ===
  FAIL  interaction-consistency.test.js:115:3  ★★ 每个 secret===true 的调用点都同时带 tone:danger  -> got 1 want 0
  FAIL  interaction-consistency.test.js:121:3  ★ 删号调用传 tone:danger
通过 38 项，失败 2 项
=== GREEN ===  通过 40 项，失败 0 项
```

**取舍**：`askConfirm` 只有 4 个调用方——确认提交分组 / 不等他 / 退出登录 / 删号。「不等他」的描述明确写着「名次和分数都留着」，标 danger 说「不可撤销」是假话；「解散投票」走专用 `#dissolve-modal`，根本不经过 `askConfirm`。所以 danger 只加在删除账号这一处，避免把危险档稀释成"全是危险"。

#### P3 · 删号密码框 Enter

**改了什么**：`pwa/js/game.js:3111-3116`——`askConfirm` 里给 `#confirm-secret` 挂 `sec.onkeydown`（属性赋值，重复弹框不叠加）：Enter → `preventDefault()` + `onConfirmOk()`；非密码场景 `sec.onkeydown = null` 摘掉僵尸 handler。`onConfirmOk` 自带 `confirmBusy` 连点闸与空密码拦截，无额外防重复。

**配套守卫**：`interaction-consistency.test.js [2]`——函数体提取后断言 keydown/Enter/onConfirmOk/摘监听四件事，以及全站 Enter 绑定数 ≥7（P0 是 6）。

**变异自证**（把 `sec.onkeydown = function` 换掉 → 红，恢复 → 绿）：
```
=== RED ===  FAIL ...:134:3  ★ 密码框挂了 keydown ...  通过 39 项，失败 1 项
=== GREEN ===  通过 40 项，失败 0 项
```

#### P4 · 昵称框 Enter 有预期

**改了什么**：`pwa/index.html:359`——placeholder `输入昵称` → `输入昵称（回车创建房间）`，加 `enterkeyhint="go"`。按派单的推荐项「保留行为 + 加预期」，不改 `game.js:5142` 的 Enter→`onCreate()` 行为。

**配套守卫**：`interaction-consistency.test.js [3]`——placeholder / enterkeyhint / 行为未改三断言。

**取舍**：另一选项（Enter 只 blur）会改变已上线行为，且需要同时改 `_onCreate` 的调用路径，风险高于加提示；选加预期。

#### P5 · 忙碌态一套视觉

**改了什么**
- `pwa/js/game.js:3147/3154`：确认键忙碌从「只 disabled + 换文字」补成 `btn.classList.add('is-busy')` / `remove('is-busy')`，与 `pressBusy` 同三态。
- `pwa/css/style.css:80` 新增 `--spin-period: 800ms`；`:510` `btnSpin 0.7s` 与 `pwa/css/records.css:609` `rpSpin 900ms` 同时改引 `var(--spin-period)`。

**配套守卫**：`interaction-consistency.test.js [4]`——token 值、两处引用、旧周期归零、确认键 is-busy 成对；另有一条全站规则：写了 `disabled = true` 的函数必须同时出现 `is-busy` 或 `pressBusy`，渲染态豁免按**具名函数**逐项列理由（`readyBtn` 已就位徽标用 `.is-done`、`updateSubmit` 的「已提交/还差 N 张」文案），并断言豁免项仍在代码里。

**变异自证**（去掉确认键的 `is-busy` → 红，恢复 → 绿）：
```
=== RED ===  FAIL ...:166:3  ★★ 确认键 disabled 时同时 is-busy  通过 39 项，失败 1 项
=== GREEN ===  通过 40 项，失败 0 项
```

**取舍**：800ms 取 0.7s 与 900ms 的中间值，两个环都放慢/加快不到 100ms，读者不会察觉节奏突变；没有把 `rpSpin` 直接删掉复用 `.btn` 的伪元素——战绩页加载环是独立 SVG 大小的 DOM，共用选择器会牵动尺寸体系。

#### P6（交互）· 结算页三颗次级按钮

**改了什么**：`pwa/index.html:535/536/539`——`btn-share` / `btn-replay` 的 `btn btn-lg` → `btn btn-quiet btn-lg`，`btn-records` 的裸 `btn` → `btn btn-quiet`。`pwa/css/style.css:441-447` 过期注释更新：不再说「裸用可以拿兜底灰底」，改说「每颗按钮必须带一个变体类」，并把例子改成现网的 `btn btn-quiet btn-lg`。

**配套守卫**：`interaction-consistency.test.js [5]`——扫 HTML 所有 `class="…btn…"`（≥20 颗），变体类 `{primary,secondary,quiet,ghost,danger}` 必须**含且只含一个**；三颗按钮各自带 `btn-quiet`；过期注释句子消失且新例子在 CSS 里。

**变异自证**（`btn-share` 改回裸 `btn btn-lg` → 红，恢复 → 绿）：
```
=== RED ===
  FAIL ...:212:3  ★★ class="btn…" 含且只含一个变体类  -> btn btn-lg → 变体数 0
  FAIL ...:215:5  ★ #btn-share 用实体次级 btn-quiet
通过 38 项，失败 2 项
=== GREEN ===  通过 40 项，失败 0 项
```

**取舍**：选 `btn-quiet`（实体次级）而非 `btn-ghost`——这三颗是「看一眼的事」但仍要有可点的实体感；相邻的「这把不打 / 离开房间」保持 ghost 轻量，于是两个层级（次级实体 / 幽灵）在同一排里读得出来，而不是全排一个样。

#### U4 · onHoldNext 的 restore 防御

**改了什么**：`pwa/js/game.js:3661`——`onHoldNext` 在 `pressBusy` 返回后补 `if (!restore) return;`，与其余 12 处写法一致；`finally` 不再可能对 `null` 调 `restore()`。

**配套守卫**：`interaction-consistency.test.js [6]`——调用点提取器数出 13 处 `pressBusy`，`if (!restore) return;` 必须也是 13 处；并单独用函数体断言 onHoldNext 内有这一行。

**变异自证**（删掉 onHoldNext 那一行 → 红，恢复 → 绿）：
```
=== RED ===
  FAIL ...:227:3  ★★ 每处 pressBusy 调用后都有 if(!restore) return（12/13）  -> got 12 want 13
  FAIL ...:229:3  ★★ 唯一漏网的 onHoldNext 已补齐
通过 38 项，失败 2 项
=== GREEN ===  通过 40 项，失败 0 项
```

### 文案域

#### P5（文案）· 战绩/记录混用

**改了什么**（全站统一「战绩」，本机副本写「本机战绩」）
- HTML：`:797`「先把这台设备上的记录给你看」→「先把本机战绩给你看」；`:815`「清除记录」→「清除战绩」；`:896`「当前 0 局记录将被删除」→「…0 局战绩…」。
- `recordsState.js:71/91` 两处副文案 →「先把本机战绩给你看」（`:68/:100` 本就是「战绩」）。
- `recordsView.js:735` 降级说明 →「先显示本机战绩」；`:897`「暂无战绩记录」→「暂无战绩」；`:1819` 计数回执 →「局战绩将被删除」；`:1849` 两种回执里的「已清除这台设备上的记录」→「本机战绩已清除」；`:1875/1879` 撤销条 msg 与取消回执 →「战绩」。
- `accountView.js:510` 删号描述「本机记录」→「回放和本机副本」；注释里引用旧按钮名的几处同步更新。
- 「过程记录」「下载记录」是**别的语义**（回放步骤 / 浏览器下载列表），刻意保留。

**配套守卫**：`ui-copy-consistency.test.js [5]`——HTML 与 JS 可见字符串里 `清除记录|战绩记录|局记录|设备上的记录` 命中 0；三个关键静态文案 + 运行时覆写文案正面断言；「本机战绩已清除」和撤销条拼接文案在位；「过程记录」仍在（防误伤）。

**变异自证**（按钮改回「清除记录」→ 红，恢复 → 绿）：
```
=== RED ===
  FAIL  ui-copy-consistency.test.js:136:3  ★★ 清除按钮写「战绩」  -> got 0 want 1
  FAIL  ui-copy-consistency.test.js:140:3  ★★ HTML 可见文案里没有「记录」指战绩数据  -> /清除记录/
通过 56 项，失败 2 项
=== GREEN ===  通过 58 项，失败 0 项
```

#### P6（文案）· 开局动作四动词

**改了什么**：状态提示统一「开局」——`game.js:746`「马上开始」→「马上开局」、`:3689`「人齐就开牌」→「人齐就开局」；`nextRoundHints.js:97/100/102`「就开 / 才能开」→「就开局 / 才能开局」。主按钮 `index.html:531`「开始下一局」保持。等人按钮一条线统一到**「开牌」**：`index.html:529` aria-label「先别开牌，我等个人」与 `settleView.js:1161` 运行时覆写「人齐了，开牌」都保留不改。`game.js:1073/3665` 两处刻意保留的旁听「局」/ 发牌「把」是 P0 契约，未动。

**配套守卫**：`ui-copy-consistency.test.js [6]`——三处新文案正面断言；JS 字符串里 `马上开始|才能开 ·|就开$|人齐就开牌` 归零（「添加到桌面，下次一点就开」是安装语义，显式排除）；主按钮文案与两处开牌 aria-label 在位，且没有混进「开局」。

**变异自证**（`马上开局` 改回 `马上开始` → 红，恢复 → 绿）：
```
=== RED ===
  FAIL  ui-copy-consistency.test.js:154:3  ★★ 「马上开始」已并到「开局」
  FAIL  ui-copy-consistency.test.js:158:3  ★★ 状态提示里没有孤立的「开始 / 开 / 开牌」
通过 56 项，失败 2 项
=== GREEN ===  通过 58 项，失败 0 项
```

#### P7（文案）· 万能「出了点问题」与无动词「稍后再试」

**改了什么**（按 `design-states-v1.md §②-b/②-c`：说清后果 + 具体动词；保留「已经记下了」的上报语义）
- `game.js` 9 处：默认 catch →「刚才那步没走完，是否已经生效还看不出来；错误已经记下了，回房间看一眼再定」；交牌 →「牌可能已经交上去了…别急着重交」；进房 →「你还在原来那屏…回首页重新点『加入房间』」；建房 →「房间没建成，还没开始计分…」；改把数 / 进修改 / 撤回 / 进不去 各给出具体后果与「回结算页再点一次档位 / 回房间再点一次」等动词。
- `accountView.js` 5 处（登录 / 换头像 ×2 / 上传 / 改密码）、`recordsView.js` 2 处（清除失败 / catch）、`seatSheetView.js:470`（表情没发出去）同样改写。
- 未把 P0 已清零的禁用词带回来（`ui-copy-consistency [3]` 复跑绿）。

**配套守卫**：`ui-copy-consistency.test.js [7]`——`出了点问题|稍后再试|请稍后再试|检查一下网络|暂时进不去|进不了修改` 在玩家可见 JS 字符串里命中 0；「已经记下了」仍在；扫到的重写文案每条必须带具体动词（回房间/回首页/重新点/看一眼/核对/换张照片/再点一次）；禁用词复核。

**变异自证**（默认 catch 改回「出了点问题，已经记下了」→ 红，恢复 → 绿）：
```
=== RED ===
  FAIL  ui-copy-consistency.test.js:169:3  ★★ 0 条万能文案  -> 出了点问题，已经记下了
  FAIL  ui-copy-consistency.test.js:175:3  ★★ 每条重写文案都带具体动词
通过 56 项，失败 2 项
=== GREEN ===  通过 58 项，失败 0 项
```

**取舍**：交牌那句的后果刻意写成「牌可能已经交上去了、别急着重交」——代码注释明确异常可能出在 `render` 而服务端已收牌，说「分数没变」会是假话。`no-silent-catch.test.js` 里 3 条钉住旧句的断言同步更新为新句（断言数不变）。

#### P8（文案）· AI 三叫法

**改了什么**：统一「AI」+「含 AI 的对局不计入战绩与排行榜」。`index.html:458`「补 AI 队友」→「补 AI」；`:730-735` 徽标/说明「含人机」「人机对局不计入…」→「含 AI」「含 AI 的对局不计入战绩与排行榜」；`:853/880`「不含人机对局」→「不含 AI 对局」。`recordsView.js:113` 行内徽标 →「含 AI」，`:781`「AI 玩家没有战绩」→「AI 没有战绩」；`seatSheetView.js:292/376` 同步。`settleView.js:955` 本就是「本局含 AI · 不计入战绩与排行榜」，不动。

**配套守卫**：`ui-copy-consistency.test.js [8]`——四处正面断言；HTML（含注释）与 JS 字符串里 `AI 队友|AI 玩家|含人机|人机对局` 命中 0。

**变异自证**（行内徽标改回「含人机」→ 红，恢复 → 绿）：
```
=== RED ===  FAIL ...:189:3  ★★ JS 可见字符串里没有第三种叫法  -> 含人机  通过 57 项，失败 1 项
=== GREEN ===  通过 58 项，失败 0 项
```

**取舍**：「补 AI 队友」→「补 AI」短了两个字，按钮在 `room-actions-fit` 的换行判据里只会更宽裕；`bust-block.test.js` / `records-ai.test.js` 里钉住旧说法的断言同步更新（断言数不变）。

#### P10（文案）· 成就中文数字

**改了什么**：`pwa/js/achievements.js` 共 15 条描述：`第一场/十场/五十场/一百场/两百场/连赢五场…连输五场以上` → `第 1 局 / 10 局 / 50 局 / 100 局 / 200 局 / 连赢 5 局…连输 5 局以上`；「一场打完」这类不定指改写为「一局打完」，去掉全站最后的「X场」成就文案。

**配套守卫**：`ui-copy-consistency.test.js [9]`——成就字符串里 `[一二三四五六七八九十百]+场` 命中 0；五个代表值（第 1 局 / 5 / 10 / 15 / 50 局）必须在；`\d+场`（无空格写法）不许回潮。

**变异自证**（`10 局` 改回 `十场` → 红，恢复 → 绿）：
```
=== RED ===  FAIL ...:198:3  ★★ 成就描述里没有中文数字 + 场  -> 十场。牌桌上开始有人认得你的名字
通过 57 项，失败 1 项
=== GREEN ===  通过 58 项，失败 0 项
```

**取舍**：派单举例写「10 场」，但 P0 已定的量词契约是「局 = 一整场」，且成就统计的就是整场对局，故统一用「局」（与 P0 战绩页「最近 10 局」「共 0 局」同源）。「三张一样的牌 / 五张全是花牌」是牌张数、不是局数，不在 P10 范围，保留。

#### P11（文案）· aria-label 用字

**改了什么**：`pwa/index.html:695` `aria-label="纪录"` → `"记录"`（含 `:674/676` 两处注释同步）；`:363` 房间号 placeholder `6位房间号` → `6 位房间号`（与同行 aria-label 一致）。

**配套守卫**：`ui-copy-consistency.test.js [10]`——`aria-label="记录"` 在位、`aria-label="纪录"` 全页为 0、房间号 placeholder 与 aria-label 同为「6 位房间号」。

**变异自证**（`aria-label` 改回「纪录」→ 红，恢复 → 绿）：
```
=== RED ===
  FAIL  ui-copy-consistency.test.js:208:3  ★★ 最佳成绩区 aria-label 写「记录」
  FAIL  ui-copy-consistency.test.js:209:3  ★ 全页没有第二处「纪录」
通过 56 项，失败 2 项
=== GREEN ===  通过 58 项，失败 0 项
```

---

## 二、单跑数字（全部 exit 0 / 失败 0）

| 测试文件 | 改动前 | 改动后 | 说明 |
|---|---:|---:|---|
| `number-scale` | 56（P0 后） | **67** | +11：`--fs-*` 四档 + 纪律注释 + 9 选择器 + 22/30 归零 + 2 处刻意保留 |
| `design-tokens` | 42（P0 后） | **59** | +17：四档圆角值 + 分类器自测 4 + 漂移归零 + 僵尸清单 + 种类上限 + 4 条真引用 |
| `ui-copy-consistency` | 20（P0 后） | **58** | +38：文案六域（P5/P6/P7/P8/P10/P11） |
| `interaction-consistency` | 不存在 | **40** | 新增：P2/P3/P4/P5/P6/U4 |
| `button-busy-wiring` | 16 | 16 | P0 守卫回归，未改 |
| `ui` | 359 | 359 | 两条圆角断言改走 token（措辞改，断言数不变） |
| `states` | 125 | 125 | P5 本机战绩文案断言同步（数不变） |
| `no-silent-catch` | 46 | 46 | P7 交牌文案断言同步（数不变） |
| `bust-block` / `records-ai` | 28 / 44 | 同左 | P8 AI 文案断言同步（数不变） |
| `settle-champion` / `emoji-scale` | 48 / 55 | 同左 | P7 圆角断言同步（数不变） |
| `records` / `records-replay` / `records-quota` / `hold-next` / `room-actions-fit` / `prev-result` / `settle` / `next-round` / `hand-limit-memory` / `modal-a11y` | 原值 | 同左 | 相关行为回归，全绿 |

- **本批可核对的断言净增：+106**（`number-scale` +11、`design-tokens` +17、`ui-copy-consistency` +38、新增 `interaction-consistency` +40）。没有空断言；每条新增断言都参与了至少一次红→绿变异自证。
- 另做了一轮**逐文件全扫**：`pwa/test/*.test.js` 共 **115 个文件全部 exit 0 / 0 失败**（用 `timeout 20` 逐文件单跑，不是 `npm test`）。全量的官方文件数/断言数由制作人补跑 `npm test` 后更新。
- `node --check`：所有改过的 `.js` 与 4 个测试文件全部通过。
- `git diff --check`：通过。4 份审查报告仍为未跟踪、内容未动；`release-progress.md` / `INDEX.md` / 规格文档 / memory 未动。

---

## 三、我做的判断与取舍（汇总）

1. **并档纪律只覆盖"同一屏同一语义"**。P6 只动结算页文字层 9 个选择器，其余密度/屏的字号不追；P7 只消灭 4 个近重复漂移家族并 token 化主流值，剩下 13 个几何/既成形状进显式豁免清单且逐项做僵尸检查。两处都把"不动的理由"写成断言，防止后来者"顺手统一"改错。
2. **危险档只给真正危险的那一处**。danger 只加在删号；"不等他"描述里明说数据不丢，解散投票走专用弹窗——把 danger 铺开只会让分级失去意义。
3. **错误文案宁可长一点也不说假话**。交牌异常后服务端可能已收牌，所以写"可能已经交上去了、别急着重交"而不是"分数没变"；每条都带具体动词，且保留"已经记下了"的上报事实。P0 禁用词一条没带回来。
4. **量词以 P0 契约为准**。派单 P10 举例的"10 场"与 P0"局=一整场"冲突，取后者（成就统计的就是整场）；牌张数的"三张/五张"不属于局数量词，不改。
5. **改动顺序与风险控制**：先落 CSS/JS 修复 → 再补守卫 → 最后逐条变异自证；每批先跑新守卫、再跑相关旧守卫、最后逐文件全扫。未动缩放体系、未动涨跌双色阶（`prev-result` 70 项保持绿）、未引入新依赖。

---

## 四、怎么跑起来 / 后续

```bash
cd <仓库根>
node pwa/test/number-scale.test.js
node pwa/test/design-tokens.test.js
node pwa/test/interaction-consistency.test.js
node pwa/test/ui-copy-consistency.test.js
node pwa/test/button-busy-wiring.test.js
# 相关回归
node pwa/test/ui.test.js
node pwa/test/states.test.js
node pwa/test/no-silent-catch.test.js
node pwa/test/records-ai.test.js
# 制作人补跑全量：npm test
```

**已知技术债 / 需制作人定夺**：
1. **`states.test.js` 与 `design-states-v1.md §②-b` 出现一处文案分歧**：P5 把「先把这台设备上的记录给你看」改成「先把本机战绩给你看」，`states.test.js` 的逐字断言随之更新（断言数不变）。规格文档我按分工未改，因此规格里那句仍是旧字面值。**如需"文档与代码一字不差"成立，需要设计侧把规格里这句同步为「先把本机战绩给你看」**——请制作人裁定是否派人改规格。
   - **【已闭环 · 验收后由制作人处理】** 制作人已在 `docs/design-states-v2.md` 新增改判登记 **D10**（覆盖 D1 的「is-strip 沿用原句」半句），并把 §② 表格 `offline.is-strip` 副文案同步为「先把本机战绩给你看」；v1 §②-b 封存件按「快照不改」纪律保持原样，以 D10 为准。因此上面的"规格里那句仍是旧字面值"指的是 **v1 封存件**，不再是现行口径的分歧。
2. **旁听卡字号未收敛**：`.sp-title`(40)/`.sp-tip`(26) 与横屏 `.ls` 档保留，理由是横屏 390 高只有三行空间；需要真机截图才能判断能否并档。本批按静态推断保守处理。
3. **圆角 13 个几何豁免项**按"观感明显变化不硬压"保留；若日后要彻底统一，需美术确认 28px 纸卡与 32px 标志圆角是否可并。
4. 未跑两档 `probe-ui-flow`（按分工由制作人补跑）；本批改变的主要是字号 token（值不变）、圆角（≤2px）、按钮变体（视觉层级），预计不会新增出界/热区硬缺陷，但**观感终局以真浏览器为准**。
