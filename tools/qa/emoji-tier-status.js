#!/usr/bin/env node
/* emoji-tier-status.js —— 验收侧的「档状态判定器」（只读磁盘，不启动任何东西）
 *
 * 为什么要它：
 *   跑批器打印的「超时 / 未测」是**归因**，不是事实。1920×1080 那次就是
 *   日志写「该档记未测」，而磁盘上 jsonl / log / meta / marker 一个都没有 ——
 *   「没跑」和「跑崩在预检」在文件系统层面当时无法区分。
 *   所以验收侧自己做一次**从产物反推状态**，不采信任何人的标签。
 *
 * 判定优先级（先看「有没有在跑」，再看「跑得对不对」）：
 *   NOT-RUN   <tag>.NOT-RUN 在（首行第一段是原因码，后两段是给人看的，不参与匹配）
 *   RUNNING   .lock/owner.json 的 tag === 本档 且 pid 活着
 *             （**dump 是一次性写的**：probe-emoji.js:1096 在整个扫描段跑完后才 writeFileSync，
 *               所以「正在跑」期间磁盘上没有 jsonl；此时报 MISSING 就错了）
 *   STALE     .lock/owner.json 的 tag === 本档 但 pid 已死 → 上次被硬杀，连 marker 都没落
 *   RUNNING   .lock/ 在但 owner.json 还没写（≤600ms 启动空窗，见 emoji-run-tier.js:88-96）
 *   HALF      jsonl 在、meta 不在、且没有活锁 → 只可能是「被 SIGKILL 在写 meta 之前」，拒收
 *   MISSING   三样都没有 → 「没跑」**不是通过**；若锁被别的档占着，detail 会写清 owner
 *   FAIL-ASSERT meta.exitCode === 1 → **跑完了但探针判红**（数据完整、不合格；别写成「没跑完」）
 *   FAIL-EXIT meta.exitCode 其它非 0（4/5/7 或异常码）→ 没跑完
 *   FAIL-SEAT meta.preconditionOk !== true，或 distinctSeats !== probeClaimedAvatars
 *   COUNT     records / jsonl 行数 !== --expect
 *   OK        以上都不成立
 *
 * 用法：
 *   node tools/qa/emoji-tier-status.js [--dir tools/qa/out] [--expect 20] [档名…]
 *   node tools/qa/emoji-tier-status.js --selftest
 *
 * 退出码：全 OK → 0；否则 1（便于挂到跑批/CI 后面）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIERS = ['320x568', '390x844', '844x390', '1366x768', '800x600', '1920x1080'];

/* `NOT-RUN` 首行的**契约**（2026-11-14 19:2x 以**实现侧源码**为准重核，别再各记一份）：
 *   现行（emoji-run-tier.js 实际会写的）：`<reason> exit=<code>`
 *     parse-fail exit=6
 *   兼容（R21 定版的四段写法，现在没有写者，只留读）：
 *     <reason> | probe=<sha8|none> | at=<ISO> | exit=<code>
 *   兼容（竖线两侧缺空格的老写法，宽容分支，带日落条款）
 *
 * 三条硬约束（任何一条破了，我这边就认不出来 —— 「两边都写对了自己的那份，合起来废」）：
 *   ① **第一段永远是原因码**，且必须在白名单里（拼写冻结）；
 *   ② 现行写法里 `probe` / `at` 挪到**第二行起的人读区**；四段写法里 `probe` 取不到写 `none`，不许省字段；
 *   ③ 原因码只能取白名单里的码 —— 白名单以实现侧源码为准，我方不另存一份记忆版本。
 *
 * ⚠️ 反面格式：`exit=6 reason=parse-fail` —— 首段变成 `exit=6`，白名单匹配失败。
 *   **状态判定不受影响**（NOT-RUN 靠文件存在），但原因码读不出来，报告里会写成「不可识别」。
 *
 * 匹配用「按空白切 + 白名单」，**不用 `includes()`** ——
 * 否则以后有人拼出 `nonzero-exit-no-dump` 会命中 `nonzero-exit`，把两种原因混成一种。
 */
