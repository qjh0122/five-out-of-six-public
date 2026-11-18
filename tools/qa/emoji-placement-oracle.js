#!/usr/bin/env node
/**
 * 表情 / 短语落点判定工具（oracle）—— 规格 docs/ui-emoji-placement-v2.md **v2.6**
 *
 * ★ 谁是唯一的判据实现（规格 §13）：**探针**（scripts/probe-emoji.js）是唯一实现，
 *   本文件只做**独立复算** —— 两者结论不一致时，先查是不是又出现新旧两式并存
 *   （这个坑已经踩了三次：Q1 单侧/四边、Q4a 两轴/矩形、C 是否否决方向）。
 *
 * 为什么要有第二个实现：探针量的是「实现算出来的位置对不对」，而实现本身就是
 * 被验对象 —— 用它自己的中间变量去判它，永远绿。这个文件是**独立复算**：
 * 输入只有渲染结果（座位块 rect、头像 rect、气泡 rect、视口、k），
 * 不 require 任何 pwa 代码，不读 `--tail-off` 之外的实现痕迹。
 *
 * 三件事：
 *   ① `place(ctx)`  —— 按规格 §2 / §4.1 复算「该落在哪」：内推优先 + 可用空间降序，
 *                      让位走**区间搜索**，四轮降级（dir → stack → 接受重叠 → 表情保底）
 *   ② `check(obs,ctx)` —— 按规格 §2/§6 判一条**已观测**的落点：Q1/Q5/B/Q4a(两轴)/Q4b/Q10
 *   ③ 自验（`node tools/qa/emoji-placement-oracle.js`）—— §5.2 要求：
 *      ≥3 个正样本、≥1 个**该判红**的样本、报可数结论；另加**阈值敏感度**：
 *      把 MARGIN / 圆角 18 / 尾巴外扩 改坏后，对应样本的结论必须翻转。
 *      尺子自己没被证明会红，等于没有尺子。
 *
 * 跑法：
 *   node tools/qa/emoji-placement-oracle.js             # 自验（失败退出码 1）
 *   node tools/qa/emoji-placement-oracle.js --verbose   # 每个样本打印算式
 *
 * 常量出处（改阈值请只改 TH，并让自验跟着红）：
 *   MARGIN 8 / TAIL_H 8 / TAIL_W 12 / 圆角 18 —— 规格 §3
 *   gap 10（短语）4（表情）× k、m = min(18k, L/2)、Q4 判区 gap + TAIL_H —— 规格 §2 / §6
 *   让位 = 区间搜索（位移上限由尾巴可补偿幅度决定）—— 规格 §4.1
 *   预算只算「不指人且未署名」≤ 2；「不指人但已署名」观察项 ≤ 8 —— 规格 §4.2
 */
'use strict';

/* ============================ 常量（唯一出处） ============================ */
var TH = {
  MARGIN: 8,          // 视口安全边，不乘 k
  TAIL_H: 8,          // 尾巴伸出量（设计 px，乘 k）
  TAIL_W: 12,         // 尾巴宽度（设计 px，乘 k）
  RADIUS: 18,         // 气泡圆角半径（设计 px，乘 k）→ m = min(RADIUS*k, L/2)
  GAP_PHRASE: 10,
  GAP_EMOJI: 4,
  SHIFT_GAP: 6,
  SHIFT_TRIES: 3,
  Q4A_RATE: 0.8,      // 定向落点中「瞄到脸」的下限
  /* v2.6 §4.2 拆口径：预算只统计「**不指人且未署名**」，各档统一 ≤ 2；
   * 「不指人但已署名」是**观察项**（≤ 8，不阻断）—— 两件事危害不在一个量级。 */
  NO_POINT_NARROW: 2,
  NO_POINT: 2,
  SIGNED_MAX: 8,
  NARROW_W: 320,
  DIRS: ['right', 'left', 'up', 'down']
};

/* ============================ 几何小工具 ============================ */
function rect(l, t, r, b) { return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }; }
function fromDom(r) { return r ? rect(r.left, r.top, r.right, r.bottom) : null; }
function expand(r, d) { return rect(r.left - d, r.top - d, r.right + d, r.bottom + d); }
function inside(pt, box) {
  return pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom;
}
function overlapArea(a, b) {
  var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return (w > 0 && h > 0) ? w * h : 0;
}
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function cx(r) { return r.left + r.width / 2; }
function cy(r) { return r.top + r.height / 2; }
function isSide(dir) { return dir === 'right' || dir === 'left'; }

