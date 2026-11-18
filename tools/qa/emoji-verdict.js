#!/usr/bin/env node
/**
 * tools/qa/emoji-verdict.js
 *
 * 用途：把「一档」的逐格 dump（NDJSON）汇总成**可交付的档级判定**。
 * 不联网、不占端口、不跑浏览器 —— 只吃 emoji-run-tier.js 落盘的 .jsonl。
 *
 * 为什么单独一个聚合器：摊在探针 stdout 里的 20 行，人眼看不出三件事 ——
 *   ① Q8 三数（定向 / 已署名 / 未署名）加起来是不是 20（漏计会让 ③ 变小、越绿越假）
 *   ② 兜底集合与署名集合是否逐条相等（不是数量相等）
 *   ③ 署名内容是否真的是**该气泡自己的**发送者（不是「有名字就行」）
 * 后两条直接复用 tools/qa/emoji-q10-signature.js 的 judge()，不重写判据。
 *
 * 用法：
 *   node tools/qa/emoji-verdict.js <tier.jsonl> [--players players.json] [--expect 20]
 *     --players  独立昵称 oracle：{"p2":"pal2","p3":"pal3",…}，来自**座位 fixture 配置**，
 *                不是实现输出。缺这个文件 → G16b 记「未测」，只判 G16a，不许当通过。
 *     --expect   该档应有格数，默认 20（六档已全部升为全覆盖，抽样档取消）
 *   node tools/qa/emoji-verdict.js --selftest
 *
 * 退出码：0 通过 / 1 不通过 / 3 有条件通过 / 2 用法或输入错误
 */

'use strict';

const fs = require('fs');
const { judge, normName } = require('./emoji-q10-signature.js');

const DEFAULTS = { unsignedMax: 2, signedMax: 8, expect: 20 };

function bucket(rec) {
  if (rec.q4b === true) return 'aimed';
  const signed = rec.byText != null && normName(rec.byText) !== '';
  return signed ? 'signed' : 'unsigned';
}

/**
 * N18「尾巴撒谎」—— 口径在跑实测前改过一次，记录原因：
 * 初版判 `|shift| <= 头像跨度/2`。用 390 真实 dump 一对就发现它是**错的**：
 * 行 `shift=275` 的气泡，尖端偏移实测 `-0.5`（完美对准）。因为 `shift` 是**气泡的位移量**，
 * 尾巴偏移会跟着补偿，两者不是一回事。按初版判，390 的 20 行里有 7 行会假红。
 * 现口径：**直接用 tip 与 face 的几何关系**（= 规格 §4.1「尖端仍落在头像跨度内」原话），
 * `shift` 只用来判「有没有测过」（字段缺失 = 未测），不参与超界判定。
 *   - N18b 字段缺失：仅对 `place ∈ {dir, stack}` 适用。兜底（fallback/self）没有对齐基准、
 *     本来就没算过位移，`shift: null` 是**如实表达**，不是未测。
 *   - N18a 超界：仅对非兜底格判，兜底格归 Q4b/Q8，不重复计。
 */
function checkShift(rec) {
  const out = [];
  const isFallback = rec.place === 'fallback' || rec.place === 'self';
  if (!isFallback) {
    const has = Object.prototype.hasOwnProperty.call(rec, 'shift') && rec.shift != null;
    if (!has) out.push(`N18: shift 字段缺失（place=${rec.place}）→ 该格记「未测」`);
  }
  if (isFallback) return out;
  const f = rec.face || rec.avatar;
  const t = rec.tip;
  if (!f || !t) return out;
  const horiz = rec.dir === 'up' || rec.dir === 'down';
  const span = horiz ? f.r - f.l : f.b - f.t;
  const ctr = horiz ? (f.l + f.r) / 2 : (f.t + f.b) / 2;
  const along = horiz ? t.x : t.y;
  const off = Math.abs(along - ctr);
  if (off > span / 2 + 0.5) {
    out.push(
      `N18: 尾巴撒谎 seat=${rec.seat} dir=${rec.dir} 尖端沿轴偏移 ${off.toFixed(1)} > 头像跨度/2 ${(span / 2).toFixed(1)}`
    );
  }
  return out;
}

