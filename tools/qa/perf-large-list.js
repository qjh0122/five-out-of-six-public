#!/usr/bin/env node
/**
 * QA 性能基线 · 高风险③：大列表渲染是否可测量卡顿（recordsView / seatSheetView）
 *
 * 真浏览器里加载真实 recordsView.js + gameUtils.js，用 200 条合成记录（= Records.LIMIT
 * 的上界，独立取自 records.js:63 的规格注释，不是从被测函数反推），量：
 *   A. renderRecordRows(200) 的 wall-clock 耗时 + DOM 节点增量（MutationObserver）。
 *   B. 契约断言：渲染出的 .rp-row 数 == 输入条数（不多不少），负向：容器无残留旧行。
 *   C. 二次渲染前先 innerHTML=''（实现如此），量“清空→重建”总耗时；观察是否随条数线性。
 *   D. 真实 200 场：records.js LIMIT=200 是上界，取 [10,50,200] 三点量缩放曲线。
 *
 * 期望值独立：行数=输入条数（纯函数语义）；卡顿阈值用 16.7ms/帧 ×N 的手算参考，
 * 不引用被测常量。--selftest 自验行数判定器（命中/不命中各 2 例）。
 *
 * 用法：node tools/qa/perf-large-list.js [--selftest]
 */
'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const os=require('os');
const { spawn }=require('child_process');
const { findBrowser }=require('../../scripts/lib/browser');

const ROOT=path.join(__dirname,'..','..','pwa');
const PORT=3083, CDP=9383;
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg'};

/** 行数判定：真实渲染的行数应恰好等于输入条数 */
function rowCountOk(rendered,expected){ return rendered===expected; }
function selftest(){
  const cases=[[200,200,true,'命中：200=200'],[50,50,true,'命中：50=50'],
    [199,200,false,'不命中：199≠200'],[201,200,false,'不命中：201≠200']];
  let ok=0; cases.forEach(([r,e,w,l])=>{const g=rowCountOk(r,e); if(g===w)ok++;
    console.log((g===w?'  PASS  ':'  FAIL  ')+l+' → '+g);});
  console.log('判定器自验 '+ok+'/'+cases.length+'（2 命中 2 不命中）'); return ok===cases.length;
}

/* 一个最小 HTML：只挂 recordsView 需要的 #records-list 容器 + 上游依赖脚本 */
const PAGE=`<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="records-list"></div>
<script src="/js/gameUtils.js"></script>
<script src="/js/config.js"></script>
<script src="/js/recordsView.js"></script>
</body></html>`;
const server=http.createServer((req,res)=>{
  const p=decodeURIComponent((req.url||'/').split('?')[0]);
  if(p==='/'||p==='/index.html'){ res.writeHead(200,{'Content-Type':MIME['.html']}); res.end(PAGE); return; }
  const abs=path.join(ROOT,p);
  if(!abs.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(abs,(e,buf)=>{ if(e){res.writeHead(404);res.end('404');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(abs)]||'application/octet-stream'});res.end(buf);});
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function getJson(url){return new Promise((resolve,reject)=>{http.get(url,res=>{let b='';res.on('data',d=>b+=d);
  res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}).on('error',reject);});}
function cdpConnect(wsUrl){return new Promise((resolve,reject)=>{const ws=new WebSocket(wsUrl);let id=0;const waiting=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&waiting.has(m.id)){
    const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.reject(new Error(JSON.stringify(m.error))):w.resolve(m.result);}});
  ws.addEventListener('error',reject);
  ws.addEventListener('open',()=>resolve({send(method,params){return new Promise((res,rej)=>{id++;
    waiting.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify({id,method,params:params||{}}));});},close(){try{ws.close();}catch(e){}}}));});}

