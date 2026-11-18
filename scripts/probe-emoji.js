/**
 * 表情 / 短语探针（真浏览器 / CDP）
 *
 * 静态断言能证明「元素存在」，但证明不了下面这些 —— 而它们才是会进线上的问题：
 *
 *   1) **图真的加载出来了**：13 个格子里 `<img>` 的 naturalWidth 必须 > 0。
 *      素材没发出去 / 路径大小写不对时，DOM 结构完全正常，只是空格子。
 *   2) **触摸目标够大**：格子在 390 宽的屏上是 139 设计像素 ≈ 72 CSS 像素；
 *      一旦布局改成 7 列挤进竖屏，手指就点不准了，而代码看起来没问题。
 *   3) **真能飞起来**：点完之后 #emoji-layer 里出现节点，且它的位置从
 *      「我的座位」移动到了「目标座位」附近。只断言「有节点」抓不到
 *      「起点终点算反了 / 用了缩放前坐标」这类错（后者在横屏必错）。
 *   4) **会自己消失**：1.9 秒后节点必须被移除。漏了 removeChild 的话，
 *      一局下来 layer 里会挂几百个节点，越打越卡。
 *   5) **2 秒节流真的挡住了第二条**，并且给了提示（服务端是静默丢弃，
 *      所以客户端这一层必须说话）。
 *   6) **定向发给谁**：选了某人之后，事件里的 to 必须是那个人的 id。
 *
 * 用法：node scripts/probe-emoji.js [宽] [高]
 *   竖屏：node scripts/probe-emoji.js 390 844
 *   横屏：node scripts/probe-emoji.js 844 390
 *   ZOOM=1 额外截图到系统临时目录
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
/* 端口可被环境变量覆盖（v2.5）：两个人同时跑探针时，硬编码端口必然互相
 * EADDRINUSE，而后果不是「慢」—— 是两边各拿半份数据却都以为是全量。
 * 约定：施工方 3051/9361，QA 3047/9357（默认值保持原样）。 */
