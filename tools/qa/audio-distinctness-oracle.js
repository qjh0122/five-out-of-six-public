/**
 * QA 独立声纹复算 oracle（audio-impl-1 第二轮复签）
 *
 * 为什么另写：pwa/test/audio-impl-1.test.js 的 sigOf()/HARD_AXES 是实施者自写判据，
 * 其"可辨声纹 20"没有任何守卫保护（测试只断言 unique>=8）。fresh eyes 必须用
 * 独立维度定义交叉验证，不能复用被测方的分类逻辑。
 *
 * 独立点：
 *  - 频段按"小三度带"(midi/3) 而非线性 1300Hz 阈值 —— 人耳可辨 ≥1 半音，
 *    把 1046Hz(C6) 与 1318Hz(E6)(差4半音) 判为不同频段符合听感；同时输出粗倍频程档做敏感性分析。
 *  - 波形识别 DETUNE/MIXWAVE/CHORD/SOLO；音程用语义(fifth/third/octave/repeat/second-down)；
 *    节奏用双击松紧(≤40ms/>40ms)。
 *  - 空间层(远场 lowpass+6dB)纳入 fullSig —— 诊断 §1.2 P1-11/§2 明确"自我vs他人"空间分层是正式维度。
 *
 * 跑法：node tools/qa/audio-distinctness-oracle.js
 * 自验：4 个已知答案样本（1 好 3 坏），判据须分清；否则退出码 1。
 */
'use strict';
var Sfx = require('../../pwa/js/sfx.js').Sfx;
var realMap = Sfx.audioMap();

