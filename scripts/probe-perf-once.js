#!/usr/bin/env node
/**
 * 一次性性能测量（2026-11-20 架构审查）
 *
 * 只读 pwa/，不写生产代码。测量项：
 *   1. 首次访问 / SW 温启动：DCL、load、FCP、资源数/体积、longtask、CDP TaskDuration
 *   2. 规则弹窗开合时的 rAF 帧间隔（headless 参考值，不等于真机帧率）
 *   3. JS/CSS/HTML 的 gzip 后体积（Node zlib，静态统计）
 *
 * 跑法：node scripts/probe-perf-once.js
 * 输出：tmp/perf-measure-2026-11-20.json
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { findBrowser, extraFlags } = require('./lib/browser');

const ROOT = path.join(__dirname, '..');
const PWA = path.join(ROOT, 'pwa');
const PORT = 3091;
const CDP_PORT = 9391;
const URL0 = 'http://127.0.0.1:' + PORT + '/?mode=local';
const OUT = path.join(ROOT, 'tmp', 'perf-measure-2026-11-20.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
        return;
      }
      if (msg.method) events.push(msg);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          id += 1;
          waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      drainEvents() { return events.splice(0, events.length); },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

const INIT_SCRIPT = `(function(){
  window.__perfLongTasks = [];
  window.__bound = {};
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        window.__perfLongTasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) });
      });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  try {
    var orig = EventTarget.prototype.addEventListener;
    var ids = { 'btn-auth-submit': 1, 'btn-create': 1, 'btn-rules': 1 };
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
      if (type === 'click' && this && ids[this.id] && !window.__bound[this.id]) {
        window.__bound[this.id] = Math.round(performance.now() * 10) / 10;
      }
      return orig.call(this, type, fn, opt);
    };
  } catch (e) {}
})();`;

const SUMMARY = `(async function () {
  var nav = (performance.getEntriesByType('navigation') || [])[0] || {};
  var rs = performance.getEntriesByType('resource') || [];
  var ps = performance.getEntriesByType('paint') || [];
  var fcp = ps.filter(function (p) { return p.name === 'first-contentful-paint'; })[0];
  var fp = ps.filter(function (p) { return p.name === 'first-paint'; })[0];
  var byType = {};
  var scripts = [];
  rs.forEach(function (r) {
    var k = r.initiatorType || 'other';
    if (!byType[k]) byType[k] = { count: 0, transferSize: 0, duration: 0 };
    byType[k].count += 1;
    byType[k].transferSize += r.transferSize || 0;
    byType[k].duration += r.duration || 0;
    if (/\\.js(\\?|$)/.test(r.name)) scripts.push({
      name: r.name.split('/').pop().split('?')[0],
      transfer: r.transferSize || 0, duration: Math.round(r.duration)
    });
  });
  scripts.sort(function (a, b) { return b.duration - a.duration; });
  var lts = window.__perfLongTasks || [];
  var total = lts.reduce(function (s, x) { return s + x.d; }, 0);
  var max = lts.reduce(function (s, x) { return Math.max(s, x.d); }, 0);
  var cacheInfo = { available: false, keys: [], entries: {} };
  try {
    cacheInfo.available = true;
    cacheInfo.keys = await caches.keys();
    for (var i = 0; i < cacheInfo.keys.length; i++) {
      var c = await caches.open(cacheInfo.keys[i]);
      cacheInfo.entries[cacheInfo.keys[i]] = (await c.keys()).length;
    }
  } catch (e) {}
  return {
    nav: {
      responseEnd: Math.round(nav.responseEnd || 0),
      domInteractive: Math.round(nav.domInteractive || 0),
      dclEnd: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEnd: Math.round(nav.loadEventEnd || 0)
    },
    fcp: fcp ? Math.round(fcp.startTime) : null,
    firstPaint: fp ? Math.round(fp.startTime) : null,
    resources: {
      count: rs.length,
      transferSum: rs.reduce(function (s, r) { return s + (r.transferSize || 0); }, 0),
      byType: byType,
      topScripts: scripts.slice(0, 6)
    },
    longTasks: { count: lts.length, totalMs: total, maxMs: max, first: lts.slice(0, 12) },
    domNodes: document.querySelectorAll('*').length,
    visibleScreen: (function () {
      var ss = document.querySelectorAll('.screen');
      for (var i = 0; i < ss.length; i++) {
        if (getComputedStyle(ss[i]).display !== 'none') return ss[i].id;
      }
      return '';
    })(),
    boundHandlers: window.__bound || {},
    sw: {
      supported: 'serviceWorker' in navigator,
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      caches: cacheInfo
    },
    jsHeap: performance.memory ? Math.round(performance.memory.usedJSHeapSize) : null
  };
})()`;

const FRAMES = `(async function () {
  var btn = document.getElementById('btn-rules');
  var close = document.getElementById('btn-rules-close');
  if (!btn || !close) return { error: 'missing btn-rules' };
  var guideSkip = document.getElementById('guide-skip');
  if (guideSkip && !document.getElementById('guide-modal').classList.contains('hidden')) guideSkip.click();
  var out = {};
  function sample(label, clickFirst) {
    return new Promise(function (resolve) {
      var ds = [];
      var prev = 0;
      if (clickFirst) clickFirst.click();
      function tick(t) {
        if (prev) ds.push(t - prev);
        prev = t;
        if (ds.length < 72) requestAnimationFrame(tick);
        else resolve(ds);
      }
      requestAnimationFrame(tick);
    }).then(function (ds) {
      var s = ds.slice().sort(function (a, b) { return a - b; });
      out[label] = {
        frames: s.length,
        median: +(s[Math.floor(s.length / 2)] || 0).toFixed(2),
        p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(2),
        max: +(s[s.length - 1] || 0).toFixed(2),
        over20: s.filter(function (d) { return d > 20; }).length,
        over33: s.filter(function (d) { return d > 33; }).length
      };
    });
  }
  await sample('idle', null);
  await sample('modalOpen', btn);
  close.click();
  return out;
})()`;

function metricsMap(list) {
  const m = {};
  (list || []).forEach((x) => { m[x.name] = x.value; });
  return m;
}
function deltaMetrics(a, b) {
  const keys = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
    'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes'];
  const out = {};
  keys.forEach((k) => {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') {
      out[k] = +(b[k] - a[k]).toFixed(4);
    }
  });
  return out;
}

function gzipStats() {
  const files = [];
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css|html|webmanifest)$/.test(e.name)) files.push(p);
    });
  }
  walk(PWA);
  let raw = 0; let gz = 0;
  const top = [];
  files.forEach((f) => {
    const buf = fs.readFileSync(f);
    const z = zlib.gzipSync(buf, { level: 6 }).length;
    raw += buf.length; gz += z;
    top.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), raw: buf.length, gzip: z });
  });
  top.sort((a, b) => b.raw - a.raw);
  return { count: files.length, rawBytes: raw, gzipBytes: gz, top: top.slice(0, 15) };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const exe = findBrowser();
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-perf-edge-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1', ...extraFlags(), 'about:blank'
  ], { stdio: 'ignore' });

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
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      const st = await evaluate('document.readyState');
      if (st === 'complete') return true;
    }
    return false;
  };

  const result = {
    at: new Date().toISOString(),
    browser: exe,
    viewport: '390x844 @2x, headless Edge, --disable-gpu',
    notes: [
      '本地静态服务无 gzip / 无网关延迟，网络时间不代表生产；gzip 体积另由 zlib 静态统计。',
      'SW 首次访问会在 load 后预缓存，第二次访问为同 profile 的温启动。',
      'rAF 帧间隔为 headless 参考值，不能当真机帧率。'
    ],
    runs: {},
    gzip: gzipStats()
  };

  for (const cfg of [
    { label: 'firstVisit', cpu: 1 },
    { label: 'swWarm', cpu: 1 },
    { label: 'cpu4xWarm', cpu: 4 }
  ]) {
    const label = cfg.label;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu });
    cdp.drainEvents();
    const before = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
    await cdp.send('Page.navigate', { url: URL0 });
    const ready = await waitReady();
    await sleep(3500);
    const sum = await evaluate(SUMMARY);
    const after = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
    const events = cdp.drainEvents();
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params && e.params.exceptionDetails && e.params.exceptionDetails.text) || 'unknown');
    const frames = await evaluate(FRAMES);
    result.runs[label] = {
      readyIn20s: ready,
      cpuThrottleRate: cfg.cpu,
      navAndResources: sum,
      cdpDelta: deltaMetrics(before, after),
      jsExceptions: exceptions.slice(0, 10),
      frames: frames
    };
    console.log(label + ' 完成：FCP=' + (sum && sum.fcp) + 'ms, DCL=' +
      ((sum && sum.nav && sum.nav.dclEnd) || '?') + 'ms, longtask=' +
      ((sum && sum.longTasks && sum.longTasks.count) || '?'));
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('结果：' + OUT);
  cdp.close();
  edge.kill();
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try { server.close(); } catch (x) {}
  process.exit(1);
});
