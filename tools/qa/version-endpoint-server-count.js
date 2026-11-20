#!/usr/bin/env node
/**
 * QA 独立验收：/version.json 轻量端点正确性（服务器侧计数）
 *
 * 疑点（team-lead 指定）：实现声称 sw.js 对 /version.json 走「纯网络分支、不读不写缓存」，
 * 且温启动 fetch transfer=0B 被解释为「SW 注入 fetch，ResourceTiming 记 0，实体 18B」。
 * 必须同时证明三件事才算正确：
 *   ① 每次打开（含 SW 已接管的温启动）服务器都收到恰好 1 条 /version.json 请求（没被静默跳过）；
 *   ② 拿到的是服务器当前最新值，不是缓存旧值（改 v 后页面 reload）；
 *   ③ 负向：SW Cache API 里没有任何 /version.json 条目（不进 PRECACHE、fetch 分支不写缓存）。
 *
 * 判据只用「服务器实际收到的请求」与「真实导航/重载事件」，不引用被测常量，不采信 CDP
 * ResourceTiming（SW 用 Cache API 应答也会发 Network 事件，上一轮踩过这个坑）。
 *
 * 复用：node tools/qa/version-endpoint-server-count.js
 * 输出：tmp/qa-version-endpoint-2026-11-20.json + stdout 的 PASS/FAIL 明细
 * 不写生产代码：version.json 只在服务器内存里替换 v，磁盘文件 SHA-256 前后比对。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findBrowser, extraFlags } = require('../../scripts/lib/browser');

const ROOT = path.join(__dirname, '..', '..');
const PWA = path.join(ROOT, 'pwa');
const VERSION_FILE = path.join(PWA, 'version.json');
const SW_FILE = path.join(PWA, 'sw.js');
const PORT = 3097;
const CDP_PORT = 9397;
const URL0 = 'http://127.0.0.1:' + PORT + '/?mode=local&sharecode=QA-S1';
const OUT = path.join(ROOT, 'tmp', 'qa-version-endpoint-2026-11-20.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/* ---------- 判据自验（先自验再对他人下结论） ---------- */
// 分类器：服务器侧只把 pathname === '/version.json' 计入（忽略 query / sharecode）
function isVersionPath(rawUrl) {
  try { return new URL(rawUrl, 'http://x').pathname === '/version.json'; }
  catch (e) { return false; }
}
// 版本比较器：与页面一致的语义（data.v 为非空字符串且 !== current 才触发 reload）
function shouldReload(v, current) {
  return !!(v && typeof v === 'string' && v !== current);
}
function selfCheck() {
  const cases = [
    ['/version.json', true],
    ['/version.json?sharecode=QA-S1', true],
    ['/index.html', false],
    ['/js/game.js?v=20261120a', false],
    ['/version.json.bak', false],
    ['/api/version.json', false]
  ];
  const cmpCases = [
    ['20261120a', '20261120a', false], // 同版不 reload
    ['20261120QA', '20261120a', true],  // 异版 reload
    ['', '20261120a', false],           // 空串不 reload
    [null, '20261120a', false]          // 非字符串不 reload
  ];
  let pass = 0, total = 0;
  const detail = [];
  cases.forEach(([u, want]) => {
    total++; const got = isVersionPath(u);
    const ok = got === want; if (ok) pass++;
    detail.push({ kind: 'path', input: u, want, got, ok });
  });
  cmpCases.forEach(([v, cur, want]) => {
    total++; const got = shouldReload(v, cur);
    const ok = got === want; if (ok) pass++;
    detail.push({ kind: 'cmp', input: v + ' vs ' + cur, want, got, ok });
  });
  const hits = detail.filter((d) => d.want === true).length;
  const misses = detail.filter((d) => d.want === false).length;
  return { pass, total, hits, misses, allOk: pass === total, detail };
}