/* ============================ ① 复算落点 ============================ */
/* 可用空间 cap(dir) —— 与 QA 单 §1.6 逐字一致（G4 要求 `data-dir === oracle.dir`，
 * 两边口径不同就一定整片假红）：
 *   · 座位块边沿：right → S.right，left → S.left，up → S.top，down → S.bottom
 *   · 预放位置的跨度：侧边档 = [Ac.y − h/2, Ac.y + h/2]，上下档 = [Ac.x − w/2, Ac.x + w/2]
 *     （**不夹取**，用几何式原值；不用座位块跨度 —— 气泡按头像中心对齐）
 *   · 阻挡者 = 视口边界，或「跨度正重叠」的其它座位块
 *   · cap = min(阻挡者坐标) − 块边沿坐标，**允许为负** */
function availableSpace(ctx, dir) {
  var b = ctx.block, i, o, oLo, oHi, at, best;
  var others = ctx.others || [];
  var vert = isSide(dir);
  var spanLo = vert ? (cy(ctx.avatar) - ctx.h / 2) : (cx(ctx.avatar) - ctx.w / 2);
  var spanHi = vert ? (cy(ctx.avatar) + ctx.h / 2) : (cx(ctx.avatar) + ctx.w / 2);
  var edge = (dir === 'right') ? b.right : (dir === 'left') ? b.left
    : (dir === 'down') ? b.bottom : b.top;
  best = (dir === 'right') ? (ctx.vw - TH.MARGIN) : (dir === 'left') ? TH.MARGIN
    : (dir === 'down') ? (ctx.vh - TH.MARGIN) : TH.MARGIN;
  for (i = 0; i < others.length; i++) {
    o = others[i];
    oLo = vert ? o.top : o.left;
    oHi = vert ? o.bottom : o.right;
    if (Math.min(spanHi, oHi) - Math.max(spanLo, oLo) <= 0) continue;
    at = (dir === 'right') ? o.left : (dir === 'left') ? o.right
      : (dir === 'down') ? o.top : o.bottom;
    if (at < best) best = at;
  }
  return (dir === 'right' || dir === 'down') ? (best - edge) : (edge - best);
}

