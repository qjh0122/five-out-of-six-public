#!/usr/bin/env node
/**
 * QA 性能基线 · 高风险①：SW 脚本/样式 cache-first + `?v=` 版本串是否真的控制更新
 *
 * 不读 sw.js 的常量当结论，只做真浏览器行为测量。真正的“网络出口”判据是
 * **静态 HTTP 服务器实际收到的 /js|css 请求数**——不能用 CDP Network.requestWillBeSent：
 * SW 用 Cache API 应答时同样会发这个事件（我第一版就栽在这，缓存里明明有 35 条
 * ?v= 命中，事件仍是 35，属测量口径错误而非产品缺陷）。
 *
 *   A. 版本 v1 冷启动 → SW 接管、预热缓存
 *   B. 同版本再打开   → 服务器收到 /js|css 请求数，应为 0（负向断言）
 *   C. 版本号 bump    → 服务器请求数应 = 全部 35 条（新 URL 全部 miss）
 *   D. 新版本再打开   → 服务器请求数应回到 0（新版本也被缓存住）
 *
 * 静态服务把 index.html 里的 app-version 与所有 `?v=` 在内存里替换成当前版本，
 * 不写磁盘（禁止改生产代码）。--selftest 先自验 URL 分类器（2 命中 2 不命中）。
 *
 * 用法：node tools/qa/perf-sw-cache.js [--selftest]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('../../scripts/lib/browser');

const ROOT = path.join(__dirname, '..', '..', 'pwa');
const PORT = 3081, CDP = 9381;
/* 基线版本从生产 index.html 的 meta 读，不再写死。
 * 写死 `20261119b` 时页面已经是 20261120a，下面的 `?v=` 替换一条都命中不了 ——
 * 于是「版本 bump」那一态其实从未 bump 过，工具假红（2026-11-20 实测 C=0）。 */
const HTML_NOW = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const VM = /<meta name="app-version" content="([^"]+)">/.exec(HTML_NOW);
if (!VM) { console.error('index.html 没有 app-version meta，无法测量'); process.exit(1); }
const BASE_VER = VM[1];
let VER = BASE_VER;
let SERVER_HITS = [];                 // 真正到达服务器的请求（网络出口）
const MIME = { '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg',
  '.webmanifest':'application/manifest+json','.json':'application/json' };

function isAppAsset(urlStr) {
  let u;
  try { u = new URL(urlStr, 'http://x/'); } catch (e) { return false; }
  if (u.origin !== 'http://127.0.0.1:' + PORT) return false;
  return /^\/(js|css)\//.test(u.pathname);
}
function selftest() {
  const cases = [
    ['http://127.0.0.1:3081/js/game.js?v=20261119b', true, '命中：应用脚本'],
    ['http://127.0.0.1:3081/css/style.css?v=20261119b', true, '命中：应用样式'],
    ['http://127.0.0.1:3081/api/health', false, '不命中：api'],
    ['https://cdn.example.com/js/x.js', false, '不命中：跨域脚本']
  ];
  let ok=0;
  cases.forEach(([u,want,label])=>{ const got=isAppAsset(u); const pass=got===want; if(pass)ok++;
    console.log((pass?'  PASS  ':'  FAIL  ')+label+' → '+got); });
  console.log('分类器自验 '+ok+'/'+cases.length+'（含 '+cases.filter(c=>c[1]).length+
    ' 命中 / '+cases.filter(c=>!c[1]).length+' 不命中）');
  return ok===cases.length;
}

