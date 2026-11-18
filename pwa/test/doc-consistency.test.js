/**
 * 文档一致性守 · 测试入口（薄包装）
 *
 * 为什么要有这一层：真源是 `scripts/check-docs.js`，但 `scripts/run-tests.js`
 * 只扫 `pwa/test` + `server/test` 下的 `*.test.js`。守卫写在 scripts/ 里却没人调用，
 * 就等于没写 —— CI 既看不见它红，也看不见它绿（QA 审计 G1，与 v136 那次
 * 「接线断了不报错」是同一类）。
 *
 * 这里**不复制任何判据**，只把真源 spawn 出来并透传输出：
 * `run-tests.js` 的 parseCounts() 认「通过 N 项，失败 M 项」，
 * 所以真源报出的项数会**原样计入** `npm test` 的总断言数（透传，不在本层重算），
 * 日志里形如 `✓ [xx/NNN] pwa/test/doc-consistency.test.js  K 项`。
 *
 * ⚠️ 这里**刻意不写死项数**（曾写「39 项」与「155 个」，真源长到 43 项后注释就成了假话）。
 * 与 `check-docs.js` 的 [6]「快照提醒句不写死当前版本号」是同一条纪律：
 * **数字只留在一个权威处，其余地方指向它。**
 *
 * 单独跑：`npm run docs:check`（= node scripts/check-docs.js）。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'check-docs.js');

const r = spawnSync(process.execPath, [GUARD], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024
});

const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out);

if (r.error || r.status !== 0) {
  if (r.error) process.stderr.write('守卫进程异常：' + r.error.message + '\n');
  process.exit(1);
}
process.exit(0);
