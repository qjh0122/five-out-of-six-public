/**
 * 音效模块（真实音频文件 assets/audio/*.mp3 + WebAudio 合成兜底）
 *
 * - 移动端自动播放限制：必须在用户首次触摸手势内解锁（unlock）。
 *   ★ v155（B2 修复）：BGM 的**创建与首次 play** 都在手势栈里同步完成，
 *     不再放进 150ms setTimeout；play() 的 Promise 拒绝不能被吞掉，
 *     而是挂一次性手势重试监听（unlocked 只锁解锁流程，不锁 BGM 重试）。
 * - 若音频文件缺失/加载失败，按事件名落到 SYNTH_SPECS 的合成兜底。
 *   ★ v155（B3）：error 从 200Hz sawtooth/0.08 改成 520Hz triangle/0.22，
 *     并加 3 变体 + ±3% 音高抖动（与规格 §5.3 一致）。
 * - 混音：按优先级打断 + BGM duck；所有事件都有明确反馈，除非玩家关了总开关。
 *
 * 关于那个开关的语义：**它是「声音」总开关，不是「背景音乐」开关。**
 * 早先它只 pause 了 BGM，play() 却完全不看开关——于是玩家在房间页点了「关」，
 * 一进牌桌发牌声/选牌声/提示声照旧全响，看起来就是「关了还有声」。
 * 用户点的是「声音」，那就要真的静音全部；要只关 BGM 是产品决策，得另给一个入口。
 *
 * ⚠ 资产边界（2026-11-20）：本机没有 ffmpeg/ffprobe，本轮**未生成任何新 mp3**。
 * FILES/SFX_NAMES 仍只有原有 5 SFX + 1 BGM；新事件全部走 SYNTH_SPECS 兜底。
 * 实测口径（QA 2026-11-20）：SYNTH_SPECS 23 + FILES 6 = 29 表项，事件名并集 24；
 * PRIORITY 21 / FAR_FIELD 4 是属性表，不计入音色条目。
 * 资产待办真源见 docs/audio-redesign-spec-2026-11-20.md §九 / §十一。
 * 听感未验收，本文件只保证结构/接线/兜底到位。
 */
