/**
 * 测试共享断言底座（node scripts/test-harness.js 自测；被各 *.test.js require）
 *
 * 为什么要有它：
 *   - 以前 170 个测试文件各写各的 ok()/eq()，失败输出形态分裂（stderr ✗ / stdout FAIL），
 *     且 ok() 不打「文件:行」、不打栈 —— 于是「哪条断言红了」只能人读，机检查不到身份。
 *   - 本模块把「打印 + 定位」收成一处：按【函数引用】剥帧拿到调用点，通过时也打印，
 *     形态统一成 `  PASS  <loc>  <name>` / `  FAIL  <loc>  <name>`。
 *
 * 取位置的方式（重要，别改「按深度/按名字/按文件」）：
 *   Error.captureStackTrace(e, assertFn) 省略 assertFn 及其以上的帧，
 *   剩下的第一帧就是「调用 ok/eq 的那一行」。按引用剥帧 ⇒ eq 包几层都不偏；
 *   若改成「跳过本文件所有帧」，harness 一拆成两个文件就会静默冒充调用点。
 *
 * 代价（迁移注意）：Error.captureStackTrace 是 V8 专有，换引擎要退回解析栈字符串，
 *   那时「按深度取帧」的坑会回来。
 *
 * 红线：剥帧后首帧不在测试目录 ⇒ 输出 UNKNOWN，绝不输出那一帧 ——
 *   「报一个像位置的地址」比「报 UNKNOWN」贵得多，因为它终止复核。
 */
'use strict';

const TEST_DIR_RE = /[\\/](?:pwa|server)[\\/]test[\\/]/;

function frameOf(assertFn) {
  const e = {};
  Error.captureStackTrace(e, assertFn);
  const lines = (e.stack || '').split('\n');
  const caller = (lines[1] || '').trim();
  const m = /\(([^()]+):(\d+):(\d+)\)$/.exec(caller)
    || /at\s+([^\s()]+):(\d+):(\d+)$/.exec(caller);
  if (!m) return 'UNKNOWN';
  const file = m[1];
  if (!TEST_DIR_RE.test(file)) return 'UNKNOWN';
  const rel = file.replace(/\\/g, '/').replace(/^.*?\/(?=(?:pwa|server)\/test\/)/, '');
  return rel + ':' + m[2] + ':' + m[3];
}

/**
 * 打印一条断言结果（位置 + 统一形态）。计数由调用文件本地 pass++/fail++ 负责，
 * 本函数不计数 —— 这样每个文件的汇总行、process.exit 逻辑、调用点全部不动。
 * 通过时也打印 ⇒ 解「27 个文件通过时零输出、断言身份无法枚举」。
 */
function log(assertFn, cond, name, extra) {
  const loc = frameOf(assertFn);
  if (cond) console.log('  PASS  ' + loc + '  ' + name);
  else console.log('  FAIL  ' + loc + '  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
}

/**
 * 启动自检（每次 require 跑一次，正常时静默，失败即抛）：
 *   正控一 —— 剥帧生效：harness 内部调用点剥完落在 harness 文件，不在测试目录 ⇒ UNKNOWN。
 *   正控二 —— 帧没被清空：不剥帧时 stack 里能看到本文件，证明 captureStackTrace 真的产出帧。
 * 缺正控二，一个「把 stack 清空」的实现也能过；缺正控一，剥帧没生效也无人知。
 */
(function selfCheck() {
  function probe() { return frameOf(probe); }
  const got = probe();
  if (got !== 'UNKNOWN') {
    throw new Error('test-harness 自检失败：内部调用点应判 UNKNOWN，实际 ' + got);
  }
  const e = {};
  Error.captureStackTrace(e);
  if (!/test-harness\.js/.test(e.stack || '')) {
    throw new Error('test-harness 自检失败：未剥帧 stack 里看不到本文件，captureStackTrace 不可用');
  }
})();

module.exports = { log, frameOf };
