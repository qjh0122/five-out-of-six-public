/**
 * 变异自证器（跨轮次复用，QA 验收用）
 *
 * 为什么需要它：验收整改批次时，"守卫是绿的"不能证明"守卫抓得住"。
 * 唯一可信的证据是——把问题状态改回去，守卫必须红；还原后必须绿。
 * 而还原必须是**逐字节**的，否则下一轮 diff 里会混进取证残留。
 *
 * 用法：
 *   node tools/qa/mutate-verify.js <case-id>
 *   node tools/qa/mutate-verify.js --list
 *
 * 每个 case 自带：目标文件、原文片段、变异后片段、要跑哪个守卫。
 * 执行顺序：记 SHA-256 → 精确替换（必须命中恰好 1 次）→ 跑守卫（期望红）
 *          → 从原始字节还原 → 复核 SHA-256 相等 → 再跑守卫（期望绿）。
 * 任何一步不符预期，exit 1，并打印是哪一步。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/** 变异用例。find 必须唯一命中，否则视为用例本身失效（防止改错地方还以为验过了）。 */
const CASES = {
  /* P0-4：isElevation 逐层判定。往第 2 层塞一条裸黑外投影。
   * 旧分类器只看 layers[0]（inset 在前），这条会被漏放 → 必须红。 */
  'p0-4-second-layer': {
    file: 'pwa/css/style.css',
    find: 'box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), var(--elev-1);',
    replace: 'box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 10px 24px rgba(0, 0, 0, 0.4);',
    guard: 'pwa/test/design-tokens.test.js'
  },
  /* P0-6 相邻：JS 内联裸投影回潮（P0-4 的 JS 半边）。 */
  'p0-4-js-inline': {
    file: 'pwa/js/cardView.js',
    find: 'box-shadow:var(--elev-2);',
    replace: 'box-shadow:0 16px 32px rgba(0,0,0,0.45);',
    guard: 'pwa/test/design-tokens.test.js'
  },
  /* P0-3：删掉 --text-main 定义 → 4 处 var() 变成悬空引用。 */
  'p0-3-text-main': {
    file: 'pwa/css/style.css',
    find: '  --text-main: #f5f0e6;\n',
    replace: '',
    guard: 'pwa/test/design-tokens.test.js'
  },
  /* P0-1：冠军块净胜改回 30px —— 同屏两套字号的原始缺陷。 */
  'p0-1-sc-net': {
    file: 'pwa/css/style.css',
    find: '.sc-net { margin: 0; font-size: var(--num-2);',
    replace: '.sc-net { margin: 0; font-size: 30px;',
    guard: 'pwa/test/number-scale.test.js'
  },
  /* P1-P5 文案：清除按钮改回「清除记录」。 */
  'p1-clear-records': {
    file: 'pwa/index.html',
    find: 'type="button">清除战绩</button>',
    replace: 'type="button">清除记录</button>',
    guard: 'pwa/test/ui-copy-consistency.test.js'
  },
  /* P1-P6 交互：结算页次级按钮退回裸 .btn（变体归零）。 */
  'p1-btn-share': {
    file: 'pwa/index.html',
    find: '<button id="btn-share" class="btn btn-quiet btn-lg">',
    replace: '<button id="btn-share" class="btn btn-lg">',
    guard: 'pwa/test/interaction-consistency.test.js'
  },
  /* U4：删掉 onHoldNext 里那一行 restore 防御（`if (!restore) return;` 全站 13 处，
   * 所以带上它下面的 try + holdNext 才能唯一命中）。 */
  'u4-hold-restore': {
    file: 'pwa/js/game.js',
    find: '    if (!restore) return;\n    try {\n      var res = await RoomStore.holdNext',
    replace: '    try {\n      var res = await RoomStore.holdNext',
    guard: 'pwa/test/interaction-consistency.test.js'
  },
  /* 反向探针（期望**绿**）：运行时量词回潮，但该节点没有正面断言。
   * 这条不是"变异自证"，是**守卫盲区探针** —— 若它红了，说明守卫比我们以为的强。 */
  'probe-runtime-quantifier': {
    file: 'pwa/js/recordsView.js',
    find: "'当前 ' + st.games + ' 局战绩将被删除'",
    replace: "'当前 ' + st.games + ' 场战绩将被删除'",
    guard: 'pwa/test/ui-copy-consistency.test.js',
    expect: 'green'
  },
  /* 僵尸检查探针：删掉圆角几何豁免里的一条（`28px 28px 0 0` 只此一处），
   * 豁免表若没做僵尸检查，删掉后守卫仍然绿 = 豁免已腐化成免责声明。 */
  'zombie-radius-allow': {
    file: 'pwa/css/style.css',
    find: '  border-radius: 28px 28px 0 0;\n',
    replace: '  border-radius: var(--r-modal);\n',
    guard: 'pwa/test/design-tokens.test.js'
  }
};

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function runGuard(rel) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/.exec(out);
  return { status: r.status, out: out, pass: m ? +m[1] : null, fail: m ? +m[2] : null };
}

