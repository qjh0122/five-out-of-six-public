/**
 * E9 真人路径：真服务端 + 真账号 + 真鼠标点击，从地址栏一路点到「发出一条表情」
 *
 * 为什么要有这个脚本（它和 probe-emoji.js / journey.js 的分工）
 * ------------------------------------------------------------
 * probe-emoji.js 为了把 20 条消息铺满六档，必须把页面调成 `?mode=local`
 * 并用 RoomStore.joinRoom 直接塞 4 个假玩家。那套断言很密，但它**绕过了两个
 * 真人绕不过去的东西**：
 *   1. 登录墙。演示模式没有账号，生产路径上没有身份就被服务端拒。
 *   2. 「补 AI 队友」按钮。它是 `RoomStore.getMode() === 'ws'` 才显示的
 *      （game.js:755 `canAddBot`）—— 也就是说，**按钮出现本身就证明这是真 ws 路径**。
 *      一个 `?mode=local` 的探针永远看不到这颗按钮，等于把「五个人怎么坐满的」
 *      这件事跳过了。
 * 而 journey.js 覆盖了「注册 → 建房 → 补 AI → 分牌 → 结算 → 战绩 → 排行榜」，
 * 但它**一条表情都没发**。
 *
 * 所以这个脚本只做一件事：把 journey 的开头那段（到进牌桌为止）重走一遍，
 * 然后用 `Input.dispatchMouseEvent` —— 真的鼠标按下/抬起，不是 `el.click()` ——
 * 点表情钮、点格子、点对手头像。页面里**不注入任何状态**：不写 localStorage、
 * 不碰 RoomStore、不种 sessionStorage 假 id。唯一读的是 getBoundingClientRect，
 * 那是「鼠标该落在哪」的坐标查询，跟人眼看位置没有区别。
 *
 * 为什么这对本轮改动特别重要
 * --------------------------
 * 表情气泡这次改成「贴着人 + 尾巴指向 + 四方向按桌心择优 + 兜底改成署名」。
 * 这些东西的失效方式全是「断言全绿但人看着不对」：尾巴指向隔壁那个人、
 * 长短语兜底后没有署名、气泡贴在座位块外面看着像浮空。探针能测出「尖端落在
 * 外扩区内」，测不出「我在屏幕上看到的那个三角，指的是不是发话的人」。
 * 这个脚本的产出主要就是**截图**，断言只负责拦明显错（出屏、盖头像、无主）。
 *
 * 用法
 * ----
 *   node tools/qa/e9-emoji-realperson.js                # 1366×768（桌面，用户投诉「太小」的那一档）
 *   E9_W=1920 E9_H=1080 node tools/qa/e9-emoji-realperson.js
 *   E9_W=390 E9_H=844 node tools/qa/e9-emoji-realperson.js
 *
 * 截图落在 `os.tmpdir()/lxw-e9-<W>x<H>/`，脚本会打印路径。
 *
 * 数据隔离：和 journey.js 同一套纪律 —— PROFILE_FILE / SEED_FILE / DATA_DIR
 * 全指到临时目录，退出即删；**绝不读写 server/data/**（那是真实玩家档案），
 * 结束时还要校验它一个字节都没动。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRV_PORT = Number(process.env.E9_PORT) || 3973;
const CDP_PORT = Number(process.env.E9_CDP) || 9379;
const W = Number(process.env.E9_W) || 1366;
const H = Number(process.env.E9_H) || 768;
/* 像素密度：判「尾巴有没有真的画出来」这类事，1x 看小图容易看成没有。
 * 布局（CSS px）与密度无关，所以不同密度下读到的几何必须一致 —— 这本身也是一条判据。 */
const DPR = Number(process.env.E9_DPR) || 1;

const ROOT = path.join(__dirname, '..', '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');
const REAL_DATA = path.join(ROOT, 'server', 'data', 'profiles.example.json');

