/**
 * 交互一致性守（P1 · P2 / P3 / P4 / P5 / P6 + U4）
 *
 * 与 P0 的 button-busy-wiring.test.js 分工：那一个守「pressBusy 的目标按钮在不在体系里」，
 * 本文件守「危险动作有没有语气、输入框有没有 Enter 预期、忙碌态是不是同一套、
 * 结算页次级按钮有没有变体、onHoldNext 有没有 restore 防御」。
 *
 * 全部是**静态**守卫：真机手感由 probe-ui-flow 负责；这里只保证代码层不会再漂回去。
 * 每条规则都带分类器自测或变异自证，避免"零违规"只是因为没扫到。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const gameJs = read('js/game.js');
const accountJs = read('js/accountView.js');
const recordsJs = read('js/recordsView.js');
const html = read('index.html');
const styleCss = read('css/style.css');
const recordsCss = read('css/records.css');

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

/** 带括号/引号配平的调用点提取；跳过 `function name(` 声明。 */
function callSites(src, name) {
  const out = [];
  const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(before)) continue;
    let i = m.index + m[0].length, depth = 1, quote = null;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push({ index: m.index, args: src.slice(start, i - 1) });
    re.lastIndex = i;
  }
  return out;
}
/** 按最外层逗号拆实参（忽略引号与嵌套括号/对象里的逗号）。 */
function topArgs(s) {
  const out = []; let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}
/** 具名函数体（含 async），用大括号配平；用于缩小扫描面到单个处理函数。 */
function functionsIn(src) {
  const out = [];
  const re = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    out.push({ name: m[1], start: m.index, end: i, body: src.slice(m.index, i) });
    re.lastIndex = i;
  }
  return out;
}
function classesOf(id, src) {
  const m = new RegExp('<button\\b[^>]*\\bid="' + id + '"[^>]*>').exec(src);
  if (!m) return null;
  const c = /\bclass="([^"]*)"/.exec(m[0]);
  return c ? c[1].trim().split(/\s+/) : [];
}

