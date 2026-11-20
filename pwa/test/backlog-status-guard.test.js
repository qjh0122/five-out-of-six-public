/**
 * BACKLOG 状态解析守卫（任务 A，2026-11-20）
 *
 * 为什么要有它：scripts/backlog-status.js 曾用 split('\n') 解析全 CRLF 的
 * docs/BACKLOG.md，每行尾部残留 \r 导致 49 条一条都命不中；--check 因为
 * unknown=0 而 exit 0 —— 一个「永远绿」的假门禁。修完必须有人盯着它别回潮。
 *
 * 期望值是独立来源（grep），不是解析器自己算出来的：
 *   grep -c '^### ' docs/BACKLOG.md                  -> 49（条目数）
 *   grep -c '<!-- STATUS: open' docs/BACKLOG.md      -> 2
 *   grep -c '<!-- STATUS: closed' docs/BACKLOG.md    -> 38
 *   grep -c '<!-- STATUS: record' docs/BACKLOG.md    -> 2
 *   grep -c '<!-- STATUS: watch' docs/BACKLOG.md     -> 7
 * 注：grep -c '<!-- STATUS:' 是 50 —— 第 734 行是正文里的示例
 * `<!-- STATUS: … -->`，不是条目；所以条目锚点用 '^### ' 的 49。
 *
 * 负向样本用 --file 指向临时文件，绝不临时改真实 BACKLOG.md 再还原。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const BS = require('../../scripts/backlog-status');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
const SCRIPT = path.join(ROOT, 'scripts', 'backlog-status.js');
const REAL = path.join(ROOT, 'docs', 'BACKLOG.md');
const EXPECTED = { total: 49, open: 2, closed: 38, record: 2, watch: 7, unknown: 0 };

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: 'utf8' });
}

const raw = fs.readFileSync(REAL, 'utf8');
const items = BS.parse(raw);
const by = BS.summarize(items);

console.log('\n[A] 真实 CRLF 文档：解析数 == 独立 grep 锚点');
eq(items.length, EXPECTED.total, '★ 49 条（回归时这里是 0）');
eq(by.open.length, EXPECTED.open, 'open 2 条');
eq(by.closed.length, EXPECTED.closed, 'closed 38 条');
eq(by.record.length, EXPECTED.record, 'record 2 条');
eq(by.watch.length, EXPECTED.watch, 'watch 7 条');
eq(by.unknown.length, EXPECTED.unknown, 'unknown 0 条');

console.log('\n[B] CLI 形态与 --check');
const r1 = runCli([]);
eq(r1.status, 0, '无参数退出 0');
ok((r1.stdout || '').indexOf('BACKLOG 条目 49 条') >= 0, '★ 输出 49 条');
const r2 = runCli(['--check']);
eq(r2.status, 0, '★ 干净文档 --check 退出 0');

console.log('\n[C] 负向与跨行尾');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-guard-'));
try {
  /* 同内容换成纯 LF：必须仍解析 49 条（不能只修 CRLF） */
  const lfText = raw.split('\r\n').join('\n');
  const lfFile = path.join(tmp, 'same-content-lf.md');
  fs.writeFileSync(lfFile, lfText, 'utf8');
  const r3 = runCli(['--file', lfFile]);
  eq(r3.status, 0, 'LF 样本退出 0');
  ok((r3.stdout || '').indexOf('BACKLOG 条目 49 条') >= 0, '★ LF 同内容仍解析 49 条');

  /* 缺 STATUS 的 CRLF 样本：--check 必须红，且红的原因是 unknown */
  const lines = lfText.split('\n');
  const si = lines.findIndex((L) => /^<!-- STATUS: (open|closed|record|watch)/.test(L));
  ok(si >= 0, '找到可删的 STATUS 行做负向样本');
  lines[si] = '<!-- 守卫故意删掉了这一行的 STATUS -->';
  const badFile = path.join(tmp, 'missing-status-crlf.md');
  fs.writeFileSync(badFile, lines.join('\n').split('\n').join('\r\n'), 'utf8');

  const r4 = runCli(['--file', badFile]);
  ok((r4.stdout || '').indexOf('unknown 1 条') >= 0, '★ 缺行样本被识别为 unknown 1 条');

  const r5 = runCli(['--file', badFile, '--check']);
  eq(r5.status, 1, '★ 缺 STATUS 行 --check 必须 exit 1（负向断言）');
  ok((r5.stderr || '').indexOf('缺 STATUS') >= 0, '红的原因确实是缺 STATUS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
