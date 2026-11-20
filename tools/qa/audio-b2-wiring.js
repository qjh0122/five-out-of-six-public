/**
 * QA 独立验收工具：音效 B2 手势解锁修法 + 事件接线（2026-11-20）
 *
 * 补的是 pwa/test/audio.test.js 的盲区（audio-redesign-spec §1.1 第 4 条）：
 * 那个测试的假 Audio.play() 永远 Promise.resolve()，测不到「首次 play 被拒」的路径，
 * 因此全绿也证明不了 B2 修法有效。这里用**可配置拒绝 BGM** 的假 Audio + 假 document +
 * 假 AudioContext（初始 suspended）跑真实 sfx.js（vm 沙箱，不是复制逻辑），逐条验 B2 修法 5 步。
 *
 * 跑法：node tools/qa/audio-b2-wiring.js
 * 通过输出 PASS 行、失败输出 FAIL 行并以 exit 1 结束。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'sfx.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}
function microtaskFlush() { return new Promise((r) => setTimeout(r, 0)); }

/* ---------- 判定器自验：先证明工具本身不瞎（3 个已知答案，含命中与不命中） ---------- */
function firstPlayBeforeFlush(trace) {
  const firstPlay = trace.findIndex((e) => e === 'bgm:play');
  const firstFlush = trace.findIndex((e) => e === 'flush');
  if (firstPlay < 0) return false;
  if (firstFlush < 0) return true;
  return firstPlay < firstFlush;
}
const selfCases = [
  { t: ['bgm:play', 'flush'], want: true },
  { t: ['ctx:resume', 'bgm:play', 'flush'], want: true },
  { t: ['flush', 'bgm:play'], want: false }
];

/* ---------- 沙箱 ---------- */
function boot(opts) {
  opts = opts || {};
  const trace = [];
  const docListeners = { touchstart: [], mousedown: [] };
  const doc = {
    addEventListener: function (type, fn) { (docListeners[type] || (docListeners[type] = [])).push(fn); },
    removeEventListener: function (type, fn) {
      const arr = docListeners[type] || [];
      const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
    }
  };
  const timers = [];
  let bgmRejectRemaining = opts.rejectBgmFirst || 0;  // 只拒绝 BGM 的前 N 次 play
  let bgmPlayOrdinal = 0;
  function FakeAudio(src) {
    this.src = src; this.loop = false; this.muted = false; this.volume = 1;
    this.currentTime = 0; this.playbackRate = 1; this.playing = false;
    const self = this;
    const isBgm = src.indexOf('bgm') >= 0;
    this.play = function () {
      if (isBgm) {
        bgmPlayOrdinal++;
        trace.push('bgm:play');
        if (bgmPlayOrdinal <= bgmRejectRemaining) {
          trace.push('bgm:reject');
          return Promise.reject(new Error('NotAllowedError'));
        }
      }
      self.playing = true; trace.push('play:ok');
      return Promise.resolve();
    };
    this.pause = function () { self.playing = false; };
    this.addEventListener = function () {};
  }
  function FakeAC() {
    this.state = 'suspended'; this.currentTime = 0; this.destination = {};  // 初始 suspended，逼出 resume
    const self = this;
    this.resume = function () { trace.push('ctx:resume'); self.state = 'running'; return Promise.resolve(); };
    this.createOscillator = function () {
      return { type: 'sine', frequency: {
        setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {}
      }, connect: function () {}, start: function () { trace.push('osc:start'); }, stop: function () {} };
    };
    this.createGain = function () {
      return { gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} },
        connect: function () {} };
    };
  }
  const store = { data: {}, getItem(k) { return k in this.data ? this.data[k] : null; },
    setItem(k, v) { this.data[k] = String(v); }, removeItem(k) { delete this.data[k]; } };
  const sandbox = {
    Audio: FakeAudio, AudioContext: FakeAC, document: doc, localStorage: store,
    Math: Math, Promise: Promise, console: console,
    setTimeout: function (fn) { timers.push(fn); return timers.length; },
    clearTimeout: function () {}
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sfx.js' });
  return {
    Sfx: sandbox.Sfx, trace: trace, docListeners: docListeners,
    flush: function () { while (timers.length) { trace.push('flush'); timers.shift()(); } },
    fireGesture: function (type) { (docListeners[type] || []).slice().forEach((fn) => fn()); }
  };
}

