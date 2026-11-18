#!/usr/bin/env node
/**
 * tools/qa/emoji-run-tier.js
 *
 * 用途：**一档一跑、跑完立刻落盘**。替代手敲 `node scripts/probe-emoji.js 390 844`。
 * 它解决的是上一轮真实吃过的一次教训：三份数据攒到最后撞端口，最后不得不把
 * 「320 的 Q8」和「320 的 Q1」拼成一份结论 —— 那是「半份数据 + 全量结论」。
 *
 * 它强制五件事（手敲做不到）：
 *   ① **单实例锁**：同一时刻只允许一档在跑，第二档直接拒绝并打印持锁者
 *   ② **端口隔离**：默认 `EMOJI_PROBE_PORT=3047 / EMOJI_PROBE_CDP=9357`，可用环境变量覆盖
 *   ③ **强制 dump**：`EMOJI_PROBE_DUMP` 指向 `tools/qa/out/<w>x<h>.jsonl`，没有 dump 就判失败
 *   ④ **前置检查**：dump 里 `seat` 去重数必须 == 5（K7 前置）。不成立 → 落 `PRECONDITION-FAILED`，
 *      该档**不许进聚合**，也不许用 2 座顶 5 座
 *   ⑤ **出处记录**：`<w>x<h>.meta.json` 里写探针文件 sha256 + git HEAD + 起止时间，
 *      以后任何人问「这份数据是哪版跑的」，答案在文件里而不是在聊天记录里
 *
 * 用法：
 *   node tools/qa/emoji-run-tier.js 390 844              # 跑一档
 *   node tools/qa/emoji-run-tier.js 390 844 --dry        # 只打印将执行的命令/环境/落盘路径
 *   node tools/qa/emoji-run-tier.js --selftest           # 自验锁与前置检查逻辑（不跑浏览器）
 *
 * 退出码：0 成功 / 1 前置检查失败（座位数≠5）/ 2 用法错误 / 3 锁被占
 *         4 探针非零退出或 dump 缺失 / 5 超时
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const LOCK = path.join(OUT, '.lock');
const PROBE = process.env.EMOJI_PROBE_PATH || path.join(ROOT, 'scripts', 'probe-emoji.js');

function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

/* ---------------------------- 单实例锁 ---------------------------- */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);   // 信号 0＝只探测存活性，不真的发信号
    return true;
  } catch (e) {
    return e.code === 'EPERM';   // 存在但没权限 → 当作活着，宁可等
  }
}

/* 陈锁回收（v2.7）：进程被强行结束（Ctrl-C、任务被杀、OS 重启）时
 * owner.json 会留下来，下一档就拿不到锁 —— 一个「为了防止拼接数据的锁」
 * 反过来制造了「跑不了」的僵局。判据用 pid 存活，而不是时间：
 * 一档跑多久取决于机器，按时间猜会误杀正在跑的档。 */
function staleLock(ownerPath, lockAgeMs, timeoutMs) {
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  } catch (_) {
    return '无法解析 owner.json';        // 半写状态也算陈锁
  }
  if (!info || !info.pid) return 'owner.json 缺 pid';
  if (!pidAlive(info.pid)) return '持锁进程 ' + info.pid + ' 已不存在';
  /* 双保险：进程还在但显然超时（比如 pid 被别的进程复用）才兜底 */
  if (timeoutMs && lockAgeMs > timeoutMs * 2) return '锁已存在 ' + Math.round(lockAgeMs / 1000) + 's，超过 2× 超时';
  return null;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const t = Date.now();
    while (Date.now() - t < ms) {}
  }
}

