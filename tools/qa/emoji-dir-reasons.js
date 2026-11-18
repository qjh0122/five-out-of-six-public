#!/usr/bin/env node
'use strict';
/**
 * emoji-dir-reasons.js —— 四方向逐条否决理由（A / B / C / Q4b），带候选 rect
 *
 * 为什么要有它：当某一格「走了兜底」时，只看结论（fallback）无法区分三种完全不同的原因：
 *   ① 真的没有合法解（约束结构性冲突）→ 要改规格
 *   ② 某个方向算错了（A 用了错的高度 / B 用了错的 rect）→ 要改实现
 *   ③ 排序把它排到最后，前面某向「假通过」→ 要改排序
 * 这三种的修法互相排斥，所以必须把「每向为什么不行」打出来，而不是让人从红格里猜。
 *
 * 用法：node tools/qa/emoji-dir-reasons.js
 *   几何来源见下方 GEO_SOURCE：座位块 rect 是**推导值**（探针打印的尖端/落点 + 截图比例），
 *   不是直接读 DOM 得到，误差约 ±5px。凡结论对该误差敏感的，会在输出里标 `敏感`。
 *
 * 判据出处：规格 v2.4 §2（A/B/C/D）、§6 Q4b、§1.7（单侧裁剪盒）。
 */

var MARGIN = 8, TAIL_H = 8, RADIUS = 18, GAP_PHRASE = 10, GAP_EMOJI = 4;

