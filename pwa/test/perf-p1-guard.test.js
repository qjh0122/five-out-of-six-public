/**
 * P1-2 / P1-4 守卫（2026-11-20）
 *
 * 背景：版本自检原来每 90 秒 fetch 一次 /index.html 全文（温启动实测 92,586B），
 * 只用其中一个 app-version。改成 /version.json 后有三类「看着对、其实不生效」的失败：
 *   ① 页面还在抓 HTML / 没拼 sharecode / 没带 no-store → 流量没省、线上 403；
 *   ② SW 把 version.json 缓存了 → 自检永远报「版本一致」，混版本 bug 回来；
 *   ③ ?v= 漏 bump 或源码改了没 bump → 老内核/缓存拿旧 JS。
 * 这三件事都不会报错、不会白屏，只会在某个用户那里静默跑旧代码 —— 必须靠断言。
 *
 * [A] 把真的 checkVersionConsistency 抽出来跑（不是只看正则）：喂假 fetch / Store，
 *     验 URL、no-store、403、坏 JSON、session 防重复。
 * [B] 用 vm 跑真的 sw.js：/version.json 走纯网络、不写缓存、不进 PRECACHE。
 * [C] 门禁判据的假样本：既能抓也能放（check-docs.js 的自测另有真样本）。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const VG = require('../../scripts/lib/version-gate');

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
const HTML = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

/** 按花括号配平抽函数源码（比正则稳：函数体里有嵌套的 then/catch） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  eq(from, -1, '抽函数 ' + name + ' 时花括号必须配平');
  return null;
}

const SHARE_SRC = extractFn(HTML, 'withSharecode');
const CHECK_SRC = extractFn(HTML, 'checkVersionConsistency');

/** 造一个可控的 checkVersionConsistency 实例 */
function makeChecker(opt) {
  const o = opt || {};
  const out = { calls: [], writes: [], reloads: [] };
  const location = { protocol: o.fileProtocol ? 'file:' : 'https:', search: o.search === undefined ? '?sharecode=S1' : o.search };
  const document = {
    querySelector() {
      return o.noMeta ? null : { getAttribute: () => (o.current || '20261120a') };
    }
  };
  const Store = {
    KEYS: { VERSION_RELOADED: 'VERSION_RELOADED' },
    read: () => o.alreadyReloaded || null,
    write: (k, v, scope) => { out.writes.push({ k, v, scope }); }
  };
  const fetchStub = (url, init) => {
    out.calls.push({ url, init });
    if (o.reject) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      ok: o.httpOk === undefined ? true : o.httpOk,
      status: o.status || 200,
      json: () => (o.badJson ? Promise.reject(new Error('not json')) : Promise.resolve(o.data))
    });
  };
  const reloadWhenIdle = (reason) => { out.reloads.push(reason); };
  // eslint-disable-next-line no-new-func
  const build = new Function('fetch', 'Store', 'document', 'location', 'reloadWhenIdle',
    SHARE_SRC + '\n' + CHECK_SRC + '\nreturn checkVersionConsistency;');
  const run = build(fetchStub, Store, document, location, reloadWhenIdle);
  return { run, out };
}
const settle = () => new Promise((r) => setImmediate(r));