function acquireLock(info, timeoutMs) {
  ensureOut();
  const ownerPath = path.join(LOCK, 'owner.json');
  try {
    fs.mkdirSync(LOCK); // 原子：已存在即抛 EEXIST
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    /* mkdir 与写 owner.json 之间有一个极短的空窗：另一个进程此刻看到的是
     * 「目录在、owner 还没写」。这时候判陈锁是错的 —— 会把正在启动的档杀掉。
     * 所以先等它把 owner 写出来（最多 600ms），等不到才认定是半写残留。 */
    let owner = '';
    for (let i = 0; i < 4; i++) {
      try {
        owner = fs.readFileSync(ownerPath, 'utf8');
      } catch (_) {}
      if (owner) break;
      sleepSync(150);
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(LOCK).mtimeMs;
    } catch (_) {}
    const why = owner ? staleLock(ownerPath, age, timeoutMs) : '目录在但 600ms 内没写出 owner.json（半写残留）';
    if (!why) {
      return { ok: false, owner: owner || '(无 owner.json)' };
    }
    console.warn('[陈锁回收] ' + why + ' —— 清掉后继续（pid 存活判据，不是按时间猜）');
    releaseLock();
    try {
      fs.mkdirSync(LOCK);
    } catch (e2) {
      return { ok: false, owner: '(回收陈锁时被别的进程抢先)' };
    }
  }
  fs.writeFileSync(ownerPath, JSON.stringify(info, null, 2));
  return { ok: true };
}

function releaseLock() {
  try {
    fs.rmSync(path.join(LOCK, 'owner.json'), { force: true });
    fs.rmdirSync(LOCK);
  } catch (_) {}
}

/* ------------------------ NOT-RUN 标记（v2.7） ------------------------
 * 「六档都拿到了」和「六档里有三档没跑」，在文件系统上长得一模一样 ——
 * 都是「没有 dump」。混在一起的后果不是漏一格，是**用五档的数据得出六档的结论**。
 *
 * 契约（与 QA / 施工方三方一致，已冻结，改格式前先说）：
 *   第一行 = 机器读的那一行，`<reason> exit=<code>`，只有这两段，中间一个空格
 *   第二行起 = 人读的详情（探针 sha、原因原文、耗时）
 * reason 只有八个码：parse-fail / timeout / spawn-error / lock-busy /
 *                     no-dump / probe-error / readback-mismatch / nonzero-exit
 *
 * ★ `probe-error` 与 `nonzero-exit` 的分界（QA 问过，写在这里免得再漂）：
 *   `probe-error`  = 退出码 4，探针自己判了红（有断言失败）
 *   `nonzero-exit` = 其它非 0（2/3/6…）—— 探针不是「判红」，是没跑成
 *   两者的数据都不收：断言失败过的 dump、没跑完的 dump，都不许进总表。
 *   `code === 1` **不落 NOT-RUN**：这里的 `code` 是**探针**的退出码，
 *   1 = 探针自己跑完了、但有断言判红（数据是完整的，只是没全绿）。
 *   它既不是「没跑」，也不是「数据残缺」—— 落 NOT-RUN 会把「判红」洗成「没测」。
 *
 * 为什么第一行必须是码而不是整句：这一行会被脚本按行首匹配。写成句子，
 * 「哪个词算 reason」就取决于读的人怎么切 —— 今天切对了，明天换个人就切错。
 */
const NOT_RUN_REASONS = ['parse-fail', 'timeout', 'spawn-error', 'lock-busy',
  'no-dump', 'probe-error', 'readback-mismatch', 'nonzero-exit'];

function writeNotRun(tag, reason, exitCode, extra, dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  else ensureOut();
  if (NOT_RUN_REASONS.indexOf(reason) < 0) throw new Error('未登记的原因码：' + reason);
  const lines = [`${reason} exit=${exitCode}`];
  lines.push(`at=${new Date().toISOString()}`);
  if (extra) {
    Object.keys(extra).forEach((k) => {
      const v = extra[k] == null ? '' : String(extra[k]);
      lines.push(`${k}=${v.replace(/\s+/g, ' ').slice(0, 400)}`);
    });
  }
  lines.push('');
  lines.push('# 这一档没有可用的数据。收数前先看这一行：reason=前面的码就是原因。');
  lines.push('# 有 PRECONDITION-FAILED 的话，那是「跑了但没测出来」，两件事不一样。');
  fs.writeFileSync(path.join(dir || OUT, tag + '.NOT-RUN'), lines.join('\n'), 'utf8');
}

