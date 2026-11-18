#!/usr/bin/env node
/**
 * 探针：表情 / 短语落点的**判定尺子自验**（台账登记项，见 scripts/probes.json）
 *
 * 为什么它不是普通探针：它不开浏览器。真正的几何由 `scripts/probe-emoji.js` 在
 * 真浏览器里量；这里验的是「量完之后用来判定的那把尺子本身准不准」。
 *
 * 尺子在 `tools/qa/emoji-placement-oracle.js`（独立复算，不 require 任何 pwa 代码）。
 * 本文件只是台账入口 —— `scripts/probes.json` 的 `disk` 清单只认 `scripts/probe-*.js`，
 * 而 npm test 那边另有 `pwa/test/emoji-placement-oracle.test.js` 走同一把尺子。
 * 一份实现、两个入口，是为了「登记在台账里」和「每次都跑」两件事都不缺。
 *
 * 跑法：node scripts/probe-emoji-oracle.js [--verbose]
 */
'use strict';

const path = require('path');
const O = require(path.join(__dirname, '..', 'tools', 'qa', 'emoji-placement-oracle.js'));

const verbose = process.argv.indexOf('--verbose') >= 0;
const r = O.runSelfTest(verbose);
if (!r.ok) process.exitCode = 1;