const EDGE = (function () {
  try {
    return require(path.join(ROOT, 'scripts', 'lib', 'browser.js')).findBrowser();
  } catch (e) {
    return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  }
})();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-e9-'));
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-e9-' + W + 'x' + H + (DPR !== 1 ? '-dpr' + DPR : ''));
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const badOnes = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '（' + extra + '）' : '')); }
  else { fail++; badOnes.push(name); console.log('  FAIL  ' + name + (extra ? '（' + extra + '）' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* 页面自己报的错、以及未捕获异常，一条都不许漏 —— 这一趟是「真人会不会撞见红字」 */
const pageErrors = [];

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
        return;
      }
      /* 没有 id 的是事件：控制台报错与未捕获异常都在这里过一遍 */
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = (msg.params && msg.params.exceptionDetails) || {};
        pageErrors.push('uncaught: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params && msg.params.entry;
        if (e && (e.level === 'error' || e.level === 'warning')) {
          pageErrors.push(e.level + ': ' + e.text + (e.url ? ' @' + e.url : ''));
        }
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const t = msg.params && msg.params.type;
        if (t === 'error' || t === 'assert') {
          pageErrors.push('console.' + t + ': ' + ((msg.params.args || []).map((a) => a.value || a.description || '').join(' ')));
        }
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

let cdp = null;
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r && r.exceptionDetails) {
    throw new Error('页面内异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
      || r.exceptionDetails.text));
  }
  return r && r.result ? r.result.value : undefined;
}

async function waitFor(expr, ms) {
  const end = Date.now() + (ms || 6000);
  let lastErr = null, lastVal = undefined;
  while (Date.now() < end) {
    try { lastVal = await evaluate(expr); if (lastVal) return true; } catch (e) { lastErr = e; }
    await sleep(120);
  }
  /* 等不到就说清「为什么等不到」：表达式抛异常、还是表达式老老实实返回 false。
   * 这两种失败长得一样，但一个是脚本写错、一个是功能没到位，混着报会查错方向。 */
  console.log('    [waitFor 超时] ' + expr.slice(0, 90)
    + ' → 最后取值=' + JSON.stringify(lastVal)
    + (lastErr ? ' 最后异常=' + String(lastErr.message).slice(0, 160) : ''));
  return false;
}

/* ---------------------------- 真鼠标 ----------------------------
 * 三个事件缺一不可：移动（让 :hover 生效、有些库靠 mousemove 才装状态）、
 * 按下、抬起。只发 click 的话，绑在 pointerdown 上的面板会被判成没点。 */
async function rectOf(sel) {
  return evaluate(`(function(){
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2 || r.height < 2) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
             l: r.left, t: r.top, r: r.right, b: r.bottom };
  })()`);
}

async function realClickAt(x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base, { button: 'none' }));
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  await sleep(120);
}

/* ★ 点之前先等「位置稳定」（2026-11-14 晚）。
 *
 * 症状：注册完进首页，第一次点「创建房间」必然落空，第二次必成 —— 连红四次。
 * 查下来不是按钮坏了，是 `.screen.enter` 有 `slideInRight 0.3s` 的入场动画：
 * 屏幕刚可见时 `getBoundingClientRect` 给的是**动画中**的位置。
 * 实测那一下按钮中心在 (1817,313)，而视口只有 1366 宽 —— 点在屏幕外面。
 *
 * 这不是应用的缺陷：真人不可能在 300ms 内看清并点中刚滑进来的按钮。
 * 是**脚本比真人快**。修法是让脚本等元素停稳（两次量到的位置一致才算），
 * 而不是加 sleep —— sleep 是猜时长，量位置是看事实。
 */
async function realClick(sel) {
  let prev = null;
  const t0 = Date.now();
  for (;;) {
    const r = await rectOf(sel);
    if (!r) throw new Error('点不到（元素不存在或不可见）：' + sel);
    if (prev && Math.abs(r.x - prev.x) < 0.5 && Math.abs(r.y - prev.y) < 0.5) {
      await realClickAt(r.x, r.y);
      return r;
    }
    prev = r;
    if (Date.now() - t0 > 900) {           // 一直在动（比如无限动画）：不再等，点当下位置
      await realClickAt(prev.x, prev.y);
      return prev;
    }
    await sleep(60);
  }
}

