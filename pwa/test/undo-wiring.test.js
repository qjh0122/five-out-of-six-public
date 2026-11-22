/**
 * 「5 秒内可以反悔」条的接线（v136）
 *
 * `undo-bar.test.js` 证明的是**这个组件自己**对不对；
 * 这个文件证明的是**它真的被接上了**。
 *
 * 为什么必须分开：撤销条有一条"拿不到就退回立刻清除"的兜底（`if (!undoBar) doClear()`），
 * 这条兜底是给旧缓存用的，但它同时意味着 —— **接线断了不会报错**。
 * 忘了把 `undoBar` 传进 recordsView、或者 DOM 换 id 了没跟着改，
 * 表现都是"功能静悄悄地没了，数据还是照删"，而所有单测依然全绿。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RECORDS = read('js/recordsView.js');
const GAME = read('js/game.js');
const HTML = read('index.html');
const SW = read('sw.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass++;
  else fail++;
  ASSERT.log(ok, cond, name, extra);
}
function head(t) { console.log('\n' + t); }

head('[1] DOM 三个 id 都在（少一个 show() 就会走 no-dom 兜底）');
{
  ok(/id="undo-bar"/.test(HTML), '#undo-bar 存在');
  ok(/id="undo-msg"/.test(HTML), '#undo-msg 存在');
  ok(/id="undo-act"/.test(HTML), '#undo-act 存在');
  /* 结构：按钮必须在 bar 里面，否则 CSS 的 pointer-events 规则（容器 none / 按钮 auto）
   * 会让按钮也跟着穿透，点不动。 */
  const bar = /<div id="undo-bar"[\s\S]*?<\/div>/.exec(HTML);
  ok(!!bar && /id="undo-act"/.test(bar[0]), '★ #undo-act 在 #undo-bar 里面（否则点不动）');
  ok(/role="status"/.test(bar ? bar[0] : ''), '★ 带 role="status"（读屏会念出来，而不是静默执行）');
}

head('[2] 脚本顺序与离线缓存');
{
  const iUndo = HTML.indexOf('js/undoBar.js');
  const iRecords = HTML.indexOf('js/recordsView.js');
  /* 必须找 `<script src=` 那一次：head 里还有 `<link rel="preload" href="./js/game.js">`，
   * 用裸 indexOf 会命中预加载那行（在最前面），于是"顺序对不对"永远判成对。
   * 这条是写测试时真踩到的 —— 第一版就是绿的，但绿得毫无意义。 */
  const iGame = HTML.indexOf('<script src="./js/game.js');
  ok(iUndo > 0, 'index.html 引了 undoBar.js');
  ok(iUndo < iRecords, '★ undoBar 在 recordsView 之前加载（recordsView 只在 create 时取值）');
  ok(iGame > 0 && iUndo < iGame, '★ undoBar 在 game.js 的 script 标签之前加载', 'undo@' + iUndo + ' game@' + iGame);
  ok(/'\/js\/undoBar\.js'/.test(SW), '★★ 进了 sw 预缓存（否则离线时第二次打开就没有这个文件）');
}

