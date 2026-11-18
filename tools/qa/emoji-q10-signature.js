#!/usr/bin/env node
/**
 * tools/qa/emoji-q10-signature.js
 *
 * 用途：Q10「兜底署名」的**离线**判定器（规格 v2.5 §4.3 / §6 Q10）。
 * 不联网、不占端口、不依赖浏览��。输入是一份「DOM 快照 JSON」，输出 pass/fail + 逐条明细。
 *
 * 为什么要单独一个工具：Q10 的阈值「署名覆盖率 100%」可被一句 `昵称 = '对方'` 硬编码
 * 全部骗过 —— 覆盖率仍然是 100%，但归属一点没解决。所以 Q10 必须拆成两条定级 + 一条前置：
 *   10a 数量口径：兜底条集合 == 署名条集合（双向相等，不是数量相等）
 *   10b 内容口径：每条署名的规范化文本 == 该气泡**自己**的发送者在 players 里的昵称
 *   10c 样本前置：只 WARN 不定级（见下文「自我修正记录」）
 * 本工具的 must-miss 样本就是「三个不同座位全署同一个名字、覆盖率 100%」——
 * 只有 10a 的检查器会把它判绿，10a+10b 齐上才判红。
 *
 * 昵称 oracle（独立来源，不读实现）：`state.room.players[from].name`。
 * 规格允许「取不到用『对方』」，所以 players 里**存在**该 from 时署名却写成「对方」=
 * 取名字段接错（记 FAIL）；players 里**不存在**该 from 时写「对方」= 合法（记 WARN）。
 *
 * 用法：
 *   node tools/qa/emoji-q10-signature.js                  # 跑自验（默认）
 *   node tools/qa/emoji-q10-signature.js snap.json        # 判一份快照
 *   node tools/qa/emoji-q10-signature.js snap.json --strict-scope
 *        --strict-scope：非兜底气泡也挂了署名 → 由 WARN 升为 FAIL。
 *        默认只 WARN，理由是「一律署名」属于设计主张不同，但它会让 Q10 失去区分力，
 *        必须在报告里显式写明，不能当「更严格所以更好」吞掉。
 *
 * 快照 JSON 结构（探针 dump 时照此拼）：
 * {
 *   "viewport": "390x844",
 *   "players": { "p1": "阿宝", "p2": "pal2" },          // state.room.players
 *   "bubbles": [
 *     { "seat": "pal2", "from": "p2", "dir": "down",
 *       "q4b": false,                                    // 该气泡 Q4b 是否通过（探针算）
 *       "byText": "pal2：",                              // .emoji-by textContent；无该元素则 null
 *       "byTruncated": false,                            // scrollWidth > clientWidth + 1
 *       "bodyOriginal": "今晚这把我要赢回来",              // 原文（无署名）
 *       "bodyVisibleChars": 9 }                          // 正文可见字符数（Q7 交叉项）
 *   ]
 * }
 *
 * 退出码：0 = 全通过；1 = 有 FAIL；2 = 输入/用法错误。
 */

'use strict';

const fs = require('fs');

const NAME_FALLBACK = '对方';
// 规范化：trim、全角冒号/半角冒号及空白去掉、连续空白压一格
function normName(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\u00a0|\u3000/g, ' ')
    .trim()
    .replace(/[\s:：]+$/g, '')
    .trim();
}