/* ⚠️ 2026-11-14 19:2x 修正：实现侧 `emoji-run-tier.js` 的写法和码表都已经不是上面这版了。
 *   · 写法：现在是首行 `<reason> exit=<code>`（**空格分隔、没有 probe/at 段**），不是四段竖线
 *   · 码表：实现侧 7 个 = parse-fail / timeout / spawn-error / lock-busy / no-dump / probe-error / readback-mismatch
 *   实测后果：拿真实 marker（`parse-fail exit=6`）喂旧解析器 → 原因码读成 `parse-fail exit=6`，
 *   四个码全部「不可识别」。**状态仍判 NOT-RUN（靠文件存在），但「哪个原因该谁修」的分流全废。**
 *   → 白名单以**实现侧源码**为准（不是我记忆里的那份），并把只剩历史意义的码标出来。
 *   D2：码表二次漂移 3 换 3（`nonzero-exit / precondition / probe-missing` 被删，
 *   `spawn-error / probe-error / readback-mismatch` 新增），其中 `nonzero-exit` 正好是
 *   「任何非 0 退出都要落 NOT-RUN」那条要求用的码。**下次改码表请先说，别只改注释里的「三方一致」。** */
const REASONS = new Set([
  /* 实现侧契约里的 9 个（lead-programmer 2026-11-14 冻结，docs/impl-emoji-placement-v2.md §2.5）
   * ⚠️ 但 emoji-run-tier.js 目前**只实际写 4/5/7 三个**（`:385` 的 hardFail 表）+ `parse-fail`（预检）+ `no-dump`。
   *    `nonzero-exit` **只出现在注释里，没有写点** → 「exit=2/3/6」的留痕至今没落地。
   *    这不再是我的盲区：本工具从 `.meta.json` 的 `exitCode` 反推状态（见 FAIL-ASSERT / FAIL-EXIT 两个分支），
   *    不依赖对方有没有写 marker —— 「等别人落码」不如「自己按数据判」。 */
  'parse-fail', 'timeout', 'spawn-error', 'lock-busy', 'no-dump', 'probe-error', 'readback-mismatch',
  'nonzero-exit', 'probe-missing',
  /* 已废：只认得旧 marker 用（`precondition` 改由 `<tag>.PRECONDITION-FAILED` 表达）。别在新代码里引用。 */
  'precondition',
]);

function parseReason(firstLine) {
  const line = String(firstLine).trim();
  /* ① 实现侧现行写法：`<reason> exit=<code>` —— 首段按空白切，`exit=` 独立取 */
  if (line.indexOf('|') < 0) {
    const head = line.split(/\s+/)[0];
    return { code: head, ok: REASONS.has(head), legacy: false };
  }
  /* ② 契约写法：`<reason> | probe=… | at=… | exit=…`（竖线两侧各一空格） */
  const strict = line.split(' | ')[0].trim();
  if (REASONS.has(strict)) return { code: strict, ok: true, legacy: false };
  const loose = line.split('|')[0].trim();   // 容错：竖线两侧没空格的老写法
  if (REASONS.has(loose)) return { code: loose, ok: true, legacy: true };
  return { code: strict, ok: false, legacy: false };
}

/* ---- 宽容分支的**日落条款**（lead-programmer 2026-11-14 要求，防「永远没人敢删的向后兼容」）----
 * 生效范围：本轮起 → 六档同源复跑结束（即 v2.7 定稿）为止。
 * 到期动作（两处，一起改，别只改一处）：
 *   ① 删掉 `loose` 这行 fallback，只留 ` | ` 严格分隔；
 *   ② 把自验里「竖线两侧缺空格（宽容）」那条从 `ok=true` 改成 `ok=false`，
 *      样本名改成「无空格不再接受」，让它在删代码那天变红 —— **用样本记住期限，不靠人记**。
 * 为什么要留到现在：定稿前可能还有旧版 runner 在别处跑，硬拒绝会让那些档变成「认不出」。
 */

