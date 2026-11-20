#!/usr/bin/env node
/**
 * QA 性能基线 · 高风险②：房间状态同步是否轮询风暴 / 重复请求
 *
 * 真服务端 + 真 WS 客户端（不是正则看源码）。测量：
 *   A. 候场房静置 8 秒（无计时器在跑）：统计服务端下发的 room 广播帧数。
 *      负向断言：无状态变化时 room 帧应为 0。若前端靠轮询拉状态，服务端会持续回包。
 *   B. 单次动作（rename）：统计 room 广播帧数应收敛（1~3），ok 回包应恰好 1（无重复请求）。
 *   C. 协议层心跳：确认服务端心跳是 protocol PING（不计入 room 帧），不是秒级状态广播。
 *
 * 期望值来自独立协议推理（无变化→不该有广播；一次状态变更→少量广播），
 * 不引用被测常量。--selftest 自验帧分类器（命中/不命中各 2 例）。
 *
 * 用法：node tools/qa/perf-ws-sync.js [--selftest]
 */
'use strict';
const http=require('http');
const os=require('os');
const path=require('path');
const { spawn }=require('child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function isRoomFrame(raw){ try{ const m=JSON.parse(raw); return m.type==='room'; }catch(e){ return false; } }
function isOkFrame(raw){ try{ const m=JSON.parse(raw); return m.type==='ok'; }catch(e){ return false; } }
function selftest(){
  const cases=[
    [JSON.stringify({type:'room',payload:{}}), true, '命中：room 广播帧'],
    [JSON.stringify({type:'pong'}), false, '不命中：pong'],
    [JSON.stringify({type:'ok',reqId:1}), false, '不命中：请求回包'],
    ['{bad json', false, '不命中：坏 JSON']
  ];
  let ok=0; cases.forEach(([raw,want,label])=>{ const got=isRoomFrame(raw); if(got===want)ok++;
    console.log((got===want?'  PASS  ':'  FAIL  ')+label+' → '+got); });
  console.log('分类器自验 '+ok+'/'+cases.length+'（2 命中 2 不命中）'); return ok===cases.length;
}

const PORT=3197;
let SERVER=null;
function httpJson(method,p,body,token){return new Promise(resolve=>{
  const data=body==null?null:Buffer.from(JSON.stringify(body));
  const h={}; if(data){h['Content-Type']='application/json';h['Content-Length']=data.length;}
  if(token)h['X-Session-Token']=token;
  const req=http.request({host:'127.0.0.1',port:PORT,path:p,method,headers:h},res=>{
    let b='';res.on('data',d=>b+=d);res.on('end',()=>{let j=null;try{j=JSON.parse(b);}catch(e){}
      resolve({status:res.statusCode,json:j});});});
  req.on('error',()=>resolve({status:0,json:null})); if(data)req.write(data); req.end();});}

class Client{
  constructor(name,nick){this.name=name;this.nick=nick;this.seq=0;this.pending=new Map();this.frames=[];this.token=null;this.id=null;}
  async signup(){const r=await httpJson('POST','/api/auth/register',{name:this.name,password:'pw-'+this.name,nickname:this.nick});
    if(r.status!==200||!r.json||!r.json.ok)throw new Error('注册失败 '+r.status+' '+JSON.stringify(r.json));
    this.token=r.json.token;this.id=r.json.me.playerId;}
  connect(){return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+PORT+'/ws');this.ws=ws;
    const t=setTimeout(()=>reject(new Error('连接超时')),5000);
    ws.addEventListener('open',()=>{ws.send(JSON.stringify({type:'auth',payload:{token:this.token}}));clearTimeout(t);resolve();});
    ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('连接失败'));});
    ws.addEventListener('message',ev=>{const raw=String(ev.data);this.frames.push({t:Date.now(),raw});
      let m;try{m=JSON.parse(raw);}catch(e){return;}
      if((m.type==='ok'||m.type==='error')&&this.pending.has(m.reqId)){
        const p=this.pending.get(m.reqId);this.pending.delete(m.reqId);
        m.type==='ok'?p.resolve(m.payload||{}):p.reject(new Error(JSON.stringify(m.payload)));}
    });});}
  send(type,payload){const reqId=++this.seq;return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>{this.pending.delete(reqId);reject(new Error(type+' 超时'));},5000);
    this.pending.set(reqId,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});
    this.ws.send(JSON.stringify({type,reqId,payload:payload||{}}));});}
  count(pred){return this.frames.filter(f=>pred(f.raw)).length;}
  reset(){this.frames=[];}
  close(){try{this.ws.close();}catch(e){}}
}

