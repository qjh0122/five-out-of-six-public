#!/usr/bin/env node
/**
 * 「5 秒内可以反悔」探针（v136）真浏览器 / CDP
 * 跑法：node scripts/probe-undo.js [宽] [高]      例：node scripts/probe-undo.js 390 844
 *      ZOOM=1 额外截图
 *
 * 为什么必须真浏览器：撤销条的整条逻辑都挂在**时间**和**DOM 存在性**上。
 *   · 单测能证明"到点会调 onCommit"，证明不了"5 秒之内数据真的还在"；
 *   · 单测能证明"hidden 会 flush"，证明不了 visibilitychange 真的挂上了；
 *   · 单测能证明"按钮绑了点击"，证明不了那个按钮**点得到**（pointer-events）。
 *
 * 这个探针只验战绩清除撤销（玩家能感知的四件事）：
 *   1) 确认清除之后，条子弹出来，且**此时记录还在**（这才是"可以反悔"的含义）
 *   2) 点「撤销」，记录、本机存储都还原到没清过的样子
 *   3) 不点，5 秒后真的清掉，且条子自己消失
 *   4) 条子不挡住「返回」这类关键按钮
 *
 * 本轮改动：离开房间的撤销条已按用户要求移除（点离开直接退），
 * 原 [6]–[10] 那段探针一并删除；直接退的真浏览器探针见 scripts/probe-leave.js。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const SRV_PORT = 3056;                 // 真实应用服务（不再是 ?mode=local 的静态服务器）
const CDP_PORT = 9363;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
/* SHOT_DIR 可指定：验收要看图时收进仓库（tmp-shots/ 是 .gitignore 的），
 * 默认仍进临时目录 —— 与 probe-numbers.js:353-359 同一条通道。 */
const OUT = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.tmpdir(), 'lxw-undo-probe');

/* ★ v139 曾为「三屏撤销条几何」把探针切到 ws 模式（只有 ws 能补 AI 凑够人数）。
 * 本轮那段已随「直接退」删除，断言段回到 ?mode=local；下面 startApp()/waitApp()
 * 是那段留下的进程启动代码，暂保留不动，避免夹带无关的进程收尾改动。 */
/* 断言段只走静态服务器 + ?mode=local —— [1]–[5] 的战绩清除撤销。
 * 这一段不需要服务端，也不会被云端记录干扰（ws 模式下战绩页读的是云端，
 * 种进 localStorage 的 2 条根本不会显示 —— 换成 ws 会当场把 [1]–[5] 全打红）。
 * 原来的 ws 服务启动代码（startApp / waitApp）随 [6]–[10] 一起失去用途，
 * 本轮先保留不动，避免顺手改动探针的进程收尾逻辑；下轮可单独清理。 */
const PORT = 3055;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-undo-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-undo-seed-' + Date.now() + '.json')
    }),
    stdio: 'ignore'
  });
}

function waitApp() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (tries > 60) return reject(new Error('应用服务没起来'));
        setTimeout(tick, 200);
      });
    })();
  });
}

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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            id += 1;
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
  });
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 两份最小的战绩。清除只关心"有没有数据、有几场"，
 * 所以不造回放 —— 造了也用不上，反而让种子变脆。 */