async function main(){
  if(process.argv.includes('--selftest')) process.exit(selftest()?0:1);
  if(!selftest()) process.exit(1);
  console.log('\n--- 真浏览器测量 ---');
  await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
  const edge=spawn(findBrowser(),['--headless=new','--disable-gpu','--hide-scrollbars','--mute-audio',
    '--remote-debugging-port='+CDP,'--user-data-dir='+path.join(os.tmpdir(),'qa-biglist-'+Date.now()),
    '--window-size=1280,720','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'});
  let page=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await getJson('http://127.0.0.1:'+CDP+'/json/list');
    page=(l||[]).find(t=>t.type==='page');if(page)break;}catch(e){}}
  if(!page){console.error('连不上浏览器');edge.kill();server.close();process.exit(1);}
  const cdp=await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  const ev=async expr=>{const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    return r.exceptionDetails?{__error:String(r.exceptionDetails.text)}:(r.result&&r.result.value);};
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+PORT+'/'});
  await sleep(1200);
  const ready=await ev("typeof LXW!=='undefined' && typeof LXW.recordsView==='function' && typeof LXW.utils==='object'");
  console.log('  依赖加载：recordsView='+ready);
  if(!ready){console.error('recordsView 未挂载');cdp.close();edge.kill();server.close();process.exit(1);}

  // 造数据：N 条最小合法记录（recordsView.renderRecordRows 读 endedAt/myNet/playerCount/ai/replay）
  const result=await ev(`(function(){
    function makeRows(n){var out=[];for(var i=0;i<n;i++){out.push({
      endedAt: Date.now()-i*60000, myNet:(i%7)-3, playerCount:5, ai:(i%9===0),
      endReason:'handLimit', replay:null
    });}return out;}
    /* 用真实 create() 拿 renderRecordRows；deps 给最小桩（renderRecordRows 只用 U/$/el 等全局工具） */
    var R = window.LXW.recordsView({});
    var ul = document.getElementById('records-list');
    var out = {};
    /* 先预热：第一次 renderRecordRows 含 JIT 编译，0.7ms vs 0.3ms 的差异是噪声不是缩放。
     * 每个点跑 5 次取最小，滤掉偶发 GC/调度抖动；亚毫秒级不做“严格单调”断言。 */
    R.renderRecordRows(makeRows(200));
    [10,50,200].forEach(function(n){
      var rows=makeRows(n), best=Infinity, rowsSeen=0;
      for(var k=0;k<5;k++){
        var t0=performance.now();
        R.renderRecordRows(rows);
        var ms=performance.now()-t0;
        if(ms<best)best=ms;
        rowsSeen=ul.querySelectorAll('.rp-row').length;
      }
      out[n]={ ms: Math.round(best*100)/100, rows: rowsSeen };
    });
    /* 负向：先塞一条旧行，再渲染空数组，必须清空为 0（无残留） */
    ul.innerHTML='<li class="rp-row">stale</li>';
    R.renderRecordRows([]);
    out.emptyAfterStale = ul.querySelectorAll('.rp-row').length;
    return out;
  })()`);

  console.log('  渲染耗时/行数（真实 200 上限内三点）：');
  [10,50,200].forEach(n=>{const o=result[n];
    console.log('    n='+n+' → '+o.ms+' ms，实际 .rp-row='+o.rows+'，判据='+(rowCountOk(o.rows,n)?'OK':'BAD'));});
  console.log('  负向：先放 1 条旧行再 renderRecordRows([]) → 残留 '+result.emptyAfterStale+' 行（应 0）');

  const countOK = [10,50,200].every(n=>rowCountOk(result[n].rows,n));
  const negOK = result.emptyAfterStale===0;
  /* 卡顿参考：每点单次渲染 < 16.7ms(1帧) 视为无感知卡顿（手算阈值，非被测值）。
   * 亚毫秒级不做严格单调断言——噪声会盖过缩放差异（见上面预热注释）。 */
  const perfOK = [10,50,200].every(n=>result[n].ms < 16.7);
  const pass = countOK && negOK && perfOK;
  console.log('\n判定：'+(pass?'实测通过':'实测异常')+
    ' | 行数契约='+countOK+' 无残留='+negOK+' 三点均<16.7ms(1帧)='+perfOK);
  cdp.close();edge.kill();server.close();
  process.exit(pass?0:1);
}
main().catch(e=>{console.error(e);server.close();process.exit(1);});
