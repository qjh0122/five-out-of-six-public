#!/usr/bin/env node
/* emoji-n18-ruler-compare.js —— N18「尾巴撒谎」两条判据的误伤对照（QA 侧，只读 dump）
 *
 * 为什么有这个文件：
 *   N18 初版判 `|shift| ≤ 头像沿位移轴跨度/2`，被真实 dump 证伪（大 shift 但尖端完美对准）。
 *   现在把两条判据并排算，任何一档都能一眼看出「换判据会误红多少行」。
 *   实现侧若再提类似口径，直接跑这个文件出数，不用重新写一遍。
 *
 * 用法：
 *   node tools/qa/emoji-n18-ruler-compare.js <dump.jsonl>
 *   node tools/qa/emoji-n18-ruler-compare.js --selftest      # 不读 dump，只验判据实现
 *
 * 说明：只读，不启浏览器、不连端口、不写文件。
 */
'use strict';
const fs = require('fs');

/* 沿位移轴取几何：左右档的位移轴是 y，上下档是 x（与 shiftSearch 的自由轴一致） */
function axisOf(r) {
  const vert = (r.dir === 'left' || r.dir === 'right');
  return {
    avHalf: vert ? (r.face.b - r.face.t) / 2 : (r.face.r - r.face.l) / 2,
    faceC: vert ? (r.face.t + r.face.b) / 2 : (r.face.l + r.face.r) / 2,
    tipAlong: vert ? r.tip.y : r.tip.x,
  };
}

/* 现行判据（规格 §14 采纳）：尖端沿轴偏离头像中心 > 头像跨度/2 → 撒谎 */
function violatesTip(r) {
  const a = axisOf(r);
  return Math.abs(a.tipAlong - a.faceC) > a.avHalf + 0.5;
}

/* 被证伪的初版判据：|shift| > 头像跨度/2 → 撒谎 */
function violatesShift(r) {
  const a = axisOf(r);
  return typeof r.shift === 'number' && Math.abs(r.shift) > a.avHalf;
}

/* 气泡沿**位移轴**的跨度（左右档位移在 y → 取 h；上下档在 x → 取 w）
 * dump 里这个字段叫 `rect`（{l,t,r,b,w,h}），旧版探针叫 `box` —— 两个都认。 */
function spanOf(r) {
  const vert = (r.dir === 'left' || r.dir === 'right');
  const b = r.box || r.rect || {};
  const len = vert ? (b.h != null ? b.h : (b.b != null ? b.b - b.t : null))
    : (b.w != null ? b.w : (b.r != null ? b.r - b.l : null));
  return typeof len === 'number' && len > 0 ? len : null;
}

/* ---- 位移量级体检（2026-11-14 新增，因为真出过一次跨轴相减的 bug）----------
 * 背景：`shift` 曾写成 `(vert ? spot.left : spot.top) - basePos`，即拿 x 减 y，
 *       量出 215 / 275 这种「看上去位移严重超预算」的假数。跨轴相减的特征是
 *       **数值接近视口尺寸**，而真位移是「对齐位置的微调」。
 * 判据 A（硬·上界，不需要 k）：|shift| ≤ 气泡沿位移轴跨度/2 + 头像跨度/2。
 *       依据：`seatSheetView.js:727` 写明 |位移| ≤ (跨度/2 − m) + 头像跨度/2，
 *       且 m ≥ 0，故上式是它的必要条件。违反 → 该字段不可能是位移，**不许用来判实现**。
 * 判据 B（已**砍掉**，2026-11-14 当天砍）：原本还写了「max|shift| > 4×头像半跨 → 疑似跨轴」。
 *       在**修好后的** 320 数据上它当场误报：长短语 legit 位移 124，而 4×头像半跨只有 34。
 *       —— 位移上界由**气泡跨度**决定，不由头像决定；拿头像当分母就是错的分母。
 *       硬上界（判据 A）已经能在带 bug 的旧数据上抓到 5/16，B 是多余的。
 * 两轴都缺 `rect`/`box` → 记「未测」，不猜。
 */