/* 内推方向：从本块中心指向「全部座位块中心的重心」的主轴，吸附到四方向之一。 */
function inwardDir(ctx) {
  var b = ctx.block;
  var all = ctx.allSeats && ctx.allSeats.length ? ctx.allSeats : [b].concat(ctx.others || []);
  var sx = 0, sy = 0, i;
  for (i = 0; i < all.length; i++) { sx += cx(all[i]); sy += cy(all[i]); }
  var dx = sx / all.length - cx(b);
  var dy = sy / all.length - cy(b);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/* 现场排序：内推优先，其余按可用空间降序；相等时退回 right/left/up/down。 */
function dirOrder(ctx) {
  var inw = inwardDir(ctx);
  var rank = { right: 0, left: 1, up: 2, down: 3 };
  var rest = TH.DIRS.filter(function (d) { return d !== inw; });
  rest.sort(function (a, b2) {
    var d = availableSpace(ctx, b2) - availableSpace(ctx, a);
    return d !== 0 ? d : (rank[a] - rank[b2]);
  });
  return { inward: inw, order: inw ? [inw].concat(rest) : rest };
}

function baseOf(ctx, dir) {
  var b = ctx.block, w = ctx.w, h = ctx.h;
  var g = ctx.gap;
  if (dir === 'right') return { left: b.right + g, top: cy(ctx.avatar) - h / 2 };
  if (dir === 'left') return { left: b.left - g - w, top: cy(ctx.avatar) - h / 2 };
  if (dir === 'up') return { left: cx(ctx.avatar) - w / 2, top: b.top - g - h };
  return { left: cx(ctx.avatar) - w / 2, top: b.bottom + g };
}

/* 尾巴沿贴合边的位置 + 尖端坐标。m = min(RADIUS*k, L/2)（规格 §2 约束 C，唯一出处）。 */
function tailOf(ctx, dir, left, top) {
  var r = rect(left, top, left + ctx.w, top + ctx.h);
  var span = isSide(dir) ? ctx.h : ctx.w;
  var m = Math.min(TH.RADIUS * ctx.k, span / 2);
  var ideal = isSide(dir) ? (cy(ctx.avatar) - top) : (cx(ctx.avatar) - left);
  var off = clamp(ideal, m, span - m);
  var len = TH.TAIL_H * ctx.k;
  var tip;
  if (dir === 'right') tip = { x: left - len, y: top + off };
  else if (dir === 'left') tip = { x: left + ctx.w + len, y: top + off };
  else if (dir === 'up') tip = { x: left + off, y: top + ctx.h + len };
  else tip = { x: left + off, y: top - len };
  return { box: r, span: span, m: m, off: off, len: len, tip: tip };
}

/* 一条候选位置判 A/B/D。opt：strictD / allowSelf
 * A 是**单侧**外扩（QA 单 §1.7）：尾巴只朝座位那一侧伸出，外扩边留 MARGIN + TAIL_H。
 * ★ C（Q4b）**不是否决条件**（规格 §2 约束 C / v2.3）：m ≤ L/2 恒成立 ⇒ clamp 恒有解
 *   ⇒「尾巴放不下」在数学上不存在。这里只把结果记成 `reach`，
 *   给 §4.3 兜底署名与探针 Q8/Q10 用，不参与方向选择。 */
function judgeAt(ctx, dir, left, top, opt) {
  var vw = ctx.vw, vh = ctx.vh, w = ctx.w, h = ctx.h;
  var len = TH.TAIL_H * ctx.k;
  var loX = TH.MARGIN + (dir === 'right' ? len : 0);
  var hiX = vw - TH.MARGIN - (dir === 'left' ? len : 0) - w;
  var loY = TH.MARGIN + (dir === 'down' ? len : 0);
  var hiY = vh - TH.MARGIN - (dir === 'up' ? len : 0) - h;
  if (hiX < loX || hiY < loY) return null;          // 连裁剪盒都放不下 → 该方向作废
  left = clamp(left, loX, hiX);
  top = clamp(top, loY, hiY);
  var t = tailOf(ctx, dir, left, top);
  var box = t.box;
  /* B：短语与全部座位块 0 重叠；表情只排非锚点块，锚点自己仅保底分支放行 */
  var i, list = ctx.others || [];
  for (i = 0; i < list.length; i++) if (overlapArea(box, list[i]) > 0) return null;
  if (!opt.allowSelf && overlapArea(box, ctx.block) > 0) return null;
  /* D：不与存活气泡相交 */
  if (opt.strictD) {
    var live = ctx.live || [];
    for (i = 0; i < live.length; i++) if (overlapArea(box, live[i]) > 0) return null;
  }
  var reach = inside(t.tip, expand(ctx.block, ctx.gap + t.len));
  return { left: left, top: top, dir: dir, tailOff: t.off, tip: t.tip, reach: reach, place: opt.place };
}

/* §4.1 区间搜索（v2.6）：替掉「自身边长 + 6」的整块换行。可行域边界只落在
 * 「对齐位置 / 贴着某个障碍的一边 / A 窗口两端」，把它们当候选穷举，取位移最小的。
 * 位移上限由尾巴决定：尖端必须仍落在头像跨度内（气泡可以滑，尾巴不能撒谎）。 */
function shiftSearch(ctx, dir, base, opt) {
  var vert = isSide(dir);
  var span = vert ? ctx.h : ctx.w;
  var m = Math.min(TH.RADIUS * ctx.k, span / 2);
  var acAlong = vert ? cy(ctx.avatar) : cx(ctx.avatar);
  var acHalf = (vert ? ctx.avatar.height : ctx.avatar.width) / 2;
  var cap = (span / 2 - m) + acHalf;
  var basePos = vert ? base.top : base.left;
  var len = TH.TAIL_H * ctx.k;
  var lo = vert ? (TH.MARGIN + (dir === 'down' ? len : 0)) : (TH.MARGIN + (dir === 'right' ? len : 0));
  var hi = vert ? (ctx.vh - TH.MARGIN - (dir === 'up' ? len : 0) - ctx.h)
    : (ctx.vw - TH.MARGIN - (dir === 'left' ? len : 0) - ctx.w);
  if (hi < lo) return null;
  var raw = [basePos, lo, hi], i;
  var blocks = (ctx.others || []).concat(ctx.live || []);
  for (i = 0; i < blocks.length; i++) {
    raw.push(vert ? blocks[i].bottom : blocks[i].right);
    raw.push(vert ? blocks[i].top - ctx.h : blocks[i].left - ctx.w);
  }
  var cands = [], seen = {};
  for (i = 0; i < raw.length; i++) {
    [raw[i], raw[i] - 1, raw[i] + 1].forEach(function (p) {
      if (Math.abs(p - basePos) > cap + 0.5) return;
      var q = Math.round(p);
      if (q < lo - 0.5 || q > hi + 0.5) return;
      if (seen[q]) return;
      seen[q] = 1; cands.push(q);
    });
  }
  cands.sort(function (a, b) {
    var d = Math.abs(a - basePos) - Math.abs(b - basePos);
    return d !== 0 ? d : (a - b);
  });
  for (i = 0; i < cands.length; i++) {
    var p = cands[i];
    var spot = judgeAt(ctx, dir, vert ? base.left : p, vert ? p : base.top, opt);
    if (!spot) continue;
    if (Math.abs((vert ? spot.tip.y : spot.tip.x) - acAlong) > acHalf + 0.5) continue;
    return spot;
  }
  return null;
}

/* 复算落点。返回 null 表示连兜底都放不下（调用方该走 fallbackSpot）。 */
function place(ctx) {
  var order = dirOrder(ctx).order;
  var tries = TH.SHIFT_TRIES;

  function pass(opt) {
    for (var d = 0; d < order.length; d++) {
      var dir = order[d];
      var base = baseOf(ctx, dir);
      var spot, s, away;
      if (opt.stack) {
        /* §4.1：换行（stack）是区间搜索之后的**次选**，只用于「对齐位置合法、只是被占」 */
        if (isSide(dir)) continue;
        if (!judgeAt(ctx, dir, base.left, base.top, { strictD: false, allowSelf: false })) continue;
        away = (dir === 'down') ? 1 : -1;
        for (s = 1; s <= tries; s++) {
          spot = judgeAt(ctx, dir, base.left, base.top + away * s * (ctx.h + TH.SHIFT_GAP), opt);
          if (spot) return spot;
        }
        continue;
      }
      spot = shiftSearch(ctx, dir, base, opt);
      if (spot) return spot;
    }
    return null;
  }

  return pass({ strictD: true, place: 'dir' })
    || pass({ strictD: true, place: 'stack', stack: true })
    || pass({ strictD: false, place: 'dir' })
    || (ctx.allowSelf ? pass({ strictD: false, place: 'self', allowSelf: true }) : null);
}

/* ============================ ② 判一条已观测的落点 ============================ */
/* obs: { box, dir, tailOff, tip, place }（全部来自渲染结果）
 * 返回 { ok, v: { Q1, Q5, Q4a, Q4b, B }, why: [...] }（v 里 true = 该判据成立） */
function check(obs, ctx) {
  var why = [];
  var k = ctx.k || 1;
  var tailH = TH.TAIL_H * k;
  var box = obs.box;

  /* Q1/G1：裁剪盒**单侧**外扩（尾巴只朝座位那一侧伸出，QA §1.7） */
  var q1 = box.left >= TH.MARGIN + (obs.dir === 'right' ? tailH : 0) - 0.5
    && box.right <= ctx.vw - TH.MARGIN - (obs.dir === 'left' ? tailH : 0) + 0.5
    && box.top >= TH.MARGIN + (obs.dir === 'down' ? tailH : 0) - 0.5
    && box.bottom <= ctx.vh - TH.MARGIN - (obs.dir === 'up' ? tailH : 0) + 0.5;
  if (!q1) why.push('Q1 裁剪盒出屏 ' + JSON.stringify(box));

  /* Q5/G8：--tail-off 必须等于 clamp(Ac_along − 边起点, m, L−m)（只判区间不够） */
  var span = isSide(obs.dir) ? (box.bottom - box.top) : (box.right - box.left);
  var m = Math.min(TH.RADIUS * k, span / 2);
  var start = isSide(obs.dir) ? box.top : box.left;
  var along = isSide(obs.dir) ? cy(ctx.avatar) : cx(ctx.avatar);
  var expect = clamp(along - start, m, span - m);
  var q5 = Math.abs(obs.tailOff - expect) <= 1;
  if (!q5) why.push('Q5 尾巴偏移 ' + obs.tailOff + ' ≠ 期望 ' + Math.round(expect * 10) / 10
    + '（区间 [' + m + ',' + (span - m) + ']）');

  /* B：短语与全部座位块 0 重叠（含锚点）；表情与非锚点块 0 重叠 */
  var bOk = true, i, others = ctx.others || [];
  for (i = 0; i < others.length; i++) if (overlapArea(box, others[i]) > 0) bOk = false;
  if (ctx.kind === 'phrase' && overlapArea(box, ctx.block) > 0) bOk = false;
  if (!bOk) why.push('B 压住座位块');

  /* Q4b：尖端在座位块 rect 外扩 gap + TAIL_H 内（弱判据，恒真才算「指人」）
   * Q4a：**两轴分解**（规格 §6 Q4a，v2.4 起 / v2.6 裁定 ①）
   *      轴一 沿贴合边对准头像中心：|尖端在该轴坐标 − 头像中心| ≤ 头像在该轴跨度的一半
   *      轴二 贴近块：尖端到座位块**朝向边**的距离 ≤ gap + TAIL_H
   *      旧式「尖端落进头像 rect 外扩区」给 down 设了不可能条件（头像在块顶部），
   *      v2.6 的裁定是**改判据函数**，不是改阈值、不是改分母。 */
  var pad = ctx.gap + tailH;
  var q4b = inside(obs.tip, expand(ctx.block, pad));
  var side = isSide(obs.dir);
  var acAlong = side ? cy(ctx.avatar) : cx(ctx.avatar);
  var tipAlong = side ? obs.tip.y : obs.tip.x;
  var avHalf = (side ? ctx.avatar.height : ctx.avatar.width) / 2;
  var axis1 = Math.abs(tipAlong - acAlong) <= avHalf + 0.5;
  var toward = (obs.dir === 'right') ? ctx.block.right : (obs.dir === 'left') ? ctx.block.left
    : (obs.dir === 'down') ? ctx.block.bottom : ctx.block.top;
  var axisDist = (obs.dir === 'right') ? (obs.tip.x - toward)
    : (obs.dir === 'left') ? (toward - obs.tip.x)
      : (obs.dir === 'down') ? (obs.tip.y - toward) : (toward - obs.tip.y);
  var axis2 = Math.abs(axisDist) <= pad + 0.5;
  var q4a = axis1 && axis2;
  if (!q4b) why.push('Q4b 尖端离开座位块外扩区（不指人）');
  if (!q4a) why.push('Q4a 尖端没瞄到脸（轴一 ' + axis1 + ' / 轴二 ' + Math.round(axisDist) + 'px）');

  /* Q10（§4.3 / §6）：兜底条数必须署名。obs.by 与 obs.nick 由调用方给（探针给真实昵称），
   * 只判「有署名」不够 —— 全写「对方」也能过，所以要求 by 的内容等于发送者昵称。 */
  var q10 = true;
  if (obs.nick !== undefined) {
    q10 = (obs.by || '').replace(/[：:]\s*$/, '').trim() === obs.nick;
    if (!q10) why.push('Q10 兜底未署名 / 署名与发送者不符（by=' + JSON.stringify(obs.by)
      + ' 应为 ' + JSON.stringify(obs.nick) + '）');
  }

  return {
    ok: q1 && q5 && bOk && q4b && q10,
    v: { Q1: q1, Q5: q5, B: bOk, Q4a: q4a, Q4b: q4b, Q10: q10 },
    why: why
  };
}

/* ============================ ③ 自验 ============================ */
function fixture(name, o) {
  var ctx = {
    vw: o.vw, vh: o.vh, k: o.k || 1,
    kind: o.kind || 'phrase',
    block: o.block, avatar: o.avatar,
    others: o.others || [], live: o.live || [], allSeats: o.allSeats,
    w: o.w, h: o.h,
    gap: (o.kind === 'emoji' ? TH.GAP_EMOJI : TH.GAP_PHRASE) * (o.k || 1),
    allowSelf: o.kind === 'emoji'
  };
  return { name: name, ctx: ctx, want: o.want || {} };
}

/* --- 样本几何（手算，不来自被测页面） ---
 * F0：390×844 手机，上排座位 + 长短语（9 字折行后顶到上限宽 324）。上一版的病灶正是
 *     这一格：固定从「右」开始试、四方向全废 → 兜底到桌下方，尾巴离人 211px。
 *     v2.2 的「内推优先」应让它选「下」。
 * F1：1366 桌面、中间高度的座位，内推 = 左。
 * F2：320 窄屏、最左座位，内推 = 右（顺带是 Q4a 的正样本：块窄、头像贴边）。 */
var SEAT_TOP_L = rect(40, 60, 130, 130), AV_TOP_L = rect(60, 64, 96, 100);
var SEAT_TOP_R = rect(260, 60, 350, 130);
var SEAT_ME = rect(150, 700, 240, 780);
var SEAT_DESK = rect(470, 300, 528, 370), AV_DESK = rect(490, 304, 526, 340);
var SEAT_320 = rect(10, 90, 74, 160), AV_320 = rect(30, 94, 62, 126);

var FIX = [
  fixture('390 上排左 · 长短语 324×64（旧版走兜底，应选「下」）', {
    vw: 390, vh: 844, block: SEAT_TOP_L, avatar: AV_TOP_L,
    others: [SEAT_TOP_R, SEAT_ME], allSeats: [SEAT_TOP_L, SEAT_TOP_R, SEAT_ME],
    w: 324, h: 64,
    want: { dir: 'down', place: 'dir', passes: ['Q1', 'Q5', 'Q4b'] }
  }),
  fixture('1366 桌面中间座位 · 短短语 120×40（内推 = 左）', {
    vw: 1366, vh: 768, k: 1.2, block: SEAT_DESK, avatar: AV_DESK,
    others: [rect(60, 300, 118, 370), rect(200, 300, 258, 370), rect(600, 600, 658, 672)],
    allSeats: [SEAT_DESK, rect(60, 300, 118, 370), rect(200, 300, 258, 370), rect(600, 600, 658, 672)],
    w: 120, h: 40,
    want: { dir: 'left', place: 'dir', passes: ['Q1', 'Q5', 'Q4b'] }
  }),
  fixture('320 最左座位 · 表情 64×64（内推 = 右）', {
    vw: 320, vh: 568, block: SEAT_320, avatar: AV_320,
    others: [rect(246, 90, 310, 160), rect(60, 170, 124, 240)],
    allSeats: [SEAT_320, rect(246, 90, 310, 160), rect(60, 170, 124, 240)],
    w: 64, h: 64, kind: 'emoji',
    want: { dir: 'right', place: 'dir', passes: ['Q1', 'Q5', 'Q4a', 'Q4b'] }
  })
];

/* 该判红的样本（尺子必须在这些样本上说「不行」） */
var NEG = [
  {
    name: '裁剪盒出屏：气泡距左边 4px（MARGIN 是 8）',
    ctx: FIX[1].ctx,
    obs: { box: rect(4, 300, 124, 340), dir: 'left', tailOff: 20, tip: { x: 132, y: 320 }, place: 'dir' },
    mustFail: 'Q1'
  },
  {
    name: '尾巴压到圆角外面：off=6，m=min(18,40/2)=18',
    ctx: FIX[1].ctx,
    obs: { box: rect(200, 300, 320, 340), dir: 'left', tailOff: 6, tip: { x: 180, y: 306 }, place: 'dir' },
    mustFail: 'Q5'
  },
  {
    name: '尾巴指飞了：尖端离开座位块 60px 以上',
    ctx: FIX[1].ctx,
    obs: { box: rect(200, 300, 320, 340), dir: 'left', tailOff: 20, tip: { x: 900, y: 600 }, place: 'fallback' },
    mustFail: 'Q4b'
  }
];

function runSelfTest(verbose, quiet) {
  var pass = 0, fail = 0;
  function say(s) { if (!quiet) console.log(s); }
  function ok(c, m, extra) {
    if (c) { pass++; say('  ✓ ' + m); }
    else { fail++; say('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
  }

  say('\n[A] 正样本：复算落点 + 判定必须同时成立');
  FIX.forEach(function (f) {
    var got = place(f.ctx);
    var label = f.name;
    if (!got) { ok(false, label + ' → 复算无解', 'place() 返回 null'); return; }
    ok(got.dir === f.want.dir,
      label + ' → dir=' + got.dir + (got.dir === f.want.dir ? '' : '（期望 ' + f.want.dir + '）'));
    ok(got.place === f.want.place,
      '     place=' + got.place + (got.place === f.want.place ? '' : '（期望 ' + f.want.place + '）'));
    var t = tailOf(f.ctx, got.dir, got.left, got.top);
    var res = check({
      box: t.box, dir: got.dir, tailOff: Math.round(got.tailOff * 100) / 100, tip: t.tip, place: got.place
    }, f.ctx);
    (f.want.passes || []).forEach(function (key) {
      ok(res.v[key] === true, '     ' + key + ' 成立' + (key === 'Q4a' ? '' : ''),
        res.why.join(' / '));
    });
    if (verbose) say('      box=' + JSON.stringify(t.box) + ' tip=' + JSON.stringify(t.tip)
      + ' off=' + got.tailOff + ' m=' + t.m + ' span=' + t.span);
  });

  say('\n[B] 负样本：这些必须**判红**（否则尺子没有否决权）');
  NEG.forEach(function (n) {
    var res = check(n.obs, n.ctx);
    ok(res.v[n.mustFail] === false, n.name + ' → ' + n.mustFail + ' 判红',
      JSON.stringify(res.v));
    ok(!res.ok, '     整条结论为「不通过」', JSON.stringify(res.why));
  });

  say('\n[C] 阈值敏感度：把阈值改坏，对应样本的结论必须翻转');
  {
    /* ① MARGIN 8 → 2：4px 出屏的那条会从「红」变「绿」→ 说明 MARGIN 真的在守 */
    var obsA = { box: rect(4, 300, 124, 340), dir: 'left', tailOff: 20, tip: { x: 132, y: 320 }, place: 'dir' };
    var before = check(obsA, FIX[1].ctx).v.Q1;
    var bak = TH.MARGIN; TH.MARGIN = 2;
    var after = check(obsA, FIX[1].ctx).v.Q1;
    TH.MARGIN = bak;
    ok(before === false && after === true, '① MARGIN 8→2 时「距边 4px」从判红变判绿（值真的生效）',
      before + ' → ' + after);

    /* ② 圆角 18 → 6：期望值从 clamp(22, 20, 20) = 20 变成 clamp(22, 7.2, 32.8) = 22，
     *    于是 off=20 从「绿」变「红」—— 说明 m 与 clamp 期望值真的在算，不是写着好看 */
    var obsB = { box: rect(200, 300, 320, 340), dir: 'left', tailOff: 20, tip: { x: 180, y: 306 }, place: 'dir' };
    var b1 = check(obsB, FIX[1].ctx).v.Q5;
    var bakR = TH.RADIUS; TH.RADIUS = 6;
    var b2 = check(obsB, FIX[1].ctx).v.Q5;
    TH.RADIUS = bakR;
    ok(b1 === true && b2 === false, '② 圆角 18→6 时「off=20」从判绿变判红（m = min(18k, L/2) 真的生效）',
      b1 + ' → ' + b2);

    /* ③ 尾巴外扩 TAIL_H 8 → 80：远处那条从「红」变「绿」 */
    var obsC = { box: rect(200, 300, 320, 340), dir: 'left', tailOff: 20, tip: { x: 900, y: 600 }, place: 'fallback' };
    var c1 = check(obsC, FIX[1].ctx).v.Q4b;
    var bakH = TH.TAIL_H; TH.TAIL_H = 2000;
    var c2 = check(obsC, FIX[1].ctx).v.Q4b;
    TH.TAIL_H = bakH;
    ok(c1 === false && c2 === true, '③ TAIL_H 8→2000 时「尖端飞 60px」从判红变判绿（外扩量真的进判据）',
      c1 + ' → ' + c2);
  }

  say('\n[D] 复算与规格口径对齐的自检');
  {
    var f = FIX[0];
    var o = dirOrder(f.ctx);
    ok(o.inward === 'down', '390 上排座位的内推方向 = 下（朝桌心），不是固定从「右」开始', o.inward);
    ok(o.order[0] === 'down' && o.order.length === 4, '内推方向排在第一位，其余三个都在（' + o.order.join(',') + '）');
    var space = availableSpace(f.ctx, 'down');
    ok(space > 0, '「下」方向的可用空间 cap = ' + Math.round(space) + 'px（环形布局里朝桌心最宽）');
    var capR = availableSpace(f.ctx, 'right');
    ok(space > capR, 'cap(down) ' + Math.round(space) + ' > cap(right) ' + Math.round(capR)
      + '（所以「其余按空间降序」会把 down 排在 right 前面）');

    /* ★ 把 v2.6 裁定 ① 固化成断言：同一几何下 dir=down 的尖端
     *   「旧式矩形外扩」判红、**两轴分解**判绿。这就是「不改阈值、不改分母、改判据函数」
     *   的全部含义 —— 头像在座位块**顶部**，挂在下方的尖端纵向永远越出外扩区，
     *   旧式口径给「下」设了不可能条件（390 上排两格因此恒为 3/5）。 */
    var ctxD = f.ctx;
    var tD = tailOf(ctxD, 'down', 16, 140);
    var padD = ctxD.gap + tD.len;
    var oldStyle = inside(tD.tip, expand(ctxD.avatar, padD));
    var rD = check({ box: tD.box, dir: 'down', tailOff: tD.off, tip: tD.tip, place: 'dir' }, ctxD);
    ok(oldStyle === false && rD.v.Q4a === true,
      '同一几何（down，尖端 ' + tD.tip.x + ',' + tD.tip.y + '）：旧式「头像 rect 外扩」判红、'
      + '两轴分解判绿 → 门槛换的是**判据函数**（v2.6 裁定 ①）',
      'old=' + oldStyle + ' new=' + rD.v.Q4a + ' ' + rD.why.join('/'));
    ok(rD.v.Q4b === true, '     同一几何的 Q4b（碰块）另有成立 —— 两条判据不是同一条', JSON.stringify(rD.v));

    /* 轴一真的在守：同一 down 气泡，尖端沿贴合边偏出头像跨度 → 判红。
     * （轴二仍然成立 —— 说明两轴是**分开**算的，不是合成一个矩形。） */
    var tipOff = { x: 140, y: tD.tip.y };
    var rOff = check({ box: tD.box, dir: 'down', tailOff: tD.off, tip: tipOff, place: 'dir' }, ctxD);
    ok(rOff.v.Q4a === false && rOff.v.Q4b === true,
      '尖端横移到 x=140（偏出头像跨度）→ 轴一判红、Q4b 仍成立（两轴独立）',
      JSON.stringify(rOff.v));
  }

  say('\n自验：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  /* 返回结构化结论：npm test 那边要数「跑了几条」，不能只看一个 true。
   * 一个只会说「我绿了」的自验，和没有自验一样 —— 它从没被证明过会红（[B]/[C] 就是那条证明）。 */
  return { ok: fail === 0, pass: pass, fail: fail };
}

module.exports = {
  TH: TH,
  rect: rect,
  fromDom: fromDom,
  expand: expand,
  inside: inside,
  overlapArea: overlapArea,
  availableSpace: availableSpace,
  inwardDir: inwardDir,
  dirOrder: dirOrder,
  baseOf: baseOf,
  tailOf: tailOf,
  place: place,
  placeOrder: dirOrder,
  check: check,
  fixtures: FIX,
  negatives: NEG,
  runSelfTest: runSelfTest
};

if (require.main === module) {
  var verbose = process.argv.indexOf('--verbose') >= 0;
  var r = runSelfTest(verbose);
  process.exitCode = r.ok ? 0 : 1;
}
