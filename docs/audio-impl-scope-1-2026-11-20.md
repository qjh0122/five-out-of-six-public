# 音效改造 · 实施范围单 #1 · audio-impl-scope-1

> 日期：2026-11-20
> 域：音效 / 音频（负责人：雷鸣远出方案，寇豆码实施，范可控裁定范围）
> 性质：**实施派单**。参数唯一来源 = `docs/audio-diagnosis-2026-11-20.md` §二/§三/§四/§五。本单不复述任何数字，只定范围与验收。
> 上游：`docs/audio-diagnosis-2026-11-20.md`（取代 v1 的现状判定 / 参数口径 / 资产处置三部分）。

## 一、本轮做什么

实施诊断文档 **§七 的第 1 步与第 2 步**，即「零资产、纯代码」两层：

1. **第 1 步 · 结构修复**：P0-2（零起音 → attack ramp）、P0-3（VOL 表落地，消除 mp3 unity gain）、P0-5（duck 从硬台阶改包络）、P1-6（结算序列结果音互斥）、P1-8（变体轮转对合成真正生效）、P1-11（远场低通）。
2. **第 2 步 · 三层合成**：按 §4.1 给所有 one-shot 加「瞬态噪声层 + 材质层（振荡器 + BiquadFilter）+ 情绪层（真 release）」；error / countdown_* / split_* / room_* / ready / veto / spectator / emoji_* / peer_submit / hint_guide 按 §3.2 的音色方向重做。
3. **语义音高白名单**：诊断文档 P1-12 指出的 1.02/1.04 等被抖动冲掉问题，在 `sfx.js` 内修（扩白名单或改由滤波亮度表达，二选一，按 §4.2）。
4. **变体与随机化**：按 §4.3 的合成事件「失谐量 / 滤波截止 / 瞬态 seed」三组轮转。

## 二、本轮明确不做什么

- **不生产、不下载、不新增任何音频资产**：第 3、4 步（BGM 45–60 s、deal×3、champion/win/lose 等）全部推迟到用户试听本轮结果之后。
- **不改任何 UI / 渲染 / 游戏逻辑**：特别禁止改 `game.js` 的 DOM、`ringTopHtml`、`renderTopBar`、`settleView.js` 的幕序列。上一轮改音效曾引入 `ringTopHtml` 缺 `meTitle` 的白屏回归（提交 `aab6f7f`），本轮不为音效改造再碰这些文件。
- **不改调用点的触发时机**：结果音互斥在 `sfx.js` 内部实现，不修改 `game.js:560` 的 `setTimeout(500)` 与 `settleView.js:499-518` 的业务代码。若某条互斥确实必须改调用点，停下来回报制作人，不自行改。
- **不改架构**：不引入 `createMediaElementSource`、不新建 master bus 之外的音频图、不用 `AudioBufferSourceNode.loopStart/loopEnd` 替 `<audio loop>`（诊断 §5.1 / §6.1 已判断本轮不做）。
- 不动 `package.json`、不装系统级依赖。

## 三、允许修改的文件

- `pwa/js/sfx.js`（唯一功能改动文件）
- 版本真源（bump 时按项目既有门禁同步）：`pwa/index.html` 的 meta 与全部 `?v=`、`pwa/sw.js` 的 `CACHE_NAME`、`pwa/version.json`、`scripts/probes.json`、`docs/PROBES.md`、状态卡。
- 测试文件：`pwa/test/audio.test.js` 及新增音效单测。

## 四、验收（缺一不可）

1. `npm test` 全绿，断言数不得下降；新增行为守卫必须**变异自证**（故意改坏 → 红，还原 → 绿）。
2. 文档门禁 `docs:check` / `version-gate` 全绿，版本真源一致。
3. 真浏览器冷启动冒烟：进房间 → 座位可见 → 准备 → 发牌 → 出牌 → 结算，JS 异常 0（用既有 `probe-*` 脚本 + 手动核对，不信纯断言）。
4. 静态自证：全仓搜索确认零起音写法 `setValueAtTime(gain, t)` 在合成通路已消除；至少 1 处 BiquadFilter 落地。
5. **听感未验收要如实标注**：本轮只保证结构改造到位，不宣称"好听"。用户真机试听后才算听感通过。

## 五、完成后回传

落盘一份 `docs/audio-impl-1-fix-log-2026-11-20.md`：改了哪些事件、每类音色的实际参数来自诊断文档哪一节、测试结果、浏览器冒烟结果、未做项与原因。消息只传「文件路径 + 一句话结论」。