function rangeCheck(rows) {
  const out = { checked: 0, missingBox: 0, over: [], maxShift: 0, maxAvHalf: 0, maxBound: 0 };
  for (const r of rows) {
    const a = axisOf(r);
    out.maxAvHalf = Math.max(out.maxAvHalf, a.avHalf);
    if (typeof r.shift === 'number') out.maxShift = Math.max(out.maxShift, Math.abs(r.shift));
    const span = spanOf(r);
    if (span == null) { out.missingBox++; continue; }
    if (typeof r.shift !== 'number') continue;
    out.checked++;
    const bound = span / 2 + a.avHalf;
    out.maxBound = Math.max(out.maxBound, bound);
    if (Math.abs(r.shift) > bound) {
      out.over.push(`${r.name || '?'}@${r.seat || '?'}/${r.dir} shift=${r.shift} 上界=${bound.toFixed(1)}`
        + `（跨度 ${span} /2 + 头像 ${a.avHalf.toFixed(0)}）`);
    }
  }
  return out;
}

function selfTest() {
  const face = { l: 100, r: 136, t: 200, b: 236 };   // 36px → avHalf = 18
  const cases = [
    // [名字, 行, 期望 violatesShift, 期望 violatesTip]
    ['① 大位移但尖端对准（max 275）', { dir: 'right', shift: 275, face, tip: { x: 0, y: 218 } }, true, false],
    ['② 尖端真的偏了 20px', { dir: 'right', shift: 0, face, tip: { x: 0, y: 238 } }, false, true],
    ['③ 兜底 shift=null（没算过位移）', { dir: 'down', shift: null, face, tip: { x: 118, y: 0 } }, false, false],
    ['④ 边界 shift=18 == avHalf', { dir: 'down', shift: 18, face, tip: { x: 118, y: 0 } }, false, false],
    ['⑤ 小位移 -26 尖端对准', { dir: 'right', shift: -26, face, tip: { x: 0, y: 218 } }, true, false],
  ];
  let pass = 0, total = 0;
  for (const [name, row, expS, expT] of cases) {
    total += 2;
    const gotS = violatesShift(row), gotT = violatesTip(row);
    const okS = gotS === expS, okT = gotT === expT;
    if (okS) pass++;
    if (okT) pass++;
    console.log(`${okS && okT ? 'ok  ' : 'FAIL'} ${name}  shift判=${gotS}(期望${expS}) tip判=${gotT}(期望${expT})`);
  }
  console.log(`selftest ${pass}/${total}`);

  /* ---- 位移量级体检的自验（4 项，2026-11-14 加） ---- */
  const tall = { l: 100, r: 136, t: 200, b: 236 };                  // avHalf(vert) = 18
  const wideBox = { l: 0, t: 0, r: 120, b: 44, w: 120, h: 44 };     // 位移轴跨度 44
  const rc = [
    ['⑥ 跨轴相减特征：shift=215 远超上界 22+18=40（必须命中）',
      [{ dir: 'right', shift: 215, face: tall, box: wideBox, tip: { x: 0, y: 218 } }], 'over'],
    ['⑦ 正常微调：shift=35 ≤ 40（必须不命中）',
      [{ dir: 'right', shift: 35, face: tall, box: wideBox, tip: { x: 0, y: 218 } }], 'clean'],
    ['⑧ 缺 rect/box：记未测，不猜',
      [{ dir: 'right', shift: 215, face: tall, tip: { x: 0, y: 218 } }], 'missing'],
  ];
  let p2 = 0;
  for (const [name, rows, want] of rc) {
    const r = rangeCheck(rows);
    const got = want === 'over' ? (r.over.length > 0)
      : want === 'clean' ? (r.over.length === 0 && r.checked === 1)
        : (r.missingBox === rows.length);
    if (got) p2++;
    console.log(`${got ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`rangeSelftest ${p2}/${rc.length}`);

  /* ---- 兜底行摘除的自验（3 项，2026-11-14 加）----
   * 反向断言在这里同样重要：只测「fallback 被摘出」的话，一个「全部摘出」的实现也能过，
   * 那时 N18 会变成「0/0 违例」—— 看起来最绿，实际什么都没判。 */
  const sf = [
    ['⑨ 兜底行必须被摘出分母', [{ place: 'fallback' }], (r) => r.fallback.length === 1 && r.judged.length === 0],
    ['⑩ 定向行必须留在分母（反向断言）', [{ place: 'dir' }, { place: 'dir' }], (r) => r.judged.length === 2 && r.fallback.length === 0],
    ['⑪ 缺 place 字段不许当成兜底（无法证明，就留在分母）', [{}, { place: undefined }], (r) => r.judged.length === 2 && r.fallback.length === 0],
    /* 字段优先于推断：这两条如果按 `place` 走就会判反，正是「字段在、别推断」的哨 */
    ['⑫ tailAbsent=true 但 place=dir → 必须摘出（字段优先于推断）', [{ place: 'dir', tailAbsent: true }], (r) => r.fallback.length === 1 && r.judged.length === 0],
    ['⑬ tailAbsent=false 但 place=fallback → 必须留判（字段优先于推断）', [{ place: 'fallback', tailAbsent: false }], (r) => r.judged.length === 1 && r.fallback.length === 0],
    /* 推断必须留痕：没有字段 → inferred 计数 = 全部；有字段 → inferred = 0。
     * 这两条守的是「同一个数在两种情况下长得一样」这个坑：
     * 「兜底 N/A 3 条」既可能是真的 3 条无尾，也可能是探针没传字段、工具猜的 3 条。 */
    ['⑭ 无 tailAbsent 字段 → 必须计入 inferred（不许静默推断）', [{ place: 'fallback' }, { place: 'dir' }], (r) => r.inferred === 2 && r.withField === 0],
    ['⑮ 有 tailAbsent 字段 → inferred 必须为 0（反向断言）', [{ place: 'dir', tailAbsent: false }, { place: 'fallback', tailAbsent: true }], (r) => r.inferred === 0 && r.withField === 2],
  ];
  let p3 = 0;
  for (const [name, rows, check] of sf) {
    const ok = check(splitFallback(rows));
    if (ok) p3++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`fallbackSelftest ${p3}/${sf.length}`);
  return pass === total && p2 === rc.length && p3 === sf.length;
}

/* v2.7 起：兜底落点**不画尾巴**（`seatSheetView.js:1061 setAttribute('data-tail','off')`）。
 * 不画尾巴 = 没有尖端 = 没有「尾巴撒谎」这个对象。
 * 但探针此刻还按 `::after` 尺寸算尖端，`::after` 不渲染时 `len` 落到 0 →
 * `tip` 变成**气泡 rect 边上的一个坐标**，那是人造的，拿它判 N18 就是「判一个不存在的东西」。
 * 所以：`place === 'fallback'` 的行**从分母里摘出去**，单独报 N/A ——
 * **不记通过、不记失败、也不静默丢掉**（静默丢掉 = 分母变小，读者以为覆盖面没变）。
 * ⚠️ 本工具无法从 dump 区分 v2.6（兜底有尾巴）与 v2.7（兜底无尾巴）：两份 dump 都没有 `tailAbsent`。
 *    所以这行必须显式打印「若这份 dump 出自 v2.6 及之前，这几行才有意义」，别让人替我们猜。 */
function splitFallback(rows) {
  const judged = [], fallback = [];
  let withField = 0, inferred = 0;
  for (const r of rows) {
    /* **优先读事实字段**：`tailAbsent` 是探针 v2.7 起的显式字段（`b0e9391d`）。
     * 没有该字段时才退回 `place === 'fallback'` 推断 —— 因为两者在 v2.6 之前并不等价
     * （那时兜底也画尾巴，`place=fallback` 只表示「没找到方向」）。
     * 一句话：**能从字段读到的，不要靠推断。**
     *
     * ⚠️ 2026-11-14 补：推断是**允许**的，但**不许静默**。退回推断时必须计数（`inferred`）
     * 并在输出里显式告警，否则「兜底 N/A 3 条」这个数在两种情况下长得一模一样：
     *   ① 探针传了 `tailAbsent`，确实 3 条无尾；
     *   ② 探针根本没传这个字段，工具靠 `place` 猜出 3 条。
     * ②的情况下我把「字段缺失」当成了「行为正确」—— 这正是本轮的病根（字段在、语义没了）。
     * 写入方给的「Q4b N/A 条数对得上」这个哨**单独用是抓不住②的**，因为它的数由推断也能算出来。 */
    const has = typeof r.tailAbsent === 'boolean';
    let absent;
    if (has) { withField++; absent = r.tailAbsent; }
    else { inferred++; absent = r.place === 'fallback'; }
    (absent ? fallback : judged).push(r);
  }
  return { judged, fallback, withField, inferred, total: rows.length };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return process.exit(selfTest() ? 0 : 1);

  const p = argv[0];
  if (!p) { console.error('用法：node tools/qa/emoji-n18-ruler-compare.js <dump.jsonl> | --selftest'); return process.exit(2); }
  const allRows = fs.readFileSync(p, 'utf8').trim().split(/\n+/).map((l) => JSON.parse(l))
    .filter((r) => r && r.tip && r.face && !r.missing);
  const { judged: rows, fallback, withField, inferred, total } = splitFallback(allRows);
  const cov = `tailAbsent 字段覆盖 ${withField}/${total}`;
  console.log(cov + (inferred ? `  ⚠ 其中 ${inferred} 行**没有该字段、由 place 推断**` : '  （无推断，全部按事实字段）'));
  if (inferred === total && total > 0) {
    console.log('  ⚠⚠ 整份 dump 都没有 `tailAbsent`：下面的「兜底 N/A」是**推断**出来的，'
      + '不是事实。探针没适配或版本不对，这档不许进总表。');
  }

  let n = 0, badShift = 0, badTip = 0, maxShift = 0;
  const detail = [];
  for (const r of rows) {
    n++;
    const a = axisOf(r);
    if (typeof r.shift === 'number') maxShift = Math.max(maxShift, Math.abs(r.shift));
    const s = violatesShift(r), t = violatesTip(r);
    if (s) {
      badShift++;
      detail.push(`${r.name || '?'}@${r.seat || '?'}/${r.dir} shift=${r.shift} avHalf=${a.avHalf.toFixed(1)}`
        + ` tip沿轴偏移=${(a.tipAlong - a.faceC).toFixed(1)}${t ? '  ←真撒谎' : '  ←误伤'}`);
    }
    if (t) badTip++;
  }
  console.log(`行数=${n}  max|shift|=${maxShift}`);
  console.log(`初版 |shift|<=avHalf        → 违例 ${badShift}/${n}`);
  console.log(`现行 |tip-faceC|<=avHalf+0.5 → 违例 ${badTip}/${n}`);
  if (fallback.length) {
    console.log(`兜底行 ${fallback.length} 条 → **N18 N/A**（v2.7 起兜底不画尾巴，没有尖端这个对象；`
      + `不记通过也不记失败）。若这份 dump 出自 v2.6 及之前，这几行才该判 —— 需要 dump 带 \`tailAbsent\` 才能区分。`);
  }
  detail.slice(0, 8).forEach((d) => console.log('  ' + d));

  const rc = rangeCheck(rows);
  console.log(`\n-- 位移量级体检 --  已检 ${rc.checked} 行（缺 rect/box 记未测 ${rc.missingBox} 行）`);
  console.log(`硬上界 |shift| <= 跨度/2 + 头像/2 : 超界 ${rc.over.length}/${rc.checked}`
    + `（max|shift|=${rc.maxShift} / max 上界=${rc.maxBound.toFixed(1)}）`);
  rc.over.slice(0, 5).forEach((d) => console.log('  ✗ ' + d));
  if (rc.over.length) {
    console.log('\n⚠ 超界 = `shift` 不可能是位移（违反 `seatSheetView.js:727` 的位移上界）。'
      + '**该字段不许用来判实现**，先查探针/写入点。');
  } else if (rc.checked) {
    console.log('量级自洽：没有一行超上界。注意这是**必要条件**，抓得住跨轴相减这类粗错，'
      + '抓不住量级接近的小错 —— 它不替代 N18 的 tip/face 判定。');
  }
  return process.exit(0);
}

main();