function clearNotRun(tag) {
  fs.rmSync(path.join(OUT, tag + '.NOT-RUN'), { force: true });
}

/* -------------------- 现场归档（v2.7） --------------------
 * 签名过的产物一旦被清，是找不回来的。所以**清之前先拷一份**，原样留证：
 * 不是「反正重跑一遍」，而是「这一份当时长这样，后来的重跑改不了它」。
 *
 * 目录：`history/<tag>.<sha8>.<时刻>/`，里面附一份 `origin.txt` 说明这份是什么。
 *
 * ★ 为什么叫 history 不叫 failures（QA 建议的是 failures/）：
 *   清掉的**多数是上一轮的成功档**。把一份通过的记录放进名叫「失败」的目录，
 *   就是这轮一路在清的同一类谎 —— 名字说了它是什么，内容却是别的。
 *   归档目录必须用中性名，靠 origin.txt 区分「当时是成功还是失败」。
 *   失败档也进 history，origin.txt 写 reason，不另开一份副本：
 *   同一个现场存两处，迟早有人从旧的那份读出「成功」。 */
function archiveSnapshot(tag, origin) {
  const files = [tag + '.jsonl', tag + '.log', tag + '.NOT-RUN', tag + '.PRECONDITION-FAILED', tag + '.meta.json'];
  let probeSha = 'unknown';
  let finished = 'unknown';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OUT, tag + '.meta.json'), 'utf8'));
    probeSha = String(m.probeSha256_16 || 'unknown').slice(0, 8);
    finished = String(m.finished || 'unknown').replace(/[:.]/g, '-');
  } catch (_) {}
  if (finished === 'unknown') finished = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT, 'history', `${tag}.${probeSha}.${finished}`);
  try {
    if (!files.some((f) => fs.existsSync(path.join(OUT, f)))) return null;
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const f of files) {
      const src = path.join(OUT, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dir, f));
        n++;
      }
    }
    fs.writeFileSync(path.join(dir, 'origin.txt'), (origin || 'unknown') + '\n', 'utf8');
    console.error(`[现场已归档] ${path.relative(ROOT, dir)}（${n} 件，origin=${origin || 'unknown'}）`);
    return dir;
  } catch (e) {
    console.error('[归档失败] ' + e.message + ' —— 不影响本档结论，但日志可能被下一档覆盖');
    return null;
  }
}

/* 解析预检（可注入路径，便于自验用一份故意截断的探针去撞它） */
function precheckParse(probePath) {
  const r = spawnSync(process.execPath, ['--check', probePath], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true, msg: '' };
  /* 取前 8 行而不是 4 行：node 的 SyntaxError 前面还有「文件:行号」「那行源码」
   * 和一个空行，第 4 行刚好把**唯一有用的那句**切掉 —— 自验第 ⑨ 条一开始就是
   * 这么红的（报错信息里没有 "SyntaxError" 这个词）。 */
  const lines = (r.stderr || '').replace(/\r/g, '').split('\n').filter((l) => l.length || true);
  const head = lines.slice(0, 8);
  const errIdx = lines.findIndex((l) => /SyntaxError|Error/.test(l));
  if (errIdx > 7) head.push(lines[errIdx]);
  return { ok: false, msg: head.join('\n').trim() };
}

