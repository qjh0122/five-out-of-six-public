# `tools/qa/` —— 验收工具说明

本目录是**质量域（QA）的验收工具**，全部满足三条硬要求：

1. **不联网、不占端口、不启浏览器**（除 `emoji-run-tier.js` 会调用探针，它是唯一会跑批的）；
2. **可独立运行**：`node tools/qa/<name>.js`，不依赖临时目录、不依赖上一轮残留；
3. **自带自验**：每个工具都有 `--selftest` 或默认自验，且自验里**至少 1 个必命中、1 个必不命中**样本。
   不报数的「已验证正确」不算数。

> 这些工具**不是一次性消耗品**。下一轮验收优先复用并扩展，重写前必须说明旧工具为什么不能用。

| 工具 | 判什么 | 调用 | 自验 |
|---|---|---|---|
| `emoji-placement-oracle.js` | 方向两级排序 + 尾巴偏移 oracle（施工方侧实现，QA 复核对照用） | `node tools/qa/emoji-placement-oracle.js` | 见文件内 |
| `emoji-q1-sides.js` | **Q1 裁剪盒**双口径复算（四边外扩 vs 单侧外扩）。先复现被测方判决，再谈口径差异 | `node tools/qa/emoji-q1-sides.js` | **10/10**，含零余量边界与 off-by-1 |
| `emoji-dir-reasons.js` | 逐向否决理由（A / B / C / Q4b）+ 候选 rect，定位「四向全兜底」是几何无解还是实现漏分支 | `node tools/qa/emoji-dir-reasons.js` | **5/5**，含 1 必命中、1 必不命中 |
| `emoji-q10-signature.js` | **Q10 兜底署名**：兜底 ⊆ 署名（单向）+ 逐条内容比对（`byText ↔ fromName ↔ fixture` 三层链）+ 未必截断 | `node tools/qa/emoji-q10-signature.js [snap.json] [--strict-scope]` | **11/11**，含「三座全署『对方』必须判红」「真撞名不许判红」「截断精确归因」「fromName 优先于 fixture」「oracle 漂移只 WARN」 |
| `emoji-run-tier.js` | **一档一跑、跑完落盘**：单实例锁 / 端口隔离 / 强制 dump / 座位数前置 / 出处记录 | `node tools/qa/emoji-run-tier.js <w> <h> [--dry]` | **11/11**（本机复跑；锁含 pid 存活回收 + 600ms 半写等待、`SEATS` 真传进子进程、5 种前置检查） |
| `emoji-n18-ruler-compare.js` | **N18 两条判据的误伤对照**：初版 `\|shift\| ≤ avHalf` vs 现行 `\|tip − faceC\| ≤ avHalf+0.5`，一行输出「各红几行」；**另做位移量级体检**（硬上界 `跨度/2 + 头像/2`，抓「跨轴相减」这类字段算错）；**v2.7 起兜底行从 N18 分母摘除**（兜底不画尾巴，没有尖端这个对象） | `node tools/qa/emoji-n18-ruler-compare.js <tier.jsonl>` / `--selftest` | **10/10 + 3/3 + 7/7**。阳性对照（带 bug 的旧 390）超界 5/16；阴性对照（新 320）超界 0/17。兜底行判定**优先读 `tailAbsent` 字段**（探针 `b0e9391d` 起有），没该字段才退回 `place==='fallback'` 推断 —— **但退回推断必须留痕**：输出首行固定打 `tailAbsent 字段覆盖 N/M`，一旦靠推断就打 `⚠⚠ 整份 dump 都没有 tailAbsent → 下面的 N/A 是推断不是事实`。理由：`兜底 N/A 3 条` 这个数在「真的 3 条无尾」和「字段缺失、工具猜 3 条」两种情况下**完全相同**，不分开写就分不清（2026-11-14 用剥离字段的阳性对照实证过，见 docs §14.2 门 3） |
| `emoji-verdict.js` | 把一档的 `.jsonl` 汇总成**档级判定**：Q8 三数对账 + N18 + 重算副作用分档 + 复用 Q10 判据。⚠️ **必须带 `--players`**，否则 G16b 一律记「未测」并多报一条 `[10c]` 告警（我因此把 3/3 错记成未测过一次） | `node tools/qa/emoji-verdict.js <tier.jsonl> [--players tools/qa/players-fixture.json] [--complete] [--expect 20]` | **14/14** |
| `emoji-tier-status.js` | **从产物反推档状态**（不采信任何人的标签）：`OK / NOT-RUN / RUNNING / STALE / STALE-IMPL / HALF / MISSING / FAIL-ASSERT / FAIL-EXIT / FAIL-SEAT / COUNT`，检查六档探针是否同源，告警「未登记的档标记」 | `node tools/qa/emoji-tier-status.js [--dir tools/qa/out] [--expect 20] [档…]` / `--selftest` | **33/33**（十一态各一条 + 原因码 9 条（含 4 条现行写法）+ 宽容留痕并排断言 + 「现行写法 marker 状态对**且**原因码读得出」分离断言 + stray 正反两条 + 真样本 1 条 + 漂移哨 3 条）。⚠️ 两条不能省的：**`exit=1` 判 `FAIL-ASSERT`**（跑完且判红，去修实现）与 **`exit=4/5/7` 判 `FAIL-EXIT`**（没跑完，去修工具）必须分开；**`STALE-IMPL`** 比 `meta.finished` 与实现文件 mtime —— **探针 sha 一样但实现变了，只有这条能抓到**（2026-11-14 实况：v2.7 改了 `seatSheetView.js`，六份 meta 的 `probeSha256_16` 一模一样） |
| `players-fixture.json` | **独立昵称 oracle**（来自座位 fixture 配置，不是实现输出）：`me → 我` + 4 个陪练 | `--players tools/qa/players-fixture.json` | — |
| `geometry-selftest.js` | 几何断言工具的自验集（历史遗留） | `node tools/qa/geometry-selftest.js` | 见文件内 |

