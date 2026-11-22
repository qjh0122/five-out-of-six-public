#!/usr/bin/env node
/**
 * 「这一段到底跑了没有」的清单 —— 单一来源
 *
 * ── 为什么需要它（不是形式主义）──────────────────────────────────────
 * 探针的退出码只说明"没有失败"，说明不了"断言真的执行过"。历史上
 * `probe-ui-flow.js` 就因为视口清单被 YAML 里的全角字符改坏，**安静地跑了 0 个视口
 * 然后通过**（见该文件 982-990 的注释）。所以 CI 里另有一层闸门：核日志。
 *
 * 但闸门原来把中文段标题**抄在 workflow 里**。产品一改（离开房间直接退、撤销条
 * 从「场」改成「局」），功能与断言一起删/改，YAML 那份没跟 —— journey job
 * 从 11-18 起每一步都在要求一段永远不存在的输出，必红，而私库全绿。
 *
 * 结论：段标题与断言条数只有一份，**探针打印它、CI 核它**，两边都不许自己写。
 *
 * ── 三个字段各守一件事 ────────────────────────────────────────────────
 *   segments   段落跑过来了吗（探针用同一份字符串打印段标题）
 *   mustSee    关键断言真的执行了吗（防止某段里的断言被注释掉/条件跳过）
 *   expectPass 断言条数对不对（**断言清单**：删一条也算改口径，必须显式同步）
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/lib/ci-need.js --verify undo /tmp/u.log   # 退出码 0 / 3
 *   node scripts/lib/ci-need.js --segments undo            # 打印段标题（调试用）
 *
 * 退出码：0 通过；3 闸门失败（日志里缺东西，不是探针自己红）；2 用法错。
 */
'use strict';

const fs = require('fs');

/* 段标题与断言名必须与探针里**同一份字符串**：探针从这里取，不自己写。
 * expectPass 是断言清单（跑出来多少条就是多少条，加减断言要同轮改这里 ——
 * 这是故意的摩擦：静默删掉一条断言不该是无声的）。 */
const PROBES = {
  undo: {
    label: '撤销条',
    segments: [
      '[1] 打开战绩页，确认有数据',
      '[2] 确认清除 → 条子弹出，但记录还在',
      '[3] 点「撤销」→ 一切回到没清过的样子',
      '[4] 再确认一次，这次不撤销 → 5 秒后真的清掉',
      '[5] 条子隐藏后不占位'
    ],
    mustSee: ['零重叠', '撤销按钮够高'],
    expectPass: 19              // 实跑：390×844 与 320×568 都是 19 条
  },
  undoNarrow: {
    label: '撤销条·320 窄屏',
    /* 窄屏与主档是**同一支探针**：段标题与判据都复用 undo 那份，不另立清单。
     * 留着这个别名是因为 CI 里它是一条独立的 check，红的时候要说清是哪一档。 */
    segments: null,             // 见下方 resolve()
    mustSee: ['零重叠', '撤销按钮够高'],
    expectPass: 19              // 与 undo 同一支探针，条数相同（各档只改视口）
  },
  firstPaint: {
    label: '首屏第一帧',
    segments: [
      '[A] 未登录时的首帧',
      '[B] 有会话时的首帧',
      '[C] localStorage 抛异常时的兜底',
      '[D] boot 接管后与首帧预缩放是否一致（不能跳变）'
    ],
    mustSee: [],
    expectPass: 12              // 实跑：A/B/C/D 四段共 12 条
  },
  bigFx: {
    label: '牌型特写',
    /* 这支探针不打印段标题（只有一屏一件事），闸门只看关键断言与条数 */
    segments: [],
    mustSee: ['只有一组带 is-big', '粒子从组中心出发'],
    expectPass: 21              // 实跑：21 条（含竖屏/横屏两组的半径判据）
  }
};

/* 别名解析：undoNarrow 复用 undo 的段标题。
 * 不写 `segments: PROBES.undo.segments` 是因为对象字面量里还没定义完 —— 走函数。 */
function resolve(name) {
  const spec = PROBES[name];
  if (!spec) return null;
  if (spec.segments === null) return Object.assign({}, spec, { segments: PROBES.undo.segments, resolvedFrom: 'undo' });
  return spec;
}

function segmentsOf(name) {
  const s = resolve(name);
  if (!s) throw new Error('没有这份清单：' + name);
  return s.segments;
}

/** 段标题取用（探针用）：segment('undo', 0) → '[1] 打开战绩页，确认有数据' */
function segment(name, idx) {
  const segs = segmentsOf(name);
  if (!segs[idx]) throw new Error(name + ' 没有第 ' + (idx + 1) + ' 段');
  return segs[idx];
}

/**
 * 核一份日志。返回 { ok, errors[], detail }
 * @param {string} name 清单名
 * @param {string} log  探针 stdout
 */
function verify(name, log) {
  const spec = resolve(name);
  if (!spec) return { ok: false, errors: ['没有这份清单：' + name], detail: '' };
  const text = String(log || '');
  const errors = [];

  const missingSeg = spec.segments.filter((s) => text.indexOf(s) < 0);
  if (missingSeg.length) {
    errors.push('这些段落没在日志里出现（断言可能压根没执行）：' + missingSeg.join(' / '));
  }
  const missingMust = (spec.mustSee || []).filter((s) => text.indexOf(s) < 0);
  if (missingMust.length) {
    errors.push('关键断言没出现：' + missingMust.join(' / '));
  }

  /* 汇总行的口径由 scripts/test-harness 与探针共用：「通过 N 项，失败 M 项」 */
  const m = /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/.exec(text);
  const pass = m ? Number(m[1]) : -1;
  const fail = m ? Number(m[2]) : -1;
  if (!m) {
    errors.push('日志里没有「通过 N 项，失败 M 项」汇总行 —— 探针很可能中途退出了');
  } else {
    if (fail !== 0) errors.push('探针自己报了失败 ' + fail + ' 项（原因见上面 FAIL 行）');
    if (spec.expectPass === null) {
      errors.push('清单里 expectPass 还没填（实跑一次，把条数写进 scripts/lib/ci-need.js）');
    } else if (pass !== spec.expectPass) {
      errors.push('断言条数 ' + pass + ' ≠ 清单 ' + spec.expectPass +
        '（若本次确实增减了断言，请同步 scripts/lib/ci-need.js 的 expectPass —— 那是断言清单，故意的）');
    }
  }
  return { ok: errors.length === 0, errors: errors, detail: '通过 ' + pass + ' 项 / 失败 ' + fail + ' 项' };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const name = args[1];
  if (mode === '--segments') {
    console.log(JSON.stringify(segmentsOf(name), null, 2));
    return 0;
  }
  if (mode === '--verify') {
    const file = args[2];
    if (!file) { console.error('用法：node scripts/lib/ci-need.js --verify <清单名> <日志文件>'); return 2; }
    let log;
    try { log = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      console.error('::error::读不到日志 ' + file + '（' + e.code + '）—— 探针这一步可能没跑起来');
      return 3;
    }
    const r = verify(name, log);
    if (r.ok) {
      console.log('✓ ' + resolve(name).label + '：' + r.detail + '，清单里的段落/关键断言全部出现');
      return 0;
    }
    /* 用 ::error:: 前缀，check-run 上直接能看到（不用开日志） */
    r.errors.forEach((e) => console.error('::error::' + resolve(name).label + '：' + e));
    return 3;
  }
  console.error('用法：node scripts/lib/ci-need.js --verify <清单名> <日志文件> | --segments <清单名>');
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { PROBES: PROBES, segmentsOf: segmentsOf, segment: segment, verify: verify, resolve: resolve };
