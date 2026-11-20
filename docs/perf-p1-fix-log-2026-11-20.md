# 性能优化 P1-2 + P1-4 改动日志（2026-11-20）

> 本文件只记「这一轮改了什么、怎么证明它有效、还有什么没测」。
> 版本号真源仍在 `pwa/index.html` 的 `meta[name=app-version]` 与 `pwa/sw.js` 的 `CACHE_NAME`，
> 这里不复述当前版本（避免自己变成第三份过期真源）。

## 一、改动文件清单

| 文件 | 改动 |
|---|---|
| `pwa/version.json`（新增） | 静态轻量端点，18 B，只含 `v`；放 `pwa/` 是硬约束：网关转发会剥 query，server 端路由拿不到 sharecode 会 403 |
| `pwa/index.html` | `checkVersionConsistency()` 改抓 `/version.json`（`withSharecode` 拼码 + `cache:'no-store'` + `r.json()` 比 `data.v`）；403 用 `r.ok` 判断后走 catch；保留 90 秒轮询、visibilitychange、`sessionStorage` 防重复 reload、`reloadWhenIdle`、file:// 与离线兜底；38 处版本串随 bump 更新 |
| `pwa/sw.js` | `fetch` 事件为 `/version.json` 开纯网络分支：直接 `fetch(req)`，不读 / 不写缓存；PRECACHE 清单与文件头注释标明它不入预缓存；`CACHE_NAME` bump |
| `scripts/lib/version-gate.js`（新增） | P1-4 判据纯函数：meta / CACHE_NAME / `?v=` 解析、git porcelain 解析、bump 决策；抽成模块是为了单测能喂假样本做变异自证 |
| `scripts/check-docs.js` | [0] 增加判据正负样本自测；新增 [7] 本地资源 `?v=` == meta 且 `version.json` 的 `v` 与 meta 对账（<1KB）、[8] 页面/SW 的轻量端点接线、[9] 源码变更 ⇒ app-version 与 CACHE_NAME 必须**同时** bump（工作区用 `git status`，干净工作区用 HEAD vs HEAD~1；无 git / 浅仓 / 缺基线跳过不误红） |
| `pwa/test/perf-p1-guard.test.js`（新增） | 26 项：抽出真 `checkVersionConsistency` 喂假 fetch（URL / no-store / 403 / 坏 JSON / session / file://）；vm 跑真 `sw.js`（网络值、不写缓存、不进 PRECACHE）；门禁判据假样本 |
| `pwa/test/ui.test.js` | 版本自检断言从旧端点改到新端点，并补一条「不再抓 index.html 全文」负向断言 |
| `scripts/probes.json` | 版本 bump；把 QA 遗留未登记的 `probe-perf-once.js` 按 `oneshot` 登记（否则 `probe-ledger.test.js` 必红） |
| `docs/PROBES.md` | `npm run probes:doc` 重生成（44 条，生成于新版本） |
| `docs/release-progress.md` | 当前状态卡的线上版本、回归计数、探针计数同步 |
| `docs/INDEX.md` | 探针条数、守卫项数同步；删掉台账表里写死的旧条数 / 旧版本，改为指向真源 |
| `README.md` | 回归命令行的文件数 / 断言数 / 守卫项数同步 |

未碰：`pwa/js/**`、`pwa/css/**`、`server/**`、探针脚本本体、其它历史文档。未执行 `git commit` / `push` / 发布。

## 二、版本 bump 前后（唯一事实源）

| 事实源 | 前 | 后 |
|---|---|---|
| `pwa/index.html` meta app-version | `20261119b` | `20261120a` |
| `pwa/index.html` 本地资源 `?v=`（37 处） | `20261119b` | `20261120a` |
| `pwa/sw.js` CACHE_NAME | `weile-liuxuanwu-v152` | `weile-liuxuanwu-v153` |
| `pwa/version.json` 的 `v` | 无此文件 | 与 meta 一致（由 [7] 守卫对账，不是第二真源） |
| `scripts/probes.json` version | `v152` | `v153` |
| `docs/PROBES.md` | 生成于 `v152`，43 条 | 生成于 `v153`，44 条 |

`npm run docs:check` 用于找漏改；最终 78 项全绿。

## 三、测试结果