/* 有界回读：日志/元数据再大也不许把内存吃穿（超时那一档最容易留下巨型日志） */
function readCapped(p, cap) {
  try {
    const st = fs.statSync(p);
    const buf = Buffer.alloc(Math.min(st.size, cap));
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

/* ------------------------- 前置检查（纯函数） ------------------------- */
// 从 dump 记录里数「不同 seat 数」——这是 K7 的唯一可信来源（不是探针自报）
function distinctSeats(recs) {
  const s = new Set();
  for (const r of recs) if (r && r.seat != null) s.add(String(r.seat));
  return s.size;
}

// 日志里探针自报的 avatars 数（只作交叉核对，不作判据来源）
// ★ v2.7 修：探针把这行打成了 JSON 片段（"avatars":5），旧正则只认 `avatars:5`
//   裸值，于是六档会**全部**被判「找不到自报」—— 一个正则把整轮数据废掉。
//   两种写法都要认，引号可有可无。
function avatarsFromLog(log) {
  const m = /"?avatars"?\s*[:=]\s*(\d+)/i.exec(log || '');
  return m ? parseInt(m[1], 10) : null;
}

function precondition(recs, log, expectSeats) {
  const seats = distinctSeats(recs);
  const claimed = avatarsFromLog(log);
  const fails = [];
  if (recs.length === 0) fails.push('dump 为空：一条记录都没有');
  if (seats !== expectSeats) fails.push(`dump 里不同 seat 数 = ${seats}，要求 ${expectSeats}`);
  if (claimed != null && claimed !== expectSeats) {
    fails.push(`探针自报 avatars:${claimed}，要求 ${expectSeats}`);
  }
  if (claimed == null) fails.push('日志里找不到 `avatars:N` 自报 —— 无法交叉核对，按未通过处理');
  return { ok: fails.length === 0, seats, claimed, fails };
}

/* ------------------------------ 主流程 ------------------------------ */
function sha256(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  } catch (_) {
    return null;
  }
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}

function runTier(w, h, opt) {
  const tag = `${w}x${h}`;
  const dump = path.join(OUT, tag + '.jsonl');
  const logPath = path.join(OUT, tag + '.log');
  const metaPath = path.join(OUT, tag + '.meta.json');
  const notRunPath = path.join(OUT, tag + '.NOT-RUN');
  const preFailPath = path.join(OUT, tag + '.PRECONDITION-FAILED');
  const port = process.env.EMOJI_PROBE_PORT || '3047';
  const cdp = process.env.EMOJI_PROBE_CDP || '9357';

  /* SEATS 必须显式传给探针（v2.7 修）：探针自己默认 2 座，
   * 而这里的前置检查要求 5 座 —— 不传就是「跑完 4 分钟才告诉你座位数不对」。
   * 一档跑一次的代价就在这里，配置漂移必须在这一层掐掉。 */
  const env = Object.assign({}, process.env, {
    EMOJI_PROBE_PORT: port,
    EMOJI_PROBE_CDP: cdp,
    EMOJI_PROBE_DUMP: dump,
    SEATS: String(opt.seats),
  });

  /* 开跑前的解析预检（v2.7）：探针被正在写的人截断过一半时，node 会直接
   * SyntaxError 退出，而现象在跑批这边看起来是「有 exitCode=4、dump 为空」——
   * 当时被误读成超时，白折腾了一轮。放在这里，一句话就说清是「探针本身解析不了」，
   * 并打印出错行号，不需要去翻 log。 */
  const parse = precheckParse(PROBE);
  if (!parse.ok) {
    if (!opt.dry) writeNotRun(tag, 'parse-fail', 6, { probe: sha256(PROBE), reason: parse.msg });
    console.error(`[探针解析失败] ${path.relative(ROOT, PROBE)} 现在不是合法 JS —— 这一档没跑，记 NOT-RUN 不记「未测」`);
    console.error(parse.msg);
    console.error('  多半是有人正在改这个文件（保存到一半）。等它改完再跑，不要动超时设置。');
    return 6;
  }

  if (opt.dry) {
    console.log('[dry] 将执行：');
    console.log(`  cwd      = ${ROOT}`);
    console.log(`  cmd      = node ${path.relative(ROOT, PROBE)} ${w} ${h}`);
    console.log(`  env      = EMOJI_PROBE_PORT=${port} EMOJI_PROBE_CDP=${cdp} SEATS=${opt.seats}`);
    console.log(`  dump     = ${dump}`);
    console.log(`  log      = ${logPath}`);
    console.log(`  meta     = ${metaPath}`);
    console.log(`  NOT-RUN  = ${notRunPath}`);
    console.log(`  探针 sha = ${sha256(PROBE)}   git HEAD = ${gitHead()}`);
    return 0;
  }

  const lock = acquireLock({ tag, pid: process.pid, port, cdp, at: new Date().toISOString() }, opt.timeout);
  if (!lock.ok) {
    writeNotRun(tag, 'lock-busy', 3, { probe: sha256(PROBE), reason: 'lock owner=' + lock.owner.replace(/\s+/g, ' ').slice(0, 120) });
    console.error(`[锁被占] 已有档在跑：${lock.owner}`);
    console.error('  按纪律：不并发、不并行抢端口。等它跑完再跑这一档。');
    return 3;
  }

  const started = new Date().toISOString();
  /* 上一轮的残留必须先清掉，否则「跑失败但读到旧 dump」= 又一份拼接数据。
   * ★ meta 与 NOT-RUN 也要清（v2.7 补）：只清 dump/log 时，跑失败的那一档会
   *   留着一份**上一轮的成功 meta**（exitCode:0 / records:20 / 上一版 sha），
   *   谁按 meta 汇总就会把旧成绩当本轮结果，而且它的 sha「跟别人不一样」
   *   还会被误读成「有人中途改了探针」—— 两个方向都错。
   * ★ 清之前先归档，**成功和失败都归**（v2.7 定稿，lead-programmer 复核后改回）：
   *   · 只归失败档的版本有个说不通的后果 —— 六档同源成功那一套，重跑一档就
   *     无声无息少了这一档；而**那一套正是 QA 出总表用的签字件**。
   *     19:31 / 19:36 两次「手工 rm 通配符」清掉的恰恰都是成功档，代价是
   *     只能靠回忆说「当时是绿的」。
   *   · 「制造第二数据源」的担心靠 origin.txt 解决，不靠不归档：收数只认
   *     `out/<tag>.jsonl`，history/ 是证据柜，不是可选的第二份读数。
   *   · 两种来源必须**分别标**：上一轮自己就是红的（留下 NOT-RUN /
   *     PRECONDITION-FAILED）记 `failed-prev`，其余记 `ok-prev`。
   *     混成一个 `failed` 会把「上一轮通过、这一轮重跑」的历史诬成失败记录。 */
  const prevLooksFailed = fs.existsSync(notRunPath) || fs.existsSync(preFailPath);
  archiveSnapshot(tag, prevLooksFailed ? 'failed-prev' : 'ok-prev');
  for (const p of [dump, logPath, metaPath, notRunPath, preFailPath]) fs.rmSync(p, { force: true });

  let code = 0;
  /* ★ 日志直接写文件描述符（v2.7）：探针是被超时/崩溃打断时，node 这边
   *   拿不到 stdout（spawnSync 只在子进程正常结束时回填）。以前是「先拿结果、
   *   再落盘」，所以最需要看的那一档恰恰什么都没留下 —— 1920 那两次就是
   *   只剩 2 行日志。stdio 直连 fd 之后，写到哪算哪。 */
  const logFd = fs.openSync(logPath, 'w');
  try {
    const r = spawnSync(process.execPath, [PROBE, String(w), String(h)], {
      cwd: ROOT,
      env,
      timeout: opt.timeout,
      stdio: ['ignore', logFd, logFd],
    });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      console.error(`[超时] ${tag} 超过 ${opt.timeout}ms 未结束 —— 已有日志保留在 ${path.relative(ROOT, logPath)}`);
      code = 5;
    } else if (r.error) {
      console.error(`[起不来] ${tag} ${r.error.code || r.error.message}`);
      code = 7;
    } else if (r.status !== 0) {
      console.error(`[探针非零退出] ${tag} status=${r.status}`);
      code = 4;
    }
  } finally {
    try { fs.closeSync(logFd); } catch (_) {}
    releaseLock();
  }
  const log = readCapped(logPath, 8 * 1024 * 1024);

  let recs = [];
  if (fs.existsSync(dump)) {
    recs = fs
      .readFileSync(dump, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } else {
    console.error(`[dump 缺失] 没有 ${dump} —— 该档落 NOT-RUN，不进聚合`);
    if (code === 0) code = 4;
    writeNotRun(tag, 'no-dump', code, { probe: sha256(PROBE), reason: '探针没写出 dump' });
  }

  const pre = precondition(recs, log, opt.seats);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        tag,
        probe: path.relative(ROOT, PROBE),
        probeSha256_16: sha256(PROBE),
        gitHead: gitHead(),
        env: { EMOJI_PROBE_PORT: port, EMOJI_PROBE_CDP: cdp, EMOJI_PROBE_DUMP: dump },
        started,
        finished: new Date().toISOString(),
        exitCode: code,
        records: recs.length,
        distinctSeats: pre.seats,
        probeClaimedAvatars: pre.claimed,
        preconditionOk: pre.ok,
        preconditionFails: pre.fails,
      },
      null,
      2
    )
  );

  /* 探针没跑完（超时 / 崩溃 / 起不来）：即使 dump 里已经有几条，也不收 ——
   * 半份数据配全量结论是这一整套工具的初衷。NOT-RUN 必须盖过 PRECONDITION-FAILED：
   * 「跑完了但座位不对」和「根本没跑完」是两件事，写错会把人送去调座位。
   *
   * 码的分配不是「有几个分支就写几个词」，而是**按「数据能不能用」分**：
   *   4 → probe-error：探针自己判了红（有断言失败），数据不完整
   *   5 → timeout    ：硬超时被杀，一定不完整
   *   7 → spawn-error：根本没起来
   *   其它非 0/1 → nonzero-exit：探针中途别的错，同样不收
   *   1 → **不落 NOT-RUN**：探针跑完了、只是有断言判红（数据完整，没全绿），
   *       那是 FAIL-ASSERT，不是「没测」。判红洗成「没测」= 把问题藏起来。
   * 落漏了会出什么？「exit≠0 但 dump 看着满 20 条」这种档会**静默变成有效数据** ——
   * QA 点名的就是这个洞。 */
  const hardFail = { 4: 'probe-error', 5: 'timeout', 7: 'spawn-error' }[code]
    || (code !== 0 && code !== 1 ? 'nonzero-exit' : null);
  if (hardFail) {
    writeNotRun(tag, hardFail, code, {
      probe: sha256(PROBE),
      reason: `探针退出码 ${code}，日志 ${logPath}`,
      duration: Math.round((Date.now() - new Date(started).getTime()) / 1000) + 's',
    });
    console.error(`[该档 NOT-RUN] ${tag} reason=${hardFail} exit=${code}`);
    /* ★ 这里**不归档**。归档的 `origin.txt` 描述的是「上一轮」（ok-prev / failed-prev），
     *   不是「这一轮」；失败现场留在 out/ 里，靠 NOT-RUN 标记自证。
     *   下一次跑同一档时，开头的归档步骤会看到 NOT-RUN 并把它存成 failed-prev。
     *   历史上这里调过一个不存在的 archiveFailure()，只在失败分支炸 —— 自测从不走这条路，
     *   所以一直没被发现。删掉而不是补实现：失败不该有第二份副本。 */
    return code;
  }

  if (!pre.ok) {
    fs.writeFileSync(preFailPath, pre.fails.join('\n'));
    /* 先清 NOT-RUN 再退：这一档是「跑了、没测出来」，不是「没跑」。
     * 两个标记同时存在，读的人只能猜哪个算数。 */
    clearNotRun(tag);
    console.error(`[前置检查未通过] ${tag}`);
    for (const f of pre.fails) console.error('  - ' + f);
    console.error('  该档记「未测」，不许进聚合，也不许用 2 座顶 5 座。');
    return 1;
  }
  fs.rmSync(preFailPath, { force: true });
  /* 成功路径必须把旧标记清掉（v2.7）：否则「上一次失败留下的 NOT-RUN」
   * 会跟着一份新数据一起存在，收数的人看到标记就把这档丢掉 —— 白跑。 */
  clearNotRun(tag);

  console.log(`[完成] ${tag}  记录 ${recs.length} 条  座位 ${pre.seats}  探针 ${sha256(PROBE)}`);
  console.log(`  下一步：node tools/qa/emoji-verdict.js ${dump} --players tools/qa/out/players.json --expect 20`);
  return code;
}

