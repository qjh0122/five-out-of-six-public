/**
 * 表情 / 短语的**跨设备尺寸与落点**
 * 跑法：node pwa/test/emoji-scale.test.js
 *
 * 这个文件守的是 2026-11-14 那两个 bug，它们都属于「单测全绿、真机上不对」：
 *
 * 1. **尺寸写死 CSS px**。#emoji-layer 是 fixed 全屏、不在 #stage 里，拿不到那圈
 *    transform: scale()。座位头像在手机竖屏是 35、电脑窗口是 57，而气泡一直是
 *    64 / 24 号字 —— 电脑上就变成「表情比头像还小、短语比座位名还小」。
 * 2. **落点正中对齐座位**。气泡中心 = 座位中心，于是短语气泡正好糊住对方头像，
 *    连名字一起挡掉。
 *
 * 静态断言能守的只有「代码长这样」，真正的像素与遮挡由 scripts/probe-emoji.js
 * 用真浏览器在 390×844 / 844×390 / 1366×768 / 1920×1080 四档量。
 * 这里守的是「别有人把 var(--emo-k) 改回写死的数字」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments, parseBlocks } = require('../../scripts/lib/css-blocks');

const ROOT = path.join(__dirname, '..');
const cssRaw = fs.readFileSync(path.join(ROOT, 'css', 'emoji.css'), 'utf8');
const css = stripComments(cssRaw);
const jsRaw = fs.readFileSync(path.join(ROOT, 'js', 'seatSheetView.js'), 'utf8');
const js = stripComments(jsRaw);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function rule(sel) {
  const b = parseBlocks(css).filter((x) => x.selector.replace(/\s+/g, ' ') === sel);
  return b.length ? b[b.length - 1].body : '';
}

console.log('\n[1] 尺寸必须跟着 --emo-k 走');
{
  const fly = rule('.emoji-fly');
  ok(/width:\s*calc\(64px \* var\(--emo-k/.test(fly), '★ 表情直径 = 64px × --emo-k（不是写死 64px）', fly.slice(0, 120));
  ok(/height:\s*calc\(64px \* var\(--emo-k/.test(fly), '表情高度同步缩放（长宽必须同源，否则会变椭圆）');

  const ph = rule('.emoji-fly.is-phrase .emoji-pop');
  ok(/font-size:\s*calc\(24px \* var\(--emo-k/.test(ph), '★ 短语字号 = 24px × --emo-k（用户报的就是这一条）', ph.slice(0, 160));
  ok(/padding:\s*calc\(10px \* var\(--emo-k/.test(ph), '内边距同步（只放大字号会让气泡显得挤）');
  ok(/border-radius:\s*calc\(18px \* var\(--emo-k/.test(ph), '圆角同步（不同步会变成「字很大、角很尖」）');

  const wrap = rule('.emoji-fly.is-phrase');
  ok(/max-width:\s*min\(calc\(460px \* var\(--emo-k/.test(wrap),
    '★ 宽度上限同步放大，且再与「视口宽 - 24」取小（320 档不会顶出屏幕）', wrap.slice(0, 160));
  const popRule = rule('.emoji-fly.is-phrase .emoji-pop');
  ok(/white-space:\s*normal/.test(popRule),
    '★ 允许折行（只在视口上限真的压下来时触发；换成 overflow:hidden 会截断句子）');
}

console.log('\n[2] 不许退回写死的尺寸');
{
  ok(!/^\.emoji-fly \{[^}]*width:\s*64px;/m.test(css), '★ .emoji-fly 不再有裸 width: 64px');
  ok(!/is-phrase \.emoji-pop \{[^}]*font-size:\s*24px;/m.test(css), '★ 短语气泡不再有裸 font-size: 24px');
}

console.log('\n[3] --emo-k 由舞台缩放反算');
{
  ok(/function stageScale\(\)/.test(js), '有 stageScale()');
  const body = js.slice(js.indexOf('function stageScale()'));
  ok(/getComputedStyle\(st\)\.transform/.test(body.slice(0, 400)), '读的是 #stage 的 computed transform（竖版 --pt-scale、横版 --ls-scale 都落在这里）');
  ok(/matrix/.test(body.slice(0, 400)), '按 matrix 取比例（不猜变量名）');
  ok(/Math\.max\(1,\s*Math\.min\(1\.5,\s*stageScale\(\)\s*\/\s*0\.52\)\)/.test(js),
    '★ k = clamp(舞台缩放 / 0.52, 1, 1.5)：只放大不缩小，且封顶（桌面不再随舞台无界放大）');
  ok(!/Math\.max\(1,\s*stageScale\(\)\s*\/\s*0\.52\)/.test(js),
    '★ 旧的无上限公式已消失（否则 1920 会把短语顶到 54px，是座位名的 2.25 倍）');
  ok(/setProperty\('--emo-k',\s*k\)/.test(js), '把 k 写进外层节点的 --emo-k');

  /* 顺序是硬要求：量的是「此刻的尺寸」，--emo-k 晚一步写进去，
   * 量到的就是上一版的 64 / 50，落点跟着偏。 */
  const setAt = js.indexOf("setProperty('--emo-k'");
  const measureAt = js.indexOf('var sz = wrapSize();');
  ok(setAt > 0 && measureAt > setAt, '★ 先写 --emo-k、后量尺寸（写反了量到旧尺寸）',
    'set=' + setAt + ' measure=' + measureAt);
  /* 尺寸来源必须是**小数点**尺寸：offsetWidth/offsetHeight 是整数，
   * 1920 档 k=2.27 时表情实际 145.27 只量到 145，规划用整数、渲染是小数，
   * 0.27px 就让「刚好让开」变成 29px² 的重叠（Q6 实测红过）。 */
  ok(/var r = wrap\.getBoundingClientRect\(\);/.test(js) && /r\.width \|\| wrap\.offsetWidth/.test(js),
    '★ 尺寸用 getBoundingClientRect 的小数宽高，不用 offsetWidth（整数会在高 k 档漏 0.27px）');
  ok(!/var w = wrap\.offsetWidth/.test(js) && !/w = wrap\.offsetWidth \|\| w/.test(js),
    '★ 两处测量（首测 / 署名后复测）都走同一个 wrapSize()，不会一处整数一处小数');
}

