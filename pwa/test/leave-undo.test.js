/**
 * 直接退 + 共享撤销条 + 首次进结算页策略引导
 *
 * 本轮改动：用户要求「取掉离开房间确认的步骤，离开就直接退就行了」——
 *   onLeave 不再有 confirm 弹窗、5 秒撤销条，也不再为确认文案走 fetchRoomSnapshot。
 * 撤销条本体**保留**：战绩清除（recordsView）还在用，组件状态机测试全部保留。
 * 策略引导（AC-NB-14～18 / §4.2）一字未改。
 *
 * 取证口径（规格 §0.3）：
 *   · 所有期望值**写死在本文件**，来自规格终值表 / 手算 / 本轮用户要求的终值；
 *     不 require 被测模块取期望值，不拿内部常量当期望。
 *   · 状态机用假 DOM + 假计时器实跑；接线用源码静态守卫；两者成对（反例 1 的处置）。
 *   · 真浏览器几何 / 录帧部分归 CI 探针（本轮不跑探针、不出截图，只落静态 + 状态机这一层）。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function jsSources() {
  return fs.readdirSync(path.join(ROOT, 'js'))
    .filter(function (f) { return /\.js$/.test(f); })
    .map(function (f) { return { name: f, src: read('js/' + f) }; });
}
function occurrences(hay, needle) {
  return hay.split(needle).length - 1;
}

var GAME = read('js/game.js');
var UNDO = read('js/undoBar.js');
var RECORDS = read('js/recordsView.js');
var ACCOUNT = read('js/accountView.js');
var STORAGE = read('js/storage.js');
var SETTLE = read('js/settleView.js');
var CSS = read('css/style.css');
var HTML = read('index.html');
var SOURCES = jsSources();
var ALL_JS = SOURCES.map(function (f) { return f.src; }).join('\n');
var createUndoBar = require('../js/undoBar.js');
var Store = require('../js/storage.js');

/* 独立期望值：全部来自规格终值表 / 手算 / 本轮删除目标，不引用任何被测常量。
 * MSG_* / IRREVOCABLE 这四句现在只用于**负向守卫**（必须已从 game.js 消失）。 */
var SPEC = {
  MSG_MID: '正在离开（5 秒内可撤销）· 对局中离开算弃局，其他人这局也会结束',
  MSG_IDLE: '正在离开房间（5 秒内可撤销）',
  UNDO_MSG: '已取消，你还在房间里',
  IRREVOCABLE: '房间状态已变化，已按最新状态离开，本次无法撤销',
  STRATEGY: '这 6 张牌两轮各拆一次：大牌别只放 1 张比大小，凑十点半、斗牛收分更多。',
  KEY: 'lxw_strategy_tip_seen_v1',
  KEY_NAME: 'STRATEGY_TIP_SEEN',
  GUIDE_KEY: 'lxw_guide_seen_v1',
  WINDOW_MS: 5000,        // §2.5「沿用 DEFAULT_MS，本批不调」（战绩清除仍在用）
  N_MS: 250,              // 与换屏动画同量级，且严格小于窗口的 1/10
  TIP_MIN: 28,            // §4.2 文案长度下界
  TIP_MAX: 36             // §4.2 文案长度上界
};

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass++;
  else fail++;
  ASSERT.log(ok, cond, name, extra);
}
function eq(a, b, name) {
  if (a === b) pass++;
  else fail++;
  ASSERT.log(eq, a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}
function head(t) { console.log('\n' + t); }

/* ---------------- 假 DOM / 假计时器（独立实现，不引用 undoBar 内部状态） ---------------- */
function fakeEl(cls) {
  var set = {};
  (cls || '').split(' ').forEach(function (c) { if (c) set[c] = true; });
  return {
    textContent: '',
    listeners: {},
    classList: {
      add: function (c) { set[c] = true; },
      remove: function (c) { delete set[c]; },
      contains: function (c) { return !!set[c]; }
    },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); }
  };
}
function fakeDoc(withBar) {
  var nodes = {};
  if (withBar) {
    nodes['undo-bar'] = fakeEl('undo-bar hidden');
    nodes['undo-msg'] = fakeEl('');
    nodes['undo-act'] = fakeEl('');
  }
  var doc = {
    visibilityState: 'visible',
    listeners: {},
    nodes: nodes,
    getElementById: function (id) { return nodes[id] || null; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); }
  };
  return doc;
}
function fakeTimers() {
  var seq = 0, live = {};
  return {
    set: function (fn) { seq += 1; live[seq] = fn; return seq; },
    clear: function (id) { delete live[id]; },
    count: function () { return Object.keys(live).length; },
    fireAll: function () {
      var ids = Object.keys(live);
      ids.forEach(function (i) { var f = live[i]; delete live[i]; if (f) f(); });
    }
  };
}
function makeBar(withBar) {
  var doc = fakeDoc(withBar !== false);
  var timers = fakeTimers();
  var bar = createUndoBar({ doc: doc, timers: timers, duration: SPEC.WINDOW_MS });
  return { doc: doc, timers: timers, bar: bar };
}
/** 独立 spy：onCommit 里才真的调「目标动作」。本轮离开不再走撤销条，
 *  这里只验 UndoBar 组件自身的延迟执行语义（战绩清除仍是这个用法），
 *  不再代表离开房间的接线。 */