/* ------------------------------- 自验 ------------------------------- */
function runSelfTest() {
  let ok = 0;
  const lines = [];
  const t = (name, cond) => {
    cond ? ok++ : null;
    lines.push(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  };

  // ① 前置检查：5 座 + 自报 5 → 通过
  const recs5 = ['S1', 'pal2', 'pal3', 'pal4', 'pal'].map((s) => ({ seat: s }));
  t('① 5 座 + avatars:5 → 前置通过', precondition(recs5, 'avatars:5', 5).ok === true);

  // ② 只有 2 座 → 必须拦（不许 2 座顶 5 座）
  t(
    '② 2 座冒充 5 座 → 前置失败',
    precondition([{ seat: 'S1' }, { seat: 'pal2' }], 'avatars:2', 5).ok === false
  );

  // ③ 座位数对但自报 2（自相矛盾）→ 必须拦
  t('③ 座位数 5 但自报 avatars:2 → 前置失败', precondition(recs5, 'avatars:2', 5).ok === false);

  // ④ 没有 avatars 自报 → 必须拦（无法交叉核对，不许当通过）
  t('④ 缺 avatars 自报 → 前置失败', precondition(recs5, 'no marker here', 5).ok === false);

  // ⑤ 空 dump → 必须拦
  t('⑤ 空 dump → 前置失败', precondition([], 'avatars:5', 5).ok === false);

  // ⑥ 锁：拿得到、再拿被拒、放掉后能再拿（pid 必须给——真实调用点一定给）
  releaseLock();
  const a = acquireLock({ tag: 'test-A', pid: process.pid });
  const b = acquireLock({ tag: 'test-B', pid: process.pid });
  releaseLock();
  const c = acquireLock({ tag: 'test-C', pid: process.pid });
  releaseLock();
  t('⑥ 单实例锁：首锁成功 / 二锁被拒 / 释放后可再取', a.ok === true && b.ok === false && c.ok === true);

  // ⑦ 陈锁回收：进程被杀后留下的 owner.json 不能永久占着锁
  //    用「几乎不可能存活的 pid」+ 存活进程自身的 pid 各测一次，正反都要成立
  ensureOut();
  releaseLock();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ tag: 'died', pid: 999999 }));
  const d = acquireLock({ tag: 'test-D', pid: process.pid });
  releaseLock();
  t('⑦ 陈锁回收：持锁进程已死 → 允许接管', d.ok === true);

  ensureOut();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ tag: 'alive', pid: process.pid }));
  const e2 = acquireLock({ tag: 'test-E', pid: process.pid });
  releaseLock();
  t('⑦ 陈锁回收：持锁进程还活着 → 必须拒绝（不许误杀正在跑的档）', e2.ok === false);

  // ⑧ avatars 自报的两种写法都要认（探针现在打成 JSON 片段）
  t('⑧ avatars 解析：裸值 `avatars:5`', avatarsFromLog('xx avatars:5 yy') === 5);
  t('⑧ avatars 解析：JSON 写法 `"avatars":5`', avatarsFromLog('{"scale":0.4,"avatars":5,"box":{}}') === 5);
  t('⑧ avatars 解析：没有自报时返回 null（不许当 0 或当通过）', avatarsFromLog('no marker') === null);

  // ⑨ 解析预检：必须能抓到「写了一半的探针」
  //    用 TRUNCATED-MARKER 截断真实的 probe 文件，而不是手写一段坏语法 ——
  //    后者只能证明 node 会报错，前者才能证明**这个函数**是在检查我们真正要跑的文件。
  const good = precheckParse(PROBE);
  const tmpBroken = path.join(OUT, '.selftest-broken-probe.js');
  fs.mkdirSync(OUT, { recursive: true });
  const src = fs.readFileSync(PROBE, 'utf8');
  fs.writeFileSync(tmpBroken, src.slice(0, Math.floor(src.length * 0.4)));
  const bad = precheckParse(tmpBroken);
  fs.rmSync(tmpBroken, { force: true });
  t('⑨ 解析预检：完好的探针 → 通过', good.ok === true);
  t('⑨ 解析预检：截断到 40% 的探针 → 必须拦下（这就是 1920 那次的样子）',
    bad.ok === false && /SyntaxError|Unexpected/.test(bad.msg));

  // ⑩ NOT-RUN 契约：第一行只能是 `<reason> exit=<code>`，且 reason 必须是登记过的码
  const stTag = 'selftest-notrun';
  writeNotRun(stTag, 'timeout', 5, { probe: 'deadbeef', reason: '自验' });
  const mark = fs.readFileSync(path.join(OUT, stTag + '.NOT-RUN'), 'utf8').split('\n');
  t('⑩ NOT-RUN 第一行格式：`<reason> exit=<code>`', /^timeout exit=5$/.test(mark[0]));
  t('⑩ NOT-RUN 未登记的原因码必须拒绝写', (() => {
    try {
      writeNotRun(stTag, '跑失败了', 5, {});
      return false;
    } catch (_) {
      return true;
    }
  })());
  clearNotRun(stTag);
  t('⑩ NOT-RUN 可以被清掉（成功路径要能抹掉旧标记）',
    !fs.existsSync(path.join(OUT, stTag + '.NOT-RUN')));

  // ⑪ 给 QA 的桩：样本必须由**同一段** writeNotRun 写出（不是手写一份格式相似的）
  const sampleDir = path.join(OUT, '.selftest-sample');
  writeNotRun('st', 'nonzero-exit', 2, { probe: 'x' }, sampleDir);
  const sample = fs.readFileSync(path.join(sampleDir, 'st.NOT-RUN'), 'utf8').split('\n')[0];
  fs.rmSync(sampleDir, { recursive: true, force: true });
  t('⑪ 样本桩：写到指定目录、首行仍是 `<reason> exit=<code>`', /^nonzero-exit exit=2$/.test(sample));

  console.log(lines.join('\n'));
  console.log(`\n自验：通过 ${ok} 项，失败 ${lines.length - ok} 项`);
  return ok === lines.length;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(runSelfTest() ? 0 : 1);
  /* 给 QA 的桩（v2.7）：不跑浏览器，只写一份 NOT-RUN 样本到指定目录。
   * 他们那套七状态判定要拿真样本做正反两向验证 —— 用真跑批去造失败态成本太高，
   * 而「手写一份样本」又证明不了实现的格式是对的。这条走的是**同一段**
   * writeNotRun，所以样本格式天然与实现同源。 */
  if (args.includes('--emit-notrun-sample')) {
    const i = args.indexOf('--emit-notrun-sample');
    const dir = args[i + 1];
    if (!dir) {
      console.error('用法：--emit-notrun-sample <目录>   （写一份 timeout 样本供判定器正反验证）');
      process.exit(2);
    }
    writeNotRun('sample-timeout', 'timeout', 5, {
      probe: 'deadbeefdeadbeef',
      reason: '样本：不是真跑，只用于验证判定器对 NOT-RUN 的识别',
      duration: '300s',
    }, path.resolve(dir));
    console.log('已写样本：' + path.join(path.resolve(dir), 'sample-timeout.NOT-RUN'));
    process.exit(0);
  }
  if (args.includes('--dry')) {
    const pos = args.filter((a) => !a.startsWith('--'));
    if (pos.length < 2) {
      console.error('用法：node tools/qa/emoji-run-tier.js <w> <h> [--dry]');
      process.exit(2);
    }
    process.exit(runTier(pos[0], pos[1], { dry: true, seats: 5, timeout: 0 }));
  }
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) {
    console.error('用法：node tools/qa/emoji-run-tier.js <w> <h> [--dry] | --selftest | --emit-notrun-sample <目录>');
    process.exit(2);
  }
  process.exit(runTier(pos[0], pos[1], { seats: 5, timeout: 300000 }));
}

main();
