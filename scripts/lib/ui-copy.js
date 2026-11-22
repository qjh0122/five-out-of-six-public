/**
 * 文案策略词表 —— 单一来源
 *
 * ── 这里放什么，不放什么 ──────────────────────────────────────────────
 * 放：**策略**。即"屏幕上不该出现哪类词"的判据（禁用词、重试词）。
 *      它不是产品文案，产品改了不需要动这里；它是质量口径，改一次全站生效。
 * 不放：产品里的句子。那些的真源在 `pwa/js/recordsState.js`（四态文案表）
 *      与视图本身。**测试层不许再抄一份产品句子** —— 抄一份就多一个会忘改的副本，
 *      而这正是 2026-11-18 到 11-22 那批假红的成因（文案收短了，断言还等旧句）。
 *
 * ── 为什么这两个正则会同时出现在单测和探针里 ─────────────────────────
 * `pwa/test/states.test.js` 的分类器自测（QA S20）与
 * `scripts/probe-states.js` 的全屏可见文本检查，量的是同一条口径：
 * 「不可恢复类不许邀请玩家再试一次」。两边各写一条正则时，一条写成
 * `稍后\s*(再试|重试)`、另一条写成 `稍后再试|稍后重试`，看着一样，
 * 实际已经分叉（前者能穿透"稍后 再试"）。这里只留一条。
 *
 * 用法：
 *   const { RETRY_WORDS, GENERIC_BANNED, hitsOf } = require('./lib/ui-copy');
 */

'use strict';

/* 不可恢复（L2）屏上的禁用词。
 * 判据的语义只有一句：**再点一次不会变好，就不要邀请玩家再点**。
 * 「重试 / 再试 / 稍后再试」都属于这种邀请。 */
const RETRY_WORDS = /再试一次|再试|重试|稍后\s*(再试|重试)/;

/* 通用失败词：把"为什么"藏起来的那类套话。
 * 失败态的标题必须说清是哪一类问题（网络 / 登录 / 存储），而不是"操作失败"。 */
const GENERIC_BANNED = /操作失败|请稍后重试|网络异常|请求失败|系统繁忙/;

/** 命中了哪些词（失败信息里给出具体词，比只报"命中"好定位） */
function hitsOf(re, text) {
  const m = String(text || '').match(new RegExp(re.source, re.flags.indexOf('g') < 0 ? re.flags + 'g' : re.flags));
  return m ? Array.from(new Set(m)) : [];
}

module.exports = { RETRY_WORDS: RETRY_WORDS, GENERIC_BANNED: GENERIC_BANNED, hitsOf: hitsOf };
