#!/usr/bin/env node
'use strict';
/**
 * emoji-q1-sides.js —— 「裁剪盒完整在视口内」（Q1）的双口径复算器
 *
 * 为什么需要它：v2.3 把 Q1 从「四边各外扩 TAIL_H」改成「只在尾巴所在边外扩 TAIL_H」。
 * 口径差一个边，结论会整片翻。本项目实测：320×568 满员档 20 格里，
 * 探针按「四边 + (gap+TAIL_H)」判出 10 格红；按 v2.3「单侧 + TAIL_H」判是 20 格全绿。
 * 同一批矩形、同一视口，只换口径 —— 所以「红」到底是实现错还是尺子错，必须能复算出来。
 *
 * 用法：node tools/qa/emoji-q1-sides.js
 *   输入：本文件内联的 FIXTURE（从探针 [9] 段原始输出逐格抄录，见每条注释的来源标记）
 *   输出：逐格两口径结论 + 差异归因，末行给出 N/N 自验结果
 *
 * 判定规则（v2.3，唯一出处 docs/ui-emoji-placement-v2.md §6 Q1 + §2 A）：
 *   尾巴只朝座位那一侧伸出 →
 *     dir=right（气泡在座位右侧）→ 尾巴在左边缘 → 只扩左
 *     dir=left                    → 只扩右
 *     dir=up  （气泡在座位上侧）  → 只扩下
 *     dir=down                    → 只扩上
 *   其余三边只留 MARGIN = 8（不乘 k）。
 *   TAIL_H = 8 * k（伸出长度）；MARGIN = 8（不乘 k）。
 */

var MARGIN = 8, TAIL_H = 8;

/* ---------- 自验样本：已知答案，必须含「应命中」与「应不命中」 ---------- */
/* 每条：[名称, cell, expectSingle('pass'|'fail'), expectFour(...)] */
var SELFTEST = [
  /* 1. 零余量边界：右边界恰好 312 = vw-8，单侧口径应通过（别在等号上加 >） */
  ['零余量右贴边', { vw: 320, vh: 568, dir: 'down', l: 16, t: 100, r: 312, b: 182, kind: 'phrase', k: 1 }, 'pass', 'fail'],
  /* 2. 真越界：左边 7 < MARGIN 8，单侧口径也必须红（应命中） */
  ['左侧真越界', { vw: 320, vh: 568, dir: 'down', l: 7, t: 100, r: 303, b: 182, kind: 'phrase', k: 1 }, 'fail', 'fail'],
  /* 3. 尾巴侧恰好 8：dir=right 时只扩左，l=16 时 tip 落在 8，单侧通过；
   *    四边口径也只扩 8（不扩 gap），两边都在界内 → 通过。这一条专测「别把 pad 当裁剪盒」 */
  ['尾巴侧恰好 8', { vw: 320, vh: 568, dir: 'right', l: 16, t: 40, r: 200, b: 91, kind: 'phrase', k: 1 }, 'pass', 'pass'],
  /* 4. 尾巴侧真越界：dir=right 且 l=15 → tip 落在 7 < 8，应红 */
  ['尾巴侧差 1px', { vw: 320, vh: 568, dir: 'right', l: 15, t: 40, r: 199, b: 91, kind: 'phrase', k: 1 }, 'fail', 'fail'],
  /* 5. 非尾巴侧不受 T 约束：dir=down 时左边 10 合法（四边口径会误红） */
  ['非尾巴侧宽松', { vw: 320, vh: 568, dir: 'down', l: 10, t: 100, r: 306, b: 182, kind: 'phrase', k: 1 }, 'pass', 'fail']
];

/* ---------- 回放数据：320×568 满员档（SEATS=5）探针 [9] 段原始输出 ----------
 * 来源：`SEATS=5 node scripts/probe-emoji.js 320 568`（2026-11-14 17:3x）[9] 段逐行抄录
 * 字段：座位 / 内容 / data-dir / rect(l,t,r,b) / 探针实际使用的外扩量（用于复现它的结论）
 * 探针的外扩量：短语 +18（= gap 10 + TAIL_H 8）、表情 +12（= gap 4 + TAIL_H 8），且四边同时加。
 */