function countLines(p) {
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    return t === '' ? 0 : t.split(/\n+/).length;
  } catch (e) { return null; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* 锁是**目录**（emoji-run-tier.js:85 `fs.mkdirSync(LOCK)` 原子抢占），里面是 owner.json */
function readLock(dir) {
  const lockDir = path.join(dir, '.lock');
  if (!fs.existsSync(lockDir)) return { present: false };
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch (e) { owner = null; }
  return { present: true, owner, emptyWindow: owner === null };
}

/* pid 存活：signal 0；EPERM = 存在但没权限（也算活）。
 * ⚠️ 已知残余风险：pid 可能被系统复用 → 极少数情况下死锁会被读成 RUNNING。
 *    这也是 owner.json 里带 `at` 的原因；本轮不引入时间阈值（runner 按 pid 判陈锁，我不另立一套）。 */
function pidAlive(pid) {
  if (typeof pid !== 'number' || !pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* 被测实现的文件：探针 sha 变了才叫「换了尺子」，但这些变了叫「换了被测物」。
 * 两者都不是「同源」，而**只有前者被 meta 记录**（`probeSha256_16`）。
 * 2026-11-14 实况：v2.7 把兜底尾巴去掉，`pwa/js/seatSheetView.js` + `emoji.css` 都变了，
 * 而六份 meta 的 `probeSha256_16` 一模一样 —— 本工具照样报「6/6 同源」。
 * 所以补一条**不依赖新字段**的事后判据：`meta.finished` 早于实现 mtime 的档，判 `STALE-IMPL`。
 * ⚠️ 已知误报：有人只是 touch/保存了文件而没改内容，也会被判 STALE-IMPL。
 *    这个误差方向是**安全**的（假阳挡路，逼人重跑；假阴才会让两版拼表），所以不修。 */
const IMPL_FILES = ['pwa/js/seatSheetView.js', 'pwa/css/emoji.css'];

function implMtime() {
  let t = 0;
  for (const f of IMPL_FILES) {
    try { t = Math.max(t, fs.statSync(path.join(__dirname, '..', '..', f)).mtimeMs); } catch (e) { /* 缺文件就不判 */ }
  }
  return t;
}

/* 单档判定：输入目录 + tag + 目录锁快照，输出 {tag, status, detail} */
function judgeTier(dir, tag, expect, lock) {
  const p = (ext) => path.join(dir, tag + ext);
  const jsonl = p('.jsonl');
  const metaPath = p('.meta.json');
  const notRunPath = p('.NOT-RUN');
  const prePath = p('.PRECONDITION-FAILED');
  const L = lock || readLock(dir);

  /* 本档自己的锁？ —— 注意「锁在」不等于「本档在跑」 */
  const mine = L.present && L.owner && L.owner.tag === tag ? L.owner : null;
  const runningMe = !!(mine && pidAlive(mine.pid));
  const staleMe = !!(mine && !pidAlive(mine.pid));
  const emptyWindow = !!(L.present && L.emptyWindow);

  if (fs.existsSync(notRunPath)) {
    const first = String(fs.readFileSync(notRunPath, 'utf8')).split(/\n/)[0] || '(空)';
    const r = parseReason(first);
    return {
      tag, status: 'NOT-RUN', code: r.code, legacy: !!r.legacy,
      detail: r.ok
        ? `原因码 ${r.code}${r.legacy ? ' [legacy-separator]（竖线两侧缺空格，宽容接受，见日落条款）' : ''} · ${first}`
        : `原因码**不可识别**「${r.code}」—— 契约是「首段=冻结的 7 个之一」，请查 marker 写法`,
    };
  }

  const hasJsonl = fs.existsSync(jsonl);
  const meta = readJson(metaPath);

  if (!hasJsonl && !meta) {
    if (runningMe) return { tag, status: 'RUNNING', detail: `pid=${mine.pid} 活着（dump 一次性写，跑完才出现）` };
    if (staleMe) return { tag, status: 'STALE', detail: `pid=${mine.pid} 已死 → 上次被硬杀，marker/meta 都没落` };
    if (emptyWindow) return { tag, status: 'RUNNING', detail: '锁目录在、owner.json 还没写（≤600ms 启动空窗）' };
    return {
      tag, status: 'MISSING',
      detail: (L.present && L.owner && L.owner.tag !== tag)
        ? `没跑；但别的档在跑（owner=${L.owner.tag}）`
        : (fs.existsSync(prePath) ? '有 PRECONDITION-FAILED，但无 jsonl/meta' : '无 jsonl / meta / NOT-RUN —— 「没跑」不是「通过」'),
    };
  }

  if (hasJsonl && !meta) {
    if (runningMe) return { tag, status: 'RUNNING', detail: 'dump 已写、meta 还没写（毫秒级窗口）' };
    return { tag, status: 'HALF', detail: 'jsonl 在但 meta 不在且无活锁 → 被 SIGKILL 在写 meta 之前，拒收' };
  }

  /* exit = 1：探针**跑完了、自己判红**（断言失败）。dump 是完整数据，**不许**读成「没跑完」。
   * 这条是 lead-programmer 的判定表（docs/impl-emoji-placement-v2.md §2.5）逼出来的：
   * 我原来只有一个 FAIL-EXIT 格子装所有非 0，会把「跑完且判红」写成「没跑完」—— 方向正好相反，
   * 而这句话会直接决定「去修实现」还是「去重修工具」，指错一次就白干一轮。 */
  if (meta.exitCode === 1) {
    return {
      tag, status: 'FAIL-ASSERT',
      detail: `探针断言判红（exit=1）：records=${meta.records} 数据完整但**不合格**，红在哪看 ${tag}.log；**不是**「没跑完」`,
    };
  }

  if (meta.exitCode !== 0) {
    /* exit ≠ 0 = **没跑完**，不是「跑完了但不合格」。
     * 反面教材（2026-11-14 1920 档）：它同时落了 PRECONDITION-FAILED，正文写「dump 为空/座位数 0」，
     * 读起来像「数据不合格」，真相是 exitCode=5 超时、records=0、根本没跑完。
     * 所以：**以 exitCode 为准，PRECONDITION-FAILED 的正文不作状态依据**；
     * 若实现侧随后落了 `<tag>.NOT-RUN`，本函数会先命中 NOT-RUN 分支（优先级更高）。 */
    return {
      tag, status: 'FAIL-EXIT',
      detail: `exitCode=${meta.exitCode} → **没跑完**（不是不合格）；records=${meta.records}，PRECONDITION-FAILED 正文不作依据`,
    };
  }
  if (meta.preconditionOk !== true) return { tag, status: 'FAIL-SEAT', detail: 'preconditionOk !== true' };
  if (meta.distinctSeats !== meta.probeClaimedAvatars) {
    return { tag, status: 'FAIL-SEAT', detail: `distinctSeats=${meta.distinctSeats} ≠ probeClaimedAvatars=${meta.probeClaimedAvatars}` };
  }
  const n = countLines(jsonl);
  if (meta.records !== expect || n !== expect) {
    return { tag, status: 'COUNT', detail: `meta.records=${meta.records} / 实际行=${n} / 应 ${expect}` };
  }
  /* 最后一道：这份数据是**当前实现**跑出来的吗？（探针同源不代表被测物同源） */
  const im = implMtime(), fin = Date.parse(meta.finished || '');
  if (im && fin && fin < im) {
    return {
      tag, status: 'STALE-IMPL',
      detail: `产物 ${new Date(fin).toISOString()} **早于**实现 mtime ${new Date(im).toISOString()} → 这份是旧构建跑的，不许当现行结果`,
    };
  }
  return { tag, status: 'OK', detail: `probe=${meta.probeSha256_16} ${meta.records} 线 ${meta.distinctSeats} 座` };
}

/* 反向断言：`out/` 下有本工具**不认识的** `<tag>.NOT-RUN` 时必须告警，不许静默忽略。
 * 为什么要有这一条（真实踩过）：2026-11-14 19:0x 我拿 `zzA/zzB/zzC` 三个临时 marker 去测格式，
 * 工具报「合计 OK 6/6」—— **不是格式对，是那三个文件根本没进账**（档列表是硬编码的）。
 * 「沉默」会被读成「通过」，所以未登记的档必须自己喊出来。 */
function findStray(dir, tiers) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.NOT-RUN$/.test(f))
      .map((f) => f.replace(/\.NOT-RUN$/, ''))
      .filter((t) => tiers.indexOf(t) < 0);
  } catch (e) { return []; }
}