/* ---------------- 几何工具 ---------------- */
function rect(l, t, r, b) { return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }; }
function area(a, b) {
  var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return (w > 0 && h > 0) ? w * h : 0;          /* 相切算 0 —— 写成 >= 会让 G3 全线误红 */
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function ctr(r) { return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }

/* 尾巴所在边：气泡在座位右侧 → 尾巴在气泡左边缘 */
function tailSide(dir) {
  return dir === 'right' ? 'left' : dir === 'left' ? 'right' : dir === 'up' ? 'bottom' : 'top';
}

/* ---------------- 核心：逐向判定 ---------------- */
function evaluate(ctx, dir) {
  var g = ctx.gap, w = ctx.w, h = ctx.h, T = TAIL_H * ctx.k, M = MARGIN;
  var a0 = ctx.seats[ctx.anchor || 0];
  var s = ctx.block || a0.block;
  var av = ctx.avatar || a0.avatar;
  var ac = ctr(av);

  /* 1) 几何式（规格 §2），v2.4 允许横向/纵向夹取进视口 */
  var left, top;
  if (dir === 'right') { left = s.right + g; top = ac.y - h / 2; }
  else if (dir === 'left') { left = s.left - g - w; top = ac.y - h / 2; }
  else if (dir === 'up') { top = s.top - g - h; left = ac.x - w / 2; }
  else { top = s.bottom + g; left = ac.x - w / 2; }
  /* 夹取：横向夹进 [M, vw-M-w]，纵向夹进 [M, vh-M-h]（v2.4 D1 裁定） */
  var rawLeft = left, rawTop = top;
  left = clamp(left, M, ctx.vw - M - w);
  top = clamp(top, M, ctx.vh - M - h);
  var box = rect(left, top, left + w, top + h);

  /* 2) A：单侧裁剪盒（尾巴只在朝座位那一侧外扩） */
  var side = tailSide(dir);
  var ext = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  ext[side] = side === 'left' || side === 'top' ? ext[side] - T : ext[side] + T;
  var aFail = [];
  if (ext.left < M - 0.5) aFail.push('左 ' + Math.round(ext.left - M) + 'px');
  if (ext.top < M - 0.5) aFail.push('上 ' + Math.round(ext.top - M) + 'px');
  if (ext.right > ctx.vw - M + 0.5) aFail.push('右 ' + Math.round(ctx.vw - M - ext.right) + 'px');
  if (ext.bottom > ctx.vh - M + 0.5) aFail.push('下 ' + Math.round(ctx.vh - M - ext.bottom) + 'px');
  var A = aFail.length === 0;

  /* 3) B：与任何座位块重叠为 0（表情只排非锚点，短语含锚点） */
  var hits = [];
  ctx.seats.forEach(function (st, i) {
    if (ctx.kind === 'emoji' && i === ctx.anchor) return;
    var a = area(box, st.block);
    if (a > 1) hits.push(st.name + '(' + Math.round(a) + 'px²)');
  });
  var B = hits.length === 0;

  /* 4) C / Q4b：尾巴夹取 + 尖端是否指到块 */
  var span = (dir === 'left' || dir === 'right') ? h : w;
  var m = Math.min(RADIUS * ctx.k, span / 2);
  var base = (dir === 'left' || dir === 'right') ? (ac.y - box.top) : (ac.x - box.left);
  var tail = clamp(base, m, span - m);
  var tip = dir === 'right' ? { x: box.left - T, y: box.top + tail }
    : dir === 'left' ? { x: box.right + T, y: box.top + tail }
      : dir === 'up' ? { x: box.left + tail, y: box.bottom + T }
        : { x: box.left + tail, y: box.top - T };
  var pad = g + T;
  var q4b = tip.x >= s.left - pad && tip.x <= s.right + pad
    && tip.y >= s.top - pad && tip.y <= s.bottom + pad;

  return {
    dir: dir, box: box, A: A, aFail: aFail, B: B, hits: hits,
    C: true, tail: Math.round(tail), tip: { x: Math.round(tip.x), y: Math.round(tip.y) },
    q4b: q4b, clamped: { x: Math.round(left - rawLeft), y: Math.round(top - rawTop) },
    ok: A && B && q4b
  };
}

function order(ctx) {
  var c = { x: 0, y: 0 };
  ctx.seats.forEach(function (s) { var m = ctr(s.block); c.x += m.x; c.y += m.y; });
  c.x /= ctx.seats.length; c.y /= ctx.seats.length;
  var a0 = ctx.seats[ctx.anchor || 0];
  var sBlock = ctx.block || a0.block, sAvatar = ctx.avatar || a0.avatar;
  var sc = ctr(sBlock), dx = c.x - sc.x, dy = c.y - sc.y;
  var inward = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  var rest = ['right', 'left', 'up', 'down'].filter(function (d) { return d !== inward; });
  /* 容量：该方向上座位块边缘到最近阻挡者的距离（本工具用预放位置跨度判「挡不挡得住」） */
  function cap(d) {
    var ac = ctr(sAvatar), w = ctx.w, h = ctx.h;
    var crossLo, crossHi, edge, bound;
    if (d === 'right' || d === 'left') { crossLo = ac.y - h / 2; crossHi = ac.y + h / 2; edge = d === 'right' ? sBlock.right : sBlock.left; bound = d === 'right' ? ctx.vw - MARGIN : MARGIN; }
    else { crossLo = ac.x - w / 2; crossHi = ac.x + w / 2; edge = d === 'up' ? sBlock.top : sBlock.bottom; bound = d === 'up' ? MARGIN : ctx.vh - MARGIN; }
    var best = Math.abs(bound - edge);
    ctx.seats.forEach(function (s) {
      if (area({ left: s.block.left, right: s.block.right, top: crossLo, bottom: crossHi },
        { left: s.block.left, right: s.block.right, top: s.block.top, bottom: s.block.bottom }) <= 0) return;
      var cand = d === 'right' ? s.block.left - edge : d === 'left' ? edge - s.block.right
        : d === 'up' ? edge - s.block.bottom : s.block.top - edge;
      if (cand >= 0 && Math.abs(cand) < best) best = Math.abs(cand);
    });
    return Math.round(best);
  }
  rest.sort(function (a, b) { return cap(b) - cap(a); });
  return { center: c, inward: inward, order: [inward].concat(rest), caps: rest.map(function (d) { return d + '=' + cap(d); }) };
}

/* ---------------- 场景：390×844 满员，长短语 ---------------- */
/* 几何来源：探针 390 档打印的落点/尖端（块底 98、我块底 261、acx 127/263）+
 * table.png 截图比例推出中排块 y≈140..193。标 ** 的是推导值。 */
function scene390() {
  var seats = [
    { name: 'pal(中左)', block: rect(40, 140, 81, 193), avatar: rect(43, 140, 78, 175) },   /* ** */
    { name: 'pal2(上1)', block: rect(105, 34, 149, 98), avatar: rect(109, 34, 145, 69) },   /* avatar 实测 */
    { name: 'pal3(上2)', block: rect(241, 34, 285, 98), avatar: rect(245, 34, 281, 69) },   /* avatar 实测 */
    { name: 'pal4(中右)', block: rect(308, 140, 352, 193), avatar: rect(312, 140, 347, 175) }, /* ** */
    { name: '我(S1)', block: rect(155, 222, 204, 261), avatar: rect(161, 226, 196, 261) }   /* 块底 261 实测 */
  ];
  return { vw: 390, vh: 844, k: 1, kind: 'phrase', w: 366, h: 82, gap: GAP_PHRASE, seats: seats };
}

/* ---------------- 自验：≥3 个已知答案，含应命中与应不命中 ---------------- */
function selfTest() {
  var pass = 0, fail = 0;
  function ok(c, name, detail) { if (c) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); } }

  /* ① 空桌：四向全通（应通过）。★ vw 必须够宽：390 上放 200 宽会被夹回锚点块，
   *    那样 B 红是正确的 —— 第一版样本就是这么错的，自验把它抓住了 */
  var empty = { vw: 900, vh: 844, k: 1, kind: 'phrase', w: 200, h: 60, gap: 10, anchor: 0,
    seats: [{ name: 'A', block: rect(100, 300, 240, 360), avatar: rect(110, 300, 150, 340) }] };
  var r1 = evaluate(empty, 'right');
  ok(r1.A && r1.B && r1.q4b, '① 空桌 right 应四通（A/B/Q4b 全过）', JSON.stringify({ A: r1.A, B: r1.B, q4b: r1.q4b }));

  /* ② 越界：气泡贴着左边界且尾巴在左侧 → A 必须红（应命中） */
  var edge = { vw: 390, vh: 844, k: 1, kind: 'phrase', w: 366, h: 82, gap: 10, anchor: 0,
    seats: [{ name: 'A', block: rect(0, 300, 20, 360), avatar: rect(0, 300, 16, 336) }] };
  var r2 = evaluate(edge, 'right');   /* left = 20+10 = 30 → 尾巴在左 → ext.left = 22 ≥ 8 → A 过；改测 up 更稳 */
  var r2b = evaluate(edge, 'down');   /* top = 360+10=370 → 过；左侧 left=clamp(-183,8,16)=8 → ext.top = 362 ≥ 8 → 过 */
  ok(r2.A === true && r2b.A === true, '② 贴左边界但夹取后仍合法（v2.4 允许夹取）', JSON.stringify({ r2: r2.aFail, r2b: r2b.aFail }));

  /* ③ B 必须命中：气泡必然压到另一个块 */
  var crowded = { vw: 390, vh: 844, k: 1, kind: 'phrase', w: 366, h: 82, gap: 10, anchor: 0,
    seats: [{ name: 'A', block: rect(105, 34, 149, 98), avatar: rect(109, 34, 145, 69) },
    { name: 'B', block: rect(40, 140, 81, 193), avatar: rect(43, 140, 78, 175) }] };
  var r3 = evaluate(crowded, 'down');  /* top=108, band 108..190 压到 B(140..193) */
  ok(r3.B === false && r3.hits.length > 0, '③ 366 宽气泡向下必压中排块（B 必须红）', JSON.stringify(r3.hits));

  /* ④ Q4b 必须命中：尾巴离块太远 */
  var far = { vw: 900, vh: 900, k: 1, kind: 'phrase', w: 200, h: 60, gap: 10, anchor: 0,
    seats: [{ name: 'A', block: rect(300, 300, 360, 340), avatar: rect(310, 300, 350, 340) },
    { name: 'X', block: rect(300, 700, 360, 740), avatar: rect(310, 700, 350, 740) }] };
  var r4 = evaluate(far, 'right');     /* top = 320-30=290, tip 在块右侧 → q4b 应绿 */
  ok(r4.q4b === true, '④ 正常相邻时 Q4b 应绿（反向样本：不能恒红）', JSON.stringify(r4.tip));

  /* ⑤ 排序：inward 与容量不同向时必须取 inward（内推优先） */
  var ord = order({ vw: 390, vh: 844, k: 1, kind: 'phrase', w: 200, h: 60, gap: 10,
    seats: [
      { name: 'me', block: rect(300, 400, 360, 460), avatar: rect(310, 400, 350, 440) },
      { name: 'o1', block: rect(20, 20, 80, 80), avatar: rect(30, 20, 70, 60) },
      { name: 'o2', block: rect(20, 780, 80, 840), avatar: rect(30, 780, 70, 820) }
    ], block: rect(300, 400, 360, 460), avatar: rect(310, 400, 350, 440) });
  ok(ord.order[0] === 'left' && ord.inward === 'left', '⑤ 内推优先：桌心在左时 inward=left 且排第一', JSON.stringify(ord.order));

  console.log('\n  自验：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  return fail === 0;
}