function wireDeferredSpy(bar, spy) {
  return bar.show({
    msg: SPEC.MSG_IDLE,
    onUndo: function () { spy.undone += 1; },
    onCommit: function (reason) { spy.reasons.push(reason); spy.commits += 1; }
  });
}

/* =================== 组件状态机（战绩清除仍在使用，全部保留） =================== */
head('[C-1] 同一时刻只允许 1 个待撤销动作，旧的立刻提交');
{
  var t = makeBar(true);
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push('A:' + r); } });
  t.bar.show({ msg: 'B', onCommit: function (r) { log.push('B:' + r); } });
  eq(log.join(','), 'A:superseded', 'C-1 旧动作立刻结账（reason=superseded）');
  eq(t.bar.peek().msg, 'B', 'C-1 peek().msg 是后一次动作文案');
  eq(occurrences(log.join(','), 'superseded'), 1, 'C-1 superseded == 1');
  eq(occurrences(log.join(','), 'timeout'), 0, 'C-1 timeout == 0');
  eq(occurrences(log.join(','), 'hidden'), 0, 'C-1 hidden == 0');
  eq(occurrences(log.join(','), 'no-dom'), 0, 'C-1 no-dom == 0');
  eq(t.timers.count(), 1, 'C-1 只有一个计时器（旧的已 clear，被静默丢掉的动作数 == 0）');
}

head('[C-2] 页面转后台 / 关闭立即提交，且幂等');
{
  var t = makeBar(true);
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  t.doc.visibilityState = 'hidden';
  t.doc.fire('visibilitychange');
  eq(t.bar.flush('hidden'), false, 'C-2 第二个后台事件是空操作（幂等）');
  eq(log.length, 1, 'C-2 onCommit(hidden) 合计 == 1，不是 2');
  eq(log[0], 'hidden', 'C-2 reason == hidden');
  eq(t.bar.isPending(), false, 'C-2 状态机清空');
}

head('[C-3] 撤销条 DOM 缺失时动作照做');
{
  var t = makeBar(false);
  var log = [];
  var shown = t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  eq(shown, false, 'C-3 show() 返回 false');
  eq(log.join(','), 'no-dom', 'C-3 onCommit(no-dom) == 1（动作没被吞）');
  eq(t.timers.count(), 0, 'C-3 不留悬空计时器');
}

head('[C-4] 撤销后延迟动作提交次数 == 0（延迟执行的硬证据）');
{
  var t = makeBar(true);
  var spy = { commits: 0, undone: 0, reasons: [] };
  wireDeferredSpy(t.bar, spy);
  eq(t.bar.undo(), true, 'C-4 撤销成功');
  eq(spy.commits, 0, 'C-4 ★ 撤销后目标动作 == 0');
  eq(spy.reasons.length, 0, 'C-4 onCommit 调用数 == 0');
  eq(t.bar.isPending(), false, 'C-4 窗口结束后不再 pending');
}