function seedRecords() {
  const now = Date.now();
  return [
    { id: 'R0-1', roomId: 'R0', endedAt: now, playerCount: 3, myStartScore: 20, myEndScore: 15, myNet: -5, endReason: 'dissolve', rounds: 2 },
    { id: 'R1-2', roomId: 'R1', endedAt: now - 3600000, playerCount: 4, myStartScore: 20, myEndScore: 26, myNet: 6, endReason: 'dissolve', rounds: 3 }
  ];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  startApp();
  await waitApp();
  const BASE = 'http://127.0.0.1:' + PORT;          // 本地演示模式（撤销机制）
  const BASE_WS = 'http://127.0.0.1:' + SRV_PORT;   // 真实服务（三屏几何要补 AI）

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-undo-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.error('连不上浏览器 CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return null;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  /* [1]–[5] 走本地演示模式：不需要真服务端，战绩全在 localStorage 里 */
  await cdp.send('Page.navigate', { url: BASE + '/?mode=local' });
  await sleep(1800);
  const seedJson = JSON.stringify(seedRecords());
  await evaluate(`localStorage.setItem('lxw_records_v1', ${JSON.stringify(seedJson)});
                  localStorage.setItem('lxw_guide_seen_v1','1');
                  localStorage.setItem('lxw_records_deduped_v2','1');
                  'ok'`);
  await cdp.send('Page.navigate', { url: BASE + '/?mode=local' });
  await sleep(1800);
  console.log('视口 ' + W + '×' + H);


  /* 纯几何采集器：只取矩形，**不碰文本**。
   * tools/qa/geometry-selftest.js 会把它当「尺子」逐条审：必须含
   * querySelectorAll + getBoundingClientRect，不许出现 ownText / NUM.test / textContent ——
   * 按文本分类的采集器看不见「框溢出但被 overflow:hidden 裁掉」这类盲区，
   * 拿它量出来的绿只说明它没看见，不能说明没问题。
   * 本段几何原先内联在 readState 里（那一份同时读撤销条文案），自验工具找不到尺子
   * 就一直拒绝下结论。拆出来之后尺子有名有姓，且 readState 直接从它取数，不留第二份。 */
  const GEO = (sels) => `(function(){
    var SELS = ${JSON.stringify(sels)};
    var out = { rects: {} };
    function rect(el){
      if (!el) return null;
      var b = el.getBoundingClientRect();
      return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
    }
    for (var i = 0; i < SELS.length; i++) {
      var els = document.querySelectorAll(SELS[i]);
      out.rects[SELS[i]] = els.length ? rect(els[0]) : null;
    }
    return out;
  })()`;

  const readState = `(function(){
    var bar = document.getElementById('undo-bar');
    var msg = document.getElementById('undo-msg');
    var act = document.getElementById('undo-act');
    var allRows = [].slice.call(document.querySelectorAll('#records-list .rp-row'));
    var rows = allRows.length;
    var visRows = allRows.filter(function(x){ return x.offsetParent !== null; }).length;
    var empty = document.getElementById('records-empty');
    var back = document.getElementById('btn-records-back');
    var store = [];
    try { store = JSON.parse(localStorage.getItem('lxw_records_v1') || '[]'); } catch (e) { store = []; }
    /* 几何一律走模块级的 GEO 那把尺子，本段不再自己量一遍 */
    var G = ${GEO(['#undo-bar', '#btn-records-back', '#undo-act'])};
    var br = G.rects['#undo-bar'], kr = G.rects['#btn-records-back'];
    var overlap = 0;
    if (br && kr) {
      var ix = Math.max(0, Math.min(br.r, kr.r) - Math.max(br.l, kr.l));
      var iy = Math.max(0, Math.min(br.b, kr.b) - Math.max(br.t, kr.t));
      overlap = ix * iy;
    }
    return {
      barShown: !!bar && !bar.classList.contains('hidden'),
      msg: msg ? msg.textContent : null,
      actText: act ? act.textContent : null,
      actRect: G.rects['#undo-act'],
      barRect: br,
      backOverlap: overlap,
      rows: rows,
      visRows: visRows,
      emptyShown: !!empty && !empty.classList.contains('hidden'),
      storeCount: store.length
    };
  })()`;

  console.log('\n[1] 打开战绩页，确认有数据');
  await evaluate(`document.getElementById('btn-records-home').click()`);
  await sleep(700);
  let st = await evaluate(readState);
  ok(st.rows === 2, '★ 战绩页读到 2 条记录（种子生效）', JSON.stringify({ rows: st.rows }));

  console.log('\n[2] 确认清除 → 条子弹出，但**记录还在**');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '★★ 条子弹出来了', JSON.stringify(st));
  /* 量词契约：recordsView.js 的清除确认文案是「将清除 N 局战绩」（第 1875 行），
   * 与 ai-note 那行同一套口径（局 = 一整场对局，三处都写「局」）。
   * 这里原先写「N 场」，UI 收口到「局」之后这条就一直假红。 */
  ok(/将清除 2 局/.test(st.msg || ''), '★★ 文案说清了「将清除几局」（不是一句模糊的"已清除"）', st.msg);
  ok((st.actText || '').trim() === '撤销', '撤销按钮文案正确', st.actText);
  ok(st.visRows === 2, '★★ 5 秒之内记录**还在**（这就是「可以反悔」的全部含义）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 本机存储也还没动', String(st.storeCount));
  ok(st.actRect && st.actRect.h >= 40, '★ 撤销按钮够高（' + (st.actRect ? st.actRect.h : '?') + ' CSS px，点不中等于没这个功能）');
  /* 条子压在屏幕下半部，最容易盖住「返回」。真重叠会让玩家在 5 秒里点不到返回 ——
   * 而那 5 秒恰好是他最可能想「算了我不清除了，先退出去看看」的时候。 */
  ok(st.backOverlap === 0, '★★ 条子和「返回」按钮零重叠', 'overlap=' + st.backOverlap + 'px²');
  const p1 = await shot('undo-bar.png');
  if (p1) console.log('    图：' + p1);

  console.log('\n[3] 点「撤销」→ 一切回到没清过的样子');
  await evaluate(`document.getElementById('undo-act').click()`);
  await sleep(400);
  st = await evaluate(readState);
  ok(st.barShown === false, '★ 条子收起');
  ok(st.visRows === 2, '★★ 记录仍在（撤销真的撤销了，而不是只是把条子藏起来）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 存储仍是 2 条');
  const pHidden = await shot('undo-bar-hidden.png');       // 撤销条「消失」帧
  if (pHidden) console.log('    图：' + pHidden);

  console.log('\n[4] 再确认一次，这次不撤销 → 5 秒后真的清掉');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '条子再次弹出');
  /* 关键：**5 秒之内**任何时刻都不该清。这里在 3 秒时插一刀。 */
  await sleep(3000);
  st = await evaluate(readState);
  ok(st.visRows === 2, '★★ 第 3 秒（窗口内）记录仍在', 'visRows=' + st.visRows);
  await sleep(2600);                       // 累计 5.6 秒，越过窗口
  st = await evaluate(readState);
  ok(st.barShown === false, '★★ 到点后条子自己消失（不需要玩家再点一次）');
  /* 用**可见**行数，不是 DOM 里的行数：清空时列表容器整块 display:none，
   * 行元素还留在 DOM 里（下一次渲染直接复用）。数 DOM 会一直看到 2 行 ——
   * 上一版就是这么假红的，页面其实已经空了。 */
  ok(st.visRows === 0, '★★ 到点后记录清空了', 'visRows=' + st.visRows + ' rows=' + st.rows);
  ok(st.emptyShown === true, '★ 切到空态（不是留一块空白）');
  ok(st.storeCount === 0, '★★ 本机存储也清了', String(st.storeCount));

  console.log('\n[5] 条子隐藏后不占位');
  {
    const pos = await evaluate(`(function(){
      var bar = document.getElementById('undo-bar');
      if (!bar) return null;
      var br = bar.getBoundingClientRect();
      var cs = getComputedStyle(bar);
      return { w: Math.round(br.width), h: Math.round(br.height), display: cs.display, pe: cs.pointerEvents };
    })()`);
    /* display:none 而不是 opacity:0 硬撑着 —— 后者会让一个不可见的盒子继续吃点击。
     * 这条和 .toast 的 pointer-events:none 是同一个教训的两个面。 */
    ok(pos && pos.display === 'none', '★★ 隐藏时 display:none（不是 opacity:0 留一个看不见的盒子吃点击）', JSON.stringify(pos));
    ok(pos && pos.w === 0 && pos.h === 0, '★ 隐藏时尺寸为 0（不占位）', JSON.stringify(pos));
  }

  /* ===================================================================
   * [6]–[10]：离开房间的撤销条 / 三屏几何探针已随「直接退」一起移除。
   * 用户要求点离开就直接退，不再有 confirm / 5 秒撤销条 / 广播结账 / 锚点；
   * 这些探针断言的现象已不存在。直接退的真浏览器探针见 scripts/probe-leave.js。
   * 下方 [1]–[5]（战绩清除的 5 秒撤销）完整保留。
   * =================================================================== */


  cdp.close();
  edge.kill();
  server.close();
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}


main().catch((e) => { console.error(e); process.exit(1); });