function judge(snap, opt) {
  const strictScope = !!(opt && opt.strictScope);
  const players = snap.players || {};
  const bubbles = Array.isArray(snap.bubbles) ? snap.bubbles : [];
  const fails = [];
  const warns = [];
  const rows = [];

  if (bubbles.length === 0) {
    fails.push('空样本：bubbles 长度为 0，Q10 不可判定（不是通过）');
    return { rows, fails, warns };
  }

  const fallback = bubbles.filter((b) => b.q4b === false);
  const signed = bubbles.filter((b) => b.byText != null && normName(b.byText) !== '');
  const fallbackSet = new Set(fallback.map((b) => b.seat + '@' + b.from));
  const signedSet = new Set(signed.map((b) => b.seat + '@' + b.from));

  // ---- 10a 数量口径：双向集合相等 ----
  const missing = fallback.filter((b) => !signedSet.has(b.seat + '@' + b.from));
  const extra = signed.filter((b) => !fallbackSet.has(b.seat + '@' + b.from));
  for (const b of missing) {
    fails.push(`[10a] 兜底未署名：seat=${b.seat} from=${b.from} dir=${b.dir}`);
  }
  for (const b of extra) {
    const msg = `[10a^] 非兜底也署名：seat=${b.seat} from=${b.from} q4b=true by="${normName(b.byText)}"`;
    if (strictScope) fails.push(msg + '（--strict-scope）');
    else
      warns.push(
        msg +
          ' → 合规（规格只要求兜底必须有）。合法来源只有一个：加署名导致尺寸变化、重算后变得指得到。' +
          '若此类条目**大面积**出现，那不是署名逻辑问题，是 `reach` 判定位置有问题，单独报'
      );
  }

  // ---- 10b 内容口径：逐条比对发送者真实昵称 ----
  // 期望值优先级（v2.7）：
  //   ① `fromName`（dump 每行带的「发送者真实昵称」，从座位块 title 独立读）—— **用户视角的真值**：
  //      用户要把「气泡上的署名」和「座位上显示的名字」对上，对不上就是缺陷，与 players 数据无关；
  //   ② fixture `players[from]`（测试夹具常量）—— 真正独立的锚点，用来发现 ① 漂移；
  //   ③ 两者都没有 → G16d 记「未测」，不猜。
  // 三者一起构成链条：byText ↔ fromName ↔ fixture。只留 ① 会漏「数据本身就错」，
  // 只留 ② 会漏「座位显示与数据不一致」。**只用一个都不是真值。**
  for (const b of signed) {
    const fromName = normName(b.fromName);
    const fixtureName = normName(players[b.from] || '');
    if (fromName && fixtureName && fromName !== fixtureName) {
      warns.push(
        `[10b~] oracle 漂移：seat=${b.seat} 页面 fromName="${fromName}" ≠ fixture="${fixtureName}"` +
          ' —— 这是**尺子**与夹具不一致，不是产品缺陷；本条以 fromName 为准判，并须报给施工方核对夹具'
      );
    }
    const expected = fromName || fixtureName || null;
    const got = normName(b.byText);
    if (expected) {
      if (got !== expected) {
        // 覆盖错误属于「串座」，比字段接错更严重
        const isOtherSeat = Object.keys(players).some(
          (k) => k !== b.from && normName(players[k]) === got
        );
        fails.push(
          `[10b] 署名与发送者不符：seat=${b.seat} from=${b.from} 期望="${expected}"（来源=${fromName ? 'fromName' : 'fixture'}）实得="${got}"` +
            (isOtherSeat ? '（撞到另一个座位的名字 = 串座）' : '')
        );
      }
    } else {
      // players 里没有这个 from：**我没有真值**，所以不能判对错，只能判「规格兜底写法」是否被遵守
      if (opt && opt.complete) {
        // --complete 表示这份 players 是齐全的 → 缺键才说明实现读到了不该有的名字
        if (got !== normName(NAME_FALLBACK)) {
          fails.push(
            `[10b] players(complete) 缺 from=${b.from}，按规格应写「${NAME_FALLBACK}」，实得="${got}"`
          );
        } else {
          warns.push(`[10b] from=${b.from} 在 players 里取不到名 → 用了「${NAME_FALLBACK}」（规格允许，但请核对是否该有名字）`);
        }
      } else {
        warns.push(
          `[10b] 未测：oracle 缺 from=${b.from} 的昵称，本条无法判定对错（实得="${got}"）。` +
            '补齐 players 后重跑，或加 --complete 声明这份 players 齐全'
        );
      }
    }
    rows.push({ seat: b.seat, from: b.from, dir: b.dir, q4b: b.q4b, by: got });
  }

  // ---- 10c 区分力口径（只 WARN，不 FAIL）----
  // 自我修正记录：10c 初稿把「不同发送者署名全同」写成 FAIL。测过才知道那是**误伤**——
  // 两名玩家真叫同一个昵称时，实现照着 players 写名字是**正确**的，判红就是拿数据撞名
  // 去怪实现。而「硬编码一个人名」这种假绿，10b 的逐条比对已经挡死了（样本②）。
  // 所以 10c 降级为**样本前置条件检查**：它只回答「这份样本够不够力」，不参与定级。
  const byFrom = new Map();
  for (const b of signed) {
    if (!byFrom.has(b.from)) byFrom.set(b.from, new Set());
    byFrom.get(b.from).add(normName(b.byText));
  }
  const distinctFrom = [...byFrom.keys()].filter((f) => normName(players[f] || '') !== '');
  const named = distinctFrom.map((f) => normName(players[f]));
  const dupNames = new Set(named).size < named.length;
  if (dupNames) {
    warns.push(
      `[10c] 本档有两个座位昵称撞名（"${named.join('" / "')}"）：Q10 内容口径对这两条不可区分，` +
        '请在报告里注明「该档署名只能证明有名字、不能证明归属唯一」'
    );
  }
  if (distinctFrom.length < 2) {
    warns.push('[10c] 样本里可用的不同发送者 < 2：挡不住「恒写一个人名」，请补一条不同座位的样本');
  }
  if (distinctFrom.length >= 2 && !dupNames) {
    const expectDistinct = new Set(named).size;
    const gotDistinct = new Set(signed.map((b) => normName(b.byText))).size;
    if (gotDistinct < expectDistinct) {
      // 若走到这里说明 10b 已经红过了；这里只补一句「有几条同值」帮助定位
      warns.push(`[10c] ${expectDistinct} 个不同昵称只落出 ${gotDistinct} 种署名（10b 应已报出具体条目）`);
    }
  }

  // ---- 截断：署名被裁等于没署名 ----
  // 字段说明：优先用 `byOwnTruncated`（只表达 .emoji-by 自己是否被裁）。
  // 若探针只给了 `byTruncated`（= 署名被裁 **或** 整个气泡被裁，`|| clipped`），
  // 就不能把它当成「署名被裁」来报 —— 那是把气泡的 G10 缺陷写到署名头上，属于误归因。
  for (const b of signed) {
    if (b.byOwnTruncated === true) {
      fails.push(`[10b^] 署名被裁：seat=${b.seat} by="${normName(b.byText)}"（scrollWidth > clientWidth）`);
    } else if (b.byOwnTruncated == null && b.byTruncated === true) {
      fails.push(
        `[10b^] 署名或气泡被裁（字段未分离）：seat=${b.seat} by="${normName(b.byText)}"` +
          ' —— byTruncated 含 `|| clipped`，可能只是正文被裁，缺陷归属待 byOwnTruncated 分离'
      );
    }
  }

  // ---- Q7 交叉项：加了前缀后正文是否被挤掉字 ----
  for (const b of signed) {
    if (typeof b.bodyOriginal === 'string' && typeof b.bodyVisibleChars === 'number') {
      if (b.bodyVisibleChars < b.bodyOriginal.length) {
        fails.push(
          `[Q7^] 署名挤掉正文：seat=${b.seat} 原文 ${b.bodyOriginal.length} 字，可见 ${b.bodyVisibleChars} 字`
        );
      }
    }
  }

  return { rows, fails, warns };
}