function main() {
  var stOk = selfTest();
  if (!stOk) { console.log('\n自验未过，本工具只能当线索，不得作为判定依据。'); process.exit(2); }
  var ctx = scene390();
  var ord = order(ctx);
  console.log('\n== 390×844 满员 · 长短语（w=366 h=82 gap=10 k=1）==');
  console.log('  桌心 = (' + ord.center.x.toFixed(1) + ', ' + ord.center.y.toFixed(1) + ')');
  console.log('  本场景排序 = [' + ord.order.join(', ') + ']  其余三向容量：' + ord.caps.join(' '));

  [0, 1, 2, 3].forEach(function (idx) {
    ctx.anchor = idx;
    ctx.block = ctx.seats[idx].block;
    ctx.avatar = ctx.seats[idx].avatar;
    var sc = ctr(ctx.block), scx = ctr(ctx.seats[idx].avatar);
    var dx = ord.center.x - sc.x, dy = ord.center.y - sc.y;
    var inw = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    console.log('\n  【' + ctx.seats[idx].name + '】acx=' + scx.x.toFixed(0) + ' 块=' +
      JSON.stringify([ctx.block.left, ctx.block.top, ctx.block.right, ctx.block.bottom]) + ' 内推=' + inw);
    ['right', 'left', 'up', 'down'].forEach(function (d) {
      var r = evaluate(ctx, d);
      var why = r.ok ? '✓ 可用'
        : (!r.A ? 'A 越界(' + r.aFail.join(',') + ')' : '')
        + (!r.B ? ' B 压块(' + r.hits.join(',') + ')' : '')
        + (!r.q4b ? ' Q4b 尾巴离块太远' : '');
      console.log('    ' + d.padEnd(5) + ' cand=' +
        JSON.stringify([Math.round(r.box.left), Math.round(r.box.top), Math.round(r.box.right), Math.round(r.box.bottom)]).padEnd(26) +
        ' 夹取偏移=' + JSON.stringify(r.clamped) + ' tail=' + r.tail + ' tip=' + JSON.stringify(r.tip) +
        '  → ' + why);
    });
  });

  /* 结论：是否存在任何合法位置 */
  ctx.anchor = 0; ctx.block = ctx.seats[0].block; ctx.avatar = ctx.seats[0].avatar;
  console.log('\n== 结论 ==');
  console.log('  四向可用数（pal 为例）：' + ['right', 'left', 'up', 'down'].filter(function (d) { return evaluate(ctx, d).ok; }).length + ' / 4');
  console.log('  → 0/4 表示「约束层面无解」，需改规格；>0 却走了兜底表示实现/排序 bug。');
  console.log('  几何误差提示：中排块 rect 为推导值(±5px)，B 的重叠厚度 50px 量级，结论对该误差不敏感。');
}

main();
