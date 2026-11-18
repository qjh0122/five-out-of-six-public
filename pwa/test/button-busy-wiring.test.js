/**
 * pressBusy 目标按钮守（P0-8：btn-hold 进按钮体系）
 *
 * pressBusy() 会给目标加 disabled + is-busy + 换文案；而转圈 / 变灰的 CSS 都挂在 .btn 上。
 * 目标若不在体系内，代码"看起来上了忙碌态"，玩家却什么都看不到——静默失效。
 * 本文件静态收集 game.js 里所有 pressBusy 目标，逐个核对：
 *   ① 目标元素带 .btn；或 ② 它自己定义了 :active / [disabled] / .is-busy 三态。
 * 两项都不满足就红。扫描器先自测，避免"没抓到"被误读成"没问题"。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gameJs = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
const settleJs = fs.readFileSync(path.join(ROOT, 'js', 'settleView.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) pass++; else fail++;
  ASSERT.log(ok, c, m, extra);
}
function eq(a, b, m, extra) {
  if (a === b) pass++; else fail++;
  ASSERT.log(eq, a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }
function uniq(a) { return Array.from(new Set(a)); }
function idsIn(s) { return (s.match(/#[a-zA-Z][\w-]*/g) || []).map((x) => x.slice(1)); }

/** 某个 id 的按钮在 HTML 里的 class；取不到返回 null。 */
function classesOf(id, htmlSrc) {
  const re = new RegExp('<button\\b[^>]*\\bid="' + id + '"[^>]*>', 'g');
  const m = re.exec(htmlSrc);
  if (!m) return null;
  const c = /\bclass="([^"]*)"/.exec(m[0]);
  return c ? c[1].trim().split(/\s+/) : [];
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ② 自定义三态：至少覆盖 :active / [disabled] / .is-busy 三种选择器。 */
function hasOwnStates(id, classes, cssSrc) {
  const keys = uniq((classes || []).concat([id]).filter(Boolean));
  const states = [':active', '[disabled]', '.is-busy'];
  return states.every((st) => keys.some((k) =>
    cssSrc.indexOf('.' + k + st) >= 0 || cssSrc.indexOf('#' + k + st) >= 0));
}
function targetVerdict(id, htmlSrc, cssSrc) {
  const cls = classesOf(id, htmlSrc);
  if (cls === null) return 'index.html 找不到 #' + id;
  if (cls.indexOf('btn') >= 0) return null;
  if (hasOwnStates(id, cls, cssSrc)) return null;
  return '#' + id + ' 既没有 .btn，也没有自定义 :active/[disabled]/.is-busy 三态';
}

/* =================== [0] 分类器自测 =================== */
head('[0] 分类器自测');
{
  const h = '<button id="x" class="my-btn">x</button><button id="y" class="solo">y</button>';
  const c = '.my-btn:active{} .my-btn[disabled]{} .my-btn.is-busy::after{} .solo:active{}';
  eq(targetVerdict('x', h, c), null, '★ 自定义三态齐全 → 放行');
  ok(targetVerdict('y', h, c) !== null, '★★ 只有 :active 不算三态 → 必须红');
  eq(targetVerdict('z', h, c) !== null, true, '★ 找不到按钮 → 必须红');
  eq(targetVerdict('x', '<button id="x" class="btn btn-ghost">x</button>', ''), null, '★ 带 .btn → 放行');
}

/* =================== [1] 收集所有 pressBusy 目标 =================== */
head('[1] 全量 pressBusy 目标');
{
  const targets = new Set();
  const re = /pressBusy\(([^)]*)\)/g;
  let m, calls = 0;
  while ((m = re.exec(gameJs))) {
    const before = gameJs.slice(Math.max(0, m.index - 40), m.index);
    if (/function\s*$/.test(before)) continue;   // 函数声明不是调用点
    calls++;
    const arg = m[1];
    /* 字面量：pressBusy($('#btn-x'), …)。变量：向前找同一函数里的 `var btn = …`，
     * 从赋值式里取 #id（含 firstShown([...]) 与三元分支）。 */
    let expr = arg;
    const name = arg.split(',')[0].trim();
    const varName = /^\$?[a-zA-Z_][\w$]*$/.exec(name);
    if (varName) {
      const assign = new RegExp('var\\s+' + esc(name) + '\\s*=\\s*([^;]+);', 'g');
      let a, last = null;
      while ((a = assign.exec(gameJs))) { if (a.index < m.index) last = a[1]; else break; }
      if (last) expr = last;
    }
    idsIn(expr).forEach((id) => targets.add(id));
    /* [data-hold-next] 是属性选择器，映射由 settleView 写属性时确定。 */
    if (/\[data-hold-next\]/.test(expr)) {
      const mapped = /\$\('#btn-hold'\)[\s\S]{0,500}?setAttribute\('data-hold-next'/.test(settleJs);
      ok(mapped, '★★ [data-hold-next] 确实指向 #btn-hold（映射失效则守卫会漏目标）');
      if (mapped) targets.add('btn-hold');
    }
  }
  ok(calls >= 12, '前置：扫到了 ' + calls + ' 处 pressBusy 调用（太少说明解析坏了）');
  ok(targets.size >= 12, '前置：解析出 ' + targets.size + ' 个目标按钮 id');
  const bad = [];
  for (const id of targets) {
    const v = targetVerdict(id, html, css);
    if (v) bad.push(v);
  }
  eq(bad.length, 0, '★★ 每个 pressBusy 目标都有 .btn 或自有三态（btn-hold 改回裸类必须红）', bad.join(' | '));
  ok(targets.has('btn-hold'), '★ btn-hold 被纳入扫描面（不是靠"没扫到"过关）');
}

/* =================== [2] btn-hold 的具体接线 =================== */
head('[2] btn-hold 接线');
{
  const cls = classesOf('btn-hold', html) || [];
  for (const token of ['btn', 'btn-ghost', 'btn-hold', 'hidden']) {
    ok(cls.indexOf(token) >= 0, '★ #btn-hold 带 ' + token);
  }
  ok(/\.next-row\s+\.btn-hold\s*\{/.test(css), '★ 尺寸覆盖仍留在 .next-row .btn-hold（四态从 .btn-ghost 继承）');
  ok(/\.btn\.is-busy::after/.test(css) && /\.btn\[disabled\]/.test(css) && /\.btn:active/.test(css),
    '★ .btn 基座三态在位（忙碌转圈 / 禁灰 / 按压回执都有选择器挂点）');
  ok(/pressBusy\(btn,\s*on\s*\?/.test(gameJs) && /\[data-hold-next\]/.test(gameJs),
    '★ pressBusy 的目标就是那颗 data-hold-next 按钮（不是另一颗同名元素）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