function verdict(recs, opt) {
  const o = Object.assign({}, DEFAULTS, opt || {});
  const fails = [];
  const warns = [];
  const rows = [];

  const n = recs.length;
  let aimed = 0;
  let signed = 0;
  let unsigned = 0;
  for (const r of recs) {
    const b = bucket(r);
    if (b === 'aimed') aimed++;
    else if (b === 'signed') signed++;
    else unsigned++;
    rows.push({ seat: r.seat, from: r.from, dir: r.dir, place: r.place, bucket: b, by: normName(r.byText || '') });
  }

  // ---- N16：三数之和必须严格等于分母，不设容差 ----
  if (n !== o.expect) {
    fails.push(`N16: 格数 ${n} ≠ 应有 ${o.expect} → 该档判「未测」（分母错了一切结论都不成立）`);
  }
  if (aimed + signed + unsigned !== n) {
    fails.push(`N16: 三数之和 ${aimed + signed + unsigned} ≠ 格数 ${n}（计数逻辑错）`);
  }

  // ---- G15 预算 ----
  if (unsigned > o.unsignedMax) {
    fails.push(`G15: 不指人且未署名 = ${unsigned} > ${o.unsignedMax}（阻断项）`);
  }
  let conditional = false;
  if (signed > o.signedMax) {
    conditional = true;
    warns.push(
      `G15^: 不指人但已署名 = ${signed} > ${o.signedMax} → 最高「有条件通过」。` +
        '观察项不接出口，它就成了免检项'
    );
  }

  // ---- 署名「多」的那一小撮（重算副作用）分档 ----
  // 阈值先登记后用（team-lead 2026-11-14 拍定，先于实测；防「看到结果再定阈值」）：
  //   ≤2 正常副作用，不单列 / 3~9 报告单列 / ≥10 报 `reach` 判定位置可疑
  const extras = recs.filter((r) => r.q4b === true && r.byText != null && normName(r.byText) !== '');
  if (extras.length >= 10) {
    conditional = true;
    warns.push(
      `[G16a^] 重算副作用 ${extras.length} 条（≥10）→ 不叫副作用了，报「\`reach\` 判定位置可疑」，请施工方单独查；` +
        '本档因此降为「有条件通过」（可疑项不落通过）'
    );
  } else if (extras.length >= 3) {
    warns.push(`[G16a^] 重算副作用 ${extras.length} 条（3~9）→ 报告须单列「重算副作用 n 条」`);
  }


  for (const r of recs) for (const m of checkShift(r)) fails.push(m);

  // ---- G16：兜底集合 == 署名集合，逐条 ----
  const q10 = judge(
    {
      viewport: o.viewport || '',
      players: o.players || {},
      bubbles: recs.map((r) => ({
        seat: r.seat,
        from: r.from,
        dir: r.dir,
        q4b: r.q4b === true,
        byText: r.byText == null ? null : r.byText,
        byTruncated: r.byTruncated === true,
        byOwnTruncated: r.byOwnTruncated,
        fromName: r.fromName,
        bodyOriginal: r.bodyOriginal,
        bodyVisibleChars: r.bodyVisibleChars,
      })),
    },
    { strictScope: false, complete: o.complete === true }
  );
  const g16bCovered = !!(o.players && Object.keys(o.players).length);
  for (const f of q10.fails) fails.push('G16 ' + f);
  for (const w of q10.warns) warns.push('G16 ' + w);
  // G16b 有「未测」条目 → 署名内容没被验证过，不允许落「通过」，最高「有条件通过」。
  // 理由：未测占全绿的位置，正是最容易被洗成「通过」的地方。
  if (q10.warns.some((w) => w.includes('未测'))) {
    conditional = true;
    warns.push('G16b 存在「未测」条目 → 本档最高只能「有条件通过」（补 --players 后重跑可解除）');
  }
  if (!g16bCovered) {
    warns.push('G16b 未测：缺 --players（独立昵称 oracle）。本档只能证明「有署名」，不能证明「署名对」');
  }

  /* ---- 正向计数（2026-11-14 加）------------------------------------------
   * 为什么必须加：只打印失败/告警时，「0 失败 0 告警」与「这一项根本没跑」在输出上
   * 完全一样。「G16b 3/3」和「G16b 未执行」必须能区分，否则沉默会被读成通过。 */
  const signedBubbles = recs.filter((r) => normName(r.byText || '') !== '');
  const g16bUnmeasured = !g16bCovered || q10.warns.some((w) => w.includes('未测'));
  const ownTruncN = recs.filter((r) => r.byOwnTruncated !== undefined).length;
  const positives = [
    `G16a 兜底 ${recs.filter((r) => r.q4b !== true).length} 条 / 署名 ${signedBubbles.length} 条`
      + `（逐条对齐${q10.fails.some((f) => f.startsWith('10a')) ? ' ✗' : ' ✓'}）`,
    g16bUnmeasured
      ? 'G16b 内容比对 **未测**（未测不许当通过）'
      : `G16b 内容比对 ${signedBubbles.length}/${signedBubbles.length}（fromName 优先、fixture 交叉核对）`,
    ownTruncN
      ? `G16b' 署名是否被裁 已测（byOwnTruncated 覆盖 ${ownTruncN}/${recs.length} 行）`
      : "G16b' 署名是否被裁 **未测**（本份 dump 无 byOwnTruncated 键，只有被 `|| clipped` 污染的 byTruncated → 不能精确归因）",
  ];

  const status = fails.length ? 'fail' : conditional ? 'conditional' : 'pass';
  return { rows, fails, warns, counts: { n, aimed, signed, unsigned }, status, positives };
}

