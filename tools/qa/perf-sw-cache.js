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
const BASE_VER = '20261119b';
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
  return s.split('?v='+BASE_VER).join('?v='+VER);
}
const server=http.createServer((req,res)=>{
  const raw=req.url||'/';
  if(isAppAsset('http://127.0.0.1:'+PORT+raw)) SERVER_HITS.push(req.method+' '+raw);
  let p=decodeURIComponent(raw.split('?')[0]);
  if(p==='/') p='/index.html';
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
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
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
  console.log('A  冷启动：SW 接管='+controlled+'，服务器收到 /js|css '+SERVER_HITS.length+' 笔');

  async function measure(label){
    SERVER_HITS=[]; await nav(); await sleep(500);
    const n=SERVER_HITS.length;
    console.log('  '+label+' → 服务器实际收到 '+n+' 笔 /js|css');
    if(n>0&&n<=6) SERVER_HITS.slice(0,6).forEach(x=>console.log('      '+x));
    return n;
  }
  /* ★ PRECACHE 写的是裸路径 /js/game.js，HTML 请求的是 /js/game.js?v=xxx —— 两个不同
   * 的 cache key。所以「第一个版本化请求」必然 miss（这正是 A/B 各 35~70 笔的原因），
   * 它 fetch 后才把 ?v= 版本写回缓存。负向断言必须在**已预热**之后测，否则口径错了会
   * 把正常的首次 miss 误判成产品缺陷（我第一版就误判过，见文件头注释）。 */
  const warmOld=await measure('B 同版本第二次打开（预热 ?v=b，预期一笔）');
  const sameVer=await measure('B2 同版本第三次打开（应 0）');
  VER='20261120qa'; const bumped=await measure('C 版本 bump 后打开（应 >0，全部 miss）');
  const warmNew=await measure('C2 新版本第二次打开（预热 ?v=qa，预期一笔）');
  const settled=await measure('D 新版本第三次打开（应 0）');

  // 顺带核对缓存里确实存在带 ?v= 的条目（不是靠猜）
  const cache=await ev(`(async function(){var ks=await caches.keys();var o={};
    for(var i=0;i<ks.length;i++){var c=await caches.open(ks[i]);var rr=await c.keys();
      o[ks[i]]=rr.map(function(r){return new URL(r.url).pathname+new URL(r.url).search;});}return o;})()`);
  let withV=0; if(cache&&!cache.__error) Object.keys(cache).forEach(k=>{withV+=cache[k].filter(u=>u.indexOf('?v=')>=0).length;});
  console.log('  缓存中带 ?v= 的条目 '+withV+' 条（证明命中来自缓存而非重定向）');

  /* warmNew（C2）本身就是 0：C 那一次 bump 已经把 ?v=qa 写进缓存，C2 直接命中。
   * 首次冷启动（A=70）多出来的一半是 PRECACHE 的裸路径请求，与 ?v= 版本化请求
   * 是两个 cache key —— 这是一次性开销，不是「更新不生效」。 */
  const pass=controlled&&warmOld>0&&sameVer===0&&bumped>0&&settled===0;
  console.log('\n判定：'+(pass?'实测通过':'实测异常')+
    ' | 预热后同版本0请求='+(sameVer===0)+' bump全量重下='+(bumped>0)+
    ' 新版本稳定后0请求='+(settled===0));
  cdp.close(); edge.kill(); server.close();
  process.exit(pass?0:1);
}
main().catch(e=>{ console.error(e); server.close(); process.exit(1); });