## 跑批标准流程

```bash
# 0) 前置：探针要支持 EMOJI_PROBE_DUMP（逐格 NDJSON），否则 Q10 只能人工读屏
# 1) 一档一跑，跑完立刻落盘（脚本会拒绝并发，并检查 [data-pid] 座位数 == 5）
node tools/qa/emoji-run-tier.js 320 568
node tools/qa/emoji-run-tier.js 390 844
node tools/qa/emoji-run-tier.js 844 390
node tools/qa/emoji-run-tier.js 1366 768
node tools/qa/emoji-run-tier.js 800 600
node tools/qa/emoji-run-tier.js 1920 1080

# 2) 逐档聚合出判定
node tools/qa/emoji-verdict.js tools/qa/out/390x844.jsonl --players tools/qa/out/players.json
```

## 落盘物（`tools/qa/out/`）

| 文件 | 内容 |
|---|---|
| `<w>x<h>.jsonl` | 逐格 dump，聚合器的唯一输入 |
| `<w>x<h>.log` | 探针完整 stdout/stderr |
| `<w>x<h>.meta.json` | 探针文件 sha256 + git HEAD + 起止时间 + 环境变量 + 记录数 + 座位数 |
| `<w>x<h>.PRECONDITION-FAILED` | 座位数 ≠ 5 时落这个标记。**有它该档就不许进聚合**，也不许用 2 座顶 5 座 |

`meta.json` 是为了回答「这份数据是哪一版探针跑的」。上一轮吃过一次「半份数据 + 全量结论」的亏，
出处只能靠文件记，不能靠聊天记录。

## 两条使用纪律
- **`shift` 字段缺失 = 该格「未测」**，不推断为 `0`。哪怕实测 rect 与推算的未位移矩形完全一致也不推断 ——
  「本来没滑」和「排序算错导致它不认为该滑」两种情况的补救方向相反，用「结果一样」掩盖「过程不同」，
  会把实现缺陷洗成正常格。
- **`--players` 是独立昵称 oracle**（来自座位 fixture 配置，不是实现输出）。缺它时
  `emoji-verdict.js` 只判 G16a（集合相等），G16b（内容对错）记「未测」，
  **且该档最高只能「有条件通过」** —— 未测不许占全绿的位置。
  用 `--complete` 声明「这份 players 齐全」后，缺键才会判红（按规格应写「对方」）。
