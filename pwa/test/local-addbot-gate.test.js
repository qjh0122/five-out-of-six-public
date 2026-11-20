/**
 * local 模式补 AI 门槛固化守卫（任务 B 组，2026-11-20；任务 C 裁定的可执行留痕）
 *
 * 结论：game.js:758 的 `&& RoomStore.getMode() === 'ws'` 是**保护性门槛**，不能删。
 * 证据：roomStore.js 的 local.addBot 是硬桩（ok:false），且 pwa/js 全目录没有
 * 客户端 bot 自动出牌逻辑（真正的 _autoBots 在 server/hub.js，靠服务端定时器驱动）。
 * 删掉门槛只会把「按钮不显示」变成「点了报『本地演示模式不支持 AI 补位』」，
 * 更糟的是 bot 入房后永不提交分组，开局即卡死。
 *
 * ★ 要删门槛必须先把 hub._autoBots 的客户端路径补齐，否则死按钮+开局卡死。
 * 这是 team-lead 2026-11-20 对任务 C 的裁定；本守卫把裁定固化成可复跑断言，
 * 将来有人误删门槛会立刻红。
 *
 * 本守卫不是「断言字符串消失」：既扫源码确认门槛仍在，也把真的 canAddBot
 * 表达式抽出来跑行为：
 *   - ws 模式 + 房主 + WAITING → 可见（不能弄坏现有联机）
 *   - local 模式 + 同样条件 → 隐藏（保护性门槛）
 *   - 两个模式的差别只能来自 getMode()，不能来自别的特判
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
const GAME = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'game.js'), 'utf8');
const RSRC = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'roomStore.js'), 'utf8');

const M = /var\s+canAddBot\s*=\s*([\s\S]*?);\s*\n\s*addBotBtn\.classList\.toggle\('hidden',\s*!canAddBot\)/.exec(GAME);
ok(!!M, '抽到了真的 canAddBot 表达式（抽不到就是页面结构变了，守卫必须重评）');
ok(!!M && /RoomStore\.getMode\(\)\s*===\s*['"]ws['"]/.test(M[1]),
  '★ canAddBot 源码仍带 getMode()===' + String.fromCharCode(39) + 'ws' + String.fromCharCode(39)
  + ' 门槛（要删门槛必须先把 hub._autoBots 的客户端路径补齐，否则死按钮+开局卡死）');

const PHASE = { WAITING: 'WAITING', SETTLED: 'SETTLED' };
const SM = {
  PHASE: PHASE,
  activePlayers: (r) => (r.players || []).filter((p) => !p.left),
  capOf: () => 5
};
const room = { phase: PHASE.WAITING, players: [{ id: 'me' }], dissolve: null };

function decide(mode, r, owner) {
  const RS = { getMode: () => mode };
  // eslint-disable-next-line no-new-func
  const fn = new Function('isOwner', 'room', 'nextWait', 'StateMachine', 'RoomStore', 'CONFIG',
    'return (' + M[1] + ');');
  return !!fn(owner, r, false, SM, RS, {});
}

console.log('\n[A] 门槛行为');
eq(decide('ws', room, true), true, '★ ws + 房主 + WAITING → 补 AI 可见（现有联机不能被弄坏）');
eq(decide('local', room, true), false, '★ local + 同条件 → 补 AI 隐藏（保护性门槛仍在）');
eq(decide('local', room, false), false, 'local + 非房主 → 仍然隐藏（权限门槛没被模式判断顶掉）');
eq(decide('ws', { phase: PHASE.WAITING, players: new Array(5).fill(0).map((_, i) => ({ id: 'p' + i })) }, true),
  false, 'ws + 满员 → 隐藏（容量门槛没被模式判断顶掉）');

console.log('\n[B] 门槛为什么不能删：local 路径确实不存在');
const localStub = /addBot:\s*function\s*\(\)\s*\{\s*return\s*\{\s*ok:\s*false[\s\S]{0,120}?\}\s*;\s*\}/.exec(RSRC);
ok(!!localStub, 'local.addBot 仍是硬桩（没有可用的本地模拟玩家路径）');
if (localStub) {
  // eslint-disable-next-line no-new-func
  const call = new Function('return (' + localStub[0].replace(/^addBot:\s*/, '') + ');')();
  const res = call();
  eq(res.ok, false, '★ 真跑 local.addBot → ok:false（删门槛就是造一个点了报错的死按钮）');
  ok(/不支持 AI 补位/.test(res.error || ''), '错误文案如实说明 local 不支持 AI 补位');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