function html() {
  let s=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  s=s.replace(/<meta name="app-version" content="[^"]+">/,
    '<meta name="app-version" content="'+VER+'">');
  /* 所有本地 `?v=` 一起换（不限旧值），保证 meta 与 script/link 永远同一版；
   * 否则 SW 从 meta 读到的版本会与页面请求的版本分叉，测的就不是版本 bump 了。 */
  return s.replace(/\?v=[0-9A-Za-z_-]+/g, '?v='+VER);
}
const server=http.createServer((req,res)=>{
  const raw=req.url||'/';
  if(isAppAsset('http://127.0.0.1:'+PORT+raw)) SERVER_HITS.push(req.method+' '+raw);
  let p=decodeURIComponent(raw.split('?')[0]);
  if(p==='/') p='/index.html';
  /* 版本探针必须与当前被测版本一致：磁盘 version.json 仍是基线版，若照原样返回，
   * bump 那一态页面会自己 reload（版本自检），把「缓存 miss 的请求数」翻倍，测的就不是 SW 了。 */
  if(p==='/version.json'){
    res.writeHead(200,{'Content-Type':MIME['.json'],'Cache-Control':'no-store'});
    res.end(JSON.stringify({v:VER}));
    return;
  }
  const abs=path.join(ROOT,p);
  if(!abs.startsWith(ROOT)){ res.writeHead(403); res.end(); return; }
  if(p==='/index.html'){
    res.writeHead(200,{'Content-Type':MIME['.html'],'Cache-Control':'no-store'}); res.end(html()); return;
  }
  fs.readFile(abs,(e,buf)=>{
    if(e){ res.writeHead(404); res.end('404'); return; }
    res.writeHead(200,{'Content-Type':MIME[path.extname(abs)]||'application/octet-stream'}); res.end(buf);
  });
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function getJson(url){return new Promise((resolve,reject)=>{ http.get(url,res=>{let b='';res.on('data',d=>b+=d);
  res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}).on('error',reject);});}
function cdpConnect(wsUrl){return new Promise((resolve,reject)=>{ const ws=new WebSocket(wsUrl); let id=0;
  const waiting=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){
    const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.reject(new Error(JSON.stringify(m.error))):w.resolve(m.result);}});
  ws.addEventListener('error',reject);
  ws.addEventListener('open',()=>resolve({
    send(method,params){return new Promise((res,rej)=>{id++;waiting.set(id,{resolve:res,reject:rej});
      ws.send(JSON.stringify({id,method,params:params||{}}));});}, close(){try{ws.close();}catch(e){}} }));});}