/* =================== [1] P2 确认框严重度分级 =================== */
head('[1] P2 · askConfirm 的 danger 语气');
{
  const sites = callSites(gameJs, 'askConfirm').concat(callSites(accountJs, 'askConfirm'));
  ok(sites.length >= 4, '前置：扫到 ' + sites.length + ' 处 askConfirm 调用');
  /* 分类器自测：给一个假的 secret:true 调用，必须被抓；带 tone 的必须放行。 */
  const needsDanger = (opts) => /secret\s*:\s*true/.test(opts) && !/tone\s*:\s*['"]danger['"]/.test(opts);
  ok(needsDanger('{ busyText: "删除中…", secret: true }'), '分类器自测：裸 secret:true 被抓');
  ok(!needsDanger('{ secret: true, tone: "danger" }'), '分类器自测：带 danger 放行');

  const bad = [];
  for (const s of sites) {
    const args = topArgs(s.args);
    const opts = args[args.length - 1] || '';
    if (needsDanger(opts)) bad.push('@' + s.index + ' ' + opts);
  }
  eq(bad.length, 0, '★★ 每个 secret===true 的调用点都同时带 tone:danger', bad.join(' | '));

  ok(/opts\s*&&\s*opts\.tone\s*===\s*'danger'/.test(gameJs), '★ askConfirm 读取 opts.tone');
  ok(/classList\.toggle\('btn-danger',\s*danger\)/.test(gameJs), '★★ danger 时确定键换 .btn-danger');
  ok(/classList\.toggle\('btn-primary',\s*!danger\)/.test(gameJs), '★★ 非 danger 时恢复 .btn-primary（不是只加不摘）');
  ok(/'（不可撤销）'/.test(gameJs), '★ danger 标题带不可逆提示');
  ok(/secret:\s*true,\s*tone:\s*'danger'/.test(accountJs), '★ 删号调用传 tone:danger');
  /* 反向：每把都点的提交必须仍是默认语气，否则分级被稀释成"全是危险"。 */
  const submit = sites.find((s) => /确认提交分组/.test(s.args));
  ok(!!submit && !/tone\s*:/.test(topArgs(submit.args).pop() || ''),
    '★ 每把都点的「确认提交分组」保持默认语气（危险档没被滥用）');
}

/* =================== [2] P3 删号密码框 Enter =================== */
head('[2] P3 · #confirm-secret 的 Enter 提交');
{
  const ask = functionsIn(gameJs).find((f) => f.name === 'askConfirm');
  ok(!!ask, '前置：找得到 askConfirm 函数体');
  const body = ask ? ask.body : '';
  ok(/sec\.onkeydown\s*=\s*function/.test(body), '★ 密码框挂了 keydown（用属性赋值，重复弹框不会叠加监听）');
  ok(/e\.key\s*===\s*'Enter'/.test(body) && /onConfirmOk\(\)/.test(body),
    '★★ Enter → onConfirmOk（自带 confirmBusy 与空密码拦截）');
  ok(/e\.preventDefault\(\)/.test(body), '★ Enter 被 preventDefault（不会额外提交表单）');
  ok(/sec\.onkeydown\s*=\s*null/.test(body), '★ 非密码场景摘掉监听（不留僵尸 handler）');
  const enters = (gameJs.match(/e\.key === 'Enter'/g) || []).length;
  ok(enters >= 7, '★ 全站 Enter 绑定含删号密码框（现 ' + enters + ' 处）');
}

/* =================== [3] P4 昵称框 Enter 有预期 =================== */
head('[3] P4 · 昵称框 Enter 行为可预期');
{
  const tag = /<input\b[^>]*\bid="nickname-input"[^>]*>/.exec(html);
  ok(!!tag, '前置：找得到 #nickname-input');
  ok(/placeholder="输入昵称（回车创建房间）"/.test(tag ? tag[0] : ''), '★★ placeholder 写明回车会创建房间');
  ok(/enterkeyhint="go"/.test(tag ? tag[0] : ''), '★ enterkeyhint="go" 与行为一致');
  ok(/\$\('#nickname-input'\)\.addEventListener\('keydown'[\s\S]{0,180}e\.key === 'Enter'[\s\S]{0,80}onCreate\(\)/.test(gameJs),
    '★ 行为未改：Enter 仍建房（选的是"加预期"而不是"改行为"）');
}

/* =================== [4] P5 忙碌态一套视觉 =================== */
head('[4] P5 · 转圈周期与 is-busy');
{
  ok(/--spin-period:\s*800ms\s*;/.test(styleCss), '★★ :root 定义 --spin-period: 800ms');
  ok(/animation:\s*btnSpin\s+var\(--spin-period\)/.test(styleCss), '★★ 按钮转圈引用 token');
  ok(/animation:\s*rpSpin\s+var\(--spin-period\)/.test(recordsCss), '★★ 战绩加载环引用同一 token');
  ok(!/animation:\s*(btnSpin|rpSpin)\s+(0\.7s|900ms)/.test(styleCss + recordsCss),
    '★ 0.7s / 900ms 两套周期已归零');

  const confirm = functionsIn(gameJs).find((f) => f.name === 'onConfirmOk');
  ok(!!confirm, '前置：找得到 onConfirmOk');
  const cbody = confirm ? confirm.body : '';
  ok(/btn\.disabled = true; btn\.classList\.add\('is-busy'\)/.test(cbody),
    '★★ 确认键 disabled 时同时 is-busy（改回只换文字必须红）');
  ok(/btn\.disabled = false; btn\.classList\.remove\('is-busy'\)/.test(cbody),
    '★ finally 里成对还原 is-busy');

  /* 「async 点击处理里 disabled=true 必须同时 is-busy 或 pressBusy」。
   * 扫描面：整个 game.js / accountView.js（pressBusy 在这两个文件里定义与调用）。
   * 渲染态的 disabled 是豁免项——它不是"正在处理"，是"这颗按钮当前无意义"，
   * 每一项都写明理由，且下面断言它们仍在，防止豁免变成免责声明。 */
  const RENDER_DISABLE = [
    { f: 'game.js', name: 'readyBtn', why: '已就位徽标，用 .is-done 表达完成态' },
    { f: 'game.js', name: 'updateSubmit', why: '提交按钮的渲染态文案（已提交 / 还差 N 张），不是异步请求' }
  ];
  const files = [{ n: 'game.js', s: gameJs }, { n: 'accountView.js', s: accountJs }];
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const fns = functionsIn(file.s);
    for (const fn of fns) {
      if (!/\.disabled\s*=\s*true/.test(fn.body)) continue;
      if (/is-busy|pressBusy/.test(fn.body)) { checked++; continue; }
      const isRender = RENDER_DISABLE.some((e) => e.f === file.n && e.name === fn.name);
      if (isRender) { checked++; continue; }
      bad.push(file.n + ':' + fn.name);
    }
  }
  ok(checked >= 4, '前置：扫到了 ' + checked + ' 个写 disabled=true 的函数');
  eq(bad.length, 0, '★★ 有 disabled=true 的处理函数都配了 is-busy / pressBusy（或具名渲染态豁免）', bad.join(' | '));
  ok(/\.readyBtn|readyBtn\.disabled/.test(gameJs) && /已就位 ✓/.test(gameJs),
    '★ 渲染态豁免项仍在 CSS/JS 里（不是把代码删掉骗过扫描）');
}

/* =================== [5] P6 结算页次级按钮变体 =================== */
head('[5] P6 · .btn 组合含且只含一个变体');
{
  const VARIANTS = ['btn-primary', 'btn-secondary', 'btn-quiet', 'btn-ghost', 'btn-danger'];
  const combos = [];
  const re = /<button\b[^>]*\bclass="([^"]*\bbtn\b[^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) combos.push(m[1].trim().split(/\s+/));
  ok(combos.length >= 20, '前置：扫到 ' + combos.length + ' 颗带 .btn 的按钮');
  const bad = [];
  for (const c of combos) {
    const n = VARIANTS.filter((v) => c.indexOf(v) >= 0).length;
    if (n !== 1) bad.push(c.join(' ') + ' → 变体数 ' + n);
  }
  eq(bad.length, 0, '★★ class="btn…" 含且只含一个变体类（裸 .btn 改回来必须红）', bad.join(' | '));
  for (const id of ['btn-share', 'btn-replay', 'btn-records']) {
    const cls = classesOf(id, html) || [];
    ok(cls.indexOf('btn-quiet') >= 0, '★ #' + id + ' 用实体次级 btn-quiet');
  }
  ok(!/首页「加入房间」就是/.test(styleCss), '★★ style.css 的过期注释已更新');
  ok(/btn btn-quiet btn-lg/.test(styleCss), '★ 注释里的新例子与现网 index.html 一致');
}

/* =================== [6] U4 onHoldNext 的 restore 防御 =================== */
head('[6] U4 · pressBusy 返回 null 的防御');
{
  const calls = callSites(gameJs, 'pressBusy');
  ok(calls.length >= 12, '前置：扫到 ' + calls.length + ' 处 pressBusy 调用');
  const guards = (gameJs.match(/if \(!restore\) return;/g) || []).length;
  eq(guards, calls.length, '★★ 每处 pressBusy 调用后都有 if(!restore) return（' + guards + '/' + calls.length + '）');
  const hold = functionsIn(gameJs).find((f) => f.name === 'onHoldNext');
  ok(!!hold && /if \(!restore\) return;/.test(hold.body),
    '★★ 唯一漏网的 onHoldNext 已补齐（finally 不再可能 TypeError）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