function midi(f) { return 69 + 12 * Math.log(f / 440) / Math.LN2; }
function band3(f) { return 'B' + Math.floor(midi(f) / 3); }   // 小三度带（细）
function oct(f) { return f < 200 ? 'SUB' : f < 400 ? 'LOW' : f < 800 ? 'MID' : f < 1600 ? 'HIGH' : 'TOP'; } // 倍频程（粗，敏感性分析）
function timbre(spec) {
  var tones = spec.tones || [{ ratio: 1, type: spec.type }];
  var types = {}; tones.forEach(function (t) { types[t.type || spec.type] = 1; });
  if (spec.detuneTone) return 'DETUNE';
  if (Object.keys(types).length > 1) return 'MIXWAVE';
  if (tones.length > 1) return spec.type.toUpperCase() + '-CHORD';
  return spec.type.toUpperCase() + '-SOLO';
}
function contour(spec) {
  var tones = spec.tones || [{ ratio: 1 }];
  if (tones.length === 1) return spec.sweep ? (spec.sweep > 1 ? 'SWEEP-UP' : 'SWEEP-DOWN') : 'MONO';
  var top = Math.max.apply(null, tones.map(function (t) { return t.ratio; }));
  var bot = Math.min.apply(null, tones.map(function (t) { return t.ratio; }));
  if (Math.abs(top - 1) < 0.01 && Math.abs(bot - 1) < 0.01) return 'REPEAT';
  if (top > 1.9) return 'OCTAVE-UP';
  if (top > 1.4) return 'FIFTH-UP';
  if (top > 1.1) return 'THIRD-UP';
  if (bot < 0.9) return 'THIRD-DOWN';
  if (bot < 0.97) return 'SECOND-DOWN';
  return 'OTHER';
}
function rhythm(spec) {
  var tones = spec.tones || [{ ratio: 1 }];
  if (tones.length >= 4) return 'FOUR';
  if (tones.length === 3) return 'TRIPLE';
  if (tones.length === 2) return (tones[1].delay || 0) <= 40 ? 'DBL-TIGHT' : 'DBL-WIDE';
  return 'SINGLE';
}
/* 四硬轴：频段(小三度带)/波形/音程/节奏 */
function hardSig(spec) { return [band3(spec.freq), timbre(spec), contour(spec), rhythm(spec)].join('|'); }
/* 粗四轴敏感性分析（频段用倍频程） */
function coarseSig(spec) { return [oct(spec.freq), timbre(spec), contour(spec), rhythm(spec)].join('|'); }
/* 完整轮廓 = 四硬轴 + 空间(远场) + body + cutoff 亮度 */
function fullSig(entry) {
  var s = entry.spec;
  return hardSig(s) + '|' + (entry.far ? 'FAR' : 'NEAR') + '|' +
    (s.body ? 'BODY' : 'FLAT') + '|' + (s.cut >= 5000 ? 'BRIGHT' : s.cut >= 2000 ? 'OPEN' : 'MUFFLED');
}
var GROUPS = [
  { n: 'deal↔error', g: ['deal', 'error'] },
  { n: 'select↔split_tick', g: ['select', 'split_tick'] },
  { n: 'countdown_go↔emoji_receive↔emoji_send', g: ['countdown_go', 'emoji_receive', 'emoji_send'] },
  { n: 'room_enter↔room_leave↔peer_submit↔spectator', g: ['room_enter', 'room_leave', 'peer_submit', 'spectator'] },
  { n: 'ready↔hold_toggle', g: ['ready'], absent: 'hold_toggle' },
  { n: 'win↔achievement↔champion_fanfare↔lose', g: ['win', 'achievement', 'champion_fanfare', 'lose'] },
  { n: 'error↔veto↔split_timeout↔submit', g: ['error', 'veto', 'split_timeout', 'submit'] }
];
function separated(map, names, fn) {
  fn = fn || hardSig;
  for (var i = 0; i < names.length; i++) for (var j = i + 1; j < names.length; j++) {
    if (!map[names[i]] || !map[names[j]]) return false;
    if (fn(map[names[i]].spec) === fn(map[names[j]].spec)) return false;
  }
  return true;
}
function uniq(map, fn) {
  var o = {}; Object.keys(map).forEach(function (k) { o[fn(map[k])] = 1; }); return Object.keys(o).length;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

var pass = 0, fail = 0;
function chk(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('=== QA 独立声纹 oracle（不复用 sigOf） ===');
console.log('真实参数表（四硬轴 | 粗倍频程轴 | 空间 | body）：');
Object.keys(realMap).forEach(function (k) {
  var e = realMap[k], s = e.spec;
  console.log('  ' + k + ' | ' + hardSig(s) + ' | coarse=' + oct(s.freq) + ' | ' + (e.far ? 'FAR' : 'NEAR') + ' | body=' + (s.body ? s.body.freq + 'Hz' : '-'));
});

console.log('\n[判据自验：已知答案样本]');
var allGood = GROUPS.every(function (c) { return c.absent ? (!!realMap[c.g[0]] && !realMap[c.absent]) : separated(realMap, c.g); });
chk(allGood === true, '样本1(真源/应全拆开): 7组判定=通过');
var bad1 = clone(realMap); bad1.select.spec = clone(realMap.split_tick.spec);
chk(separated(bad1, ['select', 'split_tick']) === false, '样本2(已知坏/select改成分辨不出): 判据判红');
var hardOf = function (e) { return hardSig(e.spec); };
var bad2 = clone(realMap); Object.keys(bad2).forEach(function (k) { bad2[k].spec = clone(realMap.win.spec); });
chk(uniq(bad2, hardOf) < 8, '样本3(已知坏/全部塌成win): 声纹计数判红');
var bad3 = clone(realMap); bad3.achievement.spec = clone(realMap.win.spec);
chk(separated(bad3, ['win', 'achievement']) === false, '样本4(已知坏/achievement改成win同音): 判据判红');
chk(pass === 4 && fail === 0, '★ 自验 4/4 通过（1好3坏均分清），判据可用');

console.log('\n[正式判定：七组逐组]');
GROUPS.forEach(function (c) {
  var good = c.absent ? (!!realMap[c.g[0]] && !realMap[c.absent]) : separated(realMap, c.g);
  var coarse = c.absent ? good : separated(realMap, c.g, coarseSig);
  var detail = c.g.map(function (n) { return n + '=' + (realMap[n] ? hardSig(realMap[n].spec) : 'ABSENT'); }).join(' ; ');
  chk(good, '组拆开(细轴)：' + c.n, detail);
  if (c.n.indexOf('emoji') >= 0) console.log('    [敏感性] 粗倍频程轴下本组=' + (coarse ? '仍拆开' : '重合→靠空间层(远场低通)+小三度音高拆开'));
});
var uHard = uniq(realMap, hardOf), uFull = uniq(realMap, fullSig);
console.log('\n声纹唯一数：四硬轴=' + uHard + '  完整(含空间/body/亮度)=' + uFull + '  事件数=' + Object.keys(realMap).length);
chk(uHard >= 8, '★ 独立判据：硬轴可辨声纹 >=8（实测 ' + uHard + '）');
chk(uFull >= 8, '★ 独立判据：完整轮廓 >=8（实测 ' + uFull + '）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exitCode = 1;