/* ---------- 服务器侧计数（唯一网络出口判据） ---------- */
const diskV = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).v;
let servedV = diskV; // 内存可变，绝不动磁盘
const hits = []; // 每条服务器实际收到的 /version.json 请求

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { p = (req.url || '/').split('?')[0]; }
  if (p === '/version.json' && isVersionPath(req.url)) {
    hits.push({ t: Date.now(), raw: req.url, query: (req.url || '').split('?')[1] || '', servedV: servedV });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ v: servedV }));
    return;
  }
  if (p === '/') p = '/index.html';
  const abs = path.join(PWA, p);
  if (!abs.startsWith(PWA)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
        return;
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          id += 1; waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

// 每次文档加载自增的序号（经 sessionStorage 跨 reload 持久），用来客观检测 reload
const INIT = `(function(){
  var n=0; try{ n=parseInt(sessionStorage.getItem('__qaLoadSeq')||'0',10)||0; }catch(e){}
  n++; window.__qaLoadSeq=n; try{ sessionStorage.setItem('__qaLoadSeq', String(n)); }catch(e){}
})();`;

async function main() {
  const result = { at: new Date().toISOString(), browser: null, viewport: '390x844 headless Edge', selfCheck: selfCheck() };
  const shaBefore = sha(VERSION_FILE);
  result.shaBefore = shaBefore;

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = findBrowser(); result.browser = exe;
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'qa-ver-endpoint-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1', ...extraFlags(), 'about:blank'
  ], { stdio: 'ignore' });

  let cdp;
  try {
    let page = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
        page = (list || []).find((t) => t.type === 'page');
        if (page) break;
      } catch (e) {}
    }
    if (!page) throw new Error('连不上浏览器 CDP');
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });

    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
      return r.result && r.result.value;
    };
    const nav = async (url) => {
      await cdp.send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        try { if (await ev('document.readyState') === 'complete') return true; } catch (e) {}
      }
      return false;
    };

    /* ---- Phase 0: 首次加载 + 等 SW 接管 ---- */
    await nav(URL0);
    let controlled = false;
    for (let i = 0; i < 120; i++) {
      await sleep(150);
      const c = await ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)');
      if (c === true) { controlled = true; break; }
    }
    result.phase0 = { firstLoadReady: true, swControlled: controlled, hitCountAfterFirst: hits.length };
    if (!controlled) throw new Error('SW 未能接管页面，后续温启动判据不成立');

    /* ---- Phase 1: 重复打开 N 次，服务器每次应收到恰好 1 条 ---- */
    const N = 4;
    const opens = [];
    for (let k = 1; k <= N; k++) {
      const before = hits.length;
      const seqBefore = await ev('window.__qaLoadSeq');
      await sleep(150);
      const ok = await nav(URL0);
      await sleep(400); // 给 fetch 落到服务器的时间
      const after = hits.length;
      const seqAfter = await ev('window.__qaLoadSeq');
      const ctrl = await ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)');
      opens.push({ n: k, navReady: ok, swControlled: ctrl, loadSeqBefore: seqBefore, loadSeqAfter: seqAfter,
        serverHitsDelta: after - before, serverHitsCumulative: after });
    }
    result.phase1 = {
      opens,
      eachOpenExactlyOne: opens.every((o) => o.serverHitsDelta === 1),
      allWarmControlled: opens.every((o) => o.swControlled === true),
      totalServerHits: hits.length
    };

    /* ---- Phase 2: 改内存 v → 已接管页面应 reload 并拿到最新值 ---- */
    const hitsBeforeMut = hits.length;
    const seqBeforeMut = await ev('window.__qaLoadSeq');
    const MUT = '20261120QA-MUTANT';
    servedV = MUT; // 只改内存，磁盘不动
    // 在已接管页面上触发 visibilitychange（页面监听 !hidden 时自检），不注入任何 app API
    await ev(`(function(){
      try { Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}}); }catch(e){}
      document.dispatchEvent(new Event('visibilitychange')); return true;
    })()`);
    let seqAfterMut = seqBeforeMut;
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      try {
        const s = await ev('window.__qaLoadSeq');
        if (typeof s === 'number' && s > seqBeforeMut) { seqAfterMut = s; break; }
      } catch (e) { /* reload 期间上下文重建，重试 */ }
    }
    const mutHits = hits.slice(hitsBeforeMut);
    // reload 后新文档会再次自检；此时 sessionStorage 的 VERSION_RELOADED 应挡住第二次 reload
    await sleep(600);
    const seqSettled = await ev('window.__qaLoadSeq');
    result.phase2 = {
      mutatedTo: MUT,
      diskFileUntouchedDuringMutation: sha(VERSION_FILE) === shaBefore,
      loadSeqBefore: seqBeforeMut, loadSeqAfterReload: seqAfterMut, reloaded: seqAfterMut > seqBeforeMut,
      serverHitsDuringMutation: mutHits.length,
      servedValuesDuringMutation: mutHits.map((h) => h.servedV),
      gotLatestFromServer: mutHits.length > 0 && mutHits.every((h) => h.servedV === MUT),
      antiLoopSettled: seqSettled === seqAfterMut,
      loadSeqSettled: seqSettled
    };
    servedV = diskV; // 还原内存

    /* ---- Phase 3: 负向 —— SW Cache API 无 version.json 条目 ---- */
    const cacheScan = await ev(`(async function(){
      var out={keys:[],entries:[],versionJsonEntries:[]};
      try{
        out.keys=await caches.keys();
        for(var i=0;i<out.keys.length;i++){
          var c=await caches.open(out.keys[i]);
          var ks=await c.keys();
          for(var j=0;j<ks.length;j++){
            var u=ks[j].url||'';
            out.entries.push({cache:out.keys[i],url:u});
            try{ if(new URL(u).pathname==='/version.json') out.versionJsonEntries.push({cache:out.keys[i],url:u}); }
            catch(e){}
          }
        }
      }catch(e){ out.error=String(e); }
      return out;
    })()`);
    const swSrc = fs.readFileSync(SW_FILE, 'utf8');
    // PRECACHE 段里是否出现 version.json（静态交叉核对）
    const preCacheBlock = (swSrc.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
    result.phase3 = {
      cacheKeys: cacheScan && cacheScan.keys,
      totalCacheEntries: cacheScan && cacheScan.entries && cacheScan.entries.length,
      versionJsonEntriesInCache: cacheScan && cacheScan.versionJsonEntries,
      noVersionJsonInCache: !!(cacheScan && cacheScan.versionJsonEntries && cacheScan.versionJsonEntries.length === 0),
      versionJsonInPrecacheList: /version\.json/.test(preCacheBlock),
      swHasPureNetworkBranch: /url\.pathname\s*===\s*'\/version\.json'[\s\S]{0,120}respondWith\(fetch\(req\)\)/.test(swSrc)
    };

    /* ---- 汇总判定 ---- */
    const p1 = result.phase1, p2 = result.phase2, p3 = result.phase3;
    result.verdict = {
      q1_everyOpenHitsServer: p1.eachOpenExactlyOne && p1.allWarmControlled,
      q2_latestValueAndReload: p2.reloaded && p2.gotLatestFromServer && p2.diskFileUntouchedDuringMutation,
      q3_noCacheEntry: p3.noVersionJsonInCache && !p3.versionJsonInPrecacheList,
      selfCheckOk: result.selfCheck.allOk,
      shaRestored: sha(VERSION_FILE) === shaBefore
    };
    result.verdict.allTrue = Object.values(result.verdict).every((x) => x === true);

    console.log(JSON.stringify({
      selfCheck: result.selfCheck.pass + '/' + result.selfCheck.total + ' (命中' + result.selfCheck.hits + '/不命中' + result.selfCheck.misses + ')',
      swControlled: controlled,
      phase1_serverHitsPerOpen: opens.map((o) => o.serverHitsDelta),
      phase1_eachOpenExactlyOne: p1.eachOpenExactlyOne,
      phase2_reloaded: p2.reloaded,
      phase2_serverHitsDuringMutation: p2.serverHitsDuringMutation,
      phase2_servedValues: p2.servedValuesDuringMutation,
      phase2_gotLatest: p2.gotLatestFromServer,
      phase3_versionJsonInCache: p3.versionJsonEntriesInCache,
      phase3_noVersionJsonInCache: p3.noVersionJsonInCache,
      phase3_inPrecache: p3.versionJsonInPrecacheList,
      shaBefore: shaBefore, shaAfter: sha(VERSION_FILE),
      verdict: result.verdict
    }, null, 2));
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    servedV = diskV;
    if (cdp) cdp.close();
    try { edge.kill(); } catch (e) {}
    try { server.close(); } catch (e) {}
  }
  process.exit(result.verdict.allTrue ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  try { server.close(); } catch (x) {}
  process.exit(2);
});