async function typeText(text) {
  await cdp.send('Input.insertText', { text: text });
  await sleep(80);
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

/* ---------------------------- 气泡读数 ----------------------------
 * 只读 DOM，不改任何东西。判据和探针刻意**不同口径**：
 * 探针比的是「尖端是否落在座位块外扩区内」，这里比的是**人眼看的东西** ——
 * 气泡是否整块在屏内、是否压住某个人的头像、有没有尾巴、有没有署名。 */
/* 当前房间里有几个人。两套版式共用：#room-players（房间网格）/ #game-top（圆桌）。
 * ★ 圆桌版式里「我」也在 [data-pid] 里（探针的 seatDump 同样包含 gt-me），
 *   所以两处口径一致，直接取大的那个；不要再手工 +1，那会重复计。 */
const SEAT_TOTAL = '(function(){var a=document.querySelectorAll("#room-players [data-pid]").length;'
  + 'var b=document.querySelectorAll("#game-top [data-pid]").length;return Math.max(a,b);})()';

const BUBBLE_READ = `(function(){
  var layer = document.getElementById('emoji-layer');
  if (!layer) return { nodes: 0 };
  var nodes = [].slice.call(layer.querySelectorAll('.emoji-fly'));
  function box(el){ var r = el.getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height }; }
  var avatars = [].slice.call(document.querySelectorAll('#game-top [data-pid]')).map(function(s){
    var av = s.querySelector('.gt-av') || s;
    var r = av.getBoundingClientRect();
    return { pid: s.getAttribute('data-pid'), me: s.classList.contains('gt-me'),
             l:r.left, t:r.top, r:r.right, b:r.bottom, cx:(r.left+r.right)/2, cy:(r.top+r.bottom)/2 };
  });
  var out = nodes.map(function(n){
    var b = box(n);
    var ps = getComputedStyle(n, '::after');
    var tailW = parseFloat(ps.width) || 0, tailH = parseFloat(ps.height) || 0;
    var absent = n.getAttribute('data-tail') === 'off';
    var by = n.querySelector('.emoji-by');
    /* 哪个头像被这块气泡压住了（中心点落进去才算，边上擦一点不算 —— 和用户看到的判断一致） */
    var cover = avatars.filter(function(a){
      return a.cx > b.l && a.cx < b.r && a.cy > b.t && a.cy < b.b;
    }).map(function(a){ return (a.me ? '我' : a.pid); });
    return {
      dir: n.getAttribute('data-dir'),
      tailAbsent: absent,
      hasTail: !absent && tailW > 0 && tailH > 0,
      tailLen: tailW, tailH: tailH,
      hasBy: !!by,
      byText: by ? by.textContent.trim() : '',
      shift: n.getAttribute('data-shift'),
      text: (n.querySelector('.emoji-text') ? n.querySelector('.emoji-text').textContent : '').trim(),
      img: !!n.querySelector('img'),
      box: b,
      inView: b.l >= -1 && b.t >= -1 && b.r <= innerWidth + 1 && b.b <= innerHeight + 1,
      covers: cover,
      overflowsLeft: Math.max(0, -b.l),
      overflowsRight: Math.max(0, b.r - innerWidth),
      overflowsTop: Math.max(0, -b.t),
      overflowsBottom: Math.max(0, b.b - innerHeight)
    };
  });
  return { nodes: nodes.length, items: out, vw: innerWidth, vh: innerHeight, avatars: avatars };
})()`;

/* ============================ 主流程 ============================ */
(async function main() {
  let server = null, edge = null;
  const dataBefore = fs.existsSync(REAL_DATA) ? fs.readFileSync(REAL_DATA) : null;

  try {
    /* 1) 真服务端（真 ws + 真账号），数据全在临时目录 */
    console.log('===== E9 真人路径 ' + W + '×' + H + '（ws 模式，真服务端） =====');
    const dataDir = path.join(TMP, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(SRV_PORT),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PROFILE_FILE: path.join(TMP, 'profiles.json'),
        SEED_FILE: path.join(TMP, 'seed.json'),
        EVENT_LOG: 'off',
        BOT_BASE: 'http://127.0.0.1:' + SRV_PORT
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let srvLog = '';
    server.stdout.on('data', (d) => { srvLog += d; });
    server.stderr.on('data', (d) => { srvLog += d; });
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await getJson('http://127.0.0.1:' + SRV_PORT + '/api/health'); if (h) { healthy = true; break; } } catch (e) {}
    }
    if (!healthy) throw new Error('服务端没起来：\n' + srvLog.slice(-800));
    ok(healthy, '服务端起来了（/api/health 有响应）');

    /* 2) 干净浏览器：全新 user-data-dir，等于换了一台没碰过的机器 */
    edge = spawn(EDGE, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + path.join(TMP, 'edge-profile'),
      '--window-size=' + W + ',' + H,
      '--force-device-scale-factor=1',
      'about:blank'
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
    if (!page) throw new Error('连不上 Edge CDP（端口 ' + CDP_PORT + ' 被占用？）');
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    /* Log / Console 都开着：真人遇到的「红字」就是这两路来的 */
    await cdp.send('Log.enable');
    /* dsf 固定 1：这一段要的是**看得清的实物**，不是高 DPI 下的像素级读数。
     * 1920 档在 dsf=2 下会合成 3840×2160 的截图面，captureScreenshot 会卡死
     * （092 那两次 300 秒超时就是它）。1x 下 1920×1080 截得动、也看得清。 */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: DPR, mobile: false
    });

    /* 3) 地址栏直进 —— 根 URL，不带 ?mode=local，不带 sharecode */
    const url = 'http://127.0.0.1:' + SRV_PORT + '/';
    await cdp.send('Page.navigate', { url: url });
    await sleep(2200);
    const onAuth = await waitFor('!document.getElementById("screen-auth").classList.contains("hidden")', 8000);
    ok(onAuth, '★ 冷启动（无会话、无参数）落到登录页，不是白屏也不是首页');

    /* 3b) 新用户的第二屏其实是**引导层**（`lxw_guide_seen_v1` 没置过就弹）。
     * 真人到这一步只会做一件事：点右上角「跳过」。
     * 探针一直靠 `localStorage.setItem('lxw_guide_seen_v1','1')` 把它抹掉 ——
     * 于是「引导层会不会挡住登录」这件事从来没被人看过。第一次跑这条脚本就撞上了：
     * 真实鼠标点在「注册」tab 上，落点被引导层的卡片挡住，tab 没切过去。
     * 这不是脚本 bug，这是**真人会遇到的第一件事**，所以照原样走一遍。 */
    const guideUp = await evaluate('(function(){var g=document.getElementById("guide-modal");'
      + 'return !!g && !g.classList.contains("hidden");})()');
    ok(guideUp, '★ 新账号冷启动会先弹引导层（探针一直用 localStorage 抹掉它，没人验过这条路）');
    if (guideUp) {
      await realClick('#guide-skip');
      const guideGone = await waitFor('document.getElementById("guide-modal").classList.contains("hidden")', 3000);
      ok(guideGone, '点「跳过」→ 引导层关掉');
    }
    if (process.env.E9_SHOTS !== '0') console.log('    截图：' + (await shot('1-auth')));

    /* 4) 注册：真点 tab、真敲字、真点提交 */
    await realClick('[data-auth-tab="register"]');
    const nickFieldShown = await waitFor('!document.getElementById("auth-nick-field").classList.contains("hidden")', 3000);
    ok(nickFieldShown, '点「注册」后昵称框出现（tab 真的切过去了）');
    const accName = 'e9' + Date.now().toString(36).slice(-6);
    await realClick('#auth-name'); await typeText(accName);
    await realClick('#auth-pass'); await typeText('e9pass123');
    await realClick('#auth-nick'); await typeText('本人');
    await realClick('#btn-auth-submit');
    const home = await waitFor('!document.getElementById("screen-home").classList.contains("hidden")'
      + ' && document.getElementById("screen-auth").classList.contains("hidden")', 15000);
    ok(home, '注册成功、进到首页（账号 ' + accName + '）');
    if (!home) throw new Error('注册这一段没过去，后面的都没有意义');
    if (process.env.E9_SHOTS !== '0') console.log('    截图：' + (await shot('2-home')));

    /* 5) 建房：真点「创建房间」→ 真点「本局打几把」的确认 */
    if (process.env.E9_DEBUG === '1') {
      const r0 = await rectOf('#btn-create');
      const info = await evaluate('(function(){'
        + 'var x=' + Math.round(r0.x) + ',y=' + Math.round(r0.y) + ';'
        + 'var e=document.elementFromPoint(x,y);var s=[];'
        + 'while(e&&s.length<5){s.push(e.tagName+(e.id?"#"+e.id:""));'
        + 'e=e.parentElement;}'
        + 'return {vp:[innerWidth,innerHeight,scrollX,scrollY],hit:s.length?s.join("<"):"(点空)"};})()');
      console.log('    [命中] 按钮中心 (' + Math.round(r0.x) + ',' + Math.round(r0.y) + ') '
        + JSON.stringify(info));
    }
    await realClick('#btn-create');
    await sleep(400);
    const confirmShown = await waitFor('document.getElementById("btn-create-confirm")'
      + ' && !document.getElementById("btn-create-confirm").closest(".hidden")', 4000);
    ok(confirmShown, '「本局打几把」弹层出现（v103 起的二次确认）');
    await realClick('#btn-create-confirm');
    /* ★ 建房之后落到哪一屏，取决于版式：老版是 #screen-room（房间网格），
     * 新版「圆桌」版式是把**同一份房间状态画在牌桌上**（#screen-game 可见、
     * #screen-room 故意保持 hidden，见 game.js:827 与 journey.js:924 的注释）。
     * 第一版这里只等 #screen-room，于是 1366 档明明已经坐在房间里（截图里
     * 房间号、补 AI 按钮都在），脚本却报「建不了房」—— 这是脚本过期，
     * 不是功能坏了，跟探针那次「创建房间多了一层二次确认」是同一类。 */
    const inRoom = await waitFor('(function(){'
      + 'function vis(id){var e=document.getElementById(id);return !!(e&&!e.classList.contains("hidden"));}'
      + 'return vis("screen-room") || (vis("screen-game") && !!document.getElementById("btn-add-bot")'
      + ' && getComputedStyle(document.getElementById("btn-add-bot")).display!=="none");})()', 12000);
    ok(inRoom, '进到房间（房间网格或圆桌版式都算）');
    if (!inRoom) throw new Error('建不了房');

    /* 6) 补 AI ×4 —— 这颗按钮只在 ws 模式可见，所以「点得到」本身就是证据 */
    const botBtn = await rectOf('#btn-add-bot');
    ok(!!botBtn, '★「补 AI 队友」按钮可见 —— 这一条同时证明页面跑在真 ws 路径上（local 模式下它被隐藏）');
    /* 连点直到坐满：补一个 AI 之后座位网格会重排、按钮会跟着挪位，
     * 真人也是「看到人没满就再点一次」，不是精确点 4 下就撒手。
     * 第一版写死点 4 次，实测只落进 3 个（有一次点在重排的空档上）—— 
     * 断言就红了，而功能是好的。这里改成「点到满或点到 6 次为止」。 */
    let seatsNow = 0;
    for (let i = 0; i < 6 && seatsNow < 5; i++) {
      await realClick('#btn-add-bot');
      await sleep(900);
      seatsNow = await evaluate(SEAT_TOTAL);
    }
    ok(seatsNow >= 5, '点「补 AI 队友」→ 房间满 5 人', '实测 ' + seatsNow + ' 人');
    /* 7) 准备 → 开局。准备键有两套版式：#btn-ready（房间底排）/ #table-ready（牌桌动作条） */
    const readySel = (await rectOf('#btn-ready')) ? '#btn-ready' : '#table-ready';
    ok(!!(await rectOf(readySel)), '看得到「准备」键', readySel);
    await realClick(readySel);
    const inGame = await waitFor('!document.getElementById("screen-game").classList.contains("hidden")'
      + ' && document.querySelectorAll("#game-top [data-pid]").length >= 4', 20000);
    ok(inGame, '准备 → 开局，顶栏出现 4 个对手座位');
    if (!inGame) throw new Error('开不了局');
    await sleep(900);
    if (process.env.E9_SHOTS !== '0') console.log('    截图：' + (await shot('3-table')));

    /* ★ 手牌区几何（E9_MEASURE=1 才打）：判「气泡会不会盖住自己的牌」必须先有真实盒子。
     *   「手牌区」在 DOM 里不是一个节点，是 `.game-bottom`（#hand + 动作按钮）；
     *   凭截图目测 y 值和这里能差几十像素，够把结论判反。 */
    if (process.env.E9_MEASURE === '1') {
      const geo = await evaluate('(function(){'
        + 'function r(sel){var e=document.querySelector(sel);if(!e)return null;'
        + 'var b=e.getBoundingClientRect();return {l:Math.round(b.left),t:Math.round(b.top),'
        + 'r:Math.round(b.right),b:Math.round(b.bottom),w:Math.round(b.width),h:Math.round(b.height)};}'
        + 'var seats=[].slice.call(document.querySelectorAll("#game-top [data-pid]")).map(function(e){'
        + 'var b=e.getBoundingClientRect();return {id:e.getAttribute("data-pid"),l:Math.round(b.left),'
        + 't:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)};});'
        + 'return {vw:innerWidth,vh:innerHeight,bottom:r(".game-bottom"),hand:r("#hand"),'
        + 'actions:r(".game-actions"),emojiBtn:r("#btn-emoji"),seats:seats};})()');
      console.log('    几何：' + JSON.stringify(geo));
    }

    /* 8) 真点桌面右下角的表情钮 */
    const emojiBtnRect = await rectOf('#btn-emoji');
    ok(!!emojiBtnRect, '表情钮可见');
    await realClick('#btn-emoji');
    const sheetOpen = await waitFor('!document.getElementById("seat-sheet").classList.contains("hidden")', 4000);
    ok(sheetOpen, '点表情钮 → 面板打开');
    const title = await evaluate('(document.getElementById("ss-name")||{}).textContent');
    ok(title === '发给全场', '面板标题是「发给全场」（不是弹「发给谁」的选择）', String(title));

    /* 9) 发给全场一条短语：真人会点「短语」档，然后点第一条长句 */
    const phrTab = await rectOf('#ss-tabs [data-ss-tab="phr"]');
    if (phrTab) await realClick('#ss-tabs [data-ss-tab="phr"]');
    const phrShown = await waitFor('!document.getElementById("emoji-phr").classList.contains("hidden")', 3000);
    ok(phrShown, '切到「短语」档');
    /* 挑最长的一条 —— 长短语正是本轮出问题的那个场景（放不下 → 兜底 → 署名） */
    const longestSel = await evaluate(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#emoji-phr .phrase-row'));
      if (!rows.length) return '';
      var best = 0, bi = 0;
      rows.forEach(function(r, i){ var n = (r.textContent || '').length; if (n > best) { best = n; bi = i; } });
      rows[bi].setAttribute('data-e9-pick', '1');
      return '#emoji-phr .phrase-row[data-e9-pick="1"]';
    })()`);
    ok(!!longestSel, '短语档里挑出最长的一条（本轮出问题的正是长句）');
    if (longestSel) {
      await realClick(longestSel);
      /* ★ 采样窗口只有 500~1400ms：气泡 430ms 落定、1500ms 开始淡出、1900ms 被移除。
       * 第一版在这里睡 1800ms，读到的永远是「已经没了」—— 断言全红而功能是好的。
       * 这不是探针口径问题，是我把「动画时长」和「存活时长」当成了同一个数。 */
      await sleep(700);
      const b = await evaluate(BUBBLE_READ);
      ok(b.nodes === 1, '点一条短语 → 出现 1 个气泡', '实测 ' + b.nodes);
      const it = b.items && b.items[0];
      if (it) {
        ok(it.inView, '★ 气泡整块在屏内（真人不会看到半截气泡）',
          '出界左 ' + Math.round(it.overflowsLeft) + ' 右 ' + Math.round(it.overflowsRight)
          + ' 上 ' + Math.round(it.overflowsTop) + ' 下 ' + Math.round(it.overflowsBottom));
        ok(it.covers.indexOf('我') < 0 && it.covers.length === 0,
          '★ 气泡没有压住任何人的头像', '压住了 [' + it.covers.join(',') + ']');
        ok(it.hasBy || it.hasTail, '★ 归属说得清：要么有尾巴指着人，要么有署名',
          '尾巴=' + (it.hasTail ? '有' : '无') + ' 署名=' + (it.hasBy ? it.byText : '无'));
        console.log('    读数：dir=' + it.dir + ' 尾巴=' + (it.hasTail ? it.tailLen + '×' + it.tailH : '无')
          + ' 署名=' + (it.hasBy ? '「' + it.byText + '」' : '无') + ' shift=' + it.shift);
      }
      /* 放大看尾巴：1x 全图里 13 CSS px 的三角只有十来个像素，
       * 「看起来没有」和「真的没有」在这张图上分不开 —— 判尾巴必须用放大图。 */
      if (process.env.E9_SHOTS !== '0' && it) {
        const pad = 70;
        const cl = Math.max(0, it.box.l - pad), ct = Math.max(0, it.box.t - pad);
        const cw = Math.min(W - cl, it.box.w + pad * 2), ch = Math.min(H - ct, it.box.h + pad * 2);
        const z = await cdp.send('Page.captureScreenshot', { format: 'png',
          clip: { x: cl, y: ct, width: cw, height: ch, scale: 4 } });
        const zf = path.join(SHOT_DIR, '4-phrase-all-zoom.png');
        fs.writeFileSync(zf, Buffer.from(z.data, 'base64'));
        console.log('    放大图（气泡四周各留 ' + pad + 'px，4 倍）：' + zf);
      }
      if (process.env.E9_SHOTS !== '0') console.log('    截图：' + (await shot('4-phrase-all')));
    }

    /* 10) 点一个对手的头像 → 发给这个人的一条表情 */
    await evaluate('(function(){var d=document.getElementById("seat-sheet"); if(!d.classList.contains("hidden")){'
      + 'var c=document.getElementById("btn-ss-close"); if(c) c.click();}})()');
    await sleep(400);
    const oppRect = await rectOf('#game-top .gt-opp');
    ok(!!oppRect, '看得到一个对手的座位（点头像才发的出去）');
    if (oppRect) {
      await realClickAt(oppRect.x, oppRect.y);
      await sleep(700);
      const openedForOpp = await waitFor('!document.getElementById("seat-sheet").classList.contains("hidden")', 3000);
      ok(openedForOpp, '点对手头像 → 面板打开');
      const oppTitle = await evaluate('(document.getElementById("ss-name")||{}).textContent');
      ok(oppTitle && oppTitle !== '发给全场', '★ 点谁就发给谁：面板块头换成对方的名字', String(oppTitle));
      const emoTab = await rectOf('#ss-tabs [data-ss-tab="emoji"]');
      if (emoTab) await realClick('#ss-tabs [data-ss-tab="emoji"]');
      await waitFor('!document.getElementById("emoji-grid").classList.contains("hidden")', 3000);
      const cellRect = await rectOf('#emoji-grid .emoji-cell');
      ok(!!cellRect, '表情格子可见');
      if (cellRect) {
        await realClick('#emoji-grid .emoji-cell');
        await sleep(700);
        const b2 = await evaluate(BUBBLE_READ);
        const it2 = b2.items && b2.items[0];
        ok(b2.nodes === 1, '点一个表情 → 出现 1 个气泡', '实测 ' + b2.nodes);
        if (it2) {
          ok(it2.img, '是表情（图）不是文字');
          ok(it2.inView, '★ 定向表情的气泡整块在屏内',
            '出界 左' + Math.round(it2.overflowsLeft) + ' 右' + Math.round(it2.overflowsRight)
            + ' 上' + Math.round(it2.overflowsTop) + ' 下' + Math.round(it2.overflowsBottom));
          ok(it2.covers.length === 0, '★ 气泡没有压住任何人的头像', '压住了 [' + it2.covers.join(',') + ']');
          ok(!it2.tailAbsent, '★ 定向表情有尾巴（能指人的时候不该退场）', 'dir=' + it2.dir);
          console.log('    读数：dir=' + it2.dir + ' 尾巴=' + (it2.hasTail ? it2.tailLen + '×' + it2.tailH : '无'));
        }
        if (process.env.E9_SHOTS !== '0') console.log('    截图：' + (await shot('5-emoji-to-opp')));
      }
    }

    /* 11) 等气泡飞完，看它有没有自己清干净（真人会盯着屏幕等它消失） */
    await sleep(2000);
    const leftover = await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length');
    ok(leftover === 0, '★ 1.6 秒后层里不留残骸', '剩 ' + leftover + ' 个');
    const ghosts = await evaluate('(function(){'
      + 'var n=document.getElementById("emoji-layer");return n? n.children.length : 0;})()');
    ok(ghosts === 0, '动画层没留空壳节点', '剩 ' + ghosts + ' 个');

    /* 12) 控制台：真人看到的「红字」就是这两路（Log / 未捕获异常）来的 */
    ok(pageErrors.length === 0, '★ 全程没有控制台报错、没有未捕获异常',
      pageErrors.length ? pageErrors.slice(0, 3).join(' | ').slice(0, 220) : '0 条');

    /* 13) 真实档案没被碰 */
    const dataAfter = fs.existsSync(REAL_DATA) ? fs.readFileSync(REAL_DATA) : null;
    ok(!!dataBefore && !!dataAfter && dataBefore.equals(dataAfter),
      '★ server/data/profiles.example.json 一个字节都没动（档案全在临时目录里）');

  } catch (e) {
    fail++;
    console.log('  ERROR  ' + e.message);
    try { console.log('    当前截图：' + (await shot('x-error'))); } catch (_) {}
  } finally {
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (edge) edge.kill(); } catch (e) {}
    try { if (server) server.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n============================================================');
  if (fail) console.log('红的：' + badOnes.join(' / '));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录：' + SHOT_DIR);
  process.exitCode = fail ? 1 : 0;
})();