async function main() {
  console.log('\n[0] 判定器自验（3 已知样本：2 命中 1 不命中）');
  let stPass = 0;
  selfCases.forEach((c) => {
    const got = firstPlayBeforeFlush(c.t);
    ok(got === c.want, '自验 ' + JSON.stringify(c.t) + ' → ' + c.want, { got });
    if (got === c.want) stPass++;
  });
  if (stPass !== selfCases.length) {
    console.log('判定器自验未全过，本工具只能当线索，不作为结论依据。');
    process.exit(2);
  }

  console.log('\n[1] B2 修法逐条（拒绝型假 Audio）');
  {
    const a = boot({});
    a.Sfx.unlock();
    ok(firstPlayBeforeFlush(a.trace), '★ 首次 BGM play 在同步手势栈内（未 flush 就已 play）', a.trace);
    ok(a.Sfx.diagnostics().bgmMuted === true, '★ 首次 play 时 BGM 仍 muted（Promise 完成前不取消静音）', a.Sfx.diagnostics());
    await microtaskFlush();
    ok(a.Sfx.diagnostics().bgmMuted === false, '★ play() fulfilled 后 BGM 取消静音');
    ok(a.trace.indexOf('ctx:resume') >= 0, '★ 手势栈内 ensureCtx/resume（synth 兜底首播不 suspended）');
  }
  {
    const a = boot({ rejectBgmFirst: 1 });
    a.Sfx.unlock();
    await microtaskFlush();
    ok(a.docListeners.touchstart.length >= 1 && a.docListeners.mousedown.length >= 1,
      '★ 首次 BGM play 被拒后，touchstart + mousedown 重试监听已挂',
      { ts: a.docListeners.touchstart.length, md: a.docListeners.mousedown.length });
    const d = a.Sfx.diagnostics();
    ok(d.retryArmed === true && d.retryCount >= 1, 'diagnostics 报告 retryArmed/retryCount', d);
    const playsBefore = a.trace.filter((x) => x === 'bgm:play').length;
    ok(a.Sfx.isUnlocked() === true, '前提：unlocked 已置位');
    a.fireGesture('touchstart');
    const playsAfter = a.trace.filter((x) => x === 'bgm:play').length;
    ok(playsAfter === playsBefore + 1,
      '★ 下次手势真的重新 play 了 BGM（unlocked 没挡住重试）', { playsBefore, playsAfter, trace: a.trace });
  }

  console.log('\n[2] 事件 synth 覆盖与 error 参数');
  {
    const a = boot({});
    const map = a.Sfx.audioMap();
    const names = Object.keys(map);
    ok(names.length >= 20, 'SYNTH_SPECS 条目数 ≥20（实测 ' + names.length + '）', names);
    const need = ['error','lose','countdown_tick','countdown_go','split_tick','split_timeout',
      'peer_submit','room_enter','room_leave','ready','veto','spectator','emoji_receive',
      'achievement','champion_fanfare','emoji_send','hint_guide'];
    const missing = need.filter((n) => !map[n]);
    ok(missing.length === 0, '★ 16 个新事件全有确定 synth（无一落 default）', { missing });
    const err = map.error && map.error.spec;
    ok(err && err.freq === 520 && err.type === 'triangle' && err.gain === 0.22,
      '★ error = 520Hz triangle / gain 0.22（非旧 200Hz sawtooth）', err);
    ok(!map.error.asset, 'error 无 mp3 资产（走 synth 兜底，符合规格）');
  }

  console.log('\n[3] 3 个事件触发 → play 真的落地（含 synth osc）');
  {
    ['achievement', 'split_timeout', 'emoji_receive'].forEach(function (name) {
      const a = boot({});
      a.Sfx.unlock();
      const oscBefore = a.trace.filter((x) => x === 'osc:start').length;
      a.Sfx.play(name);
      const oscAfter = a.trace.filter((x) => x === 'osc:start').length;
      ok(oscAfter === oscBefore + 1, name + ' 触发时 play() 真被调用并产生 synth osc',
        { oscBefore, oscAfter });
    });
  }

  console.log('\n[4] 调用点在真实触发路径（静态源码核对）');
  {
    const gameSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'game.js'), 'utf8');
    const achSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'achievementsView.js'), 'utf8');
    function body(src, name) {
      const s = src.indexOf('function ' + name + '(');
      if (s < 0) return '';
      const e = src.indexOf('\n  }', s);
      return e < 0 ? '' : src.slice(s, e);
    }
    ok(/Sfx\.play\('split_timeout'\)/.test(body(gameSrc, 'tickSplitTimer')),
      'split_timeout 在 tickSplitTimer 函数体内');
    ok(/Sfx\.play\(txt === '开始' \? 'countdown_go' : 'countdown_tick'/.test(body(gameSrc, 'playCountdown')),
      'countdown_tick/ go 在 playCountdown 函数体内');
    ok(/function announceUnlock[\s\S]{0,300}Sfx\.play\('achievement'\)/.test(achSrc)
      && /announceUnlock:\s*announceUnlock/.test(achSrc),
      'achievement 在 announceUnlock 体内且该函数被 return 导出');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(3); });