/* ------------------------------- 自验 ------------------------------- */
function mk(seat, from, dir, q4b, extra) {
  const face = { l: 100, t: 100, r: 160, b: 160 };
  const horiz = dir === 'up' || dir === 'down';
  const tip = horiz ? { x: 130, y: 90 } : { x: 90, y: 130 }; // 正好对准头像中心
  return Object.assign(
    { seat, from, dir, q4b, place: q4b ? 'dir' : 'fallback', shift: 0, face, tip },
    extra || {}
  );
}

const PLAYERS = { p1: '我', p2: 'pal2', p3: 'pal3', p4: 'pal4', p0: 'pal' };

function tierAimedAll() {
  // 5 座 × 4 类全定向 → 20 格全 aimed
  const out = [];
  for (const s of ['S1', 'pal2', 'pal3', 'pal4', 'pal']) {
    for (const c of [1, 2, 3, 4]) out.push(mk(s + '#' + c, 'p' + c, 'down', true));
  }
  return out;
}

const SAMPLES = [
  {
    name: '① 必命中：20 格全定向、无兜底 → pass',
    expect: 'pass',
    recs: tierAimedAll(),
    opt: { players: PLAYERS },
  },
  {
    name: '② 必不命中：18 格 + 只 dump 了 18 条（分母错） → fail/未测',
    expect: 'fail',
    recs: tierAimedAll().slice(0, 18),
    opt: { players: PLAYERS },
  },
  {
    name: '③ 必不命中：三座兜底全署「对方」，未署名=0 但内容全错 → fail',
    expect: 'fail',
    recs: tierAimedAll()
      .slice(0, 17)
      .concat([
        mk('pal2', 'p2', 'down', false, { byText: '对方：' }),
        mk('pal3', 'p3', 'down', false, { byText: '对方：' }),
        mk('pal', 'p0', 'down', false, { byText: '对方：' }),
      ]),
    opt: { players: PLAYERS },
  },
  {
    name: '④ 必不命中：兜底未署名 3 条 > 2（阻断项） → fail',
    expect: 'fail',
    recs: tierAimedAll()
      .slice(0, 17)
      .concat([mk('pal2', 'p2', 'down', false), mk('pal3', 'p3', 'down', false), mk('pal', 'p0', 'down', false)]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑤ 有条件通过：已署名 9 条 > 8，但未署名 0 → conditional',
    expect: 'conditional',
    recs: tierAimedAll()
      .slice(0, 11)
      .concat([
        mk('pal2', 'p2', 'down', false, { byText: 'pal2：' }),
        mk('pal2', 'p2', 'down', false, { byText: 'pal2：' }),
        mk('pal3', 'p3', 'down', false, { byText: 'pal3：' }),
        mk('pal3', 'p3', 'down', false, { byText: 'pal3：' }),
        mk('pal4', 'p4', 'down', false, { byText: 'pal4：' }),
        mk('pal4', 'p4', 'down', false, { byText: 'pal4：' }),
        mk('pal', 'p0', 'down', false, { byText: 'pal：' }),
        mk('pal', 'p0', 'down', false, { byText: 'pal：' }),
        mk('p1', 'p1', 'down', false, { byText: '我：' }),
      ]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑥ 必不命中：place=dir 却缺 shift 字段 → N18 记未测、判 fail',
    expect: 'fail',
    recs: tierAimedAll()
      .slice(0, 19)
      .concat([
        (() => {
          const r = mk('pal', 'p0', 'down', true);
          delete r.shift;
          return r;
        })(),
      ]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑥b 误伤对照：兜底格 shift=null 是如实表达，不是未测 → 不许判红',
    expect: 'pass',
    recs: tierAimedAll()
      .slice(0, 19)
      .concat([mk('pal', 'p0', 'down', false, { shift: null, byText: 'pal：' })]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑦ 必不命中：尾巴撒谎（尖端沿轴偏移超出头像跨度/2）→ fail',
    expect: 'fail',
    recs: tierAimedAll()
      .slice(0, 19)
      .concat([mk('pal', 'p0', 'down', true, { tip: { x: 200, y: 90 } })]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑦b 误伤对照：shift 很大但尖端仍对准头像 → 不许判红（实测长短语合法位移达 124，tip 偏移 0.0）',
    expect: 'pass',
    recs: tierAimedAll()
      .slice(0, 19)
      .concat([mk('pal', 'p0', 'down', true, { shift: 275 })]),
    opt: { players: PLAYERS },
  },
  {
    name: '⑧ 边界：无 --players 且有条目需判署名 → G16b「未测」→ 最高 conditional（未测不许占全绿）',
    expect: 'conditional',
    recs: tierAimedAll()
      .slice(0, 19)
      .concat([mk('pal2', 'p2', 'down', false, { byText: '陪练2：' })]),
    opt: {},
  },
  {
    name: '⑨ 重算副作用 5 条（3~9 档）→ 仍然 pass，但必须单列告警',
    expect: 'pass',
    recs: tierAimedAll()
      .slice(0, 15)
      .concat(tierAimedAll().slice(15).map((r) => Object.assign({}, r, { byText: PLAYERS[r.from] + '：' }))),
    opt: { players: PLAYERS },
  },
  {
    name: '⑩ 重算副作用 10 条（≥10 档）→ 报 reach 判定位置可疑，降为 conditional',
    expect: 'conditional',
    recs: tierAimedAll()
      .slice(0, 10)
      .concat(tierAimedAll().slice(10).map((r) => Object.assign({}, r, { byText: PLAYERS[r.from] + '：' }))),
    opt: { players: PLAYERS },
  },
  {
    /* 2026-11-14 加：这份 dump 就是缺 byOwnTruncated 的旧版（320 的 f6ec6e9f 那版）。
     * 要点：缺这个键 → G16b' 记「未测」，但**不许因此阻断**（它是归因精度，不是合规性）。
     * 同时 `shift: 0` 一律由 mk() 默认给，本样本也就顺带证明了 **0 不是「缺失」**（falsy 陷阱）。 */
    name: "⑬ 缺 byOwnTruncated 键 → G16b' 未测，但不阻断 → pass",
    expect: 'pass',
    recs: tierAimedAll()
      .slice(0, 17)
      .concat([
        mk('pal2', 'p2', 'down', false, { byText: 'pal2：' }),
        mk('pal3', 'p3', 'down', false, { byText: 'pal3：' }),
        mk('pal', 'p0', 'down', false, { byText: 'pal：' }),
      ]),
    opt: { players: PLAYERS },
  },
  {
    /* 反向对照：**给了 byOwnTruncated: true**（署名自己被裁）必须判红 —— 否则「未测不阻断」
     * 会退化成「这一项永远不会红」。 */
    name: '⑬b 必命中：byOwnTruncated=true（署名自己被裁）→ fail',
    expect: 'fail',
    recs: tierAimedAll()
      .slice(0, 17)
      .concat([
        mk('pal2', 'p2', 'down', false, { byText: 'pal2：', byOwnTruncated: true }),
        mk('pal3', 'p3', 'down', false, { byText: 'pal3：', byOwnTruncated: false }),
        mk('pal', 'p0', 'down', false, { byText: 'pal：', byOwnTruncated: false }),
      ]),
    opt: { players: PLAYERS },
  },
];

function runSelfTest() {
  let ok = 0;
  const lines = [];
  for (const s of SAMPLES) {
    const r = verdict(s.recs, s.opt);
    const good = r.status === s.expect;
    if (good) ok++;
    lines.push(`  ${good ? 'PASS' : 'FAIL'}  ${s.name} → ${r.status}（期望 ${s.expect}）`);
    if (r.fails.length) lines.push(`        首条：${r.fails[0]}`);
  }
  console.log(lines.join('\n'));
  console.log(`\n自验：通过 ${ok} 项，失败 ${SAMPLES.length - ok} 项`);
  return ok === SAMPLES.length;
}

/* ------------------------------- CLI -------------------------------- */
function readJsonl(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`第 ${l.slice(0, 40)}… 不是合法 JSON 行`);
      }
    });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest') || args.length === 0) {
    process.exit(runSelfTest() ? 0 : 1);
  }
  const file = args.find((a) => !a.startsWith('--'));
  const pi = args.indexOf('--players');
  const ei = args.indexOf('--expect');
  let players = null;
  if (pi >= 0 && args[pi + 1]) players = JSON.parse(fs.readFileSync(args[pi + 1], 'utf8'));
  const expect = ei >= 0 && args[ei + 1] ? parseInt(args[ei + 1], 10) : DEFAULTS.expect;

  let recs;
  try {
    recs = readJsonl(file);
  } catch (e) {
    console.error('读 dump 失败：' + e.message);
    process.exit(2);
  }

  const vp = (recs[0] && recs[0].viewport) || file;
  const r = verdict(recs, { players, expect, viewport: vp });

  console.log(`== ${vp} ==  格数 ${r.counts.n}（应 ${expect}）`);
  console.log(`  定向 ${r.counts.aimed} / 已署名 ${r.counts.signed} / 未署名 ${r.counts.unsigned}` +
    `   和=${r.counts.aimed + r.counts.signed + r.counts.unsigned}`);
  console.log('\n  已执行的判据（通过也报数，防「沉默被读成通过」）：');
  for (const p of r.positives) console.log('   · ' + p);
  if (r.warns.length) {
    console.log('\n  WARN：');
    for (const w of r.warns) console.log('   - ' + w);
  }
  if (r.fails.length) {
    console.log('\n  FAIL：');
    for (const f of r.fails) console.log('   - ' + f);
  }
  const label = r.status === 'pass' ? '通过' : r.status === 'conditional' ? '有条件通过' : '不通过';
  console.log(`\n结论：${label}（失败 ${r.fails.length} 条，告警 ${r.warns.length} 条）`);
  process.exit(r.status === 'pass' ? 0 : r.status === 'conditional' ? 3 : 1);
}

main();
