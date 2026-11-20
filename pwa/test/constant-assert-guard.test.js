/**
 * 恒真断言零容忍守卫（任务 B，2026-11-20）
 *
 * 背景：全仓曾有 22 处把断言条件写死为 true 的调用。它们不是「测了个真命题」，
 * 而是两类假绿：① 本该断言连接/回包成功，却写死 true；② 本该留「本轮未覆盖」的
 * SKIP 留痕，却计入 pass。结果测试总数虚高，红灯永远不亮。
 *
 * 本守卫扫描 pwa/test/** 与 server/test/** 的全部 .test.js，
 * 断言恒真断言计数为 0；变异自证做法是临时放回一条，守卫必须转红。
 *
 * 注意：本文件自身也在扫描范围内，所以正则由片段拼出、注释也不写可被自己
 * 命中的字面量（否则守卫自己把自己判红）。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass++;
  else fail++;
  ASSERT.log(ok, cond, name, extra);
}
function eq(a, b, name) {
  if (a === b) pass++;
  else fail++;
  ASSERT.log(eq, a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['pwa/test', 'server/test'];

/* 由片段拼装，避免守卫源码被自己的正则命中 */
const RE = new RegExp('\\b(?:ok|eq)\\(\\s*' + String.fromCharCode(116, 114, 117, 101) + '\\b', 'g');

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = [];
DIRS.forEach((d) => walk(path.join(ROOT, d), files));

const hits = [];
files.forEach((f) => {
  const text = fs.readFileSync(f, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    RE.lastIndex = 0;
    if (RE.test(line)) hits.push(path.relative(ROOT, f).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + line.trim());
  });
});

console.log('\n[A] 扫描覆盖');
ok(files.length > 100, '扫描到 ' + files.length + ' 个测试文件（两目录都必须非空）');
DIRS.forEach((d) => {
  ok(files.some((f) => f.indexOf(path.join(ROOT, d) + path.sep) === 0), d + ' 目录被纳入扫描');
});
eq(typeof ASSERT.note, 'function', 'harness 提供 note（留痕不计分）');

console.log('\n[B] 恒真断言必须清零');
if (hits.length) hits.slice(0, 20).forEach((h) => console.log('  发现 ' + h));
eq(hits.length, 0, '★ 全仓恒真断言 0 条（负向断言：变异放回一条必须转红）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
