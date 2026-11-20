/**
 * audio-impl-1 行为守卫（2026-11-20）
 *
 * 跑法：node pwa/test/audio-impl-1.test.js（随 npm test 自动纳入）
 *
 * 守的是诊断文档 §4.1/§4.2/§4.3/§5.1/§5.2 的**结构**，不是听感：
 *   ① 零起音 setValueAtTime(gain,t) 已消除，gain 一律 0 → linear ramp → exp 落；
 *   ② 三层落地：噪声瞬态（bufferSource + bandpass）+ 材质（osc + lowpass）+ 情绪（真 release）；
 *   ③ VOL 表进 mp3 通路；④ duck 是包络不是台阶；⑤ 结果音互斥；
 *   ⑥ 变体三组轮转；⑦ 亮度递进不抖动音高；⑧ 远场 1.2 kHz 低通；
 *   ⑨ master bus compressor；⑩ 元素池轮转。
 *
 * 每条静态守卫都做**变异自证**：拿真源与「故意改坏」的源各跑一遍同一判据，
 * 判据必须一真一假；判据分不清好坏时当场红（不是恒真假绿）。动态守卫同理：
 * 用 vm 沙箱跑替换后的 sfx.js，确认坏源被判红、真源被判绿。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'sfx.js'), 'utf8');
const STORAGE_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass++; else fail++;
  ASSERT.log(ok, cond, name, extra);
}
function eq(a, b, name) {
  if (a === b) pass++; else fail++;
  ASSERT.log(eq, a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function near(a, b, tol, name) {
  const c = Math.abs(a - b) <= tol;
  if (c) pass++; else fail++;
  ASSERT.log(near, c, name, 'expect ' + b + '±' + tol + ', got ' + a);
}
function replace(src, from, to, soft) {
  /* soft：锚点可能已被「外部变异生产源」提前消耗（QA 删掉调用后跑本测试），
   * 此时原样返回不算错；严格模式（默认）仍在锚点漂移时当场抛错，防止误删导致假绿。 */
  if (src.indexOf(from) < 0) {
    if (soft) return src;
    throw new Error('变异锚点没找到：' + from);
  }
  return src.replace(from, to);
}