head('[C-5] 到点 / flush 后目标动作 == 1（== 2 判红）');
{
  var t = makeBar(true);
  var spy = { commits: 0, undone: 0, reasons: [] };
  wireDeferredSpy(t.bar, spy);
  t.timers.fireAll();
  eq(spy.commits, 1, 'C-5 ★ 到点后目标动作 == 1');
  eq(spy.reasons.join(','), 'timeout', 'C-5 reason == timeout');
  t.timers.fireAll();
  eq(spy.commits, 1, 'C-5 重复到点不会变成 2（双提交次数 == 0）');

  var t2 = makeBar(true);
  var spy2 = { commits: 0, undone: 0, reasons: [] };
  wireDeferredSpy(t2.bar, spy2);
  eq(t2.bar.flush('navigate'), true, 'C-5 flush(navigate) 返回 true');
  eq(spy2.commits, 1, 'C-5 flush 后目标动作 == 1');
  eq(t2.bar.flush('navigate'), false, 'C-5 第二次 flush 是空操作');
  eq(spy2.commits, 1, 'C-5 flush 不产生第二次提交');
}

/* =================== 本轮：离开房间「直接退」契约 =================== */
var onLeaveBody = (/function onLeave\(\) \{([\s\S]*?)\n  \}/.exec(GAME) || [])[1] || '';