console.log('\n[A] 页面自检：真函数 + 假 fetch');
(async function runA() {
  ok(!!SHARE_SRC && !!CHECK_SRC, '抽到了 withSharecode 与 checkVersionConsistency 的源码');

  {
    const c = makeChecker({ data: { v: '20261121a' } });
    c.run();
    await settle(); await settle();
    eq(c.out.calls.length, 1, '只发一条版本请求');
    eq(c.out.calls[0] && c.out.calls[0].url, '/version.json?sharecode=S1',
      '★ 请求 /version.json 且保留 withSharecode 拼接');
    eq(c.out.calls[0] && c.out.calls[0].init && c.out.calls[0].init.cache, 'no-store',
      '★ 必须 no-store（否则 SW / HTTP 缓存会冻住版本号）');
    eq(c.out.reloads[0], 'version mismatch', '★ 版本不一致 → 触发 reloadWhenIdle');
    eq(c.out.writes[0] && c.out.writes[0].scope, 'session', '★ 刷新前写 sessionStorage 防死循环');
  }
  {
    const c = makeChecker({ data: { v: '20261120a' } });
    c.run(); await settle(); await settle();
    eq(c.out.reloads.length, 0, '版本一致时不刷新（不是恒 reload）');
  }
  {
    const c = makeChecker({ data: { v: '20261121a' }, alreadyReloaded: '20261120a' });
    c.run(); await settle(); await settle();
    eq(c.out.calls.length, 0, '★ session 已标记本版本 → 连请求都不发（防重复 reload）');
  }
  {
    const c = makeChecker({ data: { v: '20261121a' }, httpOk: false, status: 403 });
    c.run(); await settle(); await settle();
    eq(c.out.reloads.length, 0, '★ 403 兜底：拿不到版本就不刷新');
  }
  {
    const c = makeChecker({ badJson: true });
    c.run(); await settle(); await settle();
    eq(c.out.reloads.length, 0, '★ 响应不是 JSON（网关错误页）也不刷新');
  }
  {
    const c = makeChecker({ reject: true });
    c.run(); await settle(); await settle();
    eq(c.out.reloads.length, 0, '离线 catch 保留：fetch 失败静默跳过');
  }
  {
    const c = makeChecker({ data: {} });
    c.run(); await settle(); await settle();
    eq(c.out.reloads.length, 0, '没有 v 字段时跳过（不把脏响应当版本变化）');
  }
  {
    const c = makeChecker({ data: { v: '20261121a' }, fileProtocol: true });
    c.run(); await settle();
    eq(c.out.calls.length, 0, 'file:// 下不发请求');
  }
  {
    const c = makeChecker({ data: { v: '20261121a' }, search: '' });
    c.run(); await settle(); await settle();
    eq(c.out.calls[0] && c.out.calls[0].url, '/version.json', '没有 sharecode 时路径保持干净');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[B] SW：/version.json 纯网络，不缓存');
  {
    const added = [], puts = [], fetched = [];
    const store = new Map();
    const keyOf = (req) => (typeof req === 'string' ? req : (req && req.url) || '');
    const put = async (req, res) => { puts.push(keyOf(req)); store.set(keyOf(req), res); };
    const cachesStub = {
      /* C7 的 install 会先 cache.match(同版本键) 再决定是否重新下载，
       * 桩里必须提供 match，否则测的是「桩缺方法」而不是产品行为。 */
      open: async () => ({
        put,
        match: async (req) => store.get(keyOf(req)),
        add: async (u) => {
          added.push(u);
          store.set(String(u), new Response('precached', { status: 200 }));
        }
      }),
      match: async (req) => store.get(req.url || req),
      keys: async () => [], delete: async () => true
    };
    const listeners = {};
    const selfObj = {
      location: { href: 'https://x.test/sw.js?sharecode=S', origin: 'https://x.test' },
      addEventListener: (t, fn) => { listeners[t] = fn; },
      skipWaiting: () => {}, clients: { claim: () => {} }
    };
    const sandbox = {
      self: selfObj, caches: cachesStub,
      fetch: async (req) => { fetched.push(req.url || req); return new Response('server-v', { status: 200 }); },
      Response, Request, URL, Promise, console, Date, JSON, Math,
      Object, Array, String, Number, RegExp, Error, TypeError,
      setTimeout, clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext(SW, sandbox);

    const req = { method: 'GET', url: 'https://x.test/version.json?sharecode=S', mode: 'cors' };
    let resP = null;
    listeners.fetch({ request: req, respondWith: (p) => { resP = p; } });
    const res = await resP;
    eq(await res.text(), 'server-v', '★ 拿到的是网络当前值，不是缓存副本');
    eq(fetched.length, 1, '★ 分支确实发了网络请求');
    eq(puts.length, 0, '★ 负向：不写缓存');
    eq(store.size, 0, '★ 负向：没有任何缓存条目被创建');

    /* install 的 PRECACHE 也不能碰它：跑一遍真的 install 回调 */
    let installP = null;
    listeners.install({ waitUntil: (p) => { installP = p; } });
    await installP;
    ok(added.length >= 25, 'PRECACHE 真的执行了（' + added.length + ' 条）');
    eq(added.filter((u) => String(u).indexOf('/version.json') >= 0).length, 0,
      '★ version.json 不进 PRECACHE（否则上线时把版本号冻住）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[C] 门禁判据：抓得住、也放得过');
  {
    const good = '<script src="./js/a.js?v=20261120a"></script>'
      + '<link rel="stylesheet" href="./css/a.css?v=20261120a">';
    eq(VG.checkVRefs(good, '20261120a').mismatches.length, 0, '同版本样本放行');
    eq(VG.checkVRefs(good.replace('css/a.css?v=20261120a', 'css/a.css?v=20261119b'), '20261120a').mismatches.length, 1,
      '★ 一条 ?v= 落旧版 → 抓到');
    eq(VG.bumpDecision(true, '20261120a', '20261119b', 'v152', 'v152').fail, true,
      '★ 只 bump app-version、漏 bump CACHE_NAME → 红');
    eq(VG.bumpDecision(true, '20261120a', '20261119b', 'v153', 'v152').fail, false,
      '两个都 bump → 绿');
    eq(VG.changedPathsFromPorcelain('?? pwa/js/new.js\n M docs/a.md').filter(VG.isSourcePath).length, 1,
      '未跟踪的新 js 算源码变更，docs 不算');
    eq(VG.parseVersionJson(fs.readFileSync(path.join(ROOT, 'pwa', 'version.json'), 'utf8')),
      VG.parseAppVersion(HTML), '★ version.json 的 v == 页面 meta（唯一事实源对账）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log('通过 ' + pass + ' 项，失败 ' + (fail + 1) + ' 项');
  process.exit(1);
});