| 项目 | 结果 |
|---|---|
| `npm test` | **175 文件 / 7383 断言 / 0 失败**，119.0s（全绿；新增 `perf-p1-guard` 26 项，`doc-consistency` 透传 78 项） |
| `npm run docs:check` | 通过 78 项，失败 0 项 |
| `npm run probes:check` | 台账 44 条 == 磁盘 44 个探针，退出码 0 |
| `node scripts/probe-first-paint.js 390 844` | 通过 12 项，失败 0 项（首帧无白屏、缩放不跳变） |
| `node scripts/probe-perf-once.js` | 退出码 0，JS 异常 0；数据见下节 |

npm test 期间曾红 1 项：`pwa/test/ui.test.js:88` 把版本自检端点写死成 `/index.html`。已按新实现更新判据并补负向断言，复测该文件 360/0。

## 四、温启动带宽实测（同一脚本、同一视口 390×844）

| 场景 | 改前 fetch transfer | 改后 fetch transfer |
|---|---:|---:|
| firstVisit | 92,586 B | **318 B** |
| swWarm | 92,586 B | **0 B**（SW 注入的 fetch 在 ResourceTiming 里 transferSize 记 0；实体是 18 B 静态文件，仍远小于 1KB） |
| cpu4xWarm | 92,586 B | **0 B** |

firstVisit 资源总传输 1,880,185 B → 1,787,917 B（−92,268 B，与去掉一份完整 HTML 相符）。
FCP / DCL：firstVisit 96/93 → 108/93 ms，swWarm 52/52 → 52/68 ms，cpu4xWarm 132/? → 132/181 ms（headless 本地静态服务，无网关延迟；这几项不是本次优化目标，未做统计显著性判定）。
改前原始结果已备份为 `tmp/perf-measure-baseline-before-p1.json`，改后为 `tmp/perf-measure-2026-11-20.json`（均在未跟踪的 `tmp/`）。

## 五、变异自证（临时改坏 → 守卫红 → 还原 → 绿）

一次性脚本 `tmp/mutation-perf-p1.js`（不入库），每步 `finally` 还原并比对 SHA-256；结果落 `tmp/mutation-perf-p1-result.json`。基线与还原后 `perf-p1-guard` 26/0、`docs:check` 78/0。

| 编号 | 变异 | 守卫红在哪 | 还原 |
|---|---|---|---|
| M1 | 页面端点退回 `/index.html` | `perf-p1-guard`：URL 断言 got `/index.html?sharecode=S1`；`docs:check`：负向「不再抓全文」红 | SHA 一致 |
| M2 | SW 把 `/version.json` 写进缓存 | `perf-p1-guard`：不写缓存 / 无缓存条目两条红；`docs:check`：「分支不读/不写缓存」红 | SHA 一致 |
| M3 | 一条 `<script src>` 的 `?v=` 落旧版 | `docs:check` [7]：`./js/storage.js?v=...` 被点名 | SHA 一致 |
| M4 | 源码改了但 meta app-version 不 bump | `docs:check` [9]：「工作区的 app-version 已 bump」红 | SHA 一致 |
| M5 | 只把 CACHE_NAME 退回旧值 | `docs:check` [9]：「工作区的 SW CACHE_NAME 已 bump」红 | SHA 一致 |
| M6 | 把 `bumpDecision` 改成恒绿 | `docs:check` [0] 自测与 `perf-p1-guard` [C] 同时红 | SHA 一致 |

六组均 `exit=1` 且命中预期断言，还原后两条守卫回到全绿（`allRestored=true`、`greenAgain=true`）。

## 六、未测项 / 遗留

1. **线上网关未实跑**：sharecode 拼接、403 兜底只在本地静态服务 + 假 fetch 单测里验证；网关「校验后剥 query」的行为依据 `server/index.js:585-587` 的既有实测记录，本轮没有线上环境可复验。
2. **真机 / 长期轮询未实测**：90 秒 `setInterval` 与 visibilitychange 的触发链保留并有静态 + 行为守卫，但没有让标签页真挂一晚上观察 reload。
3. **CI 浅仓分支**：门禁在无 `HEAD~1` 时跳过，已由纯函数样本覆盖，未在真实 shallow clone 中跑过。
4. **提交注意**：`scripts/probe-perf-once.js` 原本是 QA 留下的未跟踪文件，本轮已登记进台账。提交时必须带上它，否则台账会出现「幽灵条目」、CI 的 `probe-ledger.test.js` 会红；若决定不入库，应先移出 `scripts/` 并同步台账。
5. 性能数值来自 headless Edge 单次采样，FCP/DCL 的微小波动未做多轮统计；本次验收口径只看带宽（92,586 B → <1KB）。
