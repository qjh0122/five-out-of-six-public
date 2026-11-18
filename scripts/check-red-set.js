/**
 * 能红集校验器（node scripts/check-red-set.js [选项]）
 *
 * 它守什么（REVIEW §6.6 禁令三的 (b)）：
 *   「能红集」= 被演示过会红的断言（配对该红线）的集合。本脚本只查【机器查得了的部分】，
 *   因果（这次注入到底能不能让这条断言失败）由人判、写进每条记录的 causal 栏 ——
 *   不要把因果塞进一栏机检：机器只判得了「身份唯一」和「状态变过没变过」。
 *
 * 四条件（缺一不闭合）：
 *   1. 注入前绿 + 注入后红   —— 挡「无关原因的红」冒充满注入后红
 *   2. 红的身份对上注入点    —— 挡「红是另一件事造成的」（after.output 同时含 fail_loc 与 name）
 *   3. 双端内容哈希          —— 挡「断言被改弱 / 注入点被重构后记录照样亮」
 *   4. 集合包含（本轮 ⊇ 上轮）—— 挡「过度失效变假阳红」；退化必须同轮重验
 *
 * 为什么身份降到 (文件, 说明串) 且要求「说明串在该文件内命中恰好 1」：
 *   本仓断言带 文件:行，但行号会随编辑漂移 ⇒ 记录绑「文件 + 行内容哈希」而不是裸行号；
 *   说明串必须文件内唯一（可机检，含正文与代码块），命中 0 一律当「没定位到」而非「不存在」。
 *
 * 用法：
 *   node scripts/check-red-set.js                 # 默认校验 docs/red-set.json
 *   node scripts/check-red-set.js --emit-hash f:l # 打印某文件某行的哈希（填记录用，口径与本脚本一致）
 *   node scripts/check-red-set.js --self-test     # 变异自证：逐条破坏记录，确认每条判据真能红
 *
 * 退出码：0 = 全部通过；1 = 有检查项失败 / 数据缺失 / self-test 发现某条判据是瞎的。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'docs', 'red-set.json');
const BASELINE = path.join(ROOT, 'docs', 'red-set.baseline.json');
const HEAD40 = /^[0-9a-f]{40}$/;

function readJson(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { throw new Error('读不到 ' + path.relative(ROOT, p) + '：' + e.code); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(path.relative(ROOT, p) + ' 不是合法 JSON：' + e.message); }
}

/** 行内容哈希：取第 line 行（1-based），去掉行尾 \r，其余空白原样 —— 口径必须与 --emit-hash 一致 */
function lineHash(file, line) {
  let lines;
  try { lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n'); }
  catch (e) { return null; }
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  return crypto.createHash('sha256').update(lines[line - 1].replace(/\r$/, '')).digest('hex');
}

/** 字面命中数（含正文与代码块），不用正则 —— 说明串里的元字符不能转义失配 */
function literalCount(text, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function readSrc(file) {
  try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
  catch (e) { return null; }
}

function failLocMatches(output, file, line) {
  // after 的红必须落在目标断言的 文件:行（列号可漂移，故只锚到行）
  const re = new RegExp('(?:^|\\s)' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':' + line + '(?::\\d+)?(?=\\s|$)');
  return re.test(output || '');
}

/** 校验单条记录，返回检查项数组 { ok, name, detail } */
function checkRecord(rec, idx) {
  const out = [];
  const push = (ok, name, detail) => out.push({ ok: !!ok, name: 'R' + idx + ' ' + name, detail: detail || '' });
  const A = rec && rec.assertion || {};
  const I = rec && rec.injection || {};
  const B = (rec && rec.evidence && rec.evidence.before) || {};
  const F = (rec && rec.evidence && rec.evidence.after) || {};

  // 结构完整性
  push(!!(rec && rec.id && A.file && A.line && A.name && I.file && I.line),
    '结构完整', 'id / 断言文件:行:name / 注入文件:行 必须齐全');

  // 条件 1：注入前绿 + 注入后红（各带时点与 HEAD）
  push(B.exit === 0 && B.assertion_result === 'PASS',
    '注入前绿', 'exit=' + B.exit + ' result=' + B.assertion_result);
  push(F.exit !== 0 && F.assertion_result === 'FAIL',
    '注入后红', 'exit=' + F.exit + ' result=' + F.assertion_result);
  push(!!(B.time && F.time && HEAD40.test(B.head || '') && HEAD40.test(F.head || '')),
    '前后时点与 HEAD', 'B.time/head=' + B.time + '/' + B.head + ' F.time/head=' + F.time + '/' + F.head);

  // 条件 2：红的身份对上注入点 —— after 输出同时含 fail_loc 与断言说明串
  const locOk = failLocMatches(F.fail_loc, A.file, A.line) && failLocMatches(F.output, A.file, A.line);
  const nameOk = typeof F.output === 'string' && F.output.indexOf(A.name) !== -1
    && typeof B.output === 'string' && B.output.indexOf(A.name) !== -1;
  push(locOk, '身份·失败行对上断言', 'fail_loc=' + F.fail_loc + ' 期望 ' + A.file + ':' + A.line);
  push(nameOk, '身份·前后输出都含说明串', 'name=' + A.name);

  // 条件 3：双端内容哈希（注入点 + 断言行都要绑）
  const ah = lineHash(A.file, A.line);
  const ih = lineHash(I.file, I.line);
  push(!!ah && ah === A.hash, '双端哈希·断言行', A.file + ':' + A.line + ' 现=' + ah + ' 记录=' + A.hash);
  push(!!ih && ih === I.hash, '双端哈希·注入行', I.file + ':' + I.line + ' 现=' + ih + ' 记录=' + I.hash);

  // 说明串在该文件内唯一（含正文与代码块），命中 0 当「没定位到」
  const src = readSrc(A.file);
  const hits = src === null ? -1 : literalCount(src, A.name);
  push(hits === 1, '说明串文件内唯一', A.file + ' 命中 ' + hits + ' 次（须恰好 1）');

  // 注入表达式确实改了这一行（expr_old 须与当前原行一致，expr_new 须不同）
  const oldLine = srcOrNull(I.file, I.line);
  push(!!oldLine && norm(oldLine).indexOf(norm(I.expr_old)) !== -1 && norm(I.expr_old) !== norm(I.expr_new),
    '注入表达式·旧行吻合且新旧不同', 'old=' + I.expr_old + ' new=' + I.expr_new);

  // 人判因果：只查「写了」，不判因果真伪（因果只能人判）
  push(typeof rec.causal === 'string' && rec.causal.trim().length >= 20,
    '人判因果已填写', String(rec.causal || '').slice(0, 60));

  return out;
}

function srcOrNull(file, line) {
  const s = readSrc(file);
  if (s === null) return null;
  const lines = s.split('\n');
  return (Number.isInteger(line) && line >= 1 && line <= lines.length) ? lines[line - 1] : null;
}
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/** 条件 4：集合包含 —— 本轮记录 id ⊇ 上轮基线 id；退化项必须同轮重验（此轮先机检退化本身） */
function checkContainment(records, baseline) {
  const cur = new Set(records.map((r) => r && r.id).filter(Boolean));
  const base = new Set((baseline && baseline.ids) || []);
  const missing = Array.from(base).filter((id) => !cur.has(id));
  return [{
    ok: missing.length === 0,
    name: '集合包含·本轮⊇上轮',
    detail: missing.length ? '退化/缺失：' + missing.join(', ') : '本轮 ' + cur.size + ' 条 ⊇ 上轮 ' + base.size + ' 条'
  }];
}

function verify(data, baseline) {
  if (!data || !Array.isArray(data.records) || data.records.length === 0) {
    return [{ ok: false, name: '数据非空', detail: 'red-set.json 需含至少一条 records' }];
  }
  let checks = [];
  data.records.forEach((r, i) => { checks = checks.concat(checkRecord(r, i + 1)); });
  return checks.concat(checkContainment(data.records, baseline));
}

function printChecks(checks) {
  let pass = 0, fail = 0;
  checks.forEach((c) => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else { fail++; console.log('  FAIL  ' + c.name + '  -> ' + c.detail); }
  });
  console.log('能红记录校验：' + pass + ' 项通过，' + fail + ' 项失败');
  return fail;
}

/** 变异自证：逐条破坏真实记录，确认每条判据真能红（纪律自己也要做变异自证） */
function selfTest(data, baseline) {
  if (!data || !data.records || !data.records[0]) {
    console.log('  FAIL  self-test 需要至少一条真实记录');
    return 1;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mutations = [
    ['前绿→伪红', (d) => { d.records[0].evidence.before.exit = 1; }],
    ['后红→伪绿', (d) => { d.records[0].evidence.after.exit = 0; }],
    ['断言行哈希失效', (d) => { d.records[0].assertion.hash = 'deadbeef'; }],
    ['注入行哈希失效', (d) => { d.records[0].injection.hash = 'deadbeef'; }],
    ['说明串定位不到', (d) => { d.records[0].assertion.name = '__NO_SUCH_ASSERTION__'; }],
    ['失败行身份错配', (d) => { d.records[0].evidence.after.fail_loc = 'other/test.js:999:1'; }],
    ['集合退化', (d, b) => { b.ids = (b.ids || []).concat(['__GHOST_ID__']); }]
  ];
  let miss = 0;
  mutations.forEach(([label, mutate]) => {
    const d = clone(data), b = clone(baseline || { ids: [] });
    mutate(d, b);
    const checks = verify(d, b);
    const anyFail = checks.some((c) => !c.ok);
    if (anyFail) console.log('  PASS  变异自证 ' + label + ' → 能红');
    else { miss++; console.log('  FAIL  变异自证 ' + label + ' → 仍全绿（判据是瞎的）'); }
  });
  console.log('变异自证：' + (mutations.length - miss) + '/' + mutations.length + ' 条判据能被红');
  return miss ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit-hash') {
    const spec = args[1] || '';
    const m = /^(.+):(\d+)$/.exec(spec);
    if (!m) { console.error('用法：--emit-hash <文件:行>，如 pwa/js/card.js:48'); process.exit(2); }
    const h = lineHash(m[1], Number(m[2]));
    if (!h) { console.error('取不到该行：' + spec); process.exit(2); }
    console.log(h);
    return;
  }
  let data, baseline = { ids: [] };
  try {
    data = readJson(DATA);
    try { baseline = readJson(BASELINE); }
    catch (e) { /* 首次运行允许无基线，按空集处理 */ }
  } catch (e) { console.error('  FAIL  ' + e.message); process.exit(1); }

  if (args[0] === '--self-test') { process.exit(selfTest(data, baseline)); }
  process.exit(printChecks(verify(data, baseline)) ? 1 : 0);
}

main();