const PORT = Number(process.env.EMOJI_PROBE_PORT) || 3047;
const CDP_PORT = Number(process.env.EMOJI_PROBE_CDP) || 9357;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-emoji-probe');
const SHOTS = !!process.env.ZOOM;
const SEATS = Number(process.env.SEATS) || 2;   /* 满员档：SEATS=5 */

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
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error))); else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(m, p) {
        return new Promise((res, rej) => { id += 1; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* 页面里用：等某个条件为真（每 80ms 一次，最多 timeout） */
const WAIT_FN = `function __wait(fn, timeout, step){
  step = step || 80;
  return new Promise(function(res){
    var t0 = Date.now();
    (function loop(){
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return res(v);
      if (Date.now() - t0 > (timeout || 4000)) return res(null);
      setTimeout(loop, step);
    })();
  });
}`;

/* 页面里用：量尾巴尖端。★ 三个输入全是**渲染结果**，没有实现中间量：
 *   气泡 rect、--tail-off（JS 写的 px）、::after 的 computed width/height（浏览器真画出来的盒子）；
 * 期望值 reach 也自己算（头像半径 + gap + 8，gap 取规格里的设计值 × k）。
 * 方向约定见 emoji.css：right/left 时 ::after 是「长 × 宽」，up/down 时是「宽 × 长」。 */
const TIP_FN = `function tipGeom(node, r, avEl, gapDesign){
  gapDesign = (gapDesign === undefined) ? 4 : gapDesign;
  var dir = node.getAttribute('data-dir');
  var off = parseFloat(getComputedStyle(node).getPropertyValue('--tail-off')) || 0;
  var ps = getComputedStyle(node, '::after');
  var tw = parseFloat(ps.width) || 0, th = parseFloat(ps.height) || 0;
  var side = (dir === 'right' || dir === 'left');
  var len = side ? tw : th;
  var tipX, tipY;
  if (dir === 'right') { tipX = r.left - len; tipY = r.top + off; }
  else if (dir === 'left') { tipX = r.right + len; tipY = r.top + off; }
  else if (dir === 'up') { tipX = r.left + off; tipY = r.bottom + len; }
  else { tipX = r.left + off; tipY = r.top - len; }
  var ar = avEl ? avEl.getBoundingClientRect() : r;
  var acx = ar.left + ar.width / 2, acy = ar.top + ar.height / 2;
  var k = Math.max(1, parseFloat(getComputedStyle(node).getPropertyValue('--emo-k')) || 1);
  /* ★ Q4 在 v2.2 拆成两档（规格 §6）。这里给的是那条**必须恒真**的 Q4b：
   * 尖端落在「座位块 rect 外扩 gap + TAIL_H」内。旧的距离判据（离头像中心
   * ≤ 半径 + gap + 8）对「挂在座位下方」设了不可能条件 —— 座位块是「头像在上、
   * 昵称分数在下」，下方向离头像天然 48.5 > 35.7，于是「下」永远不成立。
   * 块元素从头像往上找 [data-pid]：头像一定在座位块里。 */
  var blockEl = (avEl && avEl.closest) ? avEl.closest('[data-pid]') : null;
  var bl = blockEl ? blockEl.getBoundingClientRect() : ar;
  var pad = gapDesign * k + len;
  var blockOk = tipX >= bl.left - pad && tipX <= bl.right + pad
    && tipY >= bl.top - pad && tipY <= bl.bottom + pad;
  return {
    dir: dir, place: node.getAttribute('data-place'),
    tailLen: len, tailOff: Math.round(off * 10) / 10,
    tipX: tipX, tipY: tipY,
    tipD: Math.sqrt((tipX - acx) * (tipX - acx) + (tipY - acy) * (tipY - acy)),
    reach: Math.min(ar.width, ar.height) / 2 + gapDesign * k + 8,
    pad: Math.round(pad * 10) / 10, blockOk: blockOk
  };
}`;

async function main() {
  server.listen(PORT);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return '';
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    /* 文件名带档位（v2.7）：六档连跑时同名文件互相覆盖，
     * 「我有截图」到最后只剩最后一档，比对时才发现 —— 那等于没截。 */
    const p = path.join(SHOT_DIR, W + 'x' + H + '-' + name + '.png');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  const URL_LOCAL = 'http://127.0.0.1:' + PORT + '/?mode=local';
  console.log('===== ' + W + '×' + H + ' 表情探针 =====');

  await cdp.send('Page.navigate', { url: URL_LOCAL });
  await sleep(1500);
  await evaluate('localStorage.setItem(\'lxw_guide_seen_v1\',\'1\')');
  /* ★ 本机 id 固定成 me（v2.7，QA 点名）：演示模式的本机 id 是
   * `'p' + random + timestamp`，每跑一次都不一样 —— 于是「署名比对真实昵称」
   * 这件事在自报那条格子上永远需要一个 fixture 猜名字，猜不中就记「未测」。
   * 键名来自 game.js 的 SS_UID（= Store.KEYS.MY_ID = lxw_myid_v1），session 作用域，
   * 刷一次页面就丢，所以必须在**第一次导航之后、建房之前**写。 */
  await evaluate('sessionStorage.setItem(\'lxw_myid_v1\',\'me\')');
  await cdp.send('Page.navigate', { url: URL_LOCAL });
  await sleep(1700);
  await evaluate(WAIT_FN);
  await evaluate(TIP_FN);
  await evaluate('document.getElementById("btn-create").click()');
  /* ★ v103 起「创建房间」不再直接建房：它先弹「本局打几把」，点了确认才真的开房。
   * 探针原来少了这一步，于是所有后续断言都卡在「进不了牌桌」——
   * 这是**脚本过期**，不是功能坏了（10 个红探针里有一批是同一个原因）。 */
  await sleep(500);
  await evaluate('(function(){var b=document.getElementById("btn-create-confirm");if(b)b.click();})()');

  /* 进牌桌：本地演示模式没有服务端，第二个玩家用 RoomStore 的公开接口加进去 ——
   * 和真实多标签页走的是同一条路（local store 的 joinRoom）。
   * 不用改游戏代码加测试钩子：探针越少碰内部实现，验的东西越接近线上。 */
  const table = await evaluate(`(function(){
    return __wait(function(){
      var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
      var id = Object.keys(rooms)[0];
      if (!id) return null;
      var room = rooms[id];
      /* SEATS 只影响「加几个人」。默认 2（一人一机的那条路），
       * SEATS=5 用来验满员时气泡会不会跨到邻居头上 —— 座位都在圆环上，
       * 2 人局永远测不到那一档。 */
      if (room.players.length >= ${SEATS}) return id;   /* SEATS 是 Node 常量，必须插值进页面上下文 */
      if (window.__joined) return null;
      window.__joined = 1;
      for (var s = 1; s < ${SEATS}; s++) {
        RoomStore.joinRoom(id, { id: 'probe-pal' + (s > 1 ? s : ''), nickname: '陪练' + (s > 1 ? s : '') });
      }
      return null;
    }, 6000);
  })()`);
  await evaluate(`(function(){
    var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
    var id = Object.keys(rooms)[0];
    if (id) {
      var rms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
      var rm = rms[id] || { players: [] };
      /* 本机昵称也固定成「我」：默认昵称是 '玩家' + myId.slice(-4)，
       * id 固定成 me 之后会变成「玩家me」—— 那还是个猜出来的名字。
       * 署名判据要的是「和真实昵称一致」，所以这里把真实昵称写成确定值。 */
      RoomStore.rename(id, 'me', '我');
      rm.players.forEach(function(p){ if (p.id !== 'me' && String(p.id).indexOf('probe-pal') === 0) RoomStore.setReady(id, p.id, true); });
    }
    return id;
  })()`);
  await sleep(300);
  await evaluate('(function(){ var b = document.getElementById("btn-ready"); if (b) b.click(); return "ok"; })()');
  const inGame = await evaluate('__wait(function(){ return document.getElementById("game-top") && document.querySelectorAll("#game-top .gt-opp").length > 0; }, 8000)');
  ok(!!inGame, '开局：顶栏出现对手座位（第二个人真的进桌了）', JSON.stringify(table));
  if (!inGame) {
    console.log('    !! 进不了牌桌，后面的断言没有意义，提前结束');
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    cdp.close(); try { edge.kill(); } catch (e) {} server.close();
    process.exitCode = 1;
    return;
  }

  /* 记录页面收到的每一条表情事件，用来验「定向发给谁」 */
  await evaluate('window.__emojiLog = []; RoomStore.onEmoji(function(e){ window.__emojiLog.push(e); }); "ok"');
  await sleep(200);
  if (SHOTS) console.log('    截图：' + (await shot('table')));

  console.log('\n[1] 入口按钮');
  const btn = await evaluate(`(function(){
    var b = document.getElementById('btn-emoji');
    if (!b) return { missing: true };
    var r = b.getBoundingClientRect();
    var mine = document.querySelector('#game-top .gt-me');
    var mr = mine ? mine.getBoundingClientRect() : null;
    /* v87：入口从「我的分左边那一格」搬到了桌面右下角（圆桌版），
     * 两套版式的相对位置不同，但「不压住我的分」和「整个在屏内」是共同不变量。
     * 只断言其中一个版的几何，翻开关那天就会红得莫名其妙。 */
    var ring = !!document.querySelector('#game-top.gt-ring');
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
      ring: ring,
      overlap: !!(mr && r.left < mr.right - 1 && r.right > mr.left + 1 && r.top < mr.bottom - 1 && r.bottom > mr.top + 1),
      inView: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
    };
  })()`);
  ok(btn && !btn.missing, '顶栏有表情按钮');
  ok(btn && btn.visible, '按钮可见（有尺寸）', JSON.stringify(btn));
  ok(btn && btn.w >= 44 && btn.h >= 44, '触摸目标 ≥ 44 CSS px（实测 ' + (btn && btn.w) + '×' + (btn && btn.h) + '）');
  ok(btn && !btn.overlap, '★ 按钮没有压住「我的分」（' + (btn && btn.ring ? '圆桌版：桌面右下角' : '旧顶栏：我的分左侧') + '）');
  ok(btn && btn.inView, '按钮完整落在视口内');

  console.log('\n[2] 面板');
  await evaluate('document.getElementById("btn-emoji").click()');
  await sleep(400);
  const panel = await evaluate(`(function(){
    /* v89：面板是「点谁弹谁」的浮层（#seat-sheet），不再是居中弹窗 */
    var m = document.getElementById('seat-sheet');
    var card = m;
    var grid = document.getElementById('emoji-grid');
    var cells = [].slice.call(grid.querySelectorAll('.emoji-cell'));
    var imgs = [].slice.call(grid.querySelectorAll('img'));
    var loaded = imgs.filter(function(i){ return i.naturalWidth > 0; }).length;
    var cr = card.getBoundingClientRect();
    var cellRects = cells.map(function(c){ var r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    /* 2026-11-14：面板里那行「全 全场 / 机器人1 / …」删掉了 —— 收件人由入口决定。
     * 这里验两件事：那行**不存在**，以及桌面钮进来时标题就是「发给全场」。 */
    var hasTargetRow = !!document.querySelector('#emoji-to');
    return {
      open: !m.classList.contains('hidden'),
      fits: cr.top >= -1 && cr.bottom <= innerHeight + 1 && cr.left >= -1 && cr.right <= innerWidth + 1,
      card: { t: Math.round(cr.top), b: Math.round(cr.bottom), h: Math.round(cr.height), w: Math.round(cr.width) },
      overflowInside: Math.round(card.scrollHeight - card.clientHeight),
      cells: cells.length, loaded: loaded,
      minCellW: Math.min.apply(null, cellRects.map(function(c){ return c.w; })),
      minCellH: Math.min.apply(null, cellRects.map(function(c){ return c.h; })),
      hasTargetRow: hasTargetRow,
      name: (document.getElementById('ss-name') || {}).textContent,
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      /* 面板不是全屏弹窗，不锁 stage 的 modal-open —— 它真正的「模态」表现
       * 是背后有一层可点击关闭的遮罩。这里断言遮罩在，而不是滚动锁。 */
      bgLocked: !document.getElementById('seat-sheet-bd').classList.contains('hidden')
    };
  })()`);
  ok(panel && panel.open, '点按钮 → 面板打开');
  ok(panel && panel.fits, '面板整体在视口内', JSON.stringify(panel && panel.card));
  ok(panel && panel.overflowInside <= 2, '面板内容没有被 overflow 裁掉', String(panel && panel.overflowInside));
  ok(panel && panel.cells === 13, '13 个表情格子', String(panel && panel.cells));
  ok(panel && panel.loaded === 13, '★ 13 张图全部加载成功（naturalWidth > 0）', (panel && panel.loaded) + '/13');
  ok(panel && panel.minCellW >= 36 && panel.minCellH >= 36,
    '格子触摸目标 ≥ 36 CSS px（实测 ' + (panel && panel.minCellW) + '×' + (panel && panel.minCellH) + '）');
  /* 列数是**布局档位**决定的，不是常数：竖屏 4 列、横屏/桌面 7 列（1624×750 的设计）。
   * 原来写死 4 列，横屏档一直红 —— 属于脚本过期，不是功能坏了（2026-11-14 顺手修）。 */
  const wantCols = W > H ? 7 : 4;
  ok(panel && panel.cols === wantCols, '表情格子 ' + wantCols + ' 列（竖屏 4 / 横屏 7）',
    '实测 ' + (panel && panel.cols) + ' 列');
  ok(panel && !panel.hasTargetRow,
    '★ 面板里没有「发给谁」选择行（收件人由入口决定，不再问第二遍）', String(panel && panel.hasTargetRow));
  ok(panel && panel.name === '发给全场',
    '★ 桌面表情钮进入 → 标题就是「发给全场」', panel && panel.name);
  ok(panel && panel.bgLocked, '面板背后有可点关闭的遮罩');
  if (SHOTS) console.log('    截图：' + (await shot('panel')));

  console.log('\n[3] 发一条：真的会飞');
  const fly = await evaluate(`(function(){
    var cells = document.querySelectorAll('#emoji-grid .emoji-cell');
    var pal = document.querySelector('#game-top .gt-opp');
    var me = document.querySelector('#game-top .gt-me');
    var before = { pal: pal.getBoundingClientRect(), me: me.getBoundingClientRect() };
    cells[0].click();
    return new Promise(function(res){
      __wait(function(){ return document.querySelector('#emoji-layer .emoji-fly'); }, 1500).then(function(node){
        if (!node) return res({ spawned: false });
        var r0 = node.getBoundingClientRect();
        var closed = document.getElementById('seat-sheet').classList.contains('hidden');
        var start = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
        setTimeout(function(){
          var r1 = node.getBoundingClientRect();
          var end = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
          var palC = { x: before.pal.left + before.pal.width / 2, y: before.pal.top + before.pal.height / 2 };
          var meC = { x: before.me.left + before.me.width / 2, y: before.me.top + before.me.height / 2 };
          /* ★ v2 起落点不再是「贴着座位上方」，而是四选一 + 尾巴（规格 §2/§4）。
           * 所以判据从「上/下邻接」换成与 Q3/Q4 同一套口径：
           *   ① 不叠我的座位块（重叠面积 0）
           *   ② 尾巴尖端离我的头像中心 ≤ 头像半径 + gap + 8
           * 老写法（above ≥ 0 || below ≥ 0）在「气泡挂在我左边」时必然红 ——
           * 那是脚本跟着旧规格，不是功能坏了。 */
          var ox = Math.max(0, Math.min(r1.right, before.me.right) - Math.max(r1.left, before.me.left));
          var oy = Math.max(0, Math.min(r1.bottom, before.me.bottom) - Math.max(r1.top, before.me.top));
          var g = tipGeom(node, r1, document.querySelector('#game-top .gt-me .opp-avatar'));
          res({
            spawned: true, closed: closed,
            start: { x: Math.round(start.x), y: Math.round(start.y) },
            end: { x: Math.round(end.x), y: Math.round(end.y) },
            /* 全场：落点贴着我、尾巴指着我；飞行起点也是我 */
            nearMe: Math.hypot(start.x - meC.x, start.y - meC.y) < 60,
            dir: g.dir, place: g.place,
            tipD: Math.round(g.tipD), reach: Math.round(g.reach),
            blockOk: g.blockOk, pad: g.pad,
            tailOk: g.blockOk,
            overlapMe: Math.round(ox * oy),
            size: { w: Math.round(r1.width), h: Math.round(r1.height) },
            palC: { x: Math.round(palC.x), y: Math.round(palC.y) },
            meC: { x: Math.round(meC.x), y: Math.round(meC.y) },
            moved: Math.hypot(end.x - start.x, end.y - start.y) > 4
          });
        }, 520);
      });
    });
  })()`);
  ok(fly && fly.spawned, '点表情 → 动画层里出现节点', JSON.stringify(fly));
  ok(fly && fly.closed, '发完自动关面板（不关就挡住了表情落点）');
  ok(fly && fly.nearMe, '起点在我的座位旁（' + JSON.stringify(fly && fly.start) + ' vs 我 ' + JSON.stringify(fly && fly.meC) + '）');
  ok(fly && fly.overlapMe === 0 && (fly.tailOk || (fly.place !== 'dir' && fly.place !== 'self')),
    '★ 发给全场 → 落点贴着我且不叠座位；定向落点时尾巴尖端落在座位块外扩区内（Q4b 口径，方向 '
      + (fly && fly.dir) + ' / ' + (fly && fly.place) + '，判区=+' + (fly && fly.pad)
      + '，重叠 ' + (fly && fly.overlapMe) + ' px²）',
    JSON.stringify(fly && fly.size));
  if (SHOTS) console.log('    截图：' + (await shot('fly')));

  const ev1 = await evaluate('window.__emojiLog');
  ok(ev1 && ev1.length === 1, '页面收到 1 条表情事件（自己发的也走回程路径）', JSON.stringify(ev1));
  ok(ev1 && ev1[0] && ev1[0].to === '*', '默认发给全场（to = *）', JSON.stringify(ev1 && ev1[0]));

  console.log('\n[4] 节流');
  const throttle = await evaluate(`(function(){
    var cards = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
    document.getElementById('btn-emoji').click();
    var cell = document.querySelectorAll('#emoji-grid .emoji-cell')[1];
    cell.click();
    var toast = document.getElementById('toast');
    return { toast: toast ? toast.textContent : '', hidden: toast ? toast.classList.contains('hidden') : true };
  })()`);
  await sleep(300);
  const throttled = await evaluate('window.__emojiLog.length');
  ok(throttled === 1, '2 秒内第二条没有发出去（事件数还是 1）', '实际 ' + throttled);
  ok(throttle && !throttle.hidden && /慢一点/.test(throttle.toast), '给了提示而不是静默失败', JSON.stringify(throttle));

  console.log('\n[5] 定向 + 短语');
  await sleep(2100);
  const directed = await evaluate(`(function(){
    /* 定向只有一条路：**点那个人的座位**。面板里的「发给谁」选择行已经删了，
     * 所以这里也不再点 chip，而是点座位 —— 这正好是玩家真实的操作路径。 */
    var seat = document.querySelector('#game-top .gt-opp');
    if (!seat) return { noSeat: true };
    seat.click();
    var panel = document.getElementById('seat-sheet');
    if (panel.classList.contains('hidden')) return { notOpen: true };
    var pid = seat.getAttribute('data-pid');
    var name = (document.getElementById('ss-name') || {}).textContent;
    document.querySelectorAll('#emoji-grid .emoji-cell')[2].click();
    return { to: pid, name: name };
  })()`);
  await sleep(500);
  const ev2 = await evaluate('window.__emojiLog[1] || null');
  ok(directed && !directed.noSeat && !directed.notOpen, '点对手座位能直接进表情档');
  ok(ev2 && ev2.to === (directed && directed.to),
    '★ 点头像进来直接发给他（事件里的 to 就是他的 playerId，不用先选人）', JSON.stringify(ev2));
  const aimed = await evaluate(`(function(){
    var node = document.querySelector('#emoji-layer .emoji-fly');
    var pal = document.querySelector('#game-top .gt-opp');
    if (!node || !pal) return null;
    var r = node.getBoundingClientRect(), p = pal.getBoundingClientRect();
    var ox = Math.max(0, Math.min(r.right, p.right) - Math.max(r.left, p.left));
    var oy = Math.max(0, Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top));
    var g = tipGeom(node, r, pal.querySelector('.opp-avatar'), 4);
    return {
      d: Math.round(Math.hypot(r.left + r.width / 2 - (p.left + p.width / 2), r.top + r.height / 2 - (p.top + p.height / 2))),
      overlap: Math.round(ox * oy),
      dir: g.dir, place: g.place,
      tipD: Math.round(g.tipD * 10) / 10, reach: Math.round(g.reach * 10) / 10,
      blockOk: g.blockOk, pad: g.pad
    };
  })()`);
  ok(aimed && aimed.overlap === 0 && (aimed.blockOk || (aimed.place !== 'dir' && aimed.place !== 'self')),
    '★ 定向的表情挂在对方座位外侧、不盖座位；定向落点时尾巴尖端落在他的座位块外扩区内（Q4b 口径，'
      + (aimed && aimed.dir) + '/' + (aimed && aimed.place) + '，判区=+' + (aimed && aimed.pad)
      + '，重叠 ' + (aimed && aimed.overlap) + ' px²）',
    JSON.stringify(aimed));

  await sleep(2100);
  const phrase = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    var tab = document.querySelector('[data-ss-tab="phr"]');
    tab.click();
    var rows = document.querySelectorAll('#emoji-phr .phrase-row');
    var shown = rows.length;
    var gridHidden = document.getElementById('emoji-grid').classList.contains('hidden');
    rows[0].click();
    return { shown: shown, gridHidden: gridHidden, text: rows[0].textContent };
  })()`);
  await sleep(300);
  /* 正文要**排掉署名**再比：§4.3 给兜底那条加了「昵称：」前缀，
   * 直接拿 textContent 比会把「加了署名」当成「文案不一致」——
   * 那是把新功能报成回归。署名本身由 Q10 单独判。 */
  const bubble = await evaluate(`(function(){
    var n = document.querySelector('#emoji-layer .emoji-fly.is-phrase');
    if (!n) return null;
    var r = n.getBoundingClientRect();
    var by = n.querySelector('.emoji-by');
    var body = '';
    var w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, null);
    var t;
    while ((t = w.nextNode())) {
      if (by && by.contains(t)) continue;
      body += (t.nodeValue || '');
    }
    return { text: n.textContent, body: body, by: by ? by.textContent : '',
             signed: !!by, w: Math.round(r.width),
             k: Math.round(parseFloat(getComputedStyle(n).getPropertyValue('--emo-k')) * 100) / 100 || 1 };
  })()`);
  ok(phrase && phrase.shown === 8, '短语 tab 有 8 条', String(phrase && phrase.shown));
  ok(phrase && phrase.gridHidden, '切到短语后表情格子被藏起来');
  ok(bubble && bubble.body === (phrase && phrase.text),
    '发出去的短语渲染成气泡且正文一致（署名不计入正文）', JSON.stringify(bubble));
  /* 上限跟着 --emo-k 一起放大（460 是设计上限）。写死 470 的话，电脑上这条
   * 永远红 —— 而那正是这一轮修的「桌面该更大」。 */
  ok(bubble && bubble.w <= 460 * bubble.k + 20,
    '气泡宽度不超过设计上限（' + (bubble && bubble.w) + ' ≤ ' + Math.round(460 * (bubble && bubble.k) + 20) + '）',
    JSON.stringify(bubble));

  /* [5b] 尺寸与落点：气泡在**每一档设备**上的实际 CSS 尺寸、会不会盖住头像、
   * 以及「字号 : 头像宽」这个比例跨设备是否一致。
   *
   * 这三条只有真浏览器能量 —— 单测里 offsetWidth 恒为 0，而这一轮的病根恰恰是
   * 「CSS px 写死、不跟舞台缩放」，静态断言永远看不见。 */
  const geom = await evaluate(`(function(){
    var stage = document.getElementById('stage');
    var m = getComputedStyle(stage).transform;
    var sc = 1, hit = m && m.match(/matrix\\(([^)]+)\\)/);
    if (hit) { var v = parseFloat(hit[1].split(',')[0]); if (v > 0) sc = v; }
    var out = { scale: Math.round(sc * 1000) / 1000, vp: innerWidth + 'x' + innerHeight };
    var ph = document.querySelector('#emoji-layer .emoji-fly.is-phrase');
    if (!ph) return out;
    var r = ph.getBoundingClientRect();
    var inner = ph.querySelector('.emoji-pop');
    out.fs = Math.round(parseFloat(getComputedStyle(inner).fontSize) * 10) / 10;
    out.k = Math.round(parseFloat(getComputedStyle(ph).getPropertyValue('--emo-k')) * 100) / 100 || 1;
    out.box = { w: Math.round(r.width), h: Math.round(r.height) };
    out.inView = r.top >= -0.5 && r.left >= -0.5
      && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    /* 不只看落点那个座位：所有头像都不能被盖住，否则「贴在座位上方」在某个
     * 布局下又把邻居糊了。重叠按 px² 算，>1 就算盖到。 */
    var avs = [].slice.call(document.querySelectorAll('#game-top .opp-avatar'));
    var cover = 0, worst = 0;
    avs.forEach(function(a){
      var b = a.getBoundingClientRect();
      var w = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
      var h = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
      if (w * h > 1) cover++;
      worst = Math.max(worst, w * h);
    });
    var main = document.querySelector('#game-top .gt-opp .opp-avatar');
    var avW = main ? main.getBoundingClientRect().width : 0;
    out.avatars = avs.length;
    out.avatarW = Math.round(avW);
    out.coverAvatars = cover;
    out.coverArea = Math.round(worst);
    out.ratio = avW > 0 ? Math.round(out.fs / avW * 1000) / 1000 : 0;
    out.emoRatio = avW > 0 ? Math.round(64 * out.k / avW * 100) / 100 : 0;
    /* ★ 新口径（2026-11-14 晚）：比的是**界面文字**，不是头像。
     * 座位名是固定 CSS px（20 / 宽屏 24），不跟舞台缩放走；用它当尺子，
     * 才能抓住「气泡随舞台无界放大、而 UI 文字不动」这种失衡 —— 而头像本身
     * 是跟舞台走的，拿它当尺子会把这个偏差当成「正常」。 */
    var nm = document.querySelector('#game-top .opp-name');
    out.nameFs = nm ? Math.round(parseFloat(getComputedStyle(nm).fontSize) * 10) / 10 : 0;
    out.fsName = out.nameFs > 0 ? Math.round(out.fs / out.nameFs * 100) / 100 : 0;
    return out;
  })()`);
  console.log('    [尺寸] ' + JSON.stringify(geom));
  if (SHOTS) console.log('    截图：' + (await shot('bubble')));
  ok(geom && geom.inView, '气泡完整在视口内（不会被 overflow:hidden 切掉）',
    JSON.stringify(geom && geom.box) + ' @ ' + (geom && geom.vp));
  ok(geom && geom.coverAvatars === 0, '★ 气泡不盖任何座位头像（盖住的正是人脸）',
    '盖到 ' + (geom && geom.coverAvatars) + ' 个 / 共 ' + (geom && geom.avatars)
      + '，最大重叠 ' + (geom && geom.coverArea) + ' px²');
  /* ★ 比例只在「--emo-k 下限没被顶住」的档位要求一致。
   *
   * 320×568 这一档舞台只有 0.427，座位头像被压到 16 CSS px。这时如果还要求
   * 「气泡字 : 头像 = 0.69」，气泡字得是 11px —— 那是「不溢出但读不出」，
   * 比溢出更糟。所以 k 有下限 1，小屏宁可比例偏大也要保证可读；
   * 这一档的判据换成「字号够读 + 完整在屏内」，由下面那条接管。 */
  if (geom && geom.scale >= 0.45) {
    /* 0.69 是手机竖屏的实测比例（24 / 35）。允许 ±0.09：抗锯齿与紧凑档会让
     * 头像宽度有 1~2 px 的出入，放宽一点，但「电脑上掉到 0.42」这种一眼就能抓住。
     *
     * ★ 2026-11-14 晚改口径：原来拿**头像宽**当尺子，等于要求气泡随舞台无界放大
     *   （舞台 2.27 倍时字号就得 54px）。用户反馈「不同设备要适配屏幕」之后，
     *   实现侧给 k 封了 1.5，气泡相对头像的比例必然掉到 0.45 —— 这不是回归，是取舍。
     *   所以尺子换成**座位名字号**：它是固定 CSS px，气泡相对它恒定 = 「和 UI 同一个尺度」。
     *   手机 24/20 = 1.2、封顶后的桌面 36/20 = 1.8，两档都在 [0.95, 1.85] 里；
     *   而「气泡比座位名大两倍多」这种失衡照样能抓住（1920 未封顶时是 2.7）。 */
    ok(geom.fsName >= 0.95 && geom.fsName <= 1.85,
      '★ 短语字号 / 座位名跨设备一致（实测 ' + geom.fsName + '，手机基准 1.2）',
      JSON.stringify(geom));
    /* 表情：封顶后 1920 是 96/80 = 1.20，1366 是 96/57 = 1.68，390 是 64/35 = 1.81。
     * 下界 1.10 的意思是「永远不比头像小」—— 这正是 v148 那轮用户抱怨的
     * 「电脑上表情比头像还小」；上界 2.00 防止反过来糊一脸。 */
    ok(geom.emoRatio >= 1.10 && geom.emoRatio <= 2.00,
      '★ 表情直径 ≥ 头像宽 × 1.1，且 ≤ 2.0（实测 ' + geom.emoRatio + '，手机基准 1.83）',
      JSON.stringify(geom));
  } else {
    ok(geom && geom.fs >= 18, '极小屏（舞台 ' + (geom && geom.scale) + '）：字号不缩到读不清（' + (geom && geom.fs) + ' px ≥ 18）');
  }

  console.log('\n[6] 自动清理');
  const cleaned = await evaluate('__wait(function(){ return document.querySelectorAll("#emoji-layer .emoji-fly").length === 0; }, 3000)');
  ok(!!cleaned, '★ 动画结束后节点被移除（不留垃圾）',
    '剩余 ' + JSON.stringify(await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length')));

  console.log('\n[7] 关闭方式');
  const closing = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    var opened = !document.getElementById('seat-sheet').classList.contains('hidden');
    var m = document.getElementById('seat-sheet');
    document.getElementById('seat-sheet-bd').click();   // 点遮罩
    var closedByMask = m.classList.contains('hidden');
    document.getElementById('btn-emoji').click();
    document.getElementById('btn-ss-close').click();
    var closedByX = m.classList.contains('hidden');
    return { opened: opened, closedByMask: closedByMask, closedByX: closedByX,
             unlocked: !document.getElementById('stage').classList.contains('modal-open') };
  })()`);
  ok(closing && closing.opened, '再点一次按钮能重新打开');
  ok(closing && closing.closedByMask, '点遮罩能关');
  ok(closing && closing.closedByX, '点右上角 × 能关');
  ok(closing && closing.unlocked, '关掉之后背景滚动恢复');

  /* ------------------- [8] 点座位 → 贴着他弹三档面板（v89 统一浮层）-------------------
   * 这一节是「统一浮层面板」的验收：早先是点座位开战绩卡、点表情钮开底部 sheet，
   * 两个入口互不相干。现在点谁就弹谁，且面板必须**贴着那个人**，不是屏幕居中。 */
  console.log('\n[8] 点座位 → 贴着弹三档面板');
  const seatSheet = await evaluate(`(function(){
    var seat = document.querySelector('#game-top .gt-opp');
    var me = document.querySelector('#game-top .gt-me');
    if (!seat || !me) return { error: '牌桌上没有座位' };
    seat.click();
    var panel = document.getElementById('seat-sheet');
    if (panel.classList.contains('hidden')) return { error: '点座位没打开面板' };
    var pr = panel.getBoundingClientRect();
    var sr = seat.getBoundingClientRect();
    var tabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    var open = {
      tabs: tabs,
      name: (document.getElementById('ss-name') || {}).textContent,
      /* 贴着 = 面板与座位的水平或垂直间距小，且不是「居中弹」 */
      gapX: Math.round(sr.left > pr.right ? sr.left - pr.right : pr.left - sr.right),
      gapY: Math.round(sr.top > pr.bottom ? sr.top - pr.bottom : pr.top - sr.bottom),
      side: panel.getAttribute('data-side'),
      fits: pr.top >= -1 && pr.left >= -1 && pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1,
      /* 收件人不再有第二处可改：那行 chip 已删。改成验「标题写的是他」+「选择行不存在」。 */
      hasTargetRow: !!panel.querySelector('#emoji-to')
    };
    /* 切到信息档 */
    var infoTab = panel.querySelector('[data-ss-tab="info"]');
    if (infoTab) infoTab.click();
    open.infoShown = !document.getElementById('ss-info').classList.contains('hidden');
    open.gridHiddenOnInfo = document.getElementById('emoji-grid').classList.contains('hidden');
    open.infoText = (document.getElementById('ss-info').textContent || '').slice(0, 40);
    document.getElementById('btn-ss-close').click();
    /* 点自己：只有信息档 */
    me.click();
    open.selfOpened = !panel.classList.contains('hidden');
    open.selfTabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    open.selfActive = (function(){ var t = panel.querySelector('[data-ss-tab].is-on'); return t ? t.textContent : null; })();
    document.getElementById('btn-ss-close').click();
    return open;
  })()`);
  ok(seatSheet && !seatSheet.error, '点对手座位能打开面板', seatSheet && seatSheet.error);
  if (seatSheet && !seatSheet.error) {
    ok(seatSheet.tabs.length === 3 && seatSheet.tabs.join('/') === '表情/短语/信息',
      '★ 三档 tab：表情 / 短语 / 信息', JSON.stringify(seatSheet.tabs));
    ok(seatSheet.name && seatSheet.name !== '发给全场', '标题写的是被点的那个人（' + seatSheet.name + '）');
    ok(!seatSheet.hasTargetRow,
      '★ 点座位进来也没有「发给谁」选择行（目标就是标题里的这个人）');
    ok(seatSheet.gapX <= 60 || seatSheet.gapY <= 60,
      '★ 面板贴着座位（间距 ' + seatSheet.gapX + '×' + seatSheet.gapY + ' CSS px，落点 ' + seatSheet.side + '）');
    ok(seatSheet.fits, '面板整体在视口内');
    ok(seatSheet.infoShown && seatSheet.gridHiddenOnInfo, '信息档替换掉表情格子');
    ok(!!seatSheet.infoText, '信息档有内容（' + seatSheet.infoText.slice(0, 20) + '…）');
    ok(seatSheet.selfOpened && seatSheet.selfTabs.length === 1 && seatSheet.selfActive === '信息',
      '★ 点自己只有「信息」一档（自己给自己发表情没有意义）', JSON.stringify(seatSheet.selfTabs));
  }
  /* 视觉证据：上一段把面板关掉了，这里重开一次留张图 —— 「点对手头像进来是什么样」
   * 这件事只看断言不够，改版后要能一眼比对（标题是他、下面直接是表情格子）。 */
  if (SHOTS) {
    await evaluate("(function(){ var s = document.querySelector('#game-top .gt-opp'); if (s) s.click(); return 'ok'; })()");
    await sleep(320);
    console.log('    截图：' + (await shot('seat-sheet')));
    await evaluate("(function(){ var b = document.getElementById('btn-ss-close'); if (b) b.click(); return 'ok'; })()");
  }

  console.log('\n[9] 几何判据 Q0~Q10（5 座位 × 4 类内容；采样窗口 [770,1400]ms，发送间隔 ≥2100ms）');
  console.log('    Q0 段开始（测量契约：量内层 .emoji-pop、裁剪盒单侧 +TAIL_H、采样 900ms、间隔 2100ms）');
  /* 座位块几何先打一遍：跨轮次对数字时，没有这一行就只能靠「我记得」。
   * 这也是 team-lead 点名要的原始数据（含块内 .opp-avatar 的 rect）。 */
  const seatDump = await evaluate(`[].slice.call(document.querySelectorAll('#game-top [data-pid]')).map(function(s){
    var a = s.querySelector('.opp-avatar'), r = s.getBoundingClientRect();
    var ar = a ? a.getBoundingClientRect() : null;
    return {
      pid: s.getAttribute('data-pid'), me: s.classList.contains('gt-me'),
      block: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      avatar: ar ? [Math.round(ar.left), Math.round(ar.top), Math.round(ar.right), Math.round(ar.bottom)] : null
    };
  })`);
  console.log('    座位块 rect = [l,t,r,b]；avatar = 块内 .opp-avatar 的 rect（' + W + '×' + H + '）');
  (seatDump || []).forEach((s, i) => {
    console.log('      S' + (i + 1) + (s.me ? '(我)' : '     ') + ' ' + s.pid
      + ' block=' + JSON.stringify(s.block) + ' avatar=' + JSON.stringify(s.avatar));
  });
  /* 视觉证据：兜底署名的**实物**（v2.7）。
   * 320/390 上 p5（16 字长短语）放不下、走兜底并加「昵称：」前缀 ——
   * 这是本轮唯一一个「用文字换位置」的取舍，只看断言看不出好不好看。
   *
   * ★ 位置必须在扫描段**之前**。第一版放在收尾，结果拍出来是一片空桌面：
   *   扫描段为了让 20 条在 ~44 秒内发完，把 `Date.now` 假造成了每调用 +2500ms，
   *   于是房间记下的 `lastEmojiAt` 是**未来**的时间戳；时钟一还原，
   *   后续每一条都被 2 秒节流静默丢掉 —— 等 2.3 秒也没用，要等 50 秒。
   *   这里用真时钟，且上一条距现在早已超过 2 秒。 */
  if (SHOTS) {
    const signedFrom = await evaluate(`(function(){
      var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
      var id = Object.keys(rooms)[0];
      var me = document.querySelector('#game-top .gt-me');
      var pid = me ? me.getAttribute('data-pid') : '';
      if (!id || !pid) return 'no-me';
      RoomStore.sendEmoji(id, pid, Emoji.BROADCAST, 'p5');
      return pid;
    })()`);
    await sleep(900);
    const signedNodes = await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length');
    if (signedNodes > 0) {
      const signedInfo = await evaluate(`(function(){
        var n = document.querySelector('#emoji-layer .emoji-fly');
        if (!n) return null;
        var by = n.querySelector('.emoji-by');
        return { dir: n.getAttribute('data-dir'), place: n.getAttribute('data-place'),
                 by: by ? by.textContent : '', shift: n.getAttribute('data-shift') };
      })()`);
      console.log('    截图：' + (await shot('signed')) + '（p5 长短语，发送者 ' + signedFrom
        + '，落点 ' + (signedInfo && signedInfo.place) + '/' + (signedInfo && signedInfo.dir)
        + '，署名『' + (signedInfo && signedInfo.by) + '』位移 ' + (signedInfo && signedInfo.shift) + '）');
    } else {
      console.log('    !! 兜底署名的截图没拍成：发送后画面上 0 条，这张图**不作为证据**');
    }
    /* 等它自己淡出，别把残影留给扫描段（扫描段每格开头会清一次，但清完到量尺寸之间
     * 还有一帧，残影会被量进去）。 */
    await evaluate('__wait(function(){ return document.querySelectorAll("#emoji-layer .emoji-fly").length === 0; }, 3000)');
  }

  const geo = await evaluate(`(function(){
    var MARGIN = 8, GAP_PHRASE = 10, GAP_EMOJI = 4;
    /* 规格常量全部写死在这一层，不读实现里的中间变量（QA §1.5）：
     * 尾巴 12×8、圆角 18（约束 C 的 m = min(18k, L/2)）、上限宽 460 / 视口 −24。 */
    var TAIL_H_DESIGN = 8, RADIUS_DESIGN = 18;
    var SAMPLE_AT = 900;     // spawn 后采样：∈ [770, 1400]（Q0 ③）
    var SEND_GAP = 2100;     // 相邻两条的发送间隔（Q0 ④）
    function R(n){ return n.getBoundingClientRect(); }
    function ovArea(a, b){
      var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return (w > 0 && h > 0) ? w * h : 0;
    }
    function seats(){ return [].slice.call(document.querySelectorAll('#game-top [data-pid]')); }
    function nodes(){ return [].slice.call(document.querySelectorAll('#emoji-layer .emoji-fly')); }
    function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    function roomId(){ var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}'); return Object.keys(rooms)[0]; }
    function send(from, to, id){ return RoomStore.sendEmoji(roomId(), from, to, id); }
    /* 留给页面外的截图段用（v2.7）：收尾那张「兜底署名实物」要发一条 p5，
     * 而 Date.now 在扫描段被假造过、闭包里也有假时钟，重新写一遍发送链路
     * 等于复制粘贴一份会漂的实现 —— 直接借用这里这一份。 */
    window.__probeSend = send;

    /* 尾巴尖端：气泡 rect + 方向 + --tail-off + ::after 实测尺寸。
     * 方向约定（见 emoji.css）：right/left 时 ::after 是「长 × 宽」，up/down 时是「宽 × 长」，
     * 尖端永远在**指向座位**的那一端。 */
    function tailInfo(node, r){
      var dir = node.getAttribute('data-dir');
      var off = parseFloat(getComputedStyle(node).getPropertyValue('--tail-off')) || 0;
      /* ★ 尾巴退场只认显式属性（v2.7）：兜底落点不画尾巴，靠 data-tail="off" 表达。
       * 不许用 len === 0 隐式推断 —— 那是 falsy 陷阱，和「shift = 0 是合法位移」同一个坑：
       * 以后 ::after 尺寸因为别的原因变成 0（继承、合成层、浏览器差异），都会被读成「尾巴退场」。 */
      var side0 = (dir === 'right' || dir === 'left');
      var absent = node.getAttribute('data-tail') === 'off';
      var ps = getComputedStyle(node, '::after');
      var bw = absent ? 0 : (parseFloat(ps.width) || 0), bh = absent ? 0 : (parseFloat(ps.height) || 0);
      var side = side0;
      var len = side ? bw : bh;
      var wid = side ? bh : bw;
      var tip;
      if (dir === 'right') { tip = { x: r.left - len, y: r.top + off }; }
      else if (dir === 'left') { tip = { x: r.right + len, y: r.top + off }; }
      else if (dir === 'up') { tip = { x: r.left + off, y: r.bottom + len }; }
      else { tip = { x: r.left + off, y: r.top - len }; }
      return { dir: dir, off: off, len: len, wid: wid, side: side, tip: tip, absent: absent };
    }

    /* ★ Q0 测量契约（规格 §6 Q0 / QA §1，跨轮次可 diff 的前提）：
     *   ① 气泡量**内层** .emoji-pop —— 外层管位移、内层管回弹，回弹是 scale(1.16)；
     *   ② 裁剪盒 = 气泡 rect 外扩 TAIL_H × k（尾巴是 ::after，不在 rect 里，伸出 8×k）；
     *   ③ 采样窗口 = spawn 后 [770, 1400] ms（落定 430 + 回弹 340 = 770，1500 开始淡出）；
     *   ④ 合成发送间隔 ≥ 2100 ms（服务端 2 秒节流会静默丢弃，表现成「这个座位没气泡」）。
     * 尾巴几何（--tail-off / ::after）挂的是**外层**，所以尖端由外层 rect 算。 */

    /* 真实昵称：从**座位块自己的 title** 读（「昵称 · 88 分 · …」），
     * 不读 state.room.players —— Q10 要能抓住「一行硬编码全写『对方』」的作弊，
     * 期望值就不能来自实现用的那个数据源。 */
    function nickOf(pid){
      var all = seats(), s = null, i;
      for (i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-pid') === String(pid)) { s = all[i]; break; }
      }
      if (!s) return '对方';
      var n = (s.getAttribute('title') || '').split(' · ')[0].trim();
      return n || '对方';
    }

    function measure(seat, meta, node, fromPid){
      if (!node) return { missing: true };
      var ro = R(node);
      var popEl = node.querySelector('.emoji-pop');
      var r = popEl ? R(popEl) : ro;
      var ab = R(seat);
      var avEl = seat.querySelector('.opp-avatar');
      var av = avEl ? R(avEl) : ab;
      var k = Math.max(1, parseFloat(getComputedStyle(node).getPropertyValue('--emo-k')) || 1);
      var gap = (meta.kind === 'phrase' ? GAP_PHRASE : GAP_EMOJI) * k;
      /* 裁剪盒外扩量：**只有真画出来的尾巴才占位置**（v2.7）。
       * 对一条不画的尾巴做外扩，会把兜底气泡判成出屏 —— 假红，而且会把人送去调布局。 */
      var t = tailInfo(node, ro);
      var tailH = t.absent ? 0 : TAIL_H_DESIGN * k;
      var vw = innerWidth, vh = innerHeight;
      /* Q1/G1：裁剪盒**单侧**外扩 —— 尾巴只在「朝座位那一侧」伸出（QA 单 §1.7）。
       * 四边外扩在数学上不成立：320/390 的上限宽是 296/366，两侧余量只有 12，
       * 而 8 + 8 = 16 > 12，那 10 格（320/390 × 长短语）永远修不绿。 */
      var q1 = (r.left - (t.dir === 'right' ? tailH : 0) >= MARGIN - 0.5)
        && (r.top - (t.dir === 'down' ? tailH : 0) >= MARGIN - 0.5)
        && (r.right + (t.dir === 'left' ? tailH : 0) <= vw - MARGIN + 0.5)
        && (r.bottom + (t.dir === 'up' ? tailH : 0) <= vh - MARGIN + 0.5);
      /* Q2：按内容类型分开（规格 §6 Q2 / §2 约束 B）——
       * 短语：与**全部**座位块（含锚点）重叠 0；表情：与非锚点块 0（锚点只在保底分支放行） */
      var worst = 0, worstPid = '', worstSelf = 0;
      seats().forEach(function(s){
        var a = ovArea(r, R(s));
        if (s === seat) { worstSelf = a; return; }
        if (a > worst) { worst = a; worstPid = s.getAttribute('data-pid'); }
      });
      var q2 = (worst === 0) && (meta.kind === 'phrase' ? worstSelf === 0 : true);
      var place = node.getAttribute('data-place');
      var dirOk = ['right', 'left', 'up', 'down'].indexOf(t.dir) >= 0;
      /* Q3 的「确实在那一侧」：气泡整个落在座位块的对应外侧（±0.6 容差给亚像素取整）。
       * 注意不是「相对头像中心」——「下」方向的气泡离头像中心永远不近，
       * 拿中心比会把合法落点判成跑偏（v2.1 的坑，见规格 §9 裁定 c）。 */
      var sideOk = false;
      if (t.dir === 'right') sideOk = r.left >= ab.right - 0.6;
      else if (t.dir === 'left') sideOk = r.right <= ab.left + 0.6;
      else if (t.dir === 'up') sideOk = r.bottom <= ab.top + 0.6;
      else sideOk = r.top >= ab.bottom - 0.6;
      /* Q4b（弱，必须恒真）：尖端在**座位块** rect 外扩 gap + TAIL_H 内 —— 不满足即「不指人」 */
      var pad = gap + tailH;
      function inside(box){
        return t.tip.x >= box.left - pad && t.tip.x <= box.right + pad
          && t.tip.y >= box.top - pad && t.tip.y <= box.bottom + pad;
      }
      /* ★ 尾巴退场时 q4b 恒 false（v2.7）：判据是「尾巴尖端落在座位块外扩区内」，
       * 没有尾巴就没有尖端 —— 不许因为 tip 被算成贴着气泡边就意外变 true。
       * 与之配套，Q5 也跳过（--tail-off 仍在节点上，但量的是一个不画的东西），
       * 汇总时用 tailAbsent 把这些格子排除在「已量」之外，而不是当成功。 */
      var q4b = t.absent ? false : inside(ab);
      /* ★ Q4a（强，瞄到脸）**两轴分解**（v2.4 起，规格 §6 Q4a —— v2.6 裁定 ① 再次钉死）：
       *   轴一 沿贴合边：尖端在该轴上的坐标与**头像中心**的偏差 ≤ 头像在该轴跨度的一半
       *        （left/right 看纵向 off，up/down 看横向）
       *   轴二 贴近块：尖端到座位块**朝向边**的距离 ≤ gap + TAIL_H
       *        （right→块右边 / left→块左边 / down→块下边 / up→块上边）
       * 为什么不是「尖端落在头像 rect 外扩区内」：头像在座位块**顶部**，
       * 「挂在块下方」的尖端纵向永远越出外扩区 —— 旧式口径给 down 设了不可能条件，
       * 390 上排两格因此在旧口径下恒为 3/5。v2.6 裁定：**改判据函数，不改阈值、不改分母**。 */
      var side = (t.dir === 'right' || t.dir === 'left');
      var acAlong = side ? (av.top + av.height / 2) : (av.left + av.width / 2);
      var tipAlong = side ? t.tip.y : t.tip.x;
      var avHalf = side ? av.height / 2 : av.width / 2;
      var q4aAxis1 = Math.abs(tipAlong - acAlong) <= avHalf + 0.5;
      var toward, q4aAxis2;
      if (t.dir === 'right') { toward = ab.right; q4aAxis2 = (t.tip.x - toward); }
      else if (t.dir === 'left') { toward = ab.left; q4aAxis2 = (toward - t.tip.x); }
      else if (t.dir === 'down') { toward = ab.bottom; q4aAxis2 = (t.tip.y - toward); }
      else { toward = ab.top; q4aAxis2 = (toward - t.tip.y); }
      var q4a = t.absent ? false : (q4aAxis1 && Math.abs(q4aAxis2) <= pad + 0.5);
      var d = Math.sqrt((t.tip.x - (av.left + av.width / 2)) * (t.tip.x - (av.left + av.width / 2))
        + (t.tip.y - (av.top + av.height / 2)) * (t.tip.y - (av.top + av.height / 2)));
      /* Q5/G8：--tail-off 必须**等于** clamp(Ac_along − 边起点, m, L−m)（±1）。
       * 只判「落在区间内」不够 —— 写死成 m 也能过，那样尾巴永远贴着气泡角。 */
      var span = t.side ? ro.height : ro.width;
      var m = Math.min(RADIUS_DESIGN * k, span / 2);
      var along = t.side ? (av.top + av.height / 2) : (av.left + av.width / 2);
      var start = t.side ? ro.top : ro.left;
      var offExpect = Math.min(Math.max(along - start, m), span - m);
      var q5 = t.absent ? false : (Math.abs(t.off - offExpect) <= 1);
      /* 正文 = .emoji-pop 的 textContent **减去**署名前缀（§4.3 的「昵称：」在 pop 里面）。
       * 不减的话 Q7 会把署名当成"多出来的字"，一署名的短语就判红 —— 而署名是对的。 */
      var byEl = node.querySelector('.emoji-by');
      var byText = byEl ? (byEl.textContent || '') : '';
      var text = popEl ? (popEl.textContent || '') : '';
      var bodyText = (byText && text.indexOf(byText) === 0) ? text.slice(byText.length) : text;
      var clipped = popEl ? (popEl.scrollWidth > popEl.clientWidth + 1) : false;
      /* ★ Q10（规格 §4.3 / §6）：兜底条数中署名覆盖率必须 100%，
       * 而且要**比对内容**与真实发送者昵称 —— 只数「有没有 .emoji-by」会被
       * 一行硬编码（全写「对方」）骗过。「fromPid」是这一条的发送者，
       * 昵称从**座位块 title** 独立读出来，不碰实现的数据源。 */
      var nickWant = nickOf(fromPid);
      var byName = byText.replace(/[：:]\s*$/, '').trim();
      var q10 = byName === nickWant;
      return {
        seat: seat.getAttribute('data-pid'), name: meta.name, what: meta.id, from: fromPid,
        place: place, dir: t.dir, tailOff: Math.round(t.off * 10) / 10,
        span: Math.round(span * 10) / 10, m: Math.round(m * 10) / 10,
        offExpect: Math.round(offExpect * 10) / 10,
        tipD: Math.round(d * 10) / 10, tip: { x: Math.round(t.tip.x), y: Math.round(t.tip.y) },
        block: { l: Math.round(ab.left), t: Math.round(ab.top), r: Math.round(ab.right), b: Math.round(ab.bottom) },
        face: { l: Math.round(av.left), t: Math.round(av.top), r: Math.round(av.right), b: Math.round(av.bottom) },
        pad: Math.round(pad * 10) / 10,
        /* 两个外扩量**必须分开报**（QA 第三轮点名）：裁剪盒只扩 TAIL_H（Q1 用），
         * 判区扩 gap + TAIL_H（Q4 用）。以前合成一个「外扩=18」，
         * 读的人会以为 Q1 也按 18 算，两边对不上就互相怀疑。 */
        tailH: Math.round(tailH * 10) / 10, gap: Math.round(gap * 10) / 10,
        box: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
        q1: q1, q2: q2, q2other: Math.round(worst), q2who: worstPid, q2self: Math.round(worstSelf),
        dirOk: dirOk, sideOk: sideOk,
        q4a: q4a, q4aAxis1: q4aAxis1, q4aAxis2: Math.round(q4aAxis2 * 10) / 10, q4b: q4b, q5: q5,
        tailAbsent: !!t.absent,
        /* Q7 的宽度上限用 Math.floor：320 档实测会在 296 / 297 之间抖，
         * 不取整就会因为 0.4px 的亚像素决定红绿（规格 §6 Q7）。 */
        q7: (r.width <= Math.floor(vw - 24) + 0.6) && !clipped
          && bodyText.length === (meta.textLen || bodyText.length),
        textLen: bodyText.length, wantLen: meta.textLen, clipped: clipped,
        by: byText, byName: byName, nickWant: nickWant, q10: q10,
        /* hasBy 与 by 必须分开给：dump 里的 byText 要用 **null**（元素不存在）
         * 区分于 **""**（元素在但内容取不到）—— 前者是「署名没做」，后者是
         * 「署名做了但读不出来」，处置不一样（QA 的对账口径）。
         * byOwnTruncated 只表达**署名自身**是否被裁；原来的 byTruncated 带
         * clipped（把「整个气泡被裁」也算进来），拿它判「署名被裁」会误归因。 */
        hasBy: !!byEl,
        byOwnTruncated: byEl ? (byEl.scrollWidth > byEl.clientWidth + 1) : false,
        /* v2.7 探针新增字段（QA G16/G10/N18 要用）：分开给「原文」与「可见字符数」，
         * 不许只给一个总长度 —— 只有分开才能分辨「署名被当成正文」和「正文真被裁」。 */
        bodyOriginal: meta.text || '',
        bodyVisibleChars: visibleChars(popEl),
        byTruncated: byEl ? (byEl.scrollWidth > byEl.clientWidth + 1 || clipped) : clipped,
        /* 位移量：缺失时给 null，**不推断成 0**（N18：没算过位移的落点不许冒充没滑） */
        shift: node.hasAttribute('data-shift') ? Number(node.getAttribute('data-shift')) : null
      };
    }

    var KINDS = [
      { name: '短短语', kind: 'phrase', id: 'p4', textLen: 5 },
      { name: '长短语', kind: 'phrase', id: 'p5', textLen: 16 },
      { name: '表情', kind: 'emoji', id: 'e0' },
      { name: '定向表情', kind: 'emoji', id: 'e1', directed: true }
    ];
    /* 文案长度从清单里取，不硬编码 —— 改文案时 Q7 跟着走 */
    KINDS.forEach(function(m){ var e = Emoji.get(m.id); if (e && e.text) { m.textLen = e.text.length; m.text = e.text; } });

    /* 逐字量可见字符数（QA §2.2）：正文容器里还嵌着「span class=emoji-by」这个署名节点，
     * 所以 textContent.length 会把署名算成「多出来的字」，一署名就假红。
     * 做法：遍历文本节点、**跳过署名子树**，每字一个 Range 取 client rect，
     * 只算真正落在气泡盒内且有宽高的 —— 这同时也能抓到 CSS 裁剪造成的丢字。 */
    function visibleChars(popEl){
      if (!popEl) return 0;
      var byEl = popEl.querySelector('.emoji-by');
      var pr = R(popEl);
      var walker = document.createTreeWalker(popEl, NodeFilter.SHOW_TEXT, null);
      var count = 0, n;
      while ((n = walker.nextNode())) {
        if (byEl && byEl.contains(n)) continue;
        var s = n.nodeValue || '';
        for (var i = 0; i < s.length; i++) {
          var rng = document.createRange();
          rng.setStart(n, i); rng.setEnd(n, i + 1);
          var rects = rng.getClientRects();
          if (!rects.length) continue;
          var rr = rects[0];
          if (rr.width > 0 && rr.height > 0 && rr.right > pr.left && rr.left < pr.right) count++;
        }
      }
      return count;
    }

    var list = seats();
    var meSeat = document.querySelector('#game-top .gt-me');
    var myPid = meSeat ? meSeat.getAttribute('data-pid') : '';
    var out = [];
    var realNow = Date.now, fake = realNow();
    Date.now = function(){ fake += 2500; return fake; };

    function step(i, j){
      if (i >= list.length) {
        return wait(2200).then(function(){      /* 等旧节点自然消失，Q6 从干净的状态开始 */
          return burst();
        });
      }
      var seat = list[i], meta = KINDS[j];
      var pid = seat.getAttribute('data-pid');
      var from = pid, to = Emoji.BROADCAST;
      /* 定向：**必须**自己参与，否则这条根本不该出现在我的屏幕上
       * （onEmojiEvent 只放行「全场 / 发给我 / 我发的」）。
       * 发给别人 → from = 我；发给「我」 → from = 别人。 */
      if (meta.directed) {
        if (pid === myPid) {
          from = list[(i + 1) % list.length].getAttribute('data-pid');
          to = pid;
        } else {
          from = myPid || pid;
          to = pid;
        }
      }
      /* 每条之前把动画层清空：这一节量的是**单条的落点**（Q1~Q5），
       * 前面那些还没到 1.9 秒的节点会把它挤到别处去。真实玩法里同一个座位
       * 2 秒只能发一条（客户端与服务端各一层节流），本来也不会叠成一摞；
       * 「多人同时」那一档由后面的 Q6 单独验。 */
      nodes().forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); });
      send(from, to, meta.id);
      /* 采样时点 = spawn 后 900ms（Q0 ③ 的 [770,1400] 窗口内）；下一条最早 2100ms 之后
       * 才发（Q0 ④）—— 20 条 × 2.16s，一档约 44 秒，换来的是「量到的就是落定的位置」。 */
      return wait(SAMPLE_AT).then(function(){
        var all = nodes();
        var rec = measure(seat, meta, all[all.length - 1], from);
        rec.from = from; rec.to = to;
        out.push(rec);
        return wait(SEND_GAP - SAMPLE_AT + 60).then(function(){
          return (j === KINDS.length - 1) ? step(i + 1, 0) : step(i, j + 1);
        });
      });
    }

    /* 轴饱和谓词（规格 §4「接受重叠不是无限制」）：在**让开轴**上，视口内是否存在
     * 一个「自身尺寸 + 6」的空位。用这条代替「内部循环跑了几次」—— 后者不可观测，
     * 前者可独立复算。侧边放置的让开轴是竖直，上/下放置是水平。 */
    function axisFree(node, others, axis){
      var r = R(node);
      var need = (axis === 'y' ? r.height : r.width) + 6;
      var lo = MARGIN, hi = (axis === 'y' ? innerHeight : innerWidth) - MARGIN - need;
      if (hi < lo) return false;
      for (var p = lo; p <= hi + 0.5; p += 2) {
        var box = (axis === 'y')
          ? { left: r.left, right: r.right, top: p, bottom: p + need }
          : { left: p, right: p + need, top: r.top, bottom: r.bottom };
        var free = true;
        for (var i = 0; i < others.length; i++) {
          if (others[i] === node) continue;
          if (ovArea(box, R(others[i])) > 0) { free = false; break; }
        }
        if (free) return true;
      }
      return false;
    }

    /* Q6：5 个人同时发广播。一人一条，谁也不等谁 —— 这才是「多人同时发送」那一档。 */
    function burst(){
      nodes().forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); });
      list.forEach(function(s){ send(s.getAttribute('data-pid'), Emoji.BROADCAST, 'e0'); });
      return wait(SAMPLE_AT).then(function(){
        var ns = nodes();
        var recs = ns.map(function(n, i){
          var seat = list[i] || list[0];
          return measure(seat, { name: '同屏', kind: 'emoji', id: 'e0' }, n, seat.getAttribute('data-pid'));
        });
        var pairs = [], worstPair = 0;
        for (var a = 0; a < ns.length; a++) {
          for (var b = a + 1; b < ns.length; b++) {
            var o = ovArea(R(ns[a].querySelector('.emoji-pop')), R(ns[b].querySelector('.emoji-pop')));
            if (o > 1) {
              /* 「后落的那条」是让位的一方，判它在这条轴上是否已经饱和 */
              var later = ns[b];
              var ldir = later.getAttribute('data-dir');
              var axis = (ldir === 'right' || ldir === 'left') ? 'y' : 'x';
              var sat = !axisFree(later, ns, axis);
              /* 把两块的 rect 一起带上：0.x px 的重叠只能靠原始数字定位，
               * 只报 area 无法判断是「真让不开」还是「亚像素取整」 */
              var ra = R(ns[a].querySelector('.emoji-pop')), rb = R(ns[b].querySelector('.emoji-pop'));
              pairs.push({ a: a, b: b, area: Math.round(o * 100) / 100, axis: axis, dir: ldir, saturated: sat,
                ra: [Math.round(ra.left * 100) / 100, Math.round(ra.top * 100) / 100,
                  Math.round(ra.right * 100) / 100, Math.round(ra.bottom * 100) / 100],
                rb: [Math.round(rb.left * 100) / 100, Math.round(rb.top * 100) / 100,
                  Math.round(rb.right * 100) / 100, Math.round(rb.bottom * 100) / 100],
                shift: ns[b].getAttribute('data-shift'), place: ns[b].getAttribute('data-place') });
              if (o > worstPair) worstPair = o;
            }
          }
        }
        Date.now = realNow;
        return {
          seats: list.length, items: out,
          burst: {
            seats: list.length, nodes: ns.length, recs: recs,
            overlapPairs: pairs.length, worstPair: Math.round(worstPair),
            pairs: pairs,
            /* 「对数 ≤ 1 且该对可解释为轴饱和」：pairs ≤ 1 && (pairs === 0 || pairs[0].saturated) */
            pairsOk: pairs.length <= 1 && (pairs.length === 0 || pairs[0].saturated)
          }
        };
      });
    }
    return step(0, 0);
  })()`);

  const items = (geo && geo.items) || [];
  const bs = (geo && geo.burst) || { recs: [] };

  /* 视觉证据：五个人同时发的那一帧（v2.7）。
   * 「同屏五条都还在」是数字，「五条各自贴着谁、有没有互相压」只有图能看。
   * 时机很紧：burst 在 SAMPLE_AT(900ms) 才 resolve，气泡 1500ms 开始淡出，
   * 所以必须**立刻**拍，中间不许再插一次 evaluate。 */
  if (SHOTS) console.log('    截图：' + (await shot('sync')));

  /* ★ 逐格 JSONL 导出（`EMOJI_PROBE_DUMP=<path>`，v2.7）。
   * 为什么必须有：署名判据（Q10）要**逐条比对内容**，没有机器可读的原始数据，
   * 它就只能靠人读屏 —— 那样的判据迟早退化成「看着像」。
   * 每行一条，字段与 QA 的 `emoji-verdict.js` / `emoji-q10-signature.js` 对齐。 */
  if (process.env.EMOJI_PROBE_DUMP) {
    const dumpPath = process.env.EMOJI_PROBE_DUMP;
    const lines = [];
    items.forEach((r) => {
      if (r.missing) return;
      lines.push(JSON.stringify({
        seat: r.seat, from: r.from, name: r.name, what: r.what,
        /* 发送者的真实昵称（从座位块 title 独立读，不经实现的数据源）：
         * QA 的署名判据用它做 oracle，就不必再拿一份 fixture 去猜 ——
         * 少一个对不上的可能，就少一格「未测」。 */
        fromName: r.nickWant || '',
        dir: r.dir, place: r.place, shift: r.shift,
        rect: r.box, tip: r.tip, block: r.block, face: r.face,
        q4b: r.q4b, q4a: r.q4a, tailAbsent: !!r.tailAbsent,
        byText: r.hasBy ? r.by : null,
        byTruncated: !!r.byTruncated,
        byOwnTruncated: !!r.byOwnTruncated,
        bodyOriginal: r.bodyOriginal || '', bodyVisibleChars: r.bodyVisibleChars,
        /* wantLen 恒定给一个值：表情没有文案时给 null（键**不省**）——
         * 缺键会让聚合器分不清「没这条判据」和「这条不该有字数」。 */
        wantLen: (typeof r.wantLen === 'number' ? r.wantLen : null), clipped: !!r.clipped
      }));
    });
    fs.writeFileSync(dumpPath, lines.join('\n') + '\n', 'utf8');
    console.log('    dump：' + dumpPath + '（' + lines.length + ' 条）');
  }

  items.forEach((r) => {
    if (r.missing) return;
    console.log('    ' + String(r.name) + '/' + r.seat + ' → ' + r.dir + '(' + r.place + ')'
      + ' box=' + r.box.w + '×' + r.box.h + '@' + r.box.l + ',' + r.box.t
      + ' tail=' + r.tailOff + '/[' + r.m + ',' + r.span + '−' + r.m + ']'
      + ' 尖端=' + r.tip.x + ',' + r.tip.y
      + ' 裁剪盒=+' + r.tailH + ' 判区=+' + r.pad
      + ' 瞄脸=' + (r.q4a ? 'Y' : (r.q4aAxis1 ? 'n(轴二' + r.q4aAxis2 + ')' : 'n(轴一)'))
      + ' 碰块=' + (r.tailAbsent ? 'n/a' : (r.q4b ? 'Y' : 'n'))
      + (r.by ? ' 署名=「' + r.by + '」' + (r.q10 ? '✓' : '✗(应为「' + r.nickWant + '」)') : '')
      + (r.q1 ? '' : ' [出屏]') + (r.q2 ? '' : ' [压座位 ' + (r.q2other || r.q2self) + 'px²]'));
  });
  const need = 4 * ((geo && geo.seats) || 0);
  ok(items.length === need && need >= 8 && items.every((r) => !r.missing),
    '每个座位 × 4 类内容都跑到了（' + items.length + '/' + need + '）',
    JSON.stringify(items.map((r) => (r.missing ? r.name + ':无节点' : r.name))).slice(0, 240));

  /* Q1 完整在视口内 —— 量的是**裁剪盒**（rect 外扩 TAIL_H×k），不是气泡 rect */
  const badQ1 = items.filter((r) => !r.missing && !r.q1);
  ok(items.length > 0 && badQ1.length === 0,
    '★ Q1 裁剪盒完整在视口内（rect 外扩 TAIL_H×k 后仍留 ' + 8 + 'px）',
    badQ1.map((r) => r.name + '@' + r.seat + ' ' + JSON.stringify(r.box) + ' +' + Math.round(r.pad)).join(' | '));

  /* Q2 不压座位块（短语含锚点、表情只排非锚点） */
  const badQ2 = items.filter((r) => !r.missing && !r.q2);
  ok(items.length > 0 && badQ2.length === 0,
    '★ Q2 不压座位块（短语与全部块 0 重叠；表情与非锚点块 0 重叠）',
    badQ2.map((r) => r.name + '@' + r.seat + ' 非锚点 ' + r.q2other + 'px² 压 ' + r.q2who
      + ' / 锚点 ' + r.q2self + 'px²').join(' | '));

  /* Q3/Q4 只对**定向落点**有意义：place=dir/self 是「按座位算出来的四选一」，
   * place=stack/fallback 是让位与兜底 —— 那些位置本来就是「为了不压别人/不出屏
   * 而牺牲指向」的结果，拿 Q4 去量它们等于要求「既让开又不动」，自相矛盾。
   * 代价是这两条可能被「全走兜底」蒙混过去，所以下面单列一条比例下限守它。 */
  const dirItems = items.filter((r) => !r.missing && (r.place === 'dir' || r.place === 'self'));
  /* Q3 方向落在四选一，且气泡真在声称的那一侧 */
  const badQ3 = dirItems.filter((r) => !(r.dirOk && r.sideOk));
  ok(dirItems.length > 0 && badQ3.length === 0,
    '★ Q3 方向 ∈ {right,left,up,down} 且气泡真在声称的那一侧',
    badQ3.map((r) => r.name + '@' + r.seat + ' dir=' + r.dir + ' side=' + r.sideOk).join(' | '));

  /* ★ 兜底 ⟺ 尾巴退场（v2.7，双向）：这是「不画尾巴」这条修复的回归哨。
   * 只判单向（兜底必须没尾巴）不够 —— 以后有人把尾巴画回来，或者把某个非兜底
   * 路径误标成 off，单向断言都不会响。两个方向都要判。 */
  const fbHasTail = items.filter((r) => !r.missing && r.place === 'fallback' && !r.tailAbsent);
  const nonFbNoTail = items.filter((r) => !r.missing && r.place !== 'fallback' && r.tailAbsent);
  ok(fbHasTail.length === 0 && nonFbNoTail.length === 0,
    '★ 兜底落点 ⟺ 尾巴退场（双向；实测 兜底 ' + items.filter((r) => !r.missing && r.tailAbsent).length
      + ' 条全无尾，非兜底 ' + items.filter((r) => !r.missing && !r.tailAbsent).length + ' 条全有尾）',
    '兜底却有尾：' + fbHasTail.map((r) => r.name + '@' + r.seat).join(',')
      + ' | 非兜底却无尾：' + nonFbNoTail.map((r) => r.name + '@' + r.seat + ' place=' + r.place).join(','));

  /* Q4b（弱，必须恒真）：尖端在**座位块** rect 外扩 gap + TAIL_H 内 */
  const badQ4b = dirItems.filter((r) => !r.q4b);
  const naQ4b = items.filter((r) => !r.missing && r.tailAbsent);
  ok(dirItems.length > 0 && badQ4b.length === 0,
    '★ Q4b 定向落点的尾巴尖端落在座位块外扩区（gap + TAIL_H）内 —— 100%'
      + '（分母 ' + dirItems.length + '；N/A ' + naQ4b.length + ' 条尾巴退场，不计入分母）',
    badQ4b.map((r) => r.name + '@' + r.seat + ' 尖端 ' + r.tip.x + ',' + r.tip.y
      + ' 块 ' + JSON.stringify(r.block) + ' 判区=+' + r.pad).join(' | '));

  /* Q4a（强，瞄到脸）**两轴分解**（规格 §6 Q4a / v2.6 裁定 ①）：
   *   轴一 尖端沿贴合边对准头像中心（偏差 ≤ 头像在该轴跨度的一半）
   *   轴二 尖端到座位块朝向边的距离 ≤ gap + TAIL_H
   * 分母仍是 **T4（定向表情）**，要求 ≥ 80% —— 但**尾巴退场的格子不进分母**（v2.7）：
   * 「瞄到脸」这件事的前提是有一条尾巴；没有尾巴时 Q4a 无从判，记 N/A 而不是记红。
   * ⚠️ 这条不是「放宽阈值」：分母从 5 变 4 是因为其中 1 格**物理上不再有尾巴**，
   * 我们同时把「N/A 条数」打出来，读的人能自己复算回 5 格口径。 */
  const t4 = items.filter((r) => !r.missing && r.what === 'e1');
  const t4judged = t4.filter((r) => !r.tailAbsent);
  const t4ok = t4judged.filter((r) => r.q4a).length;
  const faceAll = items.filter((r) => !r.missing && r.q4a).length;
  const dirHist = {};
  items.forEach((r) => { if (!r.missing) dirHist[r.dir] = (dirHist[r.dir] || 0) + 1; });
  ok(t4judged.length > 0 && t4ok / t4judged.length >= 0.8,
    '★ Q4a T4 定向表情中「瞄到脸」≥ 80%（实测 ' + t4ok + '/' + t4judged.length
      + '（两轴分解口径；T4 共 ' + t4.length + ' 格，其中 ' + (t4.length - t4judged.length)
      + ' 格尾巴退场记 N/A，不进分母）；全员 ' + faceAll + '/' + items.length
      + '；方向分布 ' + JSON.stringify(dirHist) + '）',
    t4judged.filter((r) => !r.q4a).map((r) => r.name + '@' + r.seat + ' dir=' + r.dir
      + ' 尖端 ' + r.tip.x + ',' + r.tip.y + ' 轴一=' + r.q4aAxis1
      + ' 轴二=' + r.q4aAxis2 + '/限 ' + r.pad + ' 脸 ' + JSON.stringify(r.face)).join(' | '));

  /* Q5 尾巴在气泡边上：--tail-off 必须等于 clamp(Ac_along − 边起点, m, L−m) */
  const badQ5 = items.filter((r) => !r.missing && !r.tailAbsent && !r.q5);
  const naQ5 = items.filter((r) => !r.missing && r.tailAbsent);
  ok(items.length > 0 && badQ5.length === 0,
    '★ Q5 --tail-off == clamp(Ac_along − 边起点, m, L−m)，m = min(18k, L/2)（±1）'
      + '（分母 ' + (items.length - naQ5.length) + '；N/A ' + naQ5.length + ' 条尾巴退场）',
    badQ5.map((r) => r.name + '@' + r.seat + ' off=' + r.tailOff + ' ≠ ' + r.offExpect
      + ' [m=' + r.m + ' span=' + r.span + ']').join(' | '));

  /* 反向守一条：不能「永远走兜底」混过去。
   * 四方向能用就必须用 —— 否则 Q3/Q4 会因为「没有一条是定向落点」而空转全绿。 */
  ok(dirItems.length >= Math.ceil(items.length * 0.6),
    '★ 定向落点占多数（' + dirItems.length + '/' + items.length + '），没有退化成「全走兜底」',
    '兜底：' + items.filter((r) => r.place === 'fallback').map((r) => r.name + '@' + r.seat).join(', '));

  /* ★ Q8 / Q10（规格 §4.2 / §4.3 / §6，v2.6 拆口径）：
   *
   * 以前把两件危害不同的事算在一个数字里 ——「不知道谁说的」和「位置不够优雅」。
   * 现在拆成三个数，**必须同时报**（只报一个合计数算未测）：
   *   A 定向落点        = Q4b 成立（尾巴碰到块 → 归属靠尾巴，位置也正常）
   *   B 不指人但已署名   = !Q4b && Q10 → 位置不优雅，但用户知道是谁说的（观察项 ≤ 8）
   *   C 不指人且未署名   = !Q4b && !Q10 → **功能失效**，预算只统计这一档（≤ 2）
   * 放宽到 6 条是「用一个更大的数字承认功能失效」，不采纳（规格 §13 裁定 ②）。 */
  const pointed = items.filter((r) => !r.missing && r.q4b);
  const noPoint = items.filter((r) => !r.missing && !r.q4b);
  const signed = noPoint.filter((r) => r.q10);
  const unsigned = noPoint.filter((r) => !r.q10);
  const budget = (W <= 320) ? 2 : 2;          // v2.6 统一口径：各档都是 ≤ 2
  const signedCap = 8;                        // 观察项，不阻断
  console.log('    [Q8] 定向落点 ' + pointed.length + ' / 不指人但已署名 ' + signed.length
    + ' / 不指人且未署名 ' + unsigned.length + '（共 ' + items.length + ' 格）');
  ok(items.length > 0 && unsigned.length <= budget,
    '★ Q8 「不指人**且未署名**」' + unsigned.length + '/' + items.length + ' 条（预算 ≤ ' + budget + '）'
      + '；观察项「不指人但已署名」' + signed.length + '/20（≤ ' + signedCap + '）',
    unsigned.map((r) => r.name + '@' + r.seat + '(' + r.place + ', dir=' + r.dir + ')').join(', '));
  ok(items.length > 0 && signed.length <= signedCap,
    '★ Q8 观察项「不指人但已署名」' + signed.length + ' 条 ≤ ' + signedCap + '（§4.2：只记录，不阻断）',
    signed.map((r) => r.name + '@' + r.seat + '(' + r.place + ')').join(', '));

  /* Q10（§4.3 的否定式判据）：兜底集合（= Q4b 不成立）中署名覆盖率必须 100%。
   * 「不指人」可以容忍（窄屏物理限制），「不指人且不署名」不能容忍。
   * ★ 判定不只是「有没有 .emoji-by」—— 还要**比对文本内容与真实发送者昵称**
   *   （昵称从座位块 title 独立读，不读实现的数据源），否则一行硬编码就能骗过。 */
  const cov = noPoint.length ? Math.round((signed.length / noPoint.length) * 1000) / 10 : 100;
  ok(noPoint.length === 0 || signed.length === noPoint.length,
    '★ Q10 兜底署名覆盖率 ' + cov + '%（' + signed.length + '/' + noPoint.length + '，要求 100%；'
      + '比对项 = 文本内容 vs 座位块 title 里的真实昵称）',
    unsigned.map((r) => r.name + '@' + r.seat + ' 署名=' + JSON.stringify(r.by)
      + ' 应为「' + r.nickWant + '」').join(' | '));

  /* Q6 多人同时发送 */
  const bRecs = (bs.recs || []).filter((r) => !r.missing);
  const badB = bRecs.filter((r) => !r.q1 || !r.q2);
  ok(bs.nodes === bs.seats && bs.nodes >= 2,
    '★ Q6 同时发送：' + bs.seats + ' 个座位各一条，同屏 ' + bs.nodes + ' 条都还在（不丢内容）',
    JSON.stringify({ seats: bs.seats, nodes: bs.nodes }));
  ok(bRecs.length === bs.nodes && badB.length === 0,
    '★ Q6 同屏多条的 Q1（裁剪盒）/Q2 仍全绿',
    badB.map((r) => r.seat + ' ' + JSON.stringify(r.box) + ' q2=' + r.q2other + '/' + r.q2self).join(' | '));
  ok(!!bs.pairsOk,
    '★ Q6 同屏气泡重叠**对数** ≤ 1 且可解释为轴饱和（实测 ' + bs.overlapPairs + ' 对，最大 '
      + bs.worstPair + 'px²）',
    JSON.stringify(bs.pairs));

  /* Q7 320 宽不切字（每档都验：宽度 ≤ vw − 24、没有被裁、字数与原文一致） */
  const phr = items.filter((r) => !r.missing && r.name && r.name.indexOf('短语') >= 0);
  const badQ7 = phr.filter((r) => !r.q7);
  ok(phr.length > 0 && badQ7.length === 0,
    '★ Q7 气泡宽度 ≤ vw − 24、不裁字、可见字数 = 原文长度（' + W + ' 宽）',
    badQ7.map((r) => r.name + '@' + r.seat + ' w=' + r.box.w + ' 字 ' + r.textLen + '/' + r.wantLen + (r.clipped ? ' 被裁' : '')).join(' | '));

  /* 视觉证据：兜底署名的**实物**（v2.7）。
   * 320/390 上 p5（16 字长短语）放不下、走兜底并加「昵称：」前缀 ——
   * 这是本轮唯一一个「用文字换位置」的取舍，只看断言看不出好不好看。 */
  if (SHOTS) {
    /* 必须等 ≥2100ms：Q6 刚连发 5 条，客户端的 2 秒节流会把这一条**静默丢掉**，
     * 于是「截图成功」但图里什么都没有 —— 那种假证据比没截图更糟。
     * 第一版就踩了：拍出来是一片空桌面，而日志写着「截图：…signed.png」。 */
    await sleep(2300);
    const signedFrom = await evaluate(`(function(){
      if (!window.__probeSend) return 'no-send';
      var me = document.querySelector('#game-top .gt-me');
      var pid = me ? me.getAttribute('data-pid') : '';
      if (!pid) return 'no-me';
      window.__probeSend(pid, Emoji.BROADCAST, 'p5');
      return pid;
    })()`);
    await sleep(900);
    /* 拍之前先确认「画面上真的有这条」：数量为 0 就不写截图，直接报出来。 */
    const signedNodes = await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length');
    if (signedNodes > 0) {
      const signedShot = await shot('signed');
      const signedInfo = await evaluate(`(function(){
        var n = document.querySelector('#emoji-layer .emoji-fly');
        if (!n) return null;
        var by = n.querySelector('.emoji-by');
        return { dir: n.getAttribute('data-dir'), place: n.getAttribute('data-place'),
                 by: by ? by.textContent : '', text: n.textContent };
      })()`);
      console.log('    截图：' + signedShot + '（p5 长短语，发送者 ' + signedFrom
        + '，落点 ' + (signedInfo && signedInfo.place) + '/' + (signedInfo && signedInfo.dir)
        + '，署名『' + (signedInfo && signedInfo.by) + '』）');
    } else {
      console.log('    !! 兜底署名的截图没拍成：发送后画面上 0 条（多半又被 2 秒节流丢了），'
        + '这张图**不作为证据**');
    }
  }

  const stuck = await evaluate('__wait(function(){ return document.querySelectorAll("#emoji-layer .emoji-fly").length === 0; }, 3500)');
  ok(!!stuck, '★ [9] 跑完动画层自己清干净（' + (items.length + bs.nodes) + ' 条都不留垃圾）',
    '剩余 ' + JSON.stringify(await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length')));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  try { edge.kill(); } catch (e) { /* 已退出 */ }
  server.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; try { server.close(); } catch (x) {} });