var CELLS = [
  ['S1(我)  ', '短短语  ', 'left',           81, 11, 237, 62, 'phrase', 18],
  ['S1(我)  ', '长短语  ', 'down(fallback)', 16, 100, 312, 182, 'phrase', 18],
  ['S1(我)  ', '表情    ', 'down(fallback)', 240, 94, 304, 158, 'emoji', 12],
  ['S1(我)  ', '定向表情', 'down(fallback)', 240, 94, 304, 158, 'emoji', 12],
  ['S2(陪练)', '短短语  ', 'down(dir)',       8, 100, 164, 151, 'phrase', 18],
  ['S2(陪练)', '长短语  ', 'down(dir)',       8, 100, 304, 182, 'phrase', 18],
  ['S2(陪练)', '表情    ', 'down(dir)',       8, 94, 72, 158, 'emoji', 12],
  ['S2(陪练)', '定向表情', 'down(dir)',       8, 94, 72, 158, 'emoji', 12],
  ['S3(陪练2)', '短短语  ', 'down(dir)',      24, 100, 180, 151, 'phrase', 18],
  ['S3(陪练2)', '长短语  ', 'down(dir)',      8, 100, 304, 182, 'phrase', 18],
  ['S3(陪练2)', '表情    ', 'down(dir)',      70, 94, 134, 158, 'emoji', 12],
  ['S3(陪练2)', '定向表情', 'down(dir)',      70, 94, 134, 158, 'emoji', 12],
  ['S4(陪练3)', '短短语  ', 'down(dir)',      94, 100, 250, 151, 'phrase', 18],
  ['S4(陪练3)', '长短语  ', 'down(dir)',      16, 100, 312, 182, 'phrase', 18],
  ['S4(陪练3)', '表情    ', 'down(dir)',      140, 94, 204, 158, 'emoji', 12],
  ['S4(陪练3)', '定向表情', 'down(dir)',      140, 94, 204, 158, 'emoji', 12],
  ['S5(陪练4)', '短短语  ', 'down(dir)',      156, 100, 312, 151, 'phrase', 18],
  ['S5(陪练4)', '长短语  ', 'down(dir)',      16, 100, 312, 182, 'phrase', 18],
  ['S5(陪练4)', '表情    ', 'down(dir)',      209, 94, 273, 158, 'emoji', 12],
  ['S5(陪练4)', '定向表情', 'down(dir)',      209, 94, 273, 158, 'emoji', 12]
];

var VW = 320, VH = 568;

/* 探针 2026-11-14 17:3x 那次实跑里 Q1 判红的格（0 基下标）。
 * 用途：**先证明本工具能复现被测方的判定，再谈「换口径后全绿」**。
 * 复现不了 = 我对它的口径理解错了，那时任何「它错了」的结论都不成立。 */
var PROBE_FLAGGED = [0, 1, 4, 5, 6, 7, 9, 13, 16, 17];

