/**
 * 落点判定尺子（oracle）的**接入守卫**
 * 跑法：node pwa/test/emoji-placement-oracle.test.js
 *
 * 为什么这条要进 `npm test`：规格 §6 / QA 单 G14 的原话是
 * 「写了但没接进执行链的守卫等于没有守卫，而且它的失败会被一并吞掉」。
 *
 * 这里守三件事：
 *   [1] 尺子自己验过（≥3 正样本 + ≥1 该判红 + 阈值敏感度 3 条），并且**报得出条数**
 *   [2] 尺子的常量与规格 / 实现同源（MARGIN 8、圆角 18、TAIL_H 8、gap 10/4）
 *   [3] 台账与磁盘对得上：`scripts/probes.json` 里有 `probe-emoji-oracle.js`，
 *       而且尺子文件真的在 `tools/qa/` —— 台账条数与磁盘探针数的一致性由
 *       `pwa/test/probe-ledger.test.js` 全仓校验，这里只补「这条真的指向那把尺子」
 */
'use strict';

const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, '..', '..', 'tools', 'qa', 'emoji-placement-oracle.js'));

const ROOT = path.join(__dirname, '..', '..');
const js = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'seatSheetView.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ← ' + extra : '')); }
}

console.log('\n[1] 尺子自验（正样本 + 该判红的样本 + 阈值敏感度）');
{
  const r = O.runSelfTest(false, true);          // 静音：结论用条数说话
  ok(r.ok && r.fail === 0, '★ 自验全绿：通过 ' + r.pass + ' 项，失败 ' + r.fail + ' 项');
  ok(r.pass >= 26, '★ 自验至少跑了 26 条断言（实测 ' + r.pass + '）—— 少跑一半和全跑过长得一样');
  ok(O.fixtures.length >= 3, '正样本 ≥ 3 个（实测 ' + O.fixtures.length + '）');
  ok(O.negatives.length >= 1, '该判红的样本 ≥ 1 个（实测 ' + O.negatives.length + '）');

  /* 每一个负样本都必须真的被判红 —— 尺子没有否决权就没有意义 */
  let allRed = true;
  O.negatives.forEach(function (n) {
    const res = O.check(n.obs, n.ctx);
    if (res.ok || res.v[n.mustFail] !== false) allRed = false;
  });
  ok(allRed, '★ ' + O.negatives.length + ' 个负样本逐个判红（不是只判了整条 ok=false）');
}

console.log('\n[2] 常量与规格 / 实现同源');
{
  ok(O.TH.MARGIN === 8, 'MARGIN = 8（规格 §3，不乘 k）', O.TH.MARGIN);
  ok(O.TH.TAIL_H === 8 && O.TH.TAIL_W === 12, '尾巴 12×8（TAIL_H 是伸出长度，进裁剪盒）',
    O.TH.TAIL_H + '×' + O.TH.TAIL_W);
  ok(O.TH.RADIUS === 18, '圆角半径 18（m = min(18k, L/2) 的出处）', O.TH.RADIUS);
  ok(O.TH.GAP_PHRASE === 10 && O.TH.GAP_EMOJI === 4, 'gap 10（短语）/ 4（表情）',
    O.TH.GAP_PHRASE + '/' + O.TH.GAP_EMOJI);
  ok(O.TH.Q4A_RATE === 0.8, 'Q4a 下限 80%', O.TH.Q4A_RATE);

  /* 实现里的三个常量必须与尺子一致 —— 两边不同源，尺子量出来的红绿都不作数 */
  ok(/var MARGIN = 8;/.test(js), '实现里 MARGIN = 8');
  ok(/var TAIL_D_LEN = 8;/.test(js) && /var TAIL_D_W = 12;/.test(js), '实现里尾巴 12×8');
  ok(/var TAIL_R_DESIGN = 18;/.test(js), '实现里圆角 18');
}

console.log('\n[3] 台账登记（写了但没人跑 = 没有）');
{
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'probes.json'), 'utf8'));
  const entry = (mf.probes || []).filter(function (p) { return p.file === 'probe-emoji-oracle.js'; })[0];
  ok(!!entry, '★ scripts/probes.json 里登记了 probe-emoji-oracle.js');
  ok(!!entry && !!String(entry.what || '').trim(), '台账写了「守什么」（what 不能空）');
  ok(!!entry && ['ci', 'manual', 'oneshot'].indexOf(entry.run) >= 0, 'run 值是三档之一', entry && entry.run);
  ok(!!entry && Number(entry.expect) === 32,
    '★ 台账里的 expect == 尺子自验条数（' + (entry && entry.expect) + '）—— 项数变了会红，防「少跑一半」');
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'probe-emoji-oracle.js')), '台账条目的探针文件真的在');
  ok(fs.existsSync(path.join(ROOT, 'tools', 'qa', 'emoji-placement-oracle.js')), '它 require 的尺子文件真的在');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;