/* ------------------------------------------------------------------ */
/* 自验：4 个已知答案样本，≥1 必命中、≥1 必不命中                          */
/* ------------------------------------------------------------------ */
const PL = { p1: '阿宝', p2: 'pal2', p3: 'pal3' };

const SAMPLES = [
  {
    name: '① 必命中：两条兜底各自署名且互不相同 → PASS',
    expect: 'pass',
    snap: {
      viewport: '390x844',
      players: PL,
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: false, bodyOriginal: '今晚这把我要赢回来', bodyVisibleChars: 9 },
        { seat: 'pal3', from: 'p3', dir: 'down', q4b: false, byText: 'pal3：', byTruncated: false, bodyOriginal: '今晚这把我要赢回来', bodyVisibleChars: 9 },
        { seat: 'S1', from: 'p1', dir: 'up', q4b: true, byText: null, byTruncated: false, bodyOriginal: '今晚这把我要赢回来', bodyVisibleChars: 9 },
      ],
    },
  },
  {
    name: '② 必不命中（假绿）：三个不同座位全署「对方」，覆盖率 100% → FAIL',
    expect: 'fail',
    snap: {
      viewport: '390x844',
      players: PL,
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: '对方：', byTruncated: false },
        { seat: 'pal3', from: 'p3', dir: 'down', q4b: false, byText: '对方：', byTruncated: false },
        { seat: 'S1', from: 'p1', dir: 'up', q4b: false, byText: '对方：', byTruncated: false },
      ],
    },
  },
  {
    name: '③ 必不命中：漏一条（兜底 2 条只署 1 条） → FAIL',
    expect: 'fail',
    snap: {
      viewport: '320x568',
      players: PL,
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: false },
        { seat: 'pal3', from: 'p3', dir: 'down', q4b: false, byText: null, byTruncated: false },
      ],
    },
  },
  {
    name: '④ 必不命中：串座（pal3 的气泡署了 pal2 的名字） → FAIL',
    expect: 'fail',
    snap: {
      viewport: '390x844',
      players: PL,
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: false },
        { seat: 'pal3', from: 'p3', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: false },
      ],
    },
  },
  {
    name: '⑤ 边界：players 里没有该 from → 写「对方」合法（PASS + WARN）',
    expect: 'pass',
    snap: {
      viewport: '800x600',
      players: { p1: '阿宝' },
      bubbles: [{ seat: 'pal2', from: 'zz', dir: 'down', q4b: false, byText: '对方：', byTruncated: false }],
    },
  },
  {
    name: '⑥ 边界：署名被裁 / 正文被挤掉字 → FAIL',
    expect: 'fail',
    snap: {
      viewport: '320x568',
      players: PL,
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: true, bodyOriginal: '今晚这把我要赢回来', bodyVisibleChars: 7 },
      ],
    },
  },
  {
    name: '⑦ 误伤对照：两个座位真叫同一个昵称，实现照抄是**对的** → PASS + WARN（不许判红）',
    expect: 'pass',
    snap: {
      viewport: '390x844',
      players: { p2: '小明', p3: '小明' },
      bubbles: [
        { seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: '小明：', byTruncated: false },
        { seat: 'pal3', from: 'p3', dir: 'down', q4b: false, byText: '小明：', byTruncated: false },
      ],
    },
  },
  {
    name: '⑨ 精确归因：byOwnTruncated=true（只署名被裁）→ FAIL，且报「署名被裁」不是「或气泡」',
    expect: 'fail',
    snap: {
      viewport: '320x568',
      players: PL,
      bubbles: [{ seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', byTruncated: true, byOwnTruncated: true }],
    },
  },
  {
    name: '⑩ fromName 优先：署名跟 fixture 一致、但与页面 fromName 不一致 → FAIL（证明 fromName 真在判）',
    expect: 'fail',
    snap: {
      viewport: '390x844',
      players: { p2: 'pal2' },
      bubbles: [{ seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: 'pal2：', fromName: '陪练2' }],
    },
  },
  {
    name: '⑪ oracle 漂移：fromName ≠ fixture，但署名 == fromName → PASS + WARN（尺子不一致不是产品缺陷）',
    expect: 'pass',
    snap: {
      viewport: '390x844',
      players: { p2: 'pal2' },
      bubbles: [{ seat: 'pal2', from: 'p2', dir: 'down', q4b: false, byText: '陪练2：', fromName: '陪练2' }],
    },
  },
  {
    name: '⑧ 边界：--complete 声明 players 齐全，缺键却写了真名（不是「对方」） → FAIL',
    expect: 'fail',
    opt: { complete: true },
    snap: {
      viewport: '390x844',
      players: { p1: '阿宝' },
      bubbles: [{ seat: 'pal2', from: 'zz', dir: 'down', q4b: false, byText: '我：', byTruncated: false }],
    },
  },
];

function runSelfTest() {
  let ok = 0;
  const det = [];
  for (const s of SAMPLES) {
    const r = judge(s.snap, Object.assign({ strictScope: false }, s.opt || {}));
    const verdict = r.fails.length === 0 ? 'pass' : 'fail';
    const good = verdict === s.expect;
    if (good) ok++;
    det.push(`  ${good ? 'PASS' : 'FAIL'}  ${s.name} → ${verdict}（期望 ${s.expect}）`);
    if (r.fails.length) det.push(`        首条：${r.fails[0]}`);
  }
  console.log(det.join('\n'));
  console.log(`\n自验：通过 ${ok} 项，失败 ${SAMPLES.length - ok} 项`);
  return ok === SAMPLES.length;
}

function main() {
  const args = process.argv.slice(2);
  const strictScope = args.includes('--strict-scope');
  const complete = args.includes('--complete');
  const file = args.find((a) => !a.startsWith('--'));

  if (!file) {
    const good = runSelfTest();
    process.exit(good ? 0 : 1);
  }

  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`读取快照失败：${e.message}`);
    process.exit(2);
  }

  const r = judge(snap, { strictScope, complete });
  console.log(`== Q10 兜底署名 · ${snap.viewport || '?'} ==`);
  console.log('  seat      from  dir   q4b   署名');
  for (const row of r.rows) {
    console.log(`  ${String(row.seat).padEnd(9)} ${String(row.from).padEnd(5)} ${String(row.dir).padEnd(5)} ${String(row.q4b).padEnd(5)} "${row.by}"`);
  }
  if (r.warns.length) {
    console.log('\n  WARN：');
    for (const w of r.warns) console.log('   - ' + w);
  }
  if (r.fails.length) {
    console.log('\n  FAIL：');
    for (const f of r.fails) console.log('   - ' + f);
    console.log(`\n结论：不通过（${r.fails.length} 条）`);
    process.exit(1);
  }
  console.log('\n结论：通过');
}

// 既可作为 CLI 直接用，也可被 emoji-verdict.js require 复用（不重写判据）
module.exports = { judge, normName, NAME_FALLBACK };

if (require.main === module) main();

