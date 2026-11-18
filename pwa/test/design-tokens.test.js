/**
 * 设计令牌守（v134 · B1）
 *
 * 背景：UI 审计量出来的数字是——100 个 hex、188 处裸写颜色（token 采用率 65%）、
 * 33 档字号、**71 种 box-shadow**、39 个卡片类、7 档动效。
 *
 * 这不是审美问题，是**没有语法**：每屏都还行，串起来不像一个应用。
 * 而 71 种阴影的本质是「71 个光源」——现实里物体被同一个光照亮，
 * 投影应随高度连续变化；71 个答案让大脑读不出「谁在谁上面」。
 *
 * 本文件先钉最基础的一条：**外投影只能来自标尺（--elev-1/2/3）**。
 * 造型类的阴影不在此列，而且必须讲清楚为什么：
 *   · `0 2px 0 <色>` = 实体按钮的下沿（造型，不是高度；并进 elevation 会把按钮压平）
 *   · `0 0 Npx <色>` = 状态发光/环（表达状态，不表达高度）
 *   · `inset ...`     = 内描边 / 内高光 / 左侧色条（边缘与标记）
 *
 * 判据的写法刻意做成「分类器 + 自测 + 真文件」三段：
 * 只有分类器自测过了，「真文件零违规」才说明问题；否则它可能只是因为规则永远不匹配。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'css');
const FILES = ['style.css', 'records.css', 'emoji.css', 'flex-gap-fallback.css'];

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) pass++;
  else fail++;
  ASSERT.log(ok, c, m, extra);
}
function eq(a, b, m, extra) {
  if (a === b) pass++;
  else fail++;
  ASSERT.log(eq, a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

function readAll() {
  const out = {};
  for (const f of FILES) {
    try { out[f] = fs.readFileSync(path.join(CSS_DIR, f), 'utf8'); } catch (e) { out[f] = ''; }
  }
  return out;
}

/** 取所有 box-shadow 的声明值（跨行也算一条；注释先抹掉，注释里的例子不是违规） */
function shadows(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /box-shadow\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(flat))) out.push(m[1].trim().replace(/\s+/g, ' '));
  return out;
}

/**
 * 按顶层逗号切层：`rgba(0, 0, 0, .3), inset 0 1px 0 #fff` → 两层。
 * 不能直接 split(',')——颜色函数自己的逗号会把一层切碎，
 * 之前正是这个 bug 让 `0 8px 22px rgba(0,0,0,.34)` 被判成「非投影」而漏放。
 */