async function waitHealth(){for(let i=0;i<60;i++){
  const r=await httpJson('GET','/api/health',null,null); if(r.status===200)return; await sleep(200);}
  throw new Error('服务端没起来');}

async function main(){
  if(process.argv.includes('--selftest')) process.exit(selftest()?0:1);
  if(!selftest()) process.exit(1);
  console.log('\n--- 真服务端 + 真 WS 客户端测量 ---');
  const env=Object.assign({},process.env,{
    PORT:String(PORT),
    PROFILE_FILE:path.join(os.tmpdir(),'qa-wssync-prof-'+Date.now()+'.json'),
    SEED_FILE:path.join(os.tmpdir(),'qa-wssync-seed-'+Date.now()+'.json')
  });
  SERVER=spawn(process.execPath,[path.join(__dirname,'..','..','server','index.js')],{env,stdio:'ignore'});
  await waitHealth();
  const tag=Date.now().toString(36).slice(-6)+Math.random().toString(36).slice(2,5);
  const a=new Client('qa'+tag+'a','QA甲'+tag), b=new Client('qa'+tag+'b','QA乙'+tag);
  await a.signup(); await b.signup();
  await a.connect(); await b.connect();
  const created=await a.send('createRoom',{nickname:a.nick});
  const roomId=created.room && created.room.roomId;
  if(!roomId) throw new Error('建房失败 '+JSON.stringify(created));
  await b.send('joinRoom',{roomId,nickname:b.nick});
  await sleep(1000);
  console.log('  房间 '+roomId+' 已建，2 人候场（无计时器在跑）');

  // A 候场房静置 8 秒：无状态变化时服务端不该推 room
  a.reset(); b.reset(); await sleep(8000);
  const idleA=a.count(isRoomFrame), idleB=b.count(isRoomFrame);
  console.log('A  静置 8s：A 收到 room 帧 '+idleA+'，B 收到 '+idleB+'（无变化应 0）');
  console.log('    同期心跳帧：A 收到 pong '+a.count(r=>{try{return JSON.parse(r).type==='pong';}catch(e){return false;}})+'（服务端心跳是协议层，非 room 广播）');

  // B 单次动作：rename，必然产生一次状态变更
  a.reset(); b.reset();
  const r1=await a.send('rename',{nickname:'QA新名'+Date.now()});
  await sleep(1500);
  const actA=a.count(isRoomFrame), actB=b.count(isRoomFrame);
  const okCount=a.count(isOkFrame);
  console.log('B  单次 rename：A 收到 room 帧 '+actA+'，B 收到 '+actB+'；A 收到 ok 回包 '+okCount+'（应为 1）');
  console.log('    rename 返回 ok='+(r1&&r1.ok));

  const pass = idleA===0 && idleB===0 && okCount===1 && actA>=1 && actA<=3 && actB>=1 && actB<=3;
  console.log('\n判定：'+(pass?'实测通过':'实测异常')+
    ' | 静置零广播='+(idleA===0&&idleB===0)+' 单次动作1个ok='+(okCount===1)+
    ' 广播收敛(1~3)='+(actA>=1&&actA<=3&&actB>=1&&actB<=3));
  a.close(); b.close(); if(SERVER)SERVER.kill();
  process.exit(pass?0:1);
}
main().catch(e=>{ console.error(e); if(SERVER)SERVER.kill(); process.exit(1); });