console.log('\n[4] 落点：四方向择优 + 指向锚点的尾巴（v2 规格 §2/§3）');
{
  /* v1 的「底边贴座位上方 + 居中 + 夹取 + 逐头像下推」已被 v2 取代
   * （docs/ui-emoji-placement-v2.md）。这一段随之改写 —— 断言跟着规格走，
   * 不是跟着老代码走；真正的几何由 scripts/probe-emoji.js 的 Q0~Q8 在真浏览器量。
   * v2.2 又改了方向顺序与 Q4 判据（规格 §2 / §9），这里同步。 */
  ok(/function inwardDir\(/.test(js) && /seatBoxes\(null\)/.test(js),
    '★ 方向顺序改成现场排序：内推 = 本块中心指向「全部 [data-pid] 块重心」（规格 §2 第 1 级）');
  ok(/function availableSpace\(dir\)/.test(js) && /rest\.sort\(/.test(js) && /\[inw\]\.concat\(rest\)/.test(js),
    '★ 其余三个方向按可用空间降序（规格 §2 第 2 级），内推永远排第一');
  ok(!/var DIRS = \['right', 'left', 'up', 'down'\]/.test(js),
    '★ 固定顺序「右→左→上→下」已作废（v2.2 之前就是它把上排座位逼进兜底链的）');
  ok(/var MARGIN = 8;/.test(js), '★ 视口安全边 MARGIN = 8，且不乘 k（规格 §3）');

  ok(/ab\.right \+ gap/.test(js) && /ab\.left - gap - w/.test(js),
    '右/左：气泡边贴座位块外侧留 gap，垂直以头像中心对齐');
  ok(/ab\.top - gap - h/.test(js) && /ab\.bottom \+ gap/.test(js),
    '上/下：气泡底/顶边贴座位块留 gap，水平以头像中心对齐');

  ok(/var loX = MARGIN \+ \(dir === 'right' \? tailLen : 0\)/.test(js)
    && /var hiY = vh - MARGIN - \(dir === 'up' \? tailLen : 0\) - h/.test(js),
    '★ 约束 A：裁剪盒**单侧**外扩（尾巴只朝座位那侧伸出；四边外扩在 320/390 数学不可行）');
  ok(/hitsAny\(box, others\)/.test(js) && /overlapArea\(box, ab\) > 0/.test(js),
    '★ 约束 B：不压任何别的座位块，也不压锚点自己（表情的末位保底除外）');
  ok(/var tailPad = gap \+ tailLen;/.test(js) && /tipX < ab\.left - tailPad/.test(js),
    '★ 约束 C 用 Q4b：尖端落在座位块 rect 外扩 (gap + TAIL_H) 内（规格 §6 Q4b）');
  ok(!/var reach = avR/.test(js),
    '★ 旧的「离头像中心 ≤ 半径 + gap + 8」判据已删（它给「下」方向设了不可能条件，规格 §9 裁定 c）');
  ok(/var TAIL_R_DESIGN = 18;/.test(js) && /var m = Math\.min\(Math\.round\(TAIL_R_DESIGN \* k\), span \/ 2\);/.test(js)
    && /clampNum\(base\.vert \? \(acy - top\) : \(acx - left\), m, span - m\)/.test(js),
    '★ 尾巴沿贴合边对齐头像中心，夹在 [m, L−m]，m = min(18k, L/2)（规格 §2 约束 C 唯一出处）');
  ok(!/TAIL_D_PAD/.test(js), '★ 旧的 tailPad = 12k 常量已删（v2.1 的 12×k / 12 两套口径都作废）');
  ok(/hitsAny\(box, live\)/.test(js) && /var SHIFT_TRIES = 3;/.test(js),
    '★ 约束 D：不与存活气泡相交，让位次数上限仍在（规格 §4）');
  ok(!/needTail/.test(js) && !/window\.__tv/.test(js),
    '★ 「尾巴放不下 → 放弃该方向」整段已删（规格 §2 约束 C：C 是夹取规则不是否决条件，'
    + 'm ≤ L/2 恒成立 ⇒ 该否决理由在数学上不存在；它实测误杀过 390 档 41 次方向）');
  ok(/function shiftSearch\(dir, base, opt\)/.test(js)
    && /cands\.sort\(/.test(js) && /return d !== 0 \? d : \(a - b\);/.test(js),
    '★ 让位改区间搜索（规格 §4.1）：穷举可行域边界，取**位移最小**的解，不再用「自身边长 + 6」粗步长');
  ok(/var cap = \(span \/ 2 - m\) \+ acHalf;/.test(js) && /> acHalf \+ 0\.5\) continue;/.test(js),
    '★ 位移上限由尾巴决定：尖端必须仍落在头像跨度内（气泡可以滑，尾巴不能撒谎）');
  ok(/var reach = !\(tipX < ab\.left - tailPad/.test(js) && /reach: reach/.test(js),
    '★ Q4b 只记录成 reach（触发兜底署名），不再否决方向（规格 §2 v2.5 / §4.3）');
  ok(/return runPass\(\{ strictD: true, place: 'dir' \}\)/.test(js)
    && /place: 'stack', stack: true/.test(js)
    && /place: 'self', allowSelf: true/.test(js),
    '★ 四轮降级：A/B/D 全满足 → 换一行 → 接受重叠 → 表情可压自己的座位');
  ok(/if \(!spot\.reach\) \{/.test(js) && /className = 'emoji-by'/.test(js)
    && /senderName\(ev\.from\)/.test(js),
    '★ 兜底署名（规格 §4.3）：Q4b 不成立时加 .emoji-by，昵称按 ev.from 取');
  ok(/p && p\.nickname \? String\(p\.nickname\) : ''/.test(js) && /return n \|\| '对方';/.test(js),
    '★ 昵称从 state.room.players 取，取不到用「对方」（不能空着 —— 空着就是「不指人且不署名」）');

  ok(/function fallbackSpot\(/.test(js), '★ 四方向全废时仍有兜底链（保证不丢内容）');
  ok(/guard < 6; guard\+\+/.test(js) && /= low \+ gap;/.test(js),
    '★ 兜底：逐座位块下推（躲整块，不只躲头像 —— 否则会压在别人名字上）');
  ok(/hitsAny\(cb, live\)/.test(js),
    '★ 兜底也要躲存活气泡（5 人同时发时，兜底那条会落在别人占住的那一行上）');

  ok(/setAttribute\('data-dir', spot\.dir\)/.test(js) && /setProperty\('--tail-off'/.test(js),
    '★ 方向写外层 data-dir、位置写 --tail-off（CSS 只负责长相，JS 只负责几何）');
  ok(/__land = \{ left: tx, top: ty/.test(js),
    '★ 落点矩形记在节点上：判断「会不会压住上一条」用落点，不用飞行途中的 rect');

  const tail = rule('.emoji-fly::after');
  ok(/content:/.test(tail) && /#FFFBF0/.test(tail), '尾巴 ::after 是实心三角，与气泡同色', tail.slice(0, 120));
  ['right', 'left', 'up', 'down'].forEach((d) => {
    const r = rule('.emoji-fly[data-dir="' + d + '"]::after');
    ok(/clip-path:/.test(r), '★ data-dir="' + d + '" 有三角（clip-path）', r.slice(0, 140));
  });
  ok(/--tail-len: calc\(8px \* var\(--emo-k/.test(rule('.emoji-fly'))
    && /--tail-w: calc\(12px \* var\(--emo-k/.test(rule('.emoji-fly')),
    '尾巴尺寸 8×12 也乘 --emo-k（不跟着放大就会在大屏上变成一根牙签）');

  ok(/filter: drop-shadow/.test(rule('.emoji-fly.is-phrase')),
    '★ 阴影挂外层用 filter: drop-shadow（box-shadow 不会跟着三角形走，尾巴会像贴上去的）');
  ok(!/box-shadow/.test(rule('.emoji-fly.is-phrase .emoji-pop')),
    '★ 内层气泡不再有 box-shadow（否则矩形阴影与三角阴影各画各的）');

  /* 兜底署名（规格 §4.3）：短语 0.8× 正文 + 70% 不透明度；表情 0.7× 基准字号、居中 */
  const by = rule('.emoji-fly .emoji-by'), byEmo = rule('.emoji-fly.has-by .emoji-by');
  ok(/font-size: calc\(19\.2px \* var\(--emo-k/.test(by) && /opacity: 0\.7/.test(by),
    '★ 短语署名 0.8 × 正文 24 = 19.2 设计 px、70% 不透明度（规格 §4.3）', by.slice(0, 160));
  ok(/font-size: calc\(16\.8px \* var\(--emo-k/.test(byEmo) && /text-align: center/.test(byEmo),
    '★ 表情署名 0.7 × 基准字号 24 = 16.8 设计 px、居中（规格 §4.3）', byEmo.slice(0, 220));
  ok(/display: flex/.test(rule('.emoji-fly.has-by')),
    '★ 表情署名排在图的**下方**：外层从定宽改成纵向 flex，否则小字会溢出、压到邻居（Q2）',
    rule('.emoji-fly.has-by').slice(0, 160));
}

console.log('\n[5] 起点的写法没被顺手改坏');
{
  ok(/var fx = fromR\.left \+ fromR\.width \/ 2 - w \/ 2;/.test(js), '起点仍是发言人座位居中（飞出去的那一下）');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