- **`shift` 不是位移的唯一真值，`tip` vs `face` 才是。** 判「尾巴撒谎」只看
  `|tip 沿轴 − 头像中心| ≤ 头像跨度/2 + 0.5`；`|shift|` 大是正常的（`--tail-off` 会反向补偿）。
  **判断依据是语义，不是误伤条数**：即便 `|shift|` 数值变小，它量的也不是「尾巴指哪」。
  （历史教训：曾用「初版会误红 13/20」当证据，那批 `shift` 后来被证明是跨轴相减的脏数。）
- **拿到任何测量字段先做一次量级上界检查，再拿它当证据。**
  `shift` 的上界是 `气泡沿位移轴跨度/2 + 头像跨度/2`（由 `seatSheetView.js:727` 推出，不需要 `k`）。
  越界 → 这个字段不是它声称的东西，**先查探针/写入点，别去改判据**。
  `emoji-n18-ruler-compare.js` 已内置这条检查（阳性 5/16 命中 / 阴性 0/17）。
- **`shift` 的轴向在旧版实现里不统一**（`shiftSearch` 曾跨轴相减；换行让位曾写候选值）。
  现已统一为「沿自由轴的实测位移」，但**在确认某份 dump 的探针版本之前，仍不许拿 `shift` 做统计**。

## `NOT-RUN` 标记的契约（跨人协作，动了就要同步两侧）

⚠️ **2026-11-14 19:2x：实现侧单方面换了写法，我方旧解析器 100% 读不出原因码。**
现状以**实现侧源码** `tools/qa/emoji-run-tier.js:139` 为准，见下面「现行写法」。
教训：契约写进 README 不等于两边一致 —— **自验里没有一条用对方真实输出的样本，就会全绿着废掉一整轮**。

**现行写法**（`emoji-run-tier.js` 现在真会写的）：首行 `<reason> exit=<code>`，空格分隔，详情挪到第二行起：

```
parse-fail exit=6
at=2026-11-14T19:12:41.238Z
reason=探针退出码 6，日志 …
```

- 原因码（实现侧，共 7 个）：`parse-fail` / `timeout` / `spawn-error` / `lock-busy` / `no-dump` / `probe-error` / `readback-mismatch`；
- 已废、但我方仍认得（只为读旧 marker）：`nonzero-exit` / `precondition` / `probe-missing`。
  ⚠️ 这三换三没经过 QA：其中 `nonzero-exit` 正是「任何非 0 退出都要落 NOT-RUN」那条要求用的码，
  现在**没有码覆盖「exit ≠ 0 但 dump 和座位都正常」**这种情况 —— 待定。
- 消费侧按「首段空白切 + 白名单」，**不用 `includes()`** —— 否则 `nonzero-exit-no-dump` 会命中 `nonzero-exit`。

**兼容写法**（R21 定版的四段，现在已无写者，只留读）：

```
<reason> | probe=<sha8|none> | at=<ISO> | exit=<code>
```

- ⚠️ **反面格式**：`exit=6 reason=parse-fail`（原因码不在首段）—— 状态仍是 `NOT-RUN`（靠文件存在判定），
  但原因码读不出来，报告会写「不可识别」。三种写法在自验里都有样本（`selftest 26/26`），
  其中**四条专门盯现行写法**，一条是「状态对但原因码读不出」的分离断言（D1 回归哨）。
- **无空格的宽容分支有日落条款**：`lock-busy|probe=x` 这种老写法暂时接受，但 detail 会打 `[legacy-separator]`。
  有效期「本轮 → 六档同源复跑结束」；到期删掉 fallback，并把自验那条样本从 `ok=true` 改成 `ok=false`
  （样本名改「无空格不再接受」）—— **用样本记住期限，不靠人记**。
- **未登记的档不会被静默忽略**：`out/` 下出现不在名单里的 `<tag>.NOT-RUN` 会打
  `⚠ 发现未登记的档标记（不在本次名单里，未计入合计）` 并让退出码非 0。
  这条是踩出来的：我拿 `zzA/zzB/zzC` 三个临时 marker 测格式，工具报「合计 OK 6/6」——
  **不是格式对，是那三个文件根本没进账**（档列表硬编码）。「沉默」会被读成「通过」。