function main() {
  const id = process.argv[2];
  if (id === '--list' || !id) {
    console.log('可用变异用例：');
    Object.keys(CASES).forEach((k) => console.log('  ' + k + '  →  ' + CASES[k].guard));
    process.exit(id === '--list' ? 0 : 1);
  }
  const c = CASES[id];
  if (!c) { console.error('没有这个用例：' + id); process.exit(1); }

  const abs = path.join(ROOT, c.file);
  const original = fs.readFileSync(abs);
  const before = sha(abs);
  const text = original.toString('utf8');
  const hits = text.split(c.find).length - 1;
  if (hits !== 1) {
    console.error('✗ 用例失效：原文片段命中 ' + hits + ' 次（要求恰好 1 次）—— 拒绝执行，避免改错地方');
    process.exit(1);
  }

  console.log('=== 变异用例 ' + id + ' ===');
  console.log('文件：' + c.file);
  console.log('变异前 SHA-256：' + before);
  console.log('守卫：' + c.guard);

  const wantRed = c.expect !== 'green';
  let okAll = true;
  try {
    fs.writeFileSync(abs, text.replace(c.find, c.replace));
    const red = runGuard(c.guard);
    console.log('\n--- 问题状态（期望' + (wantRed ? '红' : '绿=盲区探针') + '）---');
    console.log('exit=' + red.status + '  通过 ' + red.pass + ' 项，失败 ' + red.fail + ' 项');
    const failLines = red.out.split('\n').filter((l) => /^\s+FAIL\s/.test(l)).slice(0, 6);
    console.log(failLines.join('\n') || '(没有 FAIL 行)');
    const isRed = red.status !== 0 && red.fail > 0;
    if (wantRed && !isRed) { console.log('✗ 期望红，实际没红 —— 守卫抓不住这个问题'); okAll = false; }
    if (!wantRed && isRed) { console.log('→ 盲区探针：守卫其实抓得住（比预期强）'); okAll = true; }
    if (!wantRed && !isRed) { console.log('→ 盲区确认：守卫对此变异无反应（此节点无断言覆盖）'); okAll = true; }
  } finally {
    fs.writeFileSync(abs, original);           // 逐字节还原：写回原始 Buffer
  }

  const after = sha(abs);
  console.log('\n--- 还原 ---');
  console.log('还原后 SHA-256：' + after);
  const restored = after === before;
  console.log(restored ? 'SHA-256 逐字节一致 ✓' : '✗ 还原不一致！');
  if (!restored) { okAll = false; }

  const green = runGuard(c.guard);
  console.log('\n--- GREEN（还原后）---');
  console.log('exit=' + green.status + '  通过 ' + green.pass + ' 项，失败 ' + green.fail + ' 项');
  if (!(green.status === 0 && green.fail === 0)) { console.log('✗ 期望绿，实际没绿'); okAll = false; }

  console.log('\n' + (okAll ? '结论：变异自证成立（红 → 还原逐字节一致 → 绿）' : '结论：不成立'));
  process.exit(okAll ? 0 : 1);
}

main();