head('[3] game.js：单例 + 三个接线点');
{
  ok(/var UndoBar = .*LXW\.undoBar/.test(GAME), '创建了单例 UndoBar');
  ok(/undoBar:\s*UndoBar/.test(GAME), '★★ 传进了 recordsView（不传的话会静默退回"立刻清除"）');
  ok(/#undo-act'\)\.addEventListener\('click'/.test(GAME), '★★ 「撤销」按钮绑了点击');
  ok(/UndoBar\.undo\(\)/.test(GAME), '点击调的是 undo()');
  ok(/UndoBar\.flush\('navigate'\)/.test(GAME), '★ showScreen 里会结账（离开战绩页不等于撤销）');
  /* 位置：showScreen 里那句必须在设置 state.screen 之前读 id —— 这里只断言它存在且带条件，
   * 具体顺序由人看代码；写成"必须先于 X"会因为格式化而假红。 */
  const ss = /function showScreen\(id\)\s*\{([\s\S]{0,400}?)\n\s*\/\* 首屏防闪/.exec(GAME);
  ok(!!ss && /UndoBar\.flush/.test(ss[1]), '★★ flush 在 showScreen 开头（换屏即结账）');
}

head('[4] recordsView：延迟执行，而不是先删再回滚');
{
  ok(/var undoBar = deps\.undoBar/.test(RECORDS), '从 deps 取 undoBar');
  ok(/undoBar\.show\(/.test(RECORDS), '调了 show()');
  ok(/seconds:\s*5/.test(RECORDS), '★ 窗口是 5 秒');
  ok(/onUndo:/.test(RECORDS) && /onCommit:/.test(RECORDS), 'onUndo / onCommit 都给了');
  /* 关键顺序：确认之后**不能**直接删。删的动作必须只在 doClear 里，
   * 而 doClear 只能从"没有条子"或 onCommit 里被调用。 */
  const body = /function onClearConfirmed\(\)\s*\{([\s\S]*?)\n  \}/.exec(RECORDS);
  ok(!!body, '找到 onClearConfirmed');
  const b = body ? body[1] : '';
  ok(/function doClear\(/.test(b), '★ 真正的删除被收进 doClear()');
  /* 条件多了一条「或拿不到文案表」：旧缓存里没有 recordsState.js 时也走立刻清 ——
   * 少一个提示 ≠ 取消这个动作。断言只钉住"退回立刻清"这个结果。 */
  ok(/if \(!undoBar[^{]*\{ doClear\('no-bar'\); return; \}/.test(b), '★ 没有条子时退回立刻清（不静默丢弃）');
  ok(/onCommit: function \(reason\) \{[\s\S]*?doClear\(reason\);/.test(b), '★★ onCommit 里才真的清');
  /* 抄近路的写法：确认后直接 Records.clear() / resetMyStats()，那样 5 秒窗口等于不存在。
   * 注意 doClear 的**函数定义**本身也含这两句 —— 它本来就该含，所以先把整段定义抠掉再看。
   * （第一版没抠，断言恒红；这是"断言写法比断言内容更容易错"的又一个例子。） */
  const stripped = stripFn(b, 'doClear');
  const beforeShow = stripped.split('undoBar.show(')[0];
  ok(!/Records\.clear\(/.test(beforeShow), '★★ 调 show() 之前没有先删本机', beforeShow.slice(-120));
  ok(!/resetMyStats\(/.test(beforeShow), '★★ 调 show() 之前没有先清云端', beforeShow.slice(-120));
  ok(/doClear\('no-bar'\)/.test(beforeShow), '兜底那一句确实在 show() 之前（否则没条子时什么都不做）');
}

/** 把 `function NAME(...) { ... }` 整段（含嵌套花括号）从源码里删掉 */
function stripFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return src;
  let i = src.indexOf('{', at);
  if (i < 0) return src;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(0, at) + src.slice(i);
}

head('[5] CSS：容器点不穿、按钮点得到');
{
  const CSS = read('css/style.css');
  const barRule = /\.undo-bar \{([\s\S]*?)\n\}/.exec(CSS);
  ok(!!barRule, '找到 .undo-bar 规则');
  const r = barRule ? barRule[1] : '';
  ok(/pointer-events:\s*none/.test(r), '★ 容器 pointer-events:none（否则会挡住底下的内容）');
  const act = /\.undo-act \{([\s\S]*?)\n\}/.exec(CSS);
  ok(!!act && /pointer-events:\s*auto/.test(act[1]), '★★ 按钮 pointer-events:auto（否则整条都点不到）');
  ok(!!act && /min-height:\s*8[0-9]px/.test(act[1]), '★ 按钮够高（88 设计px ≈ 46 CSS px）');
}

head('[6] 离开房间改为直接退：UndoBar 只剩战绩清除一个调用方');
{
  /* 本轮用户要求去掉确认 + 撤销条：这边只证「onLeave 直接发 leaveRoom」，
   * 战绩清除那条调用链的断言在 [4]，仍必须全绿。 */
  const body = /function onLeave\(\) \{([\s\S]*?)\n  \}/.exec(GAME);
  ok(!!body, '找到 onLeave 函数体');
  const b = body ? body[1] : '';
  ok(!/askConfirm\(/.test(b), '★★ onLeave 不再走确认框');
  ok(!/UndoBar\.show\(/.test(b), '★★ onLeave 不再调 undoBar.show()（撤销条只剩战绩清除）');
  ok(/RoomStore\.leaveRoom\(/.test(b), '★★ 离开直接调 leaveRoom（同步路径，非延迟）');
  ok(/cleanupRoom\(\)/.test(b) && /showScreen\('screen-home'\)/.test(b), '三步都在 onLeave 内');
  /* M1：把 leaveRoom 调用点删掉就红 —— 不能只看「有 onLeave 函数」。 */
  ok(b.split('RoomStore.leaveRoom(').length - 1 === 1, '★★ leaveRoom 调用点恰好 1 次（删掉即红）');
  ok(/leaveInFlight/.test(b) && /if \(!restore\) return;/.test(b), '★ 连点双保险：在途标记 + pressBusy');
  ok(!/function leaveMustCommitNow|function doLeave\(|fetchRoomSnapshot/.test(GAME),
    '★ 离开撤销专属函数已从 game.js 移除');
  ok(!/UndoBar\.flush\('room-changed'\)/.test(GAME), '★ 不再有 room-changed 结账');
  ok(/UndoBar\.flush\('navigate'\)/.test(GAME), '★ 共享的 navigate 结账仍在（战绩清除）');
  ok((HTML.match(/id="undo-bar"/g) || []).length === 1, '★ 仍只有一个 #undo-bar（不新建第二个条子）');
  const UNDO = read('js/undoBar.js');
  ok(/function flush\(/.test(UNDO), '★ UndoBar.flush 本体仍在（实现不改）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