function run(dir, tiers, expect) {
  const lock = readLock(dir);
  if (lock.present) {
    console.log(`[注意] 有锁：${lock.owner ? `owner=${lock.owner.tag} pid=${lock.owner.pid}` : 'owner.json 还没写'} —— 本次结果是这一刻的快照\n`);
  }
  const rows = tiers.map((t) => judgeTier(dir, t, expect, lock));
  for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.tag.padEnd(11)} ${r.detail}`);
  const ok = rows.filter((r) => r.status === 'OK').length;
  console.log(`\n合计：OK ${ok}/${rows.length}`);
  const sha = [...new Set(rows.filter((r) => r.status === 'OK').map((r) => (r.detail.match(/probe=(\w+)/) || [])[1]))];
  if (sha.length > 1) console.log(`⚠ 探针版本不一致：${sha.join(' / ')} —— 这些档**不能拼成一张表**`);
  else if (sha.length === 1) console.log(`探针同源：${sha[0]}`);
  const bad = rows.filter((r) => r.status !== 'OK').map((r) => `${r.tag}=${r.status}`);
  if (bad.length) console.log(`不可聚合：${bad.join(' ')}`);
  const stray = findStray(dir, tiers);
  if (stray.length) console.log(`⚠ 发现未登记的档标记（不在本次名单里，**未计入合计**）：${stray.join(' ')}`);
  return ok === rows.length && stray.length === 0;
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tierstatus-'));
  const mk = (tag, files) => {
    for (const [ext, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, tag + ext), body);
  };
  const meta = (o) => JSON.stringify(Object.assign({ probeSha256_16: 'abcdef0123456789', records: 20, distinctSeats: 5, probeClaimedAvatars: 5, preconditionOk: true, exitCode: 0 }, o));
  const lines = (n) => Array.from({ length: n }, (_, i) => '{"i":' + i + '}').join('\n') + '\n';

  mk('t-ok', { '.jsonl': lines(20), '.meta.json': meta({}) });
  mk('t-notrun', { '.NOT-RUN': 'parse-fail | probe=2df71f6a | at=2026-11-14T19:12:41.238Z\nSyntaxError: missing )\n' });
  mk('t-half', { '.jsonl': lines(20) });          // 有 jsonl 无 meta 无活锁
  mk('t-missing', {});                            // 什么都没有
  mk('t-exit', { '.jsonl': lines(20), '.meta.json': meta({ exitCode: 4 }) });
  /* exit=1 与 exit=4 必须分成两个状态：前者「跑完且判红」，后者「没跑完」。
   * 混成一个格子，报告就会把「实现有 bug」说成「工具没跑成」。 */
  mk('t-assert', { '.jsonl': lines(20), '.meta.json': meta({ exitCode: 1 }) });
  /* 被测物同源：探针 sha 一样、但产物早于实现 mtime → 旧构建，判 STALE-IMPL。
   * 反向样本必须有：finished 晚于实现 mtime 的档**不许**被判 STALE-IMPL，
   * 否则一个「全部 STALE-IMPL」的实现也能让上面那条过。 */
  mk('t-staleimpl', { '.jsonl': lines(20), '.meta.json': meta({ finished: '2000-01-01T00:00:00.000Z' }) });
  mk('t-freshimpl', { '.jsonl': lines(20), '.meta.json': meta({ finished: '2099-01-01T00:00:00.000Z' }) });
  mk('t-seat', { '.jsonl': lines(20), '.meta.json': meta({ preconditionOk: false }) });
  mk('t-count', { '.jsonl': lines(18), '.meta.json': meta({ records: 18 }) });
  mk('t-running', {});                            // 无产物，但本档的锁活着
  mk('t-stale', {});                              // 无产物，本档的锁 pid 已死
  /* 本轮新增：上一轮 OK + 本轮预检崩 → marker 落下，但旧 jsonl/meta 可能还在（清理列表落地前的现场）。
   * marker 优先级必须高于「有 meta 就是 OK」，否则「OK 消失」会被读成「没跑」。 */
  mk('t-notrun-stale', { '.jsonl': lines(20), '.meta.json': meta({}), '.NOT-RUN': 'timeout | probe=2df71f6a | at=2026-11-14T19:20:00.000Z | exit=7\n' });
  mk('t-notrun-legacy', { '.NOT-RUN': 'lock-busy|probe=x\n' });   // 无空格老写法，宽容分支
  /* 现行写法落盘的 marker：状态 NOT-RUN 之外，**原因码必须读得出来**（这是 D1 的回归哨） */
  mk('t-notrun-v27', { '.NOT-RUN': 'parse-fail exit=6\nat=2026-11-14T19:12:41.238Z\nreason=探针退出码 6\n' });

  const alive = { tag: 't-running', pid: process.pid, port: 3047, cdp: 9357, at: 'x' };
  const dead = { tag: 't-stale', pid: 999999, port: 3047, cdp: 9357, at: 'x' };
  const other = { tag: 'some-other', pid: process.pid, port: 3047, cdp: 9357, at: 'x' };

  const cases = [
    ['t-ok', 'OK', { present: false }],
    ['t-notrun', 'NOT-RUN', { present: false }],
    ['t-half', 'HALF', { present: false }],
    ['t-missing', 'MISSING', { present: false }],
    ['t-exit', 'FAIL-EXIT', { present: false }],
    ['t-assert', 'FAIL-ASSERT', { present: false }],
    ['t-staleimpl', 'STALE-IMPL', { present: false }],
    ['t-freshimpl', 'OK', { present: false }],
    ['t-seat', 'FAIL-SEAT', { present: false }],
    ['t-count', 'COUNT', { present: false }],
    ['t-running', 'RUNNING', { present: true, owner: alive, emptyWindow: false }],
    ['t-stale', 'STALE', { present: true, owner: dead, emptyWindow: false }],
    ['t-missing', 'MISSING', { present: true, owner: other, emptyWindow: false }],
    ['t-missing', 'RUNNING', { present: true, owner: null, emptyWindow: true }],
    /* 反向断言：jsonl 在 + 本档锁活着 → 是 RUNNING（毫秒窗口），不是 HALF */
    ['t-half', 'RUNNING', { present: true, owner: Object.assign({}, alive, { tag: 't-half' }), emptyWindow: false }],
    /* marker 优先：旧 jsonl/meta 还在也要判 NOT-RUN，不许读成 OK */
    ['t-notrun-stale', 'NOT-RUN', { present: false }],
  ];
  let pass = 0;
  for (const [tag, want, lock] of cases) {
    const r = judgeTier(tmp, tag, 20, lock);
    const ok = r.status === want;
    if (ok) pass++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${tag.padEnd(16)} lock=${lock.owner ? (lock.owner.pid === process.pid ? 'alive' : 'dead') : (lock.emptyWindow ? 'empty' : 'none')} → ${r.status}（期望 ${want}）`);
  }
  /* 原因码契约：三种写法各断言一次 */
  const reasonCases = [
    /* ★ 现行写法（实现侧 emoji-run-tier.js 真会写的）—— 这三条是 2026-11-14 19:2x 补的。
     * 之前自验里**一条都没有**，所以「实现改了写法、我方四条全读成不可识别」这件事，
     * 19/19 全绿地漏了一整轮。**自验只测自己想的格式，等于没测格式。** */
    ['现行：<reason> exit=<code>', 'parse-fail exit=6', 'parse-fail', true, false],
    ['现行：timeout', 'timeout exit=5', 'timeout', true, false],
    ['现行：spawn-error', 'spawn-error exit=7', 'spawn-error', true, false],
    ['现行：未登记的码必须拒绝', 'teapot exit=9', 'teapot', false, false],
    ['定版四段格式', 'parse-fail | probe=2df71f6a | at=2026-11-14T19:12:41.238Z | exit=6', 'parse-fail', true, false],
    ['probe 取不到写 none', 'no-dump | probe=none | at=2026-11-14T19:12:41.238Z | exit=0', 'no-dump', true, false],
    ['竖线两侧缺空格（宽容，带 legacy 标记）', 'lock-busy|probe=x', 'lock-busy', true, true],
    /* 反面样本：这个写法曾被人提过，首段会变成 "exit=6" → 认不出 */
    ['反面：exit 打头', 'exit=6 reason=parse-fail', 'exit=6', false, false],
    ['反面：拼接码冒充', 'nonzero-exit-no-dump | probe=x', 'nonzero-exit-no-dump', false, false],
  ];
  for (const [name, line, wantCode, wantOk, wantLegacy] of reasonCases) {
    const r = parseReason(line);
    const ok = r.code === wantCode && r.ok === wantOk && !!r.legacy === wantLegacy;
    if (ok) pass++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} 原因码 ${name} → ${JSON.stringify(r.code)} ok=${r.ok} legacy=${!!r.legacy}`
      + `（期望 ${JSON.stringify(wantCode)} ok=${wantOk} legacy=${wantLegacy}）`);
  }
  /* 「宽容的是分隔符，不是原因码」—— 同一函数、两种输入并排，一条被接受一条被拒绝。
   * 并且宽容必须在**输出里留痕**（detail 带 legacy-separator），否则下一个人看不出自己吃的是宽容。 */
  const legacyTier = judgeTier(tmp, 't-notrun-legacy', 20, { present: false });
  const pairOk = legacyTier.status === 'NOT-RUN' && /legacy-separator/.test(legacyTier.detail)
    && parseReason('exit=6 reason=parse-fail').ok === false;
  if (pairOk) pass++;
  console.log(`${pairOk ? 'ok  ' : 'FAIL'} 并排断言：无空格→接受且 detail 留痕 / 无竖线→拒绝（宽容的是分隔符，不是原因码）`);

  /* 未登记档标记：必须被 findStray 捞出来；已在名单里的**不许**被当成 stray（反向断言，
   * 否则「全报 stray」也能让上面那条过）。 */
  mk('stray-tier', { '.NOT-RUN': 'timeout exit=5\n' });
  const strayHit = findStray(tmp, ['t-ok', 't-notrun']).indexOf('stray-tier') >= 0;
  const strayMiss = findStray(tmp, ['t-ok', 'stray-tier']).indexOf('stray-tier') < 0;
  if (strayHit) pass++;
  console.log(`${strayHit ? 'ok  ' : 'FAIL'} 未登记档标记能被捞出来（stray-tier）`);
  if (strayMiss) pass++;
  console.log(`${strayMiss ? 'ok  ' : 'FAIL'} 已登记的档标记**不许**算 stray（反向断言）`);

  /* D1 回归哨：实现侧现行写法的 marker，状态 NOT-RUN **且原因码读得出**。
   * 这两件事要分开断言 —— 只断言状态，会漏掉「挡路能力还在、分流能力已废」。 */
  const v27 = judgeTier(tmp, 't-notrun-v27', 20, { present: false });
  const v27ok = v27.status === 'NOT-RUN' && v27.code === 'parse-fail' && !/不可识别/.test(v27.detail);
  if (v27ok) pass++;
  console.log(`${v27ok ? 'ok  ' : 'FAIL'} 现行写法 marker → ${v27.status} code=${v27.code}（期望 NOT-RUN / parse-fail，且 detail 不含「不可识别」）`);

  /* ── D1 闭合：样本必须来自**写入方真实产出**（tools/qa/fixtures/notrun/ 里有 origin.txt）
   *
   * 上一轮我错在哪：19 条「现行写法」样本全是我自己手抄的，于是「格式对」= 「我抄的和我读的一致」，
   * 跟实现侧一个字节都没关系。实现侧改了写法，我方 19/19 全绿地废了一整轮。
   *
   * 抄一份真样本进来只解决今天。**明天写入方改格式，样本照样会烂在目录里而没人知道** ——
   * 所以除了「读得懂」，还必须有三条**漂移哨**，读写入方源码现算。 */
  /* 哨子的被测对象可注入（`EMITTER_SRC`），唯一目的是**给哨子做阳性对照**：
   * 伪造一份「多了一个码 / 模板改了」的 emitter，哨必须红。
   * 注意：844x390 可能正在跑 emoji-run-tier.js，**绝不能**为了验证哨子去改那个真文件。 */
  const EMITTER = process.env.EMITTER_SRC || path.join(__dirname, 'emoji-run-tier.js');
  const realSample = path.join(__dirname, 'fixtures', 'notrun', 'sample-timeout.NOT-RUN');
  const sampleExists = fs.existsSync(realSample);
  const sampleFirst = sampleExists
    ? fs.readFileSync(realSample, 'utf8').split('\n')[0] : '';
  const sr = sampleExists ? parseReason(sampleFirst) : { code: null, ok: false };
  const realOk = sr.code === 'timeout' && sr.ok === true;
  if (realOk) pass++;
  console.log(`${realOk ? 'ok  ' : 'FAIL'} 真样本（写入方 --emit-notrun-sample 产出）首行 → `
    + `${JSON.stringify(sampleFirst)} code=${JSON.stringify(sr.code)} ok=${sr.ok}（期望 timeout/true）`
    + (sampleExists ? '' : ' —— 文件不存在，先跑写入方的桩'));

  /* 哨①口径漂移：写入方登记的码，我方必须全都认识。
   * 这条**专门抓上次那种病**：对方新增一个码、我方读成「不可识别」而自验全绿。 */
  let emitReasons = null;
  try {
    const src = fs.readFileSync(EMITTER, 'utf8');
    const m = src.match(/const NOT_RUN_REASONS = \[([\s\S]*?)\];/);
    if (m) emitReasons = (m[1].match(/'([a-z-]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  } catch (_) { /* 读不到就是 FAIL，下面报 */ }
  const unknown = emitReasons ? emitReasons.filter((c) => !REASONS.has(c)) : ['<读不到 NOT_RUN_REASONS>'];
  const codeOk = emitReasons && emitReasons.length >= 8 && unknown.length === 0;
  if (codeOk) pass++;
  console.log(`${codeOk ? 'ok  ' : 'FAIL'} 口径哨：写入方 NOT_RUN_REASONS(${emitReasons ? emitReasons.length : '?'} 个) 全部在我方码表内`
    + (unknown.length ? ` —— 不认识的：${unknown.join(',')}` : ''));

  /* 哨②模板漂移：写入方第一行的模板必须还是 `${reason} exit=${exitCode}`。
   * 模板一改，真样本立刻过期，而「读得懂旧样本」会继续绿 —— 这就是要钉住它的原因。 */
  let tplOk = false;
  try {
    const src = fs.readFileSync(EMITTER, 'utf8');
    tplOk = /`\$\{reason\} exit=\$\{exitCode\}`/.test(src);
  } catch (_) { /* keep false */ }
  if (tplOk) pass++;
  console.log(`${tplOk ? 'ok  ' : 'FAIL'} 模板哨：写入方仍写 \`\${reason} exit=\${exitCode}\``
    + (tplOk ? '' : ' —— 模板变了，**去重跑 --emit-notrun-sample 覆盖 fixtures/notrun/**，别改这条断言'));

  /* 哨③正样本不是靠「有 exit= 就算过」蒙对的：把原因码摘掉必须判不识别。
   * 反向样本从**真样本**派生，不是另写一条 —— 否则又变成测我想象的格式。 */
  const stripped = sampleFirst.replace(/^[a-z-]+\s+/, '');
  const negOk = !!stripped && stripped !== sampleFirst && parseReason(stripped).ok === false;
  if (negOk) pass++;
  console.log(`${negOk ? 'ok  ' : 'FAIL'} 反向哨：真样本摘掉原因码只剩 ${JSON.stringify(stripped)} → 必须不识别`);

  const total = cases.length + reasonCases.length + 8;
  console.log(`selftest ${pass}/${total}`);
  return pass === total;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return process.exit(selfTest() ? 0 : 1);
  let dir = path.join(__dirname, 'out');
  let expect = 20;
  const tiers = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--expect') expect = Number(argv[++i]);
    else tiers.push(argv[i]);
  }
  return process.exit(run(dir, tiers.length ? tiers : DEFAULT_TIERS, expect) ? 0 : 1);
}

main();