function layers(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 带色氛围投影：表达「状态 / 氛围」，不是「离桌面多高」，不进 elevation 标尺。
 * 必须**按字面值**列出而不是按颜色通配 —— 通配会把未来的裸黑投影也一起放过去。
 * 三处均在 style.css：.slot-point.best（绿）/ .card-wrap.selected .card（金）/ .av-cell.is-on（金）。
 * 下方 [6] 还会断言这三条仍在 CSS 里，防止豁免变成永远命中的死白名单。
 */
const ATMOSPHERE = [
  '0 4px 12px rgba(67, 209, 124, 0.24)',
  '0 12px 24px rgba(245, 193, 92, 0.45)',
  '0 4px 12px rgba(245, 193, 92, 0.35)'
];

/**
 * 分类：**逐层**判定，任一层是裸外投影即违规（P0-4）。
 * 原先只看 layers(v)[0]，于是「inset 描边 + 裸投影」「状态环 + 裸投影」全部漏检，
 * 静态断言的「外投影字面量 = 0」只是在分类器盲区下成立。
 *
 * 显式豁免（造型，不是高度；改这里必须写理由）：
 *   · `var(--elev-*)` / `var(--edge-*)` —— 已归位的高度 / 纸边；
 *   · `inset ...`                     —— 内描边 / 内高光 / 左色条；
 *   · y=0（`0 0 Npx`）                 —— 四向状态发光 / 环；
 *   · blur=0（`0 2px 0 <色>`）          —— 实体按钮下沿；
 *   · ATMOSPHERE 里三条带色氛围投影      —— 见上面的注释。
 */
function layerIsElevation(layer) {
  if (!layer) return false;
  const v = layer.trim();
  if (/^var\(--(elev-|edge-)/.test(v)) return false;
  if (/^inset\b/.test(v)) return false;
  if (ATMOSPHERE.indexOf(v) >= 0) return false;
  const parts = v.split(/\s+/);
  const num = (s) => (s === undefined ? NaN : parseFloat(s));
  if (num(parts[0]) !== 0) return false;              // x 偏移不为 0（发光/斜影）不按高度管
  if (!(num(parts[1]) > 0)) return false;             // y=0 → 四向光环
  if (!(num(parts[2]) > 0)) return false;             // blur=0 → 实体按钮下沿
  return true;
}
function isElevation(v) {
  return !!v && layers(v).some(layerIsElevation);
}

/* =================== [1] 光的三档：令牌定义齐全 =================== */
head('[1] 标尺本身');
{
  const style = readAll()['style.css'];
  for (const t of ['--elev-1', '--elev-2', '--elev-3', '--edge-hairline', '--edge-top', '--edge-paper', '--elev-paper']) {
    ok(new RegExp('\\' + t + '\\s*:').test(style), '定义了 ' + t);
  }
  /* 三档必须是递进的关系：模糊半径与不透明度都随高度增大。
   * 这条防的是「三档写了但写得一样」——那种情况下"统一"只是把 71 个换成了 3 个同值。 */
  const val = (t) => {
    const m = new RegExp('\\' + t + '\\s*:\\s*([^;]+);').exec(style);
    return m ? m[1] : '';
  };
  const blurOf = (s) => {
    const m = /0\s+(\d+)px\s+(\d+)px/.exec(s.split(',')[0]);
    return m ? Number(m[2]) : -1;
  };
  const b1 = blurOf(val('--elev-1')), b2 = blurOf(val('--elev-2')), b3 = blurOf(val('--elev-3'));
  ok(b1 > 0 && b2 > b1 && b3 > b2, '★ 三档模糊半径严格递增（' + b1 + ' < ' + b2 + ' < ' + b3 + '）');
  /* 自引用守卫：`--elev-1: 0 2px 6px ..., var(--elev-1)` 是循环引用，
   * 浏览器会把整条声明判为无效 → 元素**完全没有阴影**，但源码里看着「有写」。
   * 这种错只有跑起来才看得见，源码评审 100% 漏掉，所以钉死在这里。 */
  const cyc = ['--elev-1', '--elev-2', '--elev-3', '--elev-paper', '--edge-paper'].filter(
    (t) => new RegExp('var\\(' + t + '\\)').test(val(t))
  );
  eq(cyc.length, 0, '★★ 令牌不引用自己（循环引用会让整条声明被丢弃）', cyc.join(','));
}

/* =================== [2] 分类器自测：三个方向都要对 =================== */
head('[2] 分类器自测（不测这个，「零违规」就没有意义）');
{
  ok(isElevation('0 8px 22px rgba(0, 0, 0, 0.34)'), '外投影 → 该判（真阳性）');
  ok(isElevation('0 8px 20px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.12)'),
    '外投影 + 内高光 → 整体算外投影（第一层是投影）');
  ok(!isElevation('var(--elev-2)'), '已经是令牌 → 不判');
  ok(!isElevation('0 2px 0 #B47F22'), '★ 实体按钮下沿（blur=0）→ 不判（这是造型）');
  ok(!isElevation('0 0 16px rgba(245, 193, 92, 0.5)'), '★ 状态发光（y=0）→ 不判');
  ok(!isElevation('0 0 16px rgba(245, 193, 92, 0.5), var(--elev-2)'),
    '★ 光环 + 已归位的高度 → 不判（逐层都过不了外投影特征）');
  ok(!isElevation('0 0 10px rgba(67, 209, 124, 0.22), inset 0 -6px 10px rgba(0, 0, 0, 0.20)'),
    '★ 光环 + 内影 → 不判');
  ok(!isElevation('var(--elev-1), var(--edge-hairline)'), '★ 组合 token（高度 + 纸边）→ 不判');
  ok(!isElevation('inset 0 1px 0 rgba(255, 255, 255, 0.07), var(--elev-1)'),
    '★ inset 在前 + 令牌在后 → 不判');
  ok(!isElevation('0 0 0 4px var(--slot-color), var(--elev-2)'), '★ 状态环在前 + 令牌在后 → 不判');
  ok(!isElevation('inset 0 0 0 1px rgba(67, 209, 124, 0.55), ' + ATMOSPHERE[0]),
    '★ 状态边 + 带色氛围投影 → 显式豁免');
  ok(isElevation('inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 10px 24px rgba(0, 0, 0, 0.4)'),
    '★★ inset 在前、裸投影在第 2 层 → 必须判违规（旧分类器在这里是瞎的）');
  ok(isElevation('0 0 0 3px var(--gold), 0 12px 30px rgba(0, 0, 0, 0.42)'),
    '★★ 状态环在前、裸投影在第 2 层 → 必须判违规');
  ok(isElevation('inset 0 3px 30px rgba(0, 0, 0, 0.52), inset 0 -18px 44px rgba(0, 0, 0, 0.30), 0 18px 46px rgba(0, 0, 0, 0.34)'),
    '★★ 裸投影在第 3 层 → 必须判违规');
  ok(isElevation('0 4px 18px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)'),
    '★ 颜色里的逗号不能把一层切碎（回归：曾被 split(",") 误判）');
  ok(!isElevation('inset 0 1px 0 rgba(255, 255, 255, 0.45)'), '内高光 → 不判');
  ok(!isElevation('none'), 'none → 不判');
}

/* =================== [3] 真文件：外投影零字面量 =================== */
head('[3] 真文件');
const css = readAll();
{
  const bad = [];
  let total = 0;
  for (const f of Object.keys(css)) {
    for (const v of shadows(css[f])) {
      total += 1;
      if (isElevation(v)) bad.push(f + ': ' + v);
    }
  }
  ok(total >= 60, '一共扫到 ' + total + ' 条 box-shadow 声明（太少说明解析坏了）');
  eq(bad.length, 0, '★★ 没有一条外投影是手写字面量（全部来自 --elev-*）', bad.slice(0, 4).join(' | '));
}

/* =================== [4] 种类上限：只准减 =================== */
head('[4] 阴影种类不回升');
{
  const set = new Set();
  for (const f of Object.keys(css)) for (const v of shadows(css[f])) set.add(v);
  /* 这个数是 v134 的实测基线（113 条声明 / 83 种）。它包含外投影 3 档 +
   * 内描边 / 状态环 / 色条 / 按钮下沿等**造型**——造型本来就该按场景不同。
   * 所以这条不是「种类越少越美」，而是**只准减**：
   * 想加一个新的阴影写法，先找找能不能复用现有的；真不能，就把数字往上调并在提交里说明为什么。
   * 卡死不放到 88 那种「留余量」，是因为余量会立刻被吃掉。
   *
   * v136 → 84：新增的 `#undo-bar` 是「浮起 + 金色发丝边」的组合，现有三种 elevation
   * 都不能表达（内容卡没有边、弹窗是暖白纸、浮层是菜单）。这是**真需要**而不是随手调，
   * 所以基线加一；下一次要加，同样得在这里写清楚理由。 */
  const CAP = 84;
  ok(set.size <= CAP, '★ 不同 box-shadow 共 ' + set.size + ' 种，≤ ' + CAP + '（基线，只准减）', String(set.size));
}

/* =================== [5] 纸必须有边 =================== */
head('[5] 纸的厚度来自边缘');
{
  const style = readAll()['style.css'];
  const box = /\.modal-box\s*\{([\s\S]*?)\}/.exec(style);
  ok(!!box, '找到 .modal-box');
  const body = box ? box[1] : '';
  ok(/--elev-3/.test(body), '★ 弹窗用第三档高度');
  ok(/--edge-paper/.test(body), '★★ 弹窗带纸边（只靠阴影是贴图，有边才有厚度）');
  const stage = /#stage\s*\{([\s\S]*?)\}/.exec(style);
  ok(!!stage && /radial-gradient/.test(stage[1]), '★ 毡面有一层中心光（不是均色底）');
  ok(!!stage && /tabular-nums/.test(stage[1]), '★ 数字全局等宽（否则一列分数会左右跳）');
}

/* =================== [6] var() 引用完整性（P0-3） ===================
 * `--text-main` 曾经 4 处引用 0 处定义：声明静默作废、靠 body 继承碰巧可读。
 * 这类缺陷以前没有任何断言会红——CSS 里"写了 color"看起来和真生效一模一样。
 * 判据：所有 CSS 里的 var(--x) 必须能在 CSS 定义或 JS 注入白名单里找到。 */
head('[6] var() 引用完整性');
{
  const JS_DIR = path.join(__dirname, '..', 'js');
  const jsFiles = fs.readdirSync(JS_DIR).filter((f) => /\.js$/.test(f));
  const jsSrc = jsFiles.map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  /* JS 注入项必须**显式**列出（不靠"没定义就放行"蒙混）。每一行都要能在 JS 源里
   * 找到 setProperty('--x', …) 或内联 style="--x:…"，否则白名单会腐化成免责声明。 */
  const JS_INJECTED = [
    '--vp-h', '--pt-scale', '--ls-scale', '--sa-top', '--sa-bottom', '--sa-left', '--sa-right',
    '--tap-min', '--gt-h', '--seat-name', '--seat-score', '--seat-label', '--seat-me', '--emo-half',
    '--emo-k', '--ss-origin', '--slot-color', '--slot-soft', '--fx-color', '--fx-ring', '--hold',
    '--tail-off', '--nmw', '--a', '--d', '--r', '--pc'
  ];
  const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, ' ');
  const cleanJs = stripJsComments(jsSrc);
  const foundInJs = new Set();
  let m;
  const injectRe = /setProperty\(\s*['"](--[a-z0-9-]+)['"]|--([a-z0-9-]+)\s*:/g;
  while ((m = injectRe.exec(cleanJs))) foundInJs.add(m[1] || ('--' + m[2]));
  const stale = JS_INJECTED.filter((v) => !foundInJs.has(v));
  eq(stale.length, 0, '★★ 显式 JS 注入白名单没有僵尸条目', stale.join(','));

  const refs = new Set(), defs = new Set();
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  for (const f of Object.keys(css)) {
    const text = noComments(css[f]);
    let r;
    const refRe = /var\(\s*(--[a-z0-9-]+)/g;
    while ((r = refRe.exec(text))) refs.add(r[1]);
    let d;
    const defRe = /(--[a-z0-9-]+)\s*:/g;
    while ((d = defRe.exec(text))) defs.add(d[1]);
  }
  ok(refs.size >= 50 && defs.size >= 40, '前置：真的扫到了变量引用与定义（' + refs.size + ' / ' + defs.size + '）');
  const unresolved = [...refs].filter((v) => !defs.has(v) && JS_INJECTED.indexOf(v) < 0);
  eq(unresolved.length, 0, '★★ 所有 var() 都能解析到 CSS 定义或 JS 注入白名单', unresolved.join(','));
  ok(/--text-main\s*:\s*#f5f0e6\b/i.test(css['style.css']),
    '★★ --text-main 在 :root 明确定义为现网继承色 #f5f0e6（删掉定义此条必须红）');
}

/* =================== [7] 氛围投影豁免 + JS 内联投影（P0-4） =================== */
head('[7] 豁免清单与 JS 内联样式');
{
  const style = css['style.css'] || '';
  const missingAtm = ATMOSPHERE.filter((v) => style.indexOf(v) < 0);
  eq(missingAtm.length, 0, '★★ 三条带色氛围投影仍在 CSS 里（豁免不是永不命中的死白名单）', missingAtm.join(' | '));

  const JS_DIR = path.join(__dirname, '..', 'js');
  const jsFiles = fs.readdirSync(JS_DIR).filter((f) => /\.js$/.test(f));
  const bad = [];
  let total = 0;
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    let m;
    const re = /box-shadow\s*:\s*([^;'"}]+)/gi;
    while ((m = re.exec(src))) {
      total += 1;
      const v = m[1].trim().replace(/\s+/g, ' ');
      if (isElevation(v)) bad.push(f + ': box-shadow: ' + v);
    }
  }
  ok(total >= 1, '前置：JS 内联 box-shadow 扫描器扫到了声明（' + total + ' 条，太少说明解析坏了）');
  eq(bad.length, 0, '★★ JS 内联样式没有裸外投影（cardView 的飘牌也走 --elev-*）', bad.join(' | '));
  ok(/box-shadow:\s*var\(--elev-2\)/.test(fs.readFileSync(path.join(JS_DIR, 'cardView.js'), 'utf8')),
    '★ cardView.js 的飘牌走 --elev-2');
}

/* =================== [8] 圆角四档（P1-P7） =================== */
head('[8] 圆角：四档 token + 近重复漂移归零');
{
  const RADIUS_TOKENS = { '--r-chip': '12px', '--r-card': '16px', '--r-modal': '24px', '--r-pill': '999px' };
  /* 漂移家族：审计点名的 11/14/18/26，分别并到 12/16/16/28。
   * 这四档字面量在全站必须为 0 —— 它们没有语义，只是逐屏手输出来的近重复。 */
  const DRIFT = ['11px', '14px', '18px', '26px'];
  /* 显式几何豁免。每一项都必须在 CSS 里还有一处（下面有僵尸检查），
   * 否则这张表会腐化成"什么都能放行"的免责声明。
   *   · 0 / 50% / inherit 是几何原语，不是形状档位；
   *   · 3/6/8/10/20/28/32/48 是既成卡/角标/圆形/半屏上沿的形状，硬并进四档
   *     会肉眼可见地改版（28→24 是 4px、影响 6 张纸卡），按"观感明显变化处
   *     记录取舍、不硬压"保守保留；
   *   · calc() 那一条是表情气泡随缩放系数放大，基准值已换成 var(--r-card)。 */
  const GEOMETRY_ALLOW = [
    '0', '50%', 'inherit', '3px', '6px', '8px', '10px', '20px', '28px', '28px 28px 0 0',
    '32px', '48px', 'calc(var(--r-card) * var(--emo-k, 1))'
  ];
  const radiusVerdict = (v) => {
    if (/^var\(--r-(chip|card|modal|pill)\)$/.test(v)) return null;
    if (GEOMETRY_ALLOW.indexOf(v) >= 0) return null;
    return '非法圆角：' + v;
  };
  /* 分类器自测：先证明它抓得住漂移和现编值，否则"零违规"没意义 */
  eq(radiusVerdict('var(--r-card)'), null, '分类器自测：token 放行');
  eq(radiusVerdict('50%'), null, '分类器自测：几何原语放行');
  ok(radiusVerdict('14px') !== null, '分类器自测：14px 漂移被抓');
  ok(radiusVerdict('17px') !== null, '分类器自测：现编 17px 被抓');

  const style = css['style.css'] || '';
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(style);
  ok(!!root, '找得到 :root');
  const body = root ? root[1] : '';
  for (const [k, v] of Object.entries(RADIUS_TOKENS)) {
    const m = new RegExp('\\' + k + '\\s*:\\s*([^;]+);').exec(body);
    eq(m ? m[1].trim() : null, v, k + ' = ' + v + '（删/改档必须红）');
  }

  const seen = new Set(), bad = [], allowSeen = new Set();
  for (const f of FILES) {
    const text = css[f] || '';
    let m;
    const re = /border-radius\s*:\s*([^;}]+)/g;
    while ((m = re.exec(text))) {
      const v = m[1].trim().replace(/\s+/g, ' ');
      seen.add(v);
      const verdict = radiusVerdict(v);
      if (verdict) bad.push(f + ': ' + v + ' → ' + verdict);
      else if (GEOMETRY_ALLOW.indexOf(v) >= 0) allowSeen.add(v);
    }
  }
  ok(seen.size >= 15, '前置：真的扫到了圆角声明（' + seen.size + ' 种取值）');
  eq(bad.length, 0, '★★ 圆角只取 --r-* 或显式几何豁免（11/14/18/26 漂移归零）', bad.join(' | '));
  const missingAllow = GEOMETRY_ALLOW.filter((v) => !allowSeen.has(v));
  eq(missingAllow.length, 0, '★★ 几何豁免清单没有僵尸条目', missingAllow.join(' | '));
  ok(seen.size <= 17, '★★ 圆角取值种类从 21 收敛到 ≤17（现 ' + seen.size + '）');
  for (const k of Object.keys(RADIUS_TOKENS)) {
    ok([...seen].some((v) => v === 'var(' + k + ')'), '★ ' + k + ' 真的被用到了（不是纸面 token）');
  }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
