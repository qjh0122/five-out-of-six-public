/**
 * 「离开房间 → 直接退」探针（一次性诊断脚本，不进测试套件）
 *
 * 本轮用户要求：取掉离开确认的步骤，点「离开房间」就直接退。
 * 用途：用真 Edge（headless + CDP）走一遍
 *   注册 → 建房（WAITING）→ 点「离开」→ 开局 → 点「离开」
 * 回答三个问题：
 *   ① 等待中 / 对局中点离开，会不会弹 confirm / 撤销条？（期望：都不弹）
 *   ② 是不是立刻回到首页（screen-home）且 state.roomId 清空？
 *   ③ 连点离开，leaveRoom 调用次数是否 ≤ 1？
 *
 * 为什么必须真浏览器：静态读源码只能确认接线形状，确认不了玩家眼里
 * 「点了到底有没有退」。探针用页面内 spy 数 leaveRoom 的真实调用次数。
 *
 * 用法：node scripts/probe-leave.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3022;
const SRV_PORT = 3023;
const CDP_PORT = 9334;
const ROOT = path.join(__dirname, '..', 'pwa');

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
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-lv-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-lv-seed-' + Date.now() + '.json')
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

async function main() {
  server.listen(PORT, '127.0.0.1');
  startApp();
  await waitApp();
  console.log('应用服务 127.0.0.1:' + SRV_PORT + '  视口 ' + W + '×' + H);

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-lv-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
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
  if (!page) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await sleep(1800);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  /* 页面内探针：包一层 RoomStore.leaveRoom 数「真离开」发生了几次。
   * 不注入产品代码，全部在探针进程里包一层。 */
  const hookOk = await evaluate(`(function(){
    var R = window.RoomStore;
    if (!R) return 'no-RoomStore';
    window.__leaveSpy = { calls: 0 };
    var orig = R.leaveRoom;
    R.leaveRoom = function(){
      window.__leaveSpy.calls++;
      return orig.apply(this, arguments);
    };
    return 'ok';
  })()`);
  ok(hookOk === 'ok', '★ 装上 leaveRoom spy（不是空扫描）', hookOk);

  const readLeaveState = `(function(){
    var m = document.getElementById('confirm-modal');
    var bar = document.getElementById('undo-bar');
    var s = document.querySelector('#stage .screen:not(.hidden)');
    return {
      dialog: !!(m && !m.classList.contains('hidden')),
      bar: !!(bar && !bar.classList.contains('hidden')),
      screen: s ? s.id : '',
      roomId: (window.LXWState && window.LXWState.roomId) || '',
      leaveCalls: window.__leaveSpy ? window.__leaveSpy.calls : -1
    };
  })()`;

  /* 离开后回首页，再建房要走一次「创建 → 选局数确认」。 */
  const createRoom = async () => {
    await evaluate(`(function(){
      var n = document.getElementById('nickname-input');
      if (n) { n.value = '探针'; n.dispatchEvent(new Event('input',{bubbles:true})); }
      var b = document.getElementById('btn-create'); if (b) b.click(); return 'ok';
    })()`);
    await sleep(500);
    await evaluate(`(function(){ var b = document.getElementById('btn-create-confirm'); if (b) b.click(); return 'ok'; })()`);
    await sleep(900);
  };

  console.log('\n[1] 注册并建房');
  const reg = await evaluate(`(async function(){
    function click(sel){ var b=document.querySelector(sel); if(b){ b.click(); return true; } return false; }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await new Promise(s=>setTimeout(s,250));
    var name = 'lvprobe' + Math.floor(Math.random()*100000);
    document.getElementById('auth-name').value = name;
    document.getElementById('auth-pass').value = 'probe123456';
    var nick = document.getElementById('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '探针';
    document.getElementById('btn-auth-submit').click();
    await new Promise(s=>setTimeout(s,1800));
    var homeVisible = !document.getElementById('screen-home').classList.contains('hidden');
    if (!homeVisible) return { account: name, homeVisible: false,
      err: (document.getElementById('auth-err')||{}).textContent || null };
    var n = document.getElementById('nickname-input');
    if (n) { n.value = '探针'; n.dispatchEvent(new Event('input',{bubbles:true})); }
    document.getElementById('btn-create').click();
    /* ★ v103 起「创建房间」先弹「本局打几把」，点了确认才真的开房。
     * 缺这一步 → 房间没建 → 后面所有断言都拿不到牌桌（脚本过期，不是功能坏）。
     * ★ 这一段是**跑在页面里**的代码（整块作为字符串传给 evaluate），
     *   只能用页面内的 Promise/setTimeout；写 Node 侧的 sleep()/evaluate(cdp)
     *   会报 "… is not a function"（第一版就是这么改错的）。 */
    await new Promise(function (s) { setTimeout(s, 500); });
    var cfBtn = document.getElementById('btn-create-confirm');
    if (cfBtn) cfBtn.click();
    await new Promise(function (s) { setTimeout(s, 500); });
    await new Promise(s=>setTimeout(s,900));
    return {
      account: name,
      /* v82 起准备态画在牌桌上，房间页在默认配置下是隐藏的。
       * 判「进到准备态了吗」要两个都认，只认 screen-room 会把正常流程判成失败。 */
      roomVisible: !document.getElementById('screen-room').classList.contains('hidden')
        || !document.getElementById('table-ready').classList.contains('hidden'),
      myId: (window.LXWState && window.LXWState.myId) || null
    };
  })()`);
  console.log(JSON.stringify(reg));
  ok(reg && reg.roomVisible === true, '建房成功，进入准备态');

  console.log('\n[2] 等待中点「离开」→ 直接退，无 confirm / 无撤销条');
  const waitLeave = await evaluate(`(async function(){
    window.__leaveSpy.calls = 0;
    var b = document.getElementById('btn-leave');
    b.click();
    var busyText = b.textContent;
    var busyDisabled = b.disabled;
    await new Promise(s=>setTimeout(s,800));
    var r = ${readLeaveState};
    r.busyText = busyText;
    r.busyDisabled = busyDisabled;
    return r;
  })()`);
  console.log(JSON.stringify(waitLeave));
  ok(waitLeave && waitLeave.dialog === false, '★★ 等待点离开：没有 confirm 弹窗');
  ok(waitLeave && waitLeave.bar === false, '★★ 等待点离开：没有撤销条');
  ok(waitLeave && waitLeave.screen === 'screen-home', '★★ 直接回到首页', waitLeave && waitLeave.screen);
  ok(waitLeave && waitLeave.roomId === '', '★★ state.roomId 已清空', waitLeave && waitLeave.roomId);
  ok(waitLeave && waitLeave.leaveCalls === 1, '★ leaveRoom 恰好 1 次', waitLeave && waitLeave.leaveCalls);
  ok(waitLeave && waitLeave.busyText === '离开中…', '★ 点击同拍「离开中…」反馈', waitLeave && waitLeave.busyText);
  ok(waitLeave && waitLeave.busyDisabled === true, '★ 点击同拍按钮 disabled（挡连点）');

  console.log('\n[3] 重新建房 → 准备 → 补 AI → 开局');
  await createRoom();
  const startFlow = await evaluate(`(async function(){
    var r = {};
    /* 补 AI 在准备之前：全员准备即开局，顺序反了会在第一个 AI 进来时就开局 */
    r.bots = 0;
    for (var i = 0; i < 12; i++) {
      var b = document.getElementById('btn-add-bot');
      if (!b || b.classList.contains('hidden')) break;
      b.click(); r.bots += 1;
      await new Promise(s=>setTimeout(s,650));
    }
    /* 最后准备 → 自动开局（「开始游戏」按钮已删） */
    document.getElementById('btn-ready').click();
    await new Promise(s=>setTimeout(s,1200));
    r.gameVisible = !document.getElementById('screen-game').classList.contains('hidden');
    var ph = document.getElementById('phase-label');
    r.phase = ph ? ph.textContent : null;
    return r;
  })()`);
  console.log(JSON.stringify(startFlow));
  ok(startFlow && startFlow.gameVisible === true, '进入对局页');

  console.log('\n[4] ★ 对局中点「离开」→ 直接退（弃局由服务端记账，本端不弹确认）');
  const midLeave = await evaluate(`(async function(){
    window.__leaveSpy.calls = 0;
    var btn = document.getElementById('btn-leave-game');
    btn.click();
    /* 忙碌态必须在 click() 返回的**同一拍**读：onLeave 的同步段在 click() 内跑完。 */
    var busyText = btn.textContent;
    var busyDisabled = btn.disabled;
    await new Promise(s=>setTimeout(s,900));
    var r = ${readLeaveState};
    r.busyText = busyText;
    r.busyDisabled = busyDisabled;
    return r;
  })()`);
  console.log(JSON.stringify(midLeave));
  ok(midLeave && midLeave.dialog === false, '★★ 对局中不弹 confirm');
  ok(midLeave && midLeave.bar === false, '★★ 对局中不弹撤销条');
  ok(midLeave && midLeave.screen === 'screen-home', '★★ 弃局后直接回首页', midLeave && midLeave.screen);
  ok(midLeave && midLeave.roomId === '', '★★ 弃局后 state.roomId 已清空', midLeave && midLeave.roomId);
  ok(midLeave && midLeave.leaveCalls === 1, '★ leaveRoom 恰好 1 次', midLeave && midLeave.leaveCalls);
  ok(midLeave && midLeave.busyText === '离开中…', '★ 点击同拍「离开中…」反馈', midLeave && midLeave.busyText);
  ok(midLeave && midLeave.busyDisabled === true, '★ 点击同拍按钮 disabled（挡连点）');

  console.log('\n[5] 连点离开 → leaveRoom 调用次数 ≤ 1');
  await createRoom();
  const spam = await evaluate(`(async function(){
    window.__leaveSpy.calls = 0;
    var b = document.getElementById('btn-leave');
    for (var i = 0; i < 6; i++) { if (b) b.click(); }
    await new Promise(s=>setTimeout(s,900));
    return ${readLeaveState};
  })()`);
  console.log(JSON.stringify(spam));
  ok(spam && spam.leaveCalls <= 1, '★★ 连点 6 次，leaveRoom ≤ 1', spam && spam.leaveCalls);
  ok(spam && spam.screen === 'screen-home', '连点后仍回到首页', spam && spam.screen);

  /* 收尾：真的离开，并把探针账号删掉，别在种子文件里留垃圾 */
  await evaluate(`(async function(){
    var t = Store.read(Store.KEYS.SESSION) || '';
    var tok = '';
    try { tok = (JSON.parse(t) || {}).token || ''; } catch(e) {}
    await fetch('/api/auth/delete', {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Session-Token':tok},
      body: JSON.stringify({ password:'probe123456' })
    }).catch(function(){});
    return true;
  })()`);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  try { edge.kill(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}
  server.close();
  await sleep(200);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { serverProc && serverProc.kill(); } catch (x) {}
  process.exit(1);
});