async function main(){
  if(process.argv.includes('--selftest')) process.exit(selftest()?0:1);
  if(!selftest()) process.exit(1);
  console.log('\n--- 真浏览器测量（判据=服务器实际收到的请求）---');
  await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
  const edge=spawn(findBrowser(),['--headless=new','--disable-gpu','--hide-scrollbars','--mute-audio',
    '--remote-debugging-port='+CDP,'--user-data-dir='+path.join(os.tmpdir(),'qa-swcache-'+Date.now()),
    '--window-size=390,844','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'});
  let page=null;
  for(let i=0;i<40;i++){ await sleep(250); try{
    const l=await getJson('http://127.0.0.1:'+CDP+'/json/list'); page=(l||[]).find(t=>t.type==='page'); if(page)break;
  }catch(e){} }
  if(!page){ console.error('连不上浏览器 CDP'); edge.kill(); server.close(); process.exit(1); }
  const cdp=await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  const ev=expr=>cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true})
    .then(r=>r.exceptionDetails?{__error:String(r.exceptionDetails.text)}:(r.result&&r.result.value));
  const URL0='http://127.0.0.1:'+PORT+'/?mode=local';
  const nav=async()=>{ await cdp.send('Page.navigate',{url:URL0}); await sleep(900); };

  // A 冷启动
  VER=BASE_VER; SERVER_HITS=[]; await nav();
  let controlled=false;
  for(let i=0;i<40;i++){ controlled=!!(await ev("!!(navigator.serviceWorker&&navigator.serviceWorker.controller)"));
    if(controlled)break; await sleep(250); }
  await sleep(1500);
  const cold = SERVER_HITS.length;
  console.log('A  冷启动：SW 接管='+controlled+'，服务器收到 /js|css '+cold+' 笔');

  async function measure(label){
    SERVER_HITS=[]; await nav(); await sleep(500);
    const n=SERVER_HITS.length;
    console.log('  '+label+' → 服务器实际收到 '+n+' 笔 /js|css');
    if(n>0) {
      const bare = SERVER_HITS.filter(x => !/\?v=/.test(x)).length;
      const ver = SERVER_HITS.length - bare;
      console.log('      拆分：裸/无 v '+bare+' 笔，带 ?v= '+ver+' 笔');
      SERVER_HITS.slice(0,8).forEach(x=>console.log('      '+x));
    }
    return n;
  }
  /* C7 后 install 已把 `?v=<当前版本>` 写成缓存键，与页面引用精确对齐：
   * A 只应有 install 那一遍预缓存（≈35 笔），B/B2 必须为 0；bump 后全量 miss。
   * 改前的口径是「A/B 各 35~70 笔」，那条注释随 C7 一起作废。 */
  const warmOld=await measure('B 同版本第二次打开（C7 后应 0）');
  const sameVer=await measure('B2 同版本第三次打开（应 0）');
  VER='20261120qa'; const bumped=await measure('C 版本 bump 后打开（应 ≥30，全部 miss）');
  const warmNew=await measure('C2 新版本第二次打开（预热后应 0）');
  const settled=await measure('D 新版本第三次打开（应 0）');

  /* 离线态：断网后导航必须仍由 SW 兜底出首页，且服务器一条 /js|css 都不该收到。
   * 这一态专门守 mix-version 防线：无 v 或无网时都不许静默跑旧代码。 */
  await cdp.send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  SERVER_HITS=[]; await nav();
  let offScreen='';
  for(let i=0;i<20;i++){
    offScreen=await ev(`(function(){var ss=document.querySelectorAll('.screen');
      for(var i=0;i<ss.length;i++){if(getComputedStyle(ss[i]).display!=='none')return ss[i].id;}return '';})()`);
    if(offScreen&&offScreen!=='__error')break;
    await sleep(250);
  }
  const offHits=SERVER_HITS.length;
  await cdp.send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  console.log('E  离线兜底：可见屏='+offScreen+'，服务器收到 '+offHits+' 笔 /js|css');

  // 顺带核对缓存里确实存在带 ?v= 的条目（不是靠猜）
  const cache=await ev(`(async function(){var ks=await caches.keys();var o={};
    for(var i=0;i<ks.length;i++){var c=await caches.open(ks[i]);var rr=await c.keys();
      o[ks[i]]=rr.map(function(r){return new URL(r.url).pathname+new URL(r.url).search;});}return o;})()`);
  let withV=0; if(cache&&!cache.__error) Object.keys(cache).forEach(k=>{withV+=cache[k].filter(u=>u.indexOf('?v=')>=0).length;});
  console.log('  缓存中带 ?v= 的条目 '+withV+' 条（证明命中来自缓存而非重定向）');

  /* 三态判据：同版本第二次 0、bump 全量重下（>=30）、新版本回稳 0，
   * 且缓存里确有带 ?v= 的键（排除「靠重定向假命中」）。
   * A（冷启）只作观测：页面 defer 脚本在 SW 注册/接管之前就请求完了，install 随后
   * 仍要为离线能力预缓存一遍，所以首访「页面一遍 + install 一遍」是结构性成本；
   * C7 消掉的是**第二次访问起**的版本化重下（旧机制 B=35 → 新机制 B=0）。 */
  const pass=controlled&&cold>0&&warmOld===0&&sameVer===0
    &&bumped>=30&&warmNew===0&&settled===0&&withV>0
    &&offScreen==='screen-home'&&offHits===0;
  console.log('\n判定：'+(pass?'实测通过':'实测异常')+
    ' | 冷启观测='+cold+' 笔（页面+install 各一遍）'+
    ' 同版本0请求='+(warmOld===0&&sameVer===0)+
    ' bump全量重下='+(bumped>=30)+'（'+bumped+' 笔）'+
    ' 新版本稳定后0请求='+(warmNew===0&&settled===0)+
    ' 带v缓存条目='+withV+
    ' 离线兜底='+(offScreen==='screen-home'&&offHits===0));
  cdp.close(); edge.kill(); server.close();
  process.exit(pass?0:1);
}
main().catch(e=>{ console.error(e); server.close(); process.exit(1); });