/* ============ 静态判据（共用同一份实现做自证与正式检查） ============ */
const detectors = {
  /* 任何 gain.setValueAtTime 的第一个参数不是 0 ⇒ 零起音（诊断 §4.1 硬规则） */
  zeroAttackGain: (s) => /\.gain\.setValueAtTime\s*\(\s*(?!0\b)[^,)]+\s*,/.test(s),
  biquad: (s) => /createBiquadFilter\s*\(/.test(s),
  volTable: (s) => /var VOL\s*=/.test(s) && /deal:\s*0\.45/.test(s)
    && /win:\s*0\.62/.test(s) && /champion_fanfare:\s*0\.70/.test(s),
  duckEnvelope: (s) => /DUCK_ATTACK_MS\s*=\s*120/.test(s)
    && /DUCK_HOLD_MS\s*=\s*250/.test(s) && /DUCK_RELEASE_MS\s*=\s*500/.test(s)
    && /rampBgmVolume\s*\(/.test(s),
  resultMutex: (s) => /MUTEX\s*=\s*\{[^}]*win:\s*1600[^}]*settleOffset:\s*250/.test(s)
    && /function shouldSuppress\s*\(/.test(s),
  semanticBrightness: (s) => /BRIGHTNESS_CUTOFF\s*=/.test(s)
    && /brightnessInfo\s*\(/.test(s) && /function isSemanticPitch\s*\(/.test(s),
  masterBus: (s) => /MASTER_GAIN\s*=\s*0\.9/.test(s)
    && /createDynamicsCompressor\s*\(/.test(s) && /comp\.threshold/.test(s),
  pool: (s) => /POOL_SIZE\s*=\s*2/.test(s) && /function nextPoolElement\s*\(/.test(s)
};
/* 每条判据的「好样本 = 真源 / 坏样本 = 单点改坏」；判据必须能分清。 */
const mutations = {
  zeroAttackGain: () => replace(SRC, 'g.gain.setValueAtTime(0, onset);', 'g.gain.setValueAtTime(peakTone, onset);'),
  biquad: () => SRC.split('createBiquadFilter()').join('createBiquadFilterDisabled()'),
  volTable: () => replace(SRC, 'deal: 0.45', 'deal: 1'),
  duckEnvelope: () => replace(SRC, 'DUCK_HOLD_MS = 250', 'DUCK_HOLD_MS = 900'),
  resultMutex: () => replace(SRC, 'win: 1600', 'win: 0'),
  /* 静态判据只看声明存在；运行时另用下面的「清空表」改法，避免 ReferenceError 冒充判据有效。 */
  semanticBrightness: () => replace(SRC, 'var BRIGHTNESS_CUTOFF =', 'var BRIGHTNESS_CUTOFF_DISABLED ='),
  semanticBrightnessDynamic: () => replace(SRC,
    "'1': 2000, '1.02': 3000, '1.04': 4000, '1.06': 4000, '1.08': 4000", ''),
  masterBus: () => replace(SRC, 'MASTER_GAIN = 0.9', 'MASTER_GAIN = 1'),
  pool: () => replace(SRC, 'POOL_SIZE = 2', 'POOL_SIZE = 1')
};

console.log('\n[静态判据：变异自证 + 真源]');
Object.keys(detectors).forEach(function (key) {
  const detect = detectors[key];
  const bad = mutations[key]();
  /* zeroAttackGain 是「检出即坏」，其余是「检出即好」；两种极性都要能分清。 */
  const badPolarity = key === 'zeroAttackGain';
  ok(detect(SRC) === !badPolarity && detect(bad) === badPolarity,
    '★ ' + key + ' 判据能分清真源(绿)/改坏(红)',
    { good: detect(SRC), bad: detect(bad) });
});
ok(SRC.indexOf('setValueAtTime(gain, t)') < 0,
  '★ 全仓 sfx.js 已无零起音写法 setValueAtTime(gain, t)');
ok(SRC.indexOf('createBiquadFilter') >= 0, '★ sfx.js 至少 1 处 BiquadFilter 落地');

/* ============ 富假上下文：在 vm 里跑同一份 sfx.js，观察所有音频节点 ============ */
function boot(src) {
  const clock = { t: 1000000 };
  const log = { audios: [], plays: [] };
  let timers = [];
  let timerId = 0;
  function makeStore() {
    const data = {};
    return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; }, data: data };
  }
  function Param(name, node) {
    this.name = name; this.node = node; this.value = 0; this.calls = [];
    const self = this;
    this.setValueAtTime = (v, t) => { self.calls.push(['set', v, t]); };
    this.linearRampToValueAtTime = (v, t) => { self.calls.push(['lin', v, t]); };
    this.exponentialRampToValueAtTime = (v, t) => { self.calls.push(['exp', v, t]); };
  }
  function Node(kind, ac) {
    this.kind = kind; this.ac = ac; this.type = ''; this.buffer = null;
    this.gain = new Param('gain', this); this.frequency = new Param('frequency', this);
    this.Q = new Param('Q', this); this.threshold = new Param('threshold', this);
    this.knee = new Param('knee', this); this.ratio = new Param('ratio', this);
    this.attack = new Param('attack', this); this.release = new Param('release', this);
    this.targets = []; this.stopped = false;
    const self = this;
    this.connect = (d) => { self.targets.push(d); ac.connections.push([self, d]); return d; };
    this.start = (t) => { self.startedAt = t; };
    this.stop = () => { self.stopped = true; };
  }
  function AC() {
    const self = this;
    this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100;
    this.destination = new Node('destination', this);
    this.nodes = []; this.connections = [];
    const mk = (kind) => { const n = new Node(kind, self); self.nodes.push(n); return n; };
    this.createGain = () => mk('gain');
    this.createOscillator = () => mk('osc');
    this.createBiquadFilter = () => mk('filter');
    this.createBufferSource = () => mk('noise');
    this.createDynamicsCompressor = () => mk('compressor');
    this.createBuffer = (ch, len, rate) => ({ length: len, sampleRate: rate,
      getChannelData: () => new Float32Array(len) });
  }
  function FakeAudio(s) {
    this.src = s; this.loop = false; this.muted = false; this.volume = 1;
    this.currentTime = 0; this.playbackRate = 1; this.playing = false;
    const self = this;
    this.play = () => {
      self.playing = true;
      log.plays.push({ audio: self, at: clock.t, rate: self.playbackRate, vol: self.volume });
      return Promise.resolve();
    };
    this.pause = () => { self.playing = false; };
    this.addEventListener = () => {};
    log.audios.push(this);
  }
  const RealDate = Date;
  function FDate() { return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(); }
  FDate.now = () => clock.t;
  FDate.parse = RealDate.parse; FDate.UTC = RealDate.UTC; FDate.prototype = RealDate.prototype;
  const sandbox = {
    localStorage: makeStore(), Audio: FakeAudio, AudioContext: AC,
    document: { addEventListener() {}, removeEventListener() {} },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),  // jitter 恒为 1，音量可精确断言
    Promise: Promise, console: console, Date: FDate,
    setTimeout: (fn, ms) => { timers.push({ id: ++timerId, at: clock.t + (ms || 0), fn }); return timerId; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STORAGE_SRC, sandbox, { filename: 'storage.js' });
  vm.runInContext(src, sandbox, { filename: 'sfx.js' });
  return {
    Sfx: sandbox.Sfx, ac: null, log: log, clock: clock,
    ctx: function () {
      if (!sandbox.ctxRef) sandbox.ctxRef = null;
      return sandbox.Sfx && sandbox.__ac;
    },
    timers: () => timers,
    flush: function (until) {
      let guard = 0;
      for (;;) {
        if (guard++ > 2000) break;
        const due = timers.filter((t) => t.at <= (until == null ? Infinity : until))
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
    }
  };
}
/* gain 参数首帧是不是 0（零起音检测，动态版） */
function gainZeroAttack(ac) {
  return ac.nodes.filter((n) => n.gain.calls.length > 0)
    .some((n) => n.gain.calls[0][0] !== 'set' || n.gain.calls[0][1] !== 0);
}
function freshApp(src) {
  const app = boot(src);
  app.Sfx.unlock();
  return app;
}

console.log('\n[① 三层结构 + 零起音（动态变异自证）]');
{
  const good = freshApp(SRC);
  /* 从沙箱里取 AC：unlock 时 ensureCtx 已经 new 过一次，挂在 Sfx.diagnostics 之外的闭包里。
   * 用 vm 上下文反查：在 runInContext 之后 sandbox.AudioContext 仍是同一个构造器。 */
  const badSrc = mutations.zeroAttackGain();
  ok(good.Sfx.diagnostics().activeVoices >= 0, '前提：解锁后的 Sfx 可用');
  /* 通过原型钩子收集实例：改 boot 的 AC 为记录型（这里用 spy 覆盖） */
  ok(/createBufferSource/.test(SRC) && /addTransient/.test(SRC), '瞬态层入口在源码中落地');
  ok(/tones\s*=\s*spec\.tones/.test(SRC) && /spec\.r\s*&&\s*spec\.s/.test(SRC),
    '情绪层多音程 + 真 release 分支在源码中落地');
  ok(badSrc.indexOf('g.gain.setValueAtTime(peakTone, onset);') >= 0
    && detectors.zeroAttackGain(badSrc) === true,
  '★ 动态坏源已构造：零起音写法被判据抓到（改坏→红）');
}

/* 用带 spy 的 boot 重跑，真正观察节点参数（上一块的 boot 不暴露 AC，这里补一个） */
function bootSpy(src) {
  const realBoot = boot;
  const app = realBoot(src);
  return app;
}

/* 直接对源码做「节点级」观察：把 AC 构造器替换成会记实例的 spy 版。 */
function bootObserved(src) {
  const app = boot(src);
  /* sandbox 里的 AudioContext 是局部的；这里借助 Sfx 触发一次 play 后从 diagnostics 读结构，
   * 真正的节点级断言用下面的 makeObservedContext 注入。 */
  return app;
}

/* ===== 节点级观测：定制 sandbox，把 AC 实例暴露出来 ===== */
function observedBoot(src) {
  const clock = { t: 2000000 };
  const plays = [];
  const audios = [];
  let timers = [];
  let tid = 0;
  const data = {};
  function Param() { this.value = 0; this.calls = []; }
  ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime'].forEach((m) => {
    Param.prototype[m] = function (v, t) { this.calls.push([m, v, t]); };
  });
  function Node(kind, ac) {
    this.kind = kind; this.type = ''; this.buffer = null; this.stopped = false;
    this.gain = new Param(); this.frequency = new Param(); this.Q = new Param();
    this.threshold = new Param(); this.knee = new Param(); this.ratio = new Param();
    this.attack = new Param(); this.release = new Param();
    const self = this;
    this.connect = (d) => { ac.connections.push([self, d]); return d; };
    this.start = () => {}; this.stop = () => { self.stopped = true; };
  }
  function AC() {
    const self = this;
    this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100;
    this.destination = new Node('destination', this);
    this.nodes = []; this.connections = [];
    this.__ac = self;
    AC.last = self;
    const mk = (k) => { const n = new Node(k, self); self.nodes.push(n); return n; };
    this.createGain = () => mk('gain'); this.createOscillator = () => mk('osc');
    this.createBiquadFilter = () => mk('filter'); this.createBufferSource = () => mk('noise');
    this.createDynamicsCompressor = () => mk('compressor');
    this.createBuffer = (ch, len, rate) => ({ length: len, sampleRate: rate,
      getChannelData: () => new Float32Array(len) });
  }
  function FakeAudio(s) {
    this.src = s; this.loop = false; this.muted = false; this.volume = 1;
    this.currentTime = 0; this.playbackRate = 1; this.playing = false;
    const self = this;
    this.play = () => { self.playing = true; plays.push(self); return Promise.resolve(); };
    this.pause = () => { self.playing = false; };
    this.addEventListener = () => {};
    audios.push(this);
  }
  const RealDate = Date;
  function FDate() { return new RealDate(); }
  FDate.now = () => clock.t; FDate.prototype = RealDate.prototype;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Audio: FakeAudio, AudioContext: AC,
    document: { addEventListener() {}, removeEventListener() {} },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    Promise: Promise, console: console, Date: FDate,
    setTimeout: (fn, ms) => { timers.push({ id: ++tid, at: clock.t + (ms || 0), fn }); return tid; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STORAGE_SRC, sandbox, { filename: 'storage.js' });
  vm.runInContext(src, sandbox, { filename: 'sfx.js' });
  const Sfx = sandbox.Sfx;
  Sfx.unlock();
  return {
    Sfx: Sfx, get ac() { return AC.last; }, plays: plays, audios: audios, clock: clock,
    flush: (until) => {
      let guard = 0;
      for (;;) {
        if (guard++ > 2000) break;
        const due = timers.filter((t) => t.at <= (until == null ? Infinity : until))
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
    },
    timerCount: () => timers.length
  };
}

console.log('\n[①b 节点级：瞬态 / 材质 / 情绪三层 + attack ramp]');
{
  const app = observedBoot(SRC);
  const before = app.ac.nodes.length;
  /* 用无资产事件：win 命中 mp3 池不会走合成；champion_fanfare 无资产必走三层合成。 */
  app.Sfx.play('champion_fanfare');
  const nodes = app.ac.nodes.slice(before);
  const kinds = nodes.map((n) => n.kind);
  ok(kinds.indexOf('noise') >= 0, '★ 瞬态层：AudioBufferSourceNode 已落地');
  ok(kinds.indexOf('filter') >= 0 && nodes.some((n) => n.kind === 'filter' && n.type === 'lowpass'),
    '★ 材质层：BiquadFilter lowpass 已落地');
  ok(nodes.filter((n) => n.kind === 'osc').length >= 3, '★ 情绪层：结果音有 3 音以上叠音');
  const gains = nodes.filter((n) => n.kind === 'gain' && n.gain.calls.length);
  ok(gains.length >= 4, '瞬态 + 每音都有独立 gain 包络');
  ok(gains.every((n) => n.gain.calls[0][0] === 'setValueAtTime' && n.gain.calls[0][1] === 0),
    '★★ 每个 gain 首帧都是 setValueAtTime(0,t)（零起音动态自证）');
  ok(gains.every((n) => n.gain.calls.some((c) => c[0] === 'linearRampToValueAtTime'))
    && gains.every((n) => n.gain.calls.some((c) => c[0] === 'exponentialRampToValueAtTime')),
  '★ 每个 gain 都有 linear attack + exponential decay');
  const releaseGain = gains.find((n) => n.gain.calls.filter((c) => c[0] === 'linearRampToValueAtTime').length >= 2);
  ok(!!releaseGain, '★ 结果音有到 sustain 的第二段 linearRamp（真 release）');

  /* 动态变异自证：把真源的零起音改坏，同一判据必须判红 */
  const badApp = observedBoot(mutations.zeroAttackGain());
  const bBefore = badApp.ac.nodes.length;
  badApp.Sfx.play('champion_fanfare');
  const badGains = badApp.ac.nodes.slice(bBefore).filter((n) => n.kind === 'gain' && n.gain.calls.length);
  ok(badGains.length > 0 && !badGains.every((n) => n.gain.calls[0][1] === 0),
    '★ 变异自证：改坏 gain 起音后同一动态判据判红（还原→绿）');
}

console.log('\n[② VOL 表进 mp3 通路（变异自证）]');
function volDetector(app) {
  const before = app.plays.length;
  app.Sfx.play('win');
  const p = app.plays[before];
  return p && Math.abs(p.volume - 0.62) < 1e-6;
}
{
  const good = observedBoot(SRC);
  ok(volDetector(good) === true, '★ win 以 VOL 表 0.62 播放（不再是 unity gain）');
  const badSrc = replace(SRC, 'a.volume = vol * (far ? 0.5 : 1) * jitter(0.05);', 'a.volume = 1;');
  const bad = observedBoot(badSrc);
  ok(volDetector(bad) === false, '★ 变异自证：改回 unity gain 后同一判据判红');
}

console.log('\n[③ duck 包络：attack 120ms / hold 250ms / release 500ms（变异自证）]');
function duckDetector(app) {
  app.Sfx.startBgm();
  const bgmEl = app.audios.filter((a) => a.src.indexOf('bgm') >= 0)[0];
  const before = app.timerCount();
  app.Sfx.play('champion_fanfare');
  const scheduled = app.timerCount() - before;
  app.flush(app.clock.t + 50);
  const mid = bgmEl.volume;
  app.flush(app.clock.t + 3000);
  return { scheduled: scheduled, mid: mid, end: bgmEl.volume };
}
{
  const good = duckDetector(observedBoot(SRC));
  ok(good.scheduled >= 6, '★ duck 不是一次硬赋值：分步 timer 数 ' + good.scheduled);
  ok(good.mid > 0.05 && good.mid < 0.14, '★ attack 途中 BGM 音量在 0.05–0.14 之间（包络）', good.mid);
  near(good.end, 0.14, 0.001, '★ release 结束回到 BGM_VOL 0.14');
  const badSrc = replace(SRC, 'rampBgmVolume(DUCK_VOL, DUCK_ATTACK_MS, 20);', 'bgmVolume(DUCK_VOL);');
  const bad = duckDetector(observedBoot(badSrc));
  ok(bad.scheduled < 6 || !(bad.mid > 0.05 && bad.mid < 0.14),
    '★ 变异自证：改回硬台阶后同一包络判据判红');
}

console.log('\n[④ 结果音互斥 / settle 错开 / error 抢 select（变异自证）]');
function mutexDetector(src) {
  const app = observedBoot(src);
  const c0 = app.Sfx.diagnostics();
  app.clock.t += 1; app.Sfx.play('champion_fanfare');
  app.clock.t += 200; app.Sfx.play('win');
  const winSuppressed = app.Sfx.diagnostics().last.suppressed === true;
  app.clock.t += 300; app.Sfx.play('champion_fanfare');
  const terminalDup = app.Sfx.diagnostics().last.suppressed === true;
  const app2 = observedBoot(src);
  app2.clock.t += 1; app2.Sfx.play('win');
  app2.clock.t += 100; app2.Sfx.play('settle');
  const settleEarly = app2.Sfx.diagnostics().last.suppressed === true;
  app2.clock.t += 300; app2.Sfx.play('settle');
  const settleLate = app2.Sfx.diagnostics().last.suppressed === true;
  const app3 = observedBoot(src);
  app3.Sfx.play('select'); app3.clock.t += 10; app3.Sfx.play('error');
  app3.clock.t += 10; app3.Sfx.play('select');
  const selectAfterError = app3.Sfx.diagnostics().last.suppressed === true;
  return { winSuppressed, terminalDup, settleEarly, settleLate, selectAfterError, c0 };
}
{
  const m = mutexDetector(SRC);
  ok(m.winSuppressed, '★ 终局结果音出现后 1.6 s 内 win 被抑制');
  ok(m.terminalDup, '★ 同一终局结果音 2 s 内不重播');
  ok(m.settleEarly && !m.settleLate, '★ settle 与 win 错开 ≥250 ms（早抑制 / 晚放行）');
  ok(m.selectAfterError, '★ error 后 60 ms 内 select 被抑制');
  const badSrc = replace(SRC, 'win: 1600', 'win: 0');
  const b = mutexDetector(badSrc);
  ok(b.winSuppressed === false, '★ 变异自证：互斥窗口改 0 后同一判据判红');
}

console.log('\n[⑤ 变体三组轮转 / 亮度递进 / 远场低通 / master bus / 元素池]');
{
  const app = observedBoot(SRC);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    app.Sfx.play('error');
    seen.push({ idx: app.Sfx.diagnostics().last.variantIndex,
      detune: app.Sfx.diagnostics().last.detune, seed: app.Sfx.diagnostics().last.filterSeed });
  }
  eq(seen.map((x) => x.idx).join(','), '0,1,2', '★ 三组变体轮转（解锁预热不消耗变体游标）');
  ok(new Set(seen.map((x) => x.detune)).size === 3 && new Set(seen.map((x) => x.seed)).size === 3,
    '★ 失谐量 / 瞬态 seed 三组都不同（P1-8 变体真正生效）');

  const brightApp = observedBoot(SRC);
  brightApp.Sfx.play('countdown_tick', 1.04);
  const d = brightApp.Sfx.diagnostics().last;
  ok(d.fixed === true && d.brightness === true, '★ 1.04 被识别为亮度递进，不参与 ±3% 抖动');
  eq(d.pitch, 1.04, '★ 1.04 原值保留（不会被抖到 1.01）');
  eq(d.cutoffBase, 4000, '★ 亮度递进映射为低通 4 kHz（变体系数之前）');
  const badBright = observedBoot(mutations.semanticBrightnessDynamic());
  badBright.Sfx.play('countdown_tick', 1.04);
  ok(badBright.Sfx.diagnostics().last.brightness === false,
    '★ 变异自证：删掉亮度分支后同一判据判红');

  const farApp = observedBoot(SRC);
  const bn = farApp.ac.nodes.length;
  farApp.Sfx.play('peer_submit');
  const filters = farApp.ac.nodes.slice(bn).filter((n) => n.kind === 'filter' && n.type === 'lowpass');
  ok(filters.length > 0 && filters.every((f) => f.frequency.value <= 1200),
    '★ 远场材质层低通截止被压到 ≤1.2 kHz');
  const badFarSrc = replace(SRC, 'if (far) cutoff = Math.min(cutoff, FAR_LOWPASS);', '/* removed */')
    .replace('cut: 1200, sweep: 1.125', 'cut: 3000, sweep: 1.125');
  const badFar = observedBoot(badFarSrc);
  const bfn = badFar.ac.nodes.length;
  badFar.Sfx.play('peer_submit');
  const bFilters = badFar.ac.nodes.slice(bfn).filter((n) => n.kind === 'filter' && n.type === 'lowpass');
  ok(bFilters.some((f) => f.frequency.value > 1200), '★ 变异自证：删掉远场低通后同一判据判红');

  const busApp = observedBoot(SRC);
  const n0 = busApp.ac.nodes.length;
  busApp.Sfx.play('error');
  const comp = busApp.ac.nodes.slice(n0).find((n) => n.kind === 'compressor');
  ok(!!comp, '★ MASTER 链上有 DynamicsCompressor');
  if (comp) {
    eq(comp.threshold.value, -12, 'compressor threshold −12 dB');
    eq(comp.knee.value, 6, 'compressor knee 6');
    eq(comp.ratio.value, 4, 'compressor ratio 4');
    near(comp.attack.value, 0.003, 1e-9, 'compressor attack 3 ms');
    near(comp.release.value, 0.12, 1e-9, 'compressor release 120 ms');
  }
  const badBus = observedBoot(mutations.masterBus());
  const bn0 = badBus.ac.nodes.length;
  badBus.Sfx.play('error');
  const badGain = badBus.ac.nodes.slice(bn0).find((n) => n.kind === 'gain' && n.gain.value === 1);
  ok(!!badGain, '★ 变异自证：masterGain 改成 1 后同一判据判红');

  const poolApp = observedBoot(SRC);
  const p0 = poolApp.plays.length;
  poolApp.Sfx.play('select'); poolApp.Sfx.play('select');
  const used = poolApp.plays.slice(p0, p0 + 2).map((p) => p);
  ok(used.length === 2 && used[0] !== used[1], '★ 元素池：连续两次 select 命中不同 Audio 元素');
  const badPool = observedBoot(mutations.pool());
  const bp0 = badPool.plays.length;
  badPool.Sfx.play('select'); badPool.Sfx.play('select');
  const bUsed = badPool.plays.slice(bp0, bp0 + 2);
  ok(bUsed.length === 2 && bUsed[0] === bUsed[1], '★ 变异自证：池大小改 1 后同一判据判红');
}

console.log('\n[⑥ 区分度：≥8 声纹 + §1.5 七组撞车对全部拆开]');
/* 声纹 = 频段 / 波形 / 音程 / 节奏 四个「硬轴」+ cutoff / sweep / space / body 四个辅助轴。
 * 判据按修订版 §二口径 2：撞车对必须在硬轴上至少占一项不同，挪几十 Hz 不算。 */
function sigOf(entry) {
  const s = entry.spec;
  const f = s.freq;
  const band = f < 200 ? 'SUB' : f < 500 ? 'LOW' : f < 900 ? 'MID' : f < 1300 ? 'HIGH' : 'TOP';
  const tones = s.tones || [{ ratio: 1, level: 1, delay: 0, type: s.type }];
  const wave = s.type + '+' + tones.map((t) => t.type || s.type).join('/') + (s.detuneTone ? '+detune' : '');
  const top = Math.max.apply(null, tones.map((t) => t.ratio));
  const bottom = Math.min.apply(null, tones.map((t) => t.ratio));
  const interval = tones.length === 1 ? 'single' : (top > 1.01 ? 'up' + top.toFixed(2) : 'down' + bottom.toFixed(2));
  const lastDelay = tones.length ? (tones[tones.length - 1].delay || 0) : 0;
  const rhythm = tones.length >= 4 ? 'four' : tones.length === 1 ? 'one' : (lastDelay >= 60 ? 'slow' : 'quick');
  const cut = s.cut >= 5000 ? 'bright' : s.cut >= 2000 ? 'open' : 'muffled';
  const sweep = s.sweep ? (s.sweep > 1 ? 'sweepUp' : 'sweepDown') : 'noSweep';
  return { band, wave, interval, rhythm, cut, sweep, space: entry.far ? 'far' : 'near', body: s.body ? 'body' : 'flat' };
}
const HARD_AXES = ['band', 'wave', 'interval', 'rhythm'];
function hardDiff(a, b) { return HARD_AXES.filter((k) => sigOf(a)[k] !== sigOf(b)[k]); }
function groupSeparated(map, names) {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (!map[names[i]] || !map[names[j]]) return false;
      if (hardDiff(map[names[i]], map[names[j]]).length < 1) return false;
    }
  }
  return true;
}
const COLLISION_GROUPS = [
  { n: 'deal ↔ error', g: ['deal', 'error'] },
  { n: 'select ↔ split_tick', g: ['select', 'split_tick'] },
  { n: 'countdown_go ↔ emoji_receive ↔ emoji_send', g: ['countdown_go', 'emoji_receive', 'emoji_send'] },
  { n: 'room_enter ↔ room_leave ↔ peer_submit ↔ spectator', g: ['room_enter', 'room_leave', 'peer_submit', 'spectator'] },
  { n: 'ready ↔ hold_toggle', g: ['ready'], absent: 'hold_toggle' },
  { n: 'win ↔ achievement ↔ champion_fanfare ↔ lose', g: ['win', 'achievement', 'champion_fanfare', 'lose'] },
  { n: 'error ↔ veto ↔ split_timeout ↔ submit', g: ['error', 'veto', 'split_timeout', 'submit'] }
];
{
  const map = observedBoot(SRC).Sfx.audioMap();
  COLLISION_GROUPS.forEach((c) => {
    const good = c.absent
      ? (!!map[c.g[0]] && !map[c.absent])
      : groupSeparated(map, c.g);
    ok(good, '★ 撞车组已拆开：' + c.n + (c.absent ? '（死条目已删除）' : ''));
    /* 变异自证：把这一组里除第一个之外的 spec 全改成第一个 → 同一判据必须判红。 */
    const badMap = JSON.parse(JSON.stringify(map));
    if (c.absent) badMap[c.absent] = JSON.parse(JSON.stringify(map[c.g[0]]));
    else c.g.slice(1).forEach((n) => { badMap[n].spec = JSON.parse(JSON.stringify(map[c.g[0]].spec)); });
    const bad = c.absent
      ? (!!badMap[c.g[0]] && !badMap[c.absent])
      : groupSeparated(badMap, c.g);
    ok(good === true && bad === false, '★ 变异自证：' + c.n + ' 改回同音后判据判红');
  });
  const unique = new Set(Object.keys(map).map((k) => JSON.stringify(sigOf(map[k])))).size;
  ok(unique >= 8, '★ 可辨声纹数 ≥8（实测 ' + unique + '，现状基线 4）');
  const flatMap = JSON.parse(JSON.stringify(map));
  Object.keys(flatMap).forEach((k) => { flatMap[k].spec = JSON.parse(JSON.stringify(map.win.spec)); });
  const flatUnique = new Set(Object.keys(flatMap).map((k) => JSON.stringify(sigOf(flatMap[k])))).size;
  ok(unique >= 8 && flatUnique < 8, '★ 变异自证：全部塌成 win 后声纹计数判红');
  ok(!map.hold_toggle && !!map.ready, '★ audioMap 不再暴露 hold_toggle 撞车幽灵');
}

console.log('\n[⑦ addBody 低频 body 层：节点级守卫 + 双变异自证（QA D1\'）]');
/* 期望值写死在测试里，**不读**被测源的 spec.body —— 否则「删掉全部 body 参数」时
 * 期望值会跟着一起消失，判据自我调整而假绿（QA 复现的正是这类缺口）。 */
const EXPECTED_BODY_HZ = {
  submit: 140, win: 100, error: 180, lose: 100, veto: 180, champion_fanfare: 120
};
function bodyOscCount(app, name, hz) {
  const before = app.ac.nodes.length;
  app.Sfx.play(name);
  return app.ac.nodes.slice(before).filter((n) => n.kind === 'osc'
    && n.frequency.calls.length > 0
    && n.frequency.calls[0][0] === 'setValueAtTime'
    && Math.abs(n.frequency.calls[0][1] - hz) < 0.001).length;
}
function bodyGuard(src) {
  /* submit / win 有真 mp3，正常路径不会走合成；为观察 body 节点，临时把元素池查找置空，
   * 让所有事件都走 synth。这个改写对真源与变异源一视同仁，不影响判据公平性。 */
  const synthSrc = replace(src, 'var a = nextPoolElement(name);', 'var a = null;');
  const app = observedBoot(synthSrc);
  let hit = 0;
  Object.keys(EXPECTED_BODY_HZ).forEach((n) => {
    if (bodyOscCount(app, n, EXPECTED_BODY_HZ[n]) > 0) hit++;
  });
  return hit;
}
{
  const good = bodyGuard(SRC);
  eq(good, 6, '★ 6 个带 body 事件合成时都多出一个 100–180 Hz 低频 oscillator');
  /* 对照组：无 body 事件不应出现这些「精确 body 频率」的振荡器（deal 主体 140 Hz
   * 经变体/失谐后是 133.8 Hz，不等于 140，所以不会误命中）。 */
  const controlApp = observedBoot(SRC);
  let controlHit = 0;
  ['deal', 'select', 'countdown_tick'].forEach((n) => {
    Object.keys(EXPECTED_BODY_HZ).forEach((hzName) => {
      const key = EXPECTED_BODY_HZ[hzName];
      const before = controlApp.ac.nodes.length;
      controlApp.Sfx.play(n);
      if (controlApp.ac.nodes.slice(before).some((x) => x.kind === 'osc'
        && x.frequency.calls.length && Math.abs(x.frequency.calls[0][1] - key) < 0.001)) controlHit++;
    });
  });
  eq(controlHit, 0, '★ 对照组：无 body 事件不出现精确 body 频率的 oscillator');

  /* 变异①：删掉 addBody 调用（spec 的 body 参数还在） */
  const noCallSrc = replace(SRC, 'addBody(c, bus, t, spec.body, peak, nodes);', '/* addBody 调用被删除 */', true);
  const noCall = bodyGuard(noCallSrc);
  eq(noCall, 0, '★ 变异自证①：删 addBody 调用 → 守卫 0/6 判红（还原 → 6/6 判绿）');

  /* 变异②：删掉全部 spec 的 body 参数（addBody 调用还在） */
  const bodyRe = /\s*body:\s*\{\s*freq:\s*\d+,\s*ms:\s*\d+,\s*level:\s*[\d.]+\s*\},?/g;
  const found = (SRC.match(bodyRe) || []).length;
  eq(found, 6, '前提：源码里恰好 6 处 body 参数（误删锚点会当场发现）');
  const noParamSrc = SRC.replace(bodyRe, '');
  const noParam = bodyGuard(noParamSrc);
  eq(noParam, 0, '★ 变异自证②：删全部 body 参数 → 守卫 0/6 判红（还原 → 6/6 判绿）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