## 样本必须来自写入方真实产出（D1 闭合，2026-11-14）

`tools/qa/fixtures/notrun/` 存着一份**不是手抄的** NOT-RUN 样本：

```
tools/qa/fixtures/notrun/sample-timeout.NOT-RUN   ← 写入方 --emit-notrun-sample 原样产出
tools/qa/fixtures/notrun/origin.txt               ← 出处、生成命令、emitter sha、何时该重新生成
```

为什么非得这样：上一轮自验里那 19 条「现行写法」样本全是**我手抄的**，
于是「格式对」= 「我抄的和读的一致」，跟实现侧一个字节都没关系。
实现侧改了写法，我方 **19/19 全绿地废了一整轮** —— **自验只测自己想象的格式，等于没测格式。**

抄一份真样本只解决当天。所以另有三条**漂移哨**，读写入方源码现算：

| 哨 | 抓什么 | 红了怎么办 |
|---|---|---|
| 口径哨 | 写入方 `NOT_RUN_REASONS` 里出现了我方码表**不认识**的码 | 把我方码表补齐；不确定语义就先去问，别猜 |
| 模板哨 | 写入方第一行模板不再是 `` `${reason} exit=${exitCode}` `` | **重跑写入方的桩覆盖 fixtures**，别改断言 |
| 反向哨 | 从**真样本**派生的「摘掉原因码」必须判不识别 | 说明正向是靠「有 `exit=` 就算过」蒙的，去查解析 |

三条都做过阳性对照（表里写的是 `EMITTER_SRC` 注入伪造 emitter，**不碰真文件** —— `844x390` 当时正在跑它）：

| 伪造 | 结果 |
|---|---|
| 多一个码 `cdp-hang` | `FAIL 口径哨 … 不认识的：cdp-hang`，`32/33` |
| 模板去掉 `exit=` 段 | `FAIL 模板哨 … 模板变了`，`32/33` |

两条各红各的，不是同一个开关连坐。

当前：`selftest 33/33`。

## 用法纪律：格式类实验禁止占用真实档名

`emoji-tier-status.js` 支持 `--dir <目录>`。**测另一方的 marker 格式时，一律指向临时目录**，
不许拿 `out/320x568.NOT-RUN` 这种真实档名当试验田。

原因（2026-11-14 19:31 差点踩到）：我拿真实档名写临时 marker 的那一刻，`320x568` **正在跑批**
（`owner.json` pid 31628）。两个后果都是坏方向：
- 正在跑的档被我自己的 marker 盖成 `NOT-RUN`（假阴，开路）；
- 或者跑完之后我的残留 marker 还在，把一份好数据判成「没跑」。

跑批器「开跑前清五件」也会把 `*.NOT-RUN` 一起清 —— 于是「我写的」和「它写的」互相抹，
谁都说不清最后那个文件是谁的。

## 一条已知误差（不修，且误差方向是安全的）
`emoji-tier-status.js` 用 `process.kill(pid, 0)` 判锁的持有者是否活着，存在 **pid 复用**风险：
死掉的 runner 的 pid 被系统分给别的进程 → 会被读成 `RUNNING`。
**不修**，理由不是「懒得修」，而是**方向安全**：

| 误判方向 | 后果 |
|---|---|
| 假阳（活锁读成 RUNNING） | **拒绝聚合**，人去查一眼 —— 最坏浪费一次排查 |
| 若引入时间阈值 → 假阴（慢档读成 STALE） | 可能被当成「跑完了但失败」，甚至有人手动清锁**并发**跑起来 → **真的污染数据** |

**保守的假阳挡路，激进的假阴开路；开路的那种错不能要。**
唯一不引入阈值的修法是查该 pid 的命令行是否含 `emoji-run-tier`（平台强绑定 + 每次多一个子进程），**已评估，不做**。
排查线索靠 `owner.json` 里的 `at` 字段，够用。