head('[D-1] onLeave 去掉确认框 / 撤销条 / 网络快照');
{
  ok(!!onLeaveBody, 'D-1 找到 onLeave 函数体');
  ok(/function onLeave\(\)/.test(GAME) && !/async function onLeave\(/.test(GAME),
    'D-1 onLeave 是同步函数（不再 await 网络核对）');
  ok(!/askConfirm\(/.test(onLeaveBody), 'D-1 ★ onLeave 内没有 confirm 弹窗');
  ok(!/UndoBar\.show\(/.test(onLeaveBody), 'D-1 ★ onLeave 内没有撤销条');
  ok(!/fetchRoomSnapshot\(/.test(GAME) && !/RoomStore\.peekRoom\(/.test(GAME),
    'D-1 ★ 网络快照核对已删（game.js 不再调 peekRoom）');
  ok(!/弃局离开？|确定要离开当前房间吗/.test(GAME),
    'D-1 离开专用 confirm 文案已删（其它 confirm 的文案不在此列）');
  eq(occurrences(onLeaveBody, 'RoomStore.leaveRoom('), 1, 'D-1 onLeave 内 leaveRoom 调用点 == 1');
  ok(/cleanupRoom\(\)/.test(onLeaveBody), 'D-1 cleanupRoom 在 onLeave 内');
  ok(/showScreen\('screen-home'\)/.test(onLeaveBody), 'D-1 showScreen 回首页在 onLeave 内');
}

head('[D-2] 反馈与连点：firstShown + pressBusy + 在途标记');
{
  ok(/firstShown\(\['btn-leave-spectator', 'btn-leave', 'btn-leave-game', 'btn-back-room'\]\)/.test(onLeaveBody),
    'D-2 四个离开入口仍按可见性选按钮');
  ok(/pressBusy\(btn, '离开中…'\)/.test(onLeaveBody),
    'D-2 忙碌文案改为「离开中…」（不再是「核对中…」）');
  ok(!/pressBusy\(btn, '核对中…'\)/.test(GAME), 'D-2 「核对中…」已删');
  ok(/if \(!restore\) return;/.test(onLeaveBody), 'D-2 pressBusy 自身的连点短路保留');
  eq(occurrences(GAME, 'var leaveInFlight = false;'), 1, 'D-2 ★ 在途标记只有一处定义');
  ok(/if \(!state\.roomId \|\| leaveInFlight\) return;/.test(onLeaveBody),
    'D-2 ★ 入口用 leaveInFlight 短路，连点只发一次 leaveRoom');
  ok(!/UndoBar\.isPending\(\)/.test(onLeaveBody), 'D-2 离开不再靠共享 UndoBar 做连点短路');
}

head('[D-3] 兜底：断网 / 房间已删仍回首页，专属符号全部移除');
{
  ok(/\.catch\(function \(\) \{\}\)/.test(onLeaveBody), 'D-3 ★ leaveRoom 失败被吞，不弹「离开失败」');
  ok(!/flashRoomError|alert\(/.test(onLeaveBody), 'D-3 onLeave 不刷错误弹窗');
  ok(/reportBug\('onLeave', e\)/.test(onLeaveBody), 'D-3 同步抛仍上报');
  eq(occurrences(onLeaveBody, 'showScreen(\'screen-home\')'), 1,
    'D-3 回首页动作集中在 finish() 一处（两条路径共用，不会写两遍）');
  ok(/\.then\(finish\)/.test(onLeaveBody) && /reportBug\('onLeave', e\);\s*finish\(\);/.test(onLeaveBody),
    'D-3 成功 / 同步抛两条路径都调用 finish()');
  /* 四句文案 + 所有撤销专属状态/函数必须从 game.js 彻底消失 */
  var GONE = [
    'LEAVE_MSG_MID', 'LEAVE_MSG_IDLE', 'LEAVE_UNDO_MSG', 'LEAVE_IRREVOCABLE',
    'leaveConfirmSnap', 'lastRoomMeta', 'setLeaveOrigin', 'anchorLeaveBarOnSettle',
    'leaveMustCommitNow', 'markLeaveIrrevocable', 'fetchRoomSnapshot',
    'lastScreenId', 'function doLeave(', 'data-undo-origin'
  ];
  GONE.forEach(function (sym) {
    eq(occurrences(GAME, sym), 0, 'D-3 ★ 已移除专属符号 ' + sym);
  });
  [SPEC.MSG_MID, SPEC.MSG_IDLE, SPEC.UNDO_MSG, SPEC.IRREVOCABLE].forEach(function (s, i) {
    eq(occurrences(GAME, s), 0, 'D-3 ★ 离开撤销文案 ' + (i + 1) + ' 已从 game.js 消失');
  });
  ok(!/\[data-undo-origin="leave"\]/.test(CSS), 'D-3 CSS 里离开专属锚点规则已删（战绩条锚点不变）');
  eq(occurrences(HTML, 'id="undo-bar"'), 1, 'D-3 仍只有一个 #undo-bar（没新建、也没删共享节点）');
}

head('[D-4] 共享代码保留：UndoBar 给战绩清除、askConfirm 给退出登录/删号');
{
  ok(/var UndoBar = .*LXW\.undoBar/.test(GAME), 'D-4 UndoBar 单例仍在（共享组件不删）');
  ok(/undoBar:\s*UndoBar/.test(GAME), 'D-4 仍注入 recordsView');
  ok(/UndoBar\.flush\('navigate'\)/.test(GAME), 'D-4 showScreen 仍会结账（战绩清除）');
  ok(/#undo-act'\)\.addEventListener\('click'/.test(GAME) && /UndoBar\.undo\(\)/.test(GAME),
    'D-4 「撤销」按钮仍绑 UndoBar.undo()');
  ok(/undoBar\.show\(/.test(RECORDS) && /onCommit:/.test(RECORDS),
    'D-4 战绩清除仍走 undoBar.show + onCommit');
  ok(/function askConfirm\(/.test(GAME), 'D-4 askConfirm 本体仍在');
  ok(/askConfirm\(/.test(ACCOUNT), 'D-4 退出登录 / 删号的 confirm 仍可用');
  ok(/askConfirm\(/.test(GAME.replace(onLeaveBody, '')), 'D-4 游戏内其它 confirm（不等了等）仍可用');
}

/* =================== AC-NB-14 ～ 18：策略引导（本轮未改） =================== */
function memBacking() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    key: function (i) { return Object.keys(m)[i] || null; },
    get length() { return Object.keys(m).length; },
    _raw: m
  };
}
/** 独立实现「按设备一次」：读键 → 显示即写 → 之后不再显示 */
function displayOnce(store) {
  if (store.read(SPEC.KEY, '', 'local')) return 0;
  store.write(SPEC.KEY, '1', 'local');
  return 1;
}
var tipFns = (/var ST = deps\.Store[\s\S]*?function strategyTipLine\(room\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';
var tipTake = (/function takeStrategyTipOnce\(\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';
var tipLine = (/function strategyTipLine\(room\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';

head('[AC-NB-14] 只出现一次，且键归属 ≠ 规则弹窗键');
{
  ok(new RegExp(SPEC.KEY_NAME + ": '" + SPEC.KEY + "'").test(STORAGE), 'AC-NB-14 新键只注册在 ST.KEYS');
  eq(occurrences(ALL_JS, "'" + SPEC.KEY + "'"), 1, 'AC-NB-14 物理键字面量在 pwa/js 源码中只出现 1 处');
  eq(occurrences(ALL_JS, SPEC.STRATEGY), 1, 'AC-NB-14 文案文本只写进 1 个源码文件');
  ok(SPEC.KEY !== SPEC.GUIDE_KEY, 'AC-NB-14 策略标记 != lxw_guide_seen_v1（手算比对）');
  eq(occurrences(SETTLE, SPEC.GUIDE_KEY), 0, 'AC-NB-14 settleView 不读写 GUIDE_SEEN 字面量');
  eq(occurrences(SETTLE, 'GUIDE_SEEN'), 0, 'AC-NB-14 settleView 不引用 GUIDE_SEEN');
  eq(occurrences(SETTLE, 'closeGuide'), 0, 'AC-NB-14 策略标记不由 closeGuide() 写入');
  ok(/ST\.read\(STRATEGY_TIP_KEY/.test(tipTake), 'AC-NB-14 显示前先读设备键');
  ok(/ST\.write\(STRATEGY_TIP_KEY/.test(tipTake), 'AC-NB-14 显示那一刻即写键');
  ok(tipTake.indexOf('ST.read(') < tipTake.indexOf('ST.write('), 'AC-NB-14 读在写之前（写失败不拦截显示）');

  var dev = Store.create(memBacking(), memBacking());
  var total = 0;
  for (var i = 0; i < 10; i++) total += displayOnce(dev);
  eq(total, 1, 'AC-NB-14 同一设备连续 10 次进结算页累计出现 1 次');
  eq(displayOnce(Store.create(memBacking(), memBacking())), 1, 'AC-NB-14 清本机存储（新设备）后再出现 1 次');
  eq(displayOnce(dev), 0, 'AC-NB-14 换局 / 回看上一局不再出现');
}

head('[AC-NB-15] 不遮挡：不新增节点 / 行高 / 按钮');
{
  ok(/if \(!line\)/.test(SETTLE) && /strategyTipLine\(room\)/.test(SETTLE), 'AC-NB-15 复用 #settle-wait 既有行');
  ok(/box\.textContent = line \|\| ''/.test(SETTLE), 'AC-NB-15 只写既有行的 textContent');
  /* N-2 改判：R11 原来要求「单行不换行、放不下就不显示」，实测 320 档整句排不下，
   * 于是那一档什么都看不到 —— 「给了但没给」换了个方向照样成立。
   * 现在允许换行：行数交给排版，但**必须**显式关掉省略号（`.settle-wait` 在
   * style.css 的 nowrap+ellipsis 那一组里），否则截断就是被否掉的那件事。 */
  ok(/box\.style\.whiteSpace = 'normal'/.test(SETTLE),
    'AC-NB-15 策略行允许换行（N-2 改判，不再单行硬压）');
  ok(/box\.style\.textOverflow = 'clip'/.test(SETTLE),
    'AC-NB-15 显式关掉省略号（整句照给，不截断）');
  eq(occurrences(SETTLE, 'textOverflow = \'ellipsis\''), 0,
    'AC-NB-15 策略行不再出现 ellipsis（负向）');
  eq(occurrences(SETTLE, 'role="dialog"'), 0, 'AC-NB-15 无第二个 [role=dialog]');
  eq(occurrences(SETTLE, "aria-modal"), 0, 'AC-NB-15 无新增弹窗');
  ok(!/el\('button'/.test(tipLine + tipTake), 'AC-NB-15 策略引导不新增按钮');
  ok(!/createElement\('div'/.test(tipLine + tipTake), 'AC-NB-15 策略引导不新增独立容器');
  /* 真浏览器 rect 相交 / checkVisibility 归 CI 探针，本轮不覆盖，不伪报 */
  ok(true, 'AC-NB-15 几何 rect 相交归 CI 探针（本轮未覆盖，如实留白）');
}

head('[AC-NB-16] 不改变结算数值');
{
  eq(occurrences(tipLine + tipTake, 'rp-net'), 0, 'AC-NB-16 策略引导不写 #rp-net');
  eq(occurrences(tipLine + tipTake, 'settle-net'), 0, 'AC-NB-16 策略引导不写 .settle-net');
  eq(occurrences(tipLine + tipTake, 'font-size'), 0, 'AC-NB-16 策略引导不改字号');
  ok(!/\d+\s*分/.test(SPEC.STRATEGY), 'AC-NB-16 文案不写具体分值（不形成第二个数值载体）');
}

head('[AC-NB-17] 关闭后不复发');
{
  eq(occurrences(tipLine, 'setTimeout'), 0, 'AC-NB-17 无自动消失计时器');
  eq(occurrences(tipLine, 'close'), 0, 'AC-NB-17 无关闭按钮 / 手动关动作');
  ok(/visit !== tipVisit/.test(tipLine), 'AC-NB-17 同一次访问内重绘常驻，换房 / 换局重新判定');
  var dev2 = Store.create(memBacking(), memBacking());
  var sum = displayOnce(dev2);
  for (var j = 0; j < 10; j++) sum += displayOnce(dev2);
  eq(sum, 1, 'AC-NB-17 关闭后连续重进 10 次，出现次数合计仍 == 1（复发 0）');
}

head('[AC-NB-18] 与 guide-modal 规则弹窗不重叠');
{
  eq(occurrences(SETTLE, 'guide-modal'), 0, 'AC-NB-18 结算页策略引导不碰 guide-modal');
  ok((HTML.match(/role="dialog"/g) || []).length >= 1, 'AC-NB-18 规则弹窗仍是既有的全屏 dialog');
  var guideTotal = /GUIDE_TOTAL\s*=\s*(\d+)/.exec(ALL_JS);
  ok(!guideTotal || Number(guideTotal[1]) === 4, 'AC-NB-18 GUIDE_TOTAL 仍为 4（未被加成第 5 步）');
  ok(/!state\.roomId/.test(GAME), 'AC-NB-18 规则弹窗自动弹条件仍是 !state.roomId，结算页天然互斥');
}

head('[§4.2 / §三] 终值与口径对齐');
{
  /* §4.2「28–36 字」按字数口径：不含空格与标点；终值文本本身逐字不改。 */
  var tipChars = SPEC.STRATEGY.replace(/[\s：，、。]/g, '').length;
  ok(tipChars >= SPEC.TIP_MIN && tipChars <= SPEC.TIP_MAX,
    '§4.2 文案字数在 28–36 区间（实测 ' + tipChars + ' 字，含数字）');
  eq(occurrences(SETTLE, SPEC.STRATEGY), 1, '§4.2 文案终值逐字落在 settleView.js 且只有一处');
  ok(/房主在等朋友进来，先不开牌/.test(SETTLE), '§三 结算页 HOLD 文案对齐到「房主」口径');
  ok(/房主/.test(SETTLE), '§三 结算页 HOLD 文案点名房主');
  ok(/等朋友/.test(SETTLE), '§三 与就位态共用「等朋友」语义（B1）');
  eq(occurrences(SETTLE, "el('span', 'hold-left'"), 1, '§三 .hold-left 仍只有一处（不新增载体）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