(function (global) {
  'use strict';

  var FILES = {
    deal: 'assets/audio/sfx_deal.mp3',
    select: 'assets/audio/sfx_select.mp3',
    submit: 'assets/audio/sfx_submit.mp3',
    win: 'assets/audio/sfx_win.mp3',
    settle: 'assets/audio/sfx_settle.mp3',
    bgm: 'assets/audio/bgm_room_loop.mp3'
  };
  var SFX_NAMES = ['deal', 'select', 'submit', 'win', 'settle'];

  var BGM_VOL = 0.12;        // 规格 §7.1：常态 ≈ -18 dB（旧值 0.22 太靠近 SFX）
  var DUCK_VOL = 0.04;       // 0/1 级事件触发 duck ≈ -28 dB
  var DUCK_HOLD_MS = 900;    // attack 0.15 + hold 0.3 + release 0.6 的粗粒度近似

  /* 优先级（规格 §6.4）：数字小的可打断数字大的；同级不互相打断。 */
  var PRIORITY = {
    error: 0, veto: 0, split_timeout: 0,
    win: 1, lose: 1, champion_fanfare: 1, achievement: 1, settle: 1, countdown_go: 1,
    deal: 2, submit: 2, ready: 2, split_tick: 2,
    select: 3, hint_guide: 3, spectator: 3, emoji_receive: 3, emoji_send: 3,
    peer_submit: 3, room_enter: 3, room_leave: 3
  };
  /* 远场（-6 dB）：他人动作，规格 §6.2。 */
  var FAR_FIELD = {
    room_enter: 1, room_leave: 1, peer_submit: 1, emoji_receive: 1
  };
  /* 语义化音高：不许被随机抖动改掉（大牌型/入槽/撤牌/战绩导出）。 */
  var SEMANTIC_PITCH = [1.12, 1.03, 0.97];

  /* 合成兜底表。每一条都是「有意实现的反馈」，不是漏接线导致的静默。
   * freq/type/gain 的取值来自音频规格 §2.3 / §4 / §5.3；BGM 不在这里（它是真资产）。 */
  var SYNTH_SPECS = {
    deal:              { freq: 520,  dur: 0.14, type: 'triangle', gain: 0.22, sweep: 0.82 },
    select:            { freq: 760,  dur: 0.08, type: 'sine',     gain: 0.14 },
    submit:            { freq: 440,  dur: 0.21, type: 'triangle', gain: 0.24, sweep: 1.12 },
    win:               { freq: 880,  dur: 0.90, type: 'triangle', gain: 0.30, sweep: 1.18 },
    settle:            { freq: 660,  dur: 0.95, type: 'sine',     gain: 0.20, sweep: 0.94 },
    error:             { freq: 520,  dur: 0.12, type: 'triangle', gain: 0.22, sweep: 0.94 },
    lose:              { freq: 440,  dur: 0.75, type: 'triangle', gain: 0.26, sweep: 0.89 },
    countdown_tick:    { freq: 880,  dur: 0.08, type: 'sine',     gain: 0.18 },
    countdown_go:      { freq: 1046, dur: 0.25, type: 'triangle', gain: 0.30 },
    split_tick:        { freq: 720,  dur: 0.07, type: 'sine',     gain: 0.16 },
    split_timeout:     { freq: 420,  dur: 0.35, type: 'triangle', gain: 0.24, sweep: 0.88 },
    peer_submit:       { freq: 620,  dur: 0.20, type: 'sine',     gain: 0.14 },
    room_enter:        { freq: 560,  dur: 0.20, type: 'sine',     gain: 0.16, sweep: 1.06 },
    room_leave:        { freq: 520,  dur: 0.20, type: 'sine',     gain: 0.16, sweep: 0.90 },
    ready:             { freq: 680,  dur: 0.15, type: 'triangle', gain: 0.18, sweep: 1.08 },
    veto:              { freq: 480,  dur: 0.25, type: 'triangle', gain: 0.22, sweep: 0.86 },
    spectator:         { freq: 600,  dur: 0.18, type: 'sine',     gain: 0.12 },
    emoji_receive:     { freq: 1046, dur: 0.12, type: 'sine',     gain: 0.14 },
    emoji_send:        { freq: 1046, dur: 0.10, type: 'sine',     gain: 0.11 },
    achievement:       { freq: 784,  dur: 0.80, type: 'triangle', gain: 0.30, sweep: 1.25 },
    champion_fanfare:  { freq: 659,  dur: 1.10, type: 'triangle', gain: 0.32, sweep: 1.30 },
    hint_guide:        { freq: 700,  dur: 0.25, type: 'sine',     gain: 0.12 },
    hold_toggle:       { freq: 680,  dur: 0.15, type: 'triangle', gain: 0.18 }
  };
  var DEFAULT_SPEC = { freq: 600, dur: 0.08, type: 'sine', gain: 0.10 };
  var VARIANTS = [0.97, 1, 1.03];   // 三变体；无独立资产时用音高差代替音色差

  var audioPool = {};   // name -> Audio（null 表示加载失败，走合成回退）
  var bgm = null;
  var ST = (global.LXW && global.LXW.Store) || null;
  /* Node 测试里没有 window.LXW，就 require 同一份实现（跑的是同一段代码，
   * 只是 backing 由测试塞进来）—— 不是再造一个假存储。 */
  if (!ST && typeof require === 'function') {
    try { ST = require('./storage.js'); } catch (e) { ST = null; }
  }
  var SOUND_KEY = ST ? ST.KEYS.SOUND : 'lxw_sound_v1';              // 新键：声音总开关
  var LEGACY_BGM_KEY = ST ? ST.KEYS.BGM_LEGACY : 'lxw_bgm_v1';      // 老键：当时只管背景音乐，值要迁移

  /* 记住开关：默认开着，关过一次以后每次进来都别再吵人。
   * 只有明确的 '0' 才算关——存储里是脏值（老版本、手改过）时按默认走，不要静默变哑。 */
  function readSoundPref() {
    var v = ST ? ST.read(SOUND_KEY, '') : '';
    if (v === '0') return false;
    if (v === '1') return true;
    /* 没有新键 → 沿用老版本的 BGM 开关（storage.js 的 migrate 会搬，
     * 这里保留一条读老路径：迁移失败时也不该突然开始响）。
     * 当时玩家点「关」的本意就是「别再响了」，升级后不该突然又开始响；
     * 反过来如果按默认开处理，等于把人家关过的声音又打开一遍。 */
    var old = ST ? ST.read(LEGACY_BGM_KEY, '') : '';
    return old !== '0';
  }
  function writeSoundPref(on) {
    if (ST) ST.write(SOUND_KEY, on ? '1' : '0');
  }

  var soundEnabled = readSoundPref();
  var unlocked = false;
  var ctx = null;       // 合成回退用 AudioContext
  var bgmRetryArmed = false;
  var duckTimer = null;
  var activeVoices = [];
  var variantCursor = 0;
  var diagnostics = { last: null, gestureBgm: true, retryCount: 0, duckCount: 0 };

  function makeAudio(src, loop, volume) {
    try {
      var a = new global.Audio(src);
      a.loop = !!loop;
      a.preload = 'auto';
      if (volume != null) a.volume = volume;
      return a;
    } catch (e) { return null; }
  }

  /* ---------- 初始化音频元素，加载失败的标记为 null ---------- */
  (function init() {
    SFX_NAMES.forEach(function (name) {
      var a = makeAudio(FILES[name], false, 1);
      if (!a) { audioPool[name] = null; return; }
      a.addEventListener('error', function () { audioPool[name] = null; });
      audioPool[name] = a;
    });
  })();

  /* ---------- Web Audio 合成回退（素材缺失时仍有反馈音） ---------- */
  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }
  function jitter(amount) { return 1 + (Math.random() * 2 - 1) * amount; }
  function nextVariant() {
    var i = variantCursor % VARIANTS.length;
    variantCursor += 1;
    return VARIANTS[i];
  }
  function isSemanticPitch(p) {
    for (var i = 0; i < SEMANTIC_PITCH.length; i++) {
      if (Math.abs((p || 1) - SEMANTIC_PITCH[i]) < 0.001) return true;
    }
    return false;
  }
  function rememberVoice(entry, ms) {
    activeVoices.push(entry);
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        var i = activeVoices.indexOf(entry);
        if (i >= 0) activeVoices.splice(i, 1);
      }, ms || 2000);
    }
  }
  function interruptBelow(level) {
    activeVoices.slice().forEach(function (v) {
      if (v.level <= level) return;   // 同级不打断，只有更高优先级才抢占
      try { v.stop(); } catch (e) {}
      var i = activeVoices.indexOf(v);
      if (i >= 0) activeVoices.splice(i, 1);
    });
  }
  function synth(name, pitch, variant, far) {
    var c = ensureCtx();
    if (!c) return null;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var spec = SYNTH_SPECS[name] || DEFAULT_SPEC;
    try {
      var t = c.currentTime;
      var osc = c.createOscillator();
      var g = c.createGain();
      var freq = spec.freq * (variant || 1) * (pitch || 1) * jitter(0.03);
      var gain = spec.gain * (far ? 0.5 : 1) * jitter(0.05);
      osc.type = spec.type;
      osc.frequency.setValueAtTime(freq, t);
      if (spec.sweep) osc.frequency.exponentialRampToValueAtTime(freq * spec.sweep, t + spec.dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(t); osc.stop(t + spec.dur + 0.02);
      var voice = { level: PRIORITY[name] == null ? 3 : PRIORITY[name], stop: function () { osc.stop(); } };
      rememberVoice(voice, Math.round(spec.dur * 1000) + 100);
      return voice;
    } catch (e) { return null; }
  }

  /* ---------- BGM：手势内首次 play + 一次性重试（B2 修复点） ----------
   * 关键：创建和 play 都在手势调用栈里；muted 状态下 play，Promise fulfilled 才取消静音。
   * Promise rejected 时 armBgmRetry()，下一次 touchstart/mousedown 再试一次。
   * 老浏览器 play() 返回 undefined 时视为成功（没有拒绝信号可等）。 */
  function bgmVolume(v) {
    if (!bgm) return;
    try { bgm.volume = v; } catch (e) {}
  }
  function duckBgm() {
    if (!soundEnabled || !bgm) return;
    bgmVolume(DUCK_VOL);
    diagnostics.duckCount += 1;
    if (duckTimer && typeof clearTimeout === 'function') clearTimeout(duckTimer);
    duckTimer = typeof setTimeout === 'function' ? setTimeout(function () {
      duckTimer = null;
      bgmVolume(BGM_VOL);
    }, DUCK_HOLD_MS) : null;
  }
  function disarmBgmRetry() {
    var doc = global.document;
    if (!bgmRetryArmed || !doc || !doc.removeEventListener) return;
    doc.removeEventListener('touchstart', onBgmRetryGesture, true);
    doc.removeEventListener('mousedown', onBgmRetryGesture, true);
    bgmRetryArmed = false;
  }
  function armBgmRetry() {
    var doc = global.document;
    if (bgmRetryArmed || !doc || !doc.addEventListener) return;
    bgmRetryArmed = true;
    diagnostics.retryCount += 1;
    doc.addEventListener('touchstart', onBgmRetryGesture, { capture: true, passive: true });
    doc.addEventListener('mousedown', onBgmRetryGesture, { capture: true, passive: true });
  }
  function onBgmRetryGesture() {
    if (!soundEnabled) return;
    disarmBgmRetry();   // 一次手势只试一次；再失败由 startBgmInGesture 重新 arm
    startBgmInGesture();
  }
  function startBgmInGesture() {
    if (!soundEnabled) return;
    if (!bgm) bgm = makeAudio(FILES.bgm, true, BGM_VOL);
    if (!bgm) return;
    bgmVolume(BGM_VOL);
    try {
      bgm.muted = true;
      var p = bgm.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          if (bgm) { bgm.muted = false; bgmVolume(BGM_VOL); }
          disarmBgmRetry();
        }).catch(function () {
          armBgmRetry();    // 不吞信号：被拒后下一次手势补起
        });
      } else {
        bgm.muted = false;  // 老浏览器：play() 无 Promise，按成功处理
        disarmBgmRetry();
      }
    } catch (e) {
      armBgmRetry();
    }
  }

  /* ---------- 首次用户手势解锁 ---------- */
  function unlockSfxElement(name) {
    var a = audioPool[name];
    if (!a) return;
    try {
      a.muted = true;
      var p = a.play();
      function settle() {
        if (!a) return;
        try { a.pause(); a.currentTime = 0; } catch (e) {}
        a.muted = false;
      }
      if (p && typeof p.then === 'function') {
        p.then(settle, settle);
      } else {
        settle();
      }
    } catch (e) {
      try { a.muted = false; } catch (e2) {}
    }
  }
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    /* 同一次手势里顺手 warm 合成回退用的 AudioContext，
     * 否则 error 这类在 await/catch 之后触发的音首播可能是 suspended。 */
    var c = ensureCtx();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    SFX_NAMES.forEach(unlockSfxElement);
    /* ★ B2：BGM 的创建 + 首次 play 在这里、手势栈内同步完成。
     * 旧版的 150ms setTimeout 已删除——定时器里再做首次 play 就是 B2 的根因。 */
    startBgmInGesture();
  }

  function startBgm() {
    startBgmInGesture();
  }

  /* ---------- 播放 ---------- */
  /* pitch：变调系数（1=原调；>1 升调、<1 降调）。MP3 用 playbackRate，合成回退用频率缩放。
   * 语义化音高（1.12 / 1.03 / 0.97）不参与随机化；其余每次 play 现算 ±3%。 */
  function play(name, pitch) {
    if (!unlocked) return;
    /* 开关关着就一声都别出。这一行是「关了还在响」那个 bug 的修复点：
     * 以前这里不判断开关，只有 BGM 受控，发牌/选牌/提交/胜负音效全都是「想响就响」。 */
    if (!soundEnabled) return;
    var fixed = isSemanticPitch(pitch);
    var jittered = fixed ? 1 : jitter(0.03);
    var rate = (pitch || 1) * jittered;
    var variant = nextVariant();
    var level = PRIORITY[name] == null ? 3 : PRIORITY[name];
    var far = !!FAR_FIELD[name];
    interruptBelow(level);
    if (level <= 1) duckBgm();

    var a = audioPool[name];
    if (a) {
      try {
        a.currentTime = 0;
        a.playbackRate = rate;
        a.volume = (far ? 0.5 : 1) * jitter(0.05);
        var p = a.play();
        if (p && p.catch) p.catch(function () { synth(name, rate, variant, far); });
      } catch (e) { synth(name, rate, variant, far); }
    } else {
      synth(name, rate, variant, far);
    }
    diagnostics.last = {
      name: name, pitch: rate, jitter: jittered, variant: variant,
      priority: level, far: far, fixed: fixed
    };
  }

  global.Sfx = {
    unlock: unlock,
    play: play,
    startBgm: startBgm,
    /** 声音总开关：BGM 和音效一起受控 */
    setSoundEnabled: function (on) {
      soundEnabled = !!on;
      writeSoundPref(soundEnabled);
      if (!soundEnabled) {
        if (bgm) { try { bgm.pause(); } catch (e) {} }
        if (duckTimer && typeof clearTimeout === 'function') { clearTimeout(duckTimer); duckTimer = null; }
        /* 音效都很短（<0.3s），但正在响的那一下也要掐掉——
         * 否则「点完关它还响一下」的观感跟没修一样。 */
        SFX_NAMES.forEach(function (n) {
          var a = audioPool[n];
          if (!a) return;
          try { a.pause(); a.currentTime = 0; } catch (e) {}
        });
        activeVoices.slice().forEach(function (v) { try { v.stop(); } catch (e) {} });
        activeVoices = [];
        disarmBgmRetry();
      } else {
        startBgm();
      }
      return soundEnabled;
    },
    isSoundEnabled: function () { return soundEnabled; },
    /* 旧名字保留：语义已经从「只关背景音乐」扩到「关掉全部声音」。
     * 留着是为了让还没改名的调用方继续能关，而不是静默失效变成永远关不掉。 */
    setBgmEnabled: function (on) { return global.Sfx.setSoundEnabled(on); },
    isBgmEnabled: function () { return soundEnabled; },
    isUnlocked: function () { return unlocked; },
    /* 只读诊断口：测试用它验「B2 结构 / 随机化范围 / 优先级」，不是第二套 API。 */
    diagnostics: function () {
      return {
        last: diagnostics.last,
        gestureBgm: diagnostics.gestureBgm,
        retryArmed: bgmRetryArmed,
        retryCount: diagnostics.retryCount,
        duckCount: diagnostics.duckCount,
        bgmMuted: bgm ? !!bgm.muted : null,
        bgmVolume: bgm ? bgm.volume : null,
        activeVoices: activeVoices.length
      };
    },
    /** 事件 → 兜底参数 / 优先级，供静态门禁逐事件核对（不产生声音）。 */
    audioMap: function () {
      var out = {};
      Object.keys(SYNTH_SPECS).forEach(function (k) {
        out[k] = {
          priority: PRIORITY[k] == null ? 3 : PRIORITY[k],
          far: !!FAR_FIELD[k],
          asset: !!FILES[k],
          spec: SYNTH_SPECS[k]
        };
      });
      return out;
    }
  };
})(typeof self !== 'undefined' ? self : this);