/* 尾巴所在边（= 需要外扩的那一边） */
function tailSide(dir) {
  var d = String(dir).replace(/\(.*$/, '');
  if (d === 'right') return 'left';   /* 气泡在座位右侧 → 尾巴在气泡左边缘 */
  if (d === 'left') return 'right';
  if (d === 'up') return 'bottom';    /* 气泡在座位上侧 → 尾巴在下边缘（朝下指） */
  if (d === 'down') return 'top';
  return null;
}

/* 口径 A：v2.3 单侧外扩，T = TAIL_H * k */
function checkSingle(c, vw, vh) {
  var T = TAIL_H * (c.k || 1), side = tailSide(c.dir);
  var l = c.l - (side === 'left' ? T : 0);
  var r = c.r + (side === 'right' ? T : 0);
  var t = c.t - (side === 'top' ? T : 0);
  var b = c.b + (side === 'bottom' ? T : 0);
  var ok = l >= MARGIN && t >= MARGIN && r <= vw - MARGIN && b <= vh - MARGIN;
  /* 逐边余量，便于区分「真失败」与「0.4px 级」 */
  var slack = {
    left: l - MARGIN, top: t - MARGIN,
    right: (vw - MARGIN) - r, bottom: (vh - MARGIN) - b
  };
  return { ok: ok, side: side, T: T, box: { l: l, t: t, r: r, b: b }, slack: slack };
}

/* 口径 B：探针现状 = 四边各外扩 T（= TAIL_H×k），容差 0.6。
 * ★ 注意别被打印串误导：探针 [9] 段每行末尾的 `外扩=18/12` 是 **pad = gap + TAIL_H**，
 *   那是 Q4a/Q4b 的量（尖端判区），不是 Q1 的裁剪盒量。Q1 实际只减 TAIL_H。
 *   取证：scripts/probe-emoji.js:690
 *     var q1 = (r.left - tailH >= MARGIN - 0.6) && (r.top - tailH >= MARGIN - 0.6)
 *           && (r.right + tailH <= vw - MARGIN + 0.6) && (r.bottom + tailH <= vh - MARGIN + 0.6);
 */
function checkFour(c, vw, vh) {
  var T = TAIL_H * (c.k || 1), E = T, TOL = 0.6;
  var l = c.l - E, r = c.r + E, t = c.t - E, b = c.b + E;
  var ok = l >= MARGIN - TOL && t >= MARGIN - TOL && r <= vw - MARGIN + TOL && b <= vh - MARGIN + TOL;
  return { ok: ok, box: { l: l, t: t, r: r, b: b } };
}

function runSelfTest() {
  var pass = 0, total = 0;
  console.log('== 自验（已知答案，含应命中与应不命中） ==');
  SELFTEST.forEach(function (s) {
    var name = s[0], cell = s[1], expSingle = s[2], expFour = s[3];
    var a = checkSingle(cell, cell.vw, cell.vh);
    var b = checkFour(cell, cell.vw, cell.vh);
    var gotSingle = a.ok ? 'pass' : 'fail', gotFour = b.ok ? 'pass' : 'fail';
    total += 2;
    if (gotSingle === expSingle) pass++;
    if (gotFour === expFour) pass++;
    console.log('  ' + (gotSingle === expSingle && gotFour === expFour ? 'PASS' : 'FAIL')
      + '  ' + name + '  单侧=' + gotSingle + '(期望' + expSingle + ')'
      + '  四边=' + gotFour + '(期望' + expFour + ')');
  });
  console.log('  自验 ' + pass + '/' + total + ' 项通过'
    + '（含 ' + SELFTEST.filter(function (s) { return s[2] === 'fail'; }).length + ' 个单侧口径应红色样本，'
    + SELFTEST.filter(function (s) { return s[3] === 'pass'; }).length + ' 个四边口径应绿色样本）');
  return pass === total;
}

function main() {
  var stOk = runSelfTest();
  console.log('\n== 回放：320×568 满员档 20 格 ==');
  var singleRed = 0, fourRed = 0, flip = 0, zeroMargin = 0, agree = 0;
  var rows = [];
  CELLS.forEach(function (c, idx) {
    var name = c[0], content = c[1], dir = c[2];
    var cell = { vw: VW, vh: VH, dir: dir, l: c[3], t: c[4], r: c[5], b: c[6], kind: c[7], k: 1 };
    var a = checkSingle(cell, VW, VH);
    var b = checkFour(cell, VW, VH);
    var probeSaysRed = PROBE_FLAGGED.indexOf(idx) >= 0;
    if (probeSaysRed === !b.ok) agree++;      /* 我的四边口径必须与探针实跑判决一致 */
    if (!a.ok) singleRed++;
    if (!b.ok) fourRed++;
    if (!a.ok !== !b.ok) flip++;
    var minSlack = Math.min(a.slack.left, a.slack.top, a.slack.right, a.slack.bottom);
    if (a.ok && minSlack < 0.5) zeroMargin++;
    rows.push({
      name: name, content: content, dir: String(dir).replace(/\(.*/, ''),
      side: a.side, single: a.ok ? 'pass' : 'FAIL', four: b.ok ? 'pass' : 'FAIL',
      probe: probeSaysRed ? '红' : '绿',
      minSlack: Math.round(minSlack * 10) / 10,
      worst: Object.keys(a.slack).reduce(function (m, k2) { return a.slack[k2] < a.slack[m] ? k2 : m; }, 'left')
    });
  });
  rows.forEach(function (r) {
    console.log('  ' + r.single.padEnd(5) + ' (四边=' + r.four.padEnd(5) + '/探针=' + r.probe + ')  '
      + r.name + ' ' + r.content + ' dir=' + r.dir.padEnd(6)
      + ' 尾边=' + String(r.side).padEnd(6)
      + ' 最小余量=' + r.minSlack + 'px@' + r.worst);
  });
  console.log('\n== 结论 ==');
  console.log('  ① 复现被测方：四边口径 vs 探针实跑判决 一致 ' + agree + '/20'
    + (agree === 20 ? '（口径理解正确，可以往下谈）' : '（口径没读懂，下面的结论全部作废）'));
  console.log('  ② 单侧口径（v2.3）：' + (20 - singleRed) + '/20 通过，红 ' + singleRed + ' 格');
  console.log('  ③ 四边口径（探针现状）：' + (20 - fourRed) + '/20 通过，红 ' + fourRed + ' 格');
  console.log('  ④ 两口径结论不同的格：' + flip + ' 格 —— 这 ' + flip + ' 格是「尺子差」不是「实现差」');
  console.log('  ⑤ 单侧口径下零余量格（最小余量 < 0.5px）：' + zeroMargin + ' 格');
  console.log('\n  ' + (stOk && agree === 20 ? '工具可用' : '工具不可用') + '：'
    + (stOk && agree === 20
      ? '自验通过且能复现被测方判决 → 「探针 Q1 用四边、v2.3 要求单侧」这个归因成立，'
        + '那 ' + flip + ' 格红应在探针侧改，不要在实现侧调'
      : '自验或复现任一未过，本工具这次只能当线索，不得作为判定依据'));
  process.exit(stOk && agree === 20 ? (singleRed === 0 ? 0 : 1) : 2);
}

main();
