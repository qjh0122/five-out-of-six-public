/**
 * 版本门禁判据（P1-4 · 2026-11-20）
 *
 * 为什么单独成文件：判据既要给 `check-docs.js` 用，也要给单测喂**假样本**做变异自证。
 * 把正则和 git 输出解析写在守卫脚本里，单测就只能 spawn 整条命令、临时改真文件 ——
 * 那既慢又容易把工作区弄脏。这里只放纯函数；git 调用仍留在 check-docs.js。
 *
 * 守两件事：
 *   ① index.html 里本地 <script src> / <link href> 的 ?v= 必须等于 meta app-version；
 *   ② pwa/js|pwa/css|pwa/index.html 变了，app-version 与 SW CACHE_NAME 必须一起 bump。
 */
'use strict';

const META_RE = /<meta\s+name\s*=\s*["']app-version["']\s+content\s*=\s*["']([^"']+)["']/i;
const CACHE_RE = /CACHE_NAME\s*=\s*['"]([^'"]+)['"]/;
const TAG_RE = /<(script|link)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
const SOURCE_PATHS = ['pwa/index.html', 'pwa/js/', 'pwa/css/'];

function parseAppVersion(html) {
  const m = META_RE.exec(String(html || ''));
  return m ? m[1] : null;
}

function parseCacheName(sw) {
  const m = CACHE_RE.exec(String(sw || ''));
  return m ? m[1] : null;
}

function parseV(url) {
  const m = /[?&]v=([^&#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/** 只认本地引用（./ 或 / 开头）；外链 CDN 的版本不由本项目控制 */
function listAssetRefs(html) {
  const out = [];
  const re = new RegExp(TAG_RE.source, TAG_RE.flags);
  const src = String(html || '');
  let m;
  while ((m = re.exec(src))) {
    const url = m[3];
    if (!/^(?:\.\/|\/)/.test(url)) continue;
    out.push({ tag: m[1].toLowerCase(), attr: m[2].toLowerCase(), url: url, v: parseV(url) });
  }
  return out;
}

function checkVRefs(html, expected) {
  const want = expected || parseAppVersion(html);
  const refs = listAssetRefs(html).filter((r) => r.v !== null);
  return {
    version: want,
    refs: refs,
    mismatches: refs.filter((r) => r.v !== want)
  };
}

function parseVersionJson(text) {
  try {
    const j = JSON.parse(String(text || ''));
    return j && typeof j.v === 'string' ? j.v : null;
  } catch (e) { return null; }
}

function isSourcePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return SOURCE_PATHS.some((x) => x === 'pwa/index.html' ? s === x : s.startsWith(x));
}

/** 从 `git status --porcelain=v1` 里取变更路径（含暂存 / 未暂存 / 未跟踪）。 */
function changedPathsFromPorcelain(out) {
  return String(out || '').split(/\r?\n/)
    .filter((l) => l.length >= 4 && /^.{2}\s+/.test(l))
    .map((l) => l.slice(3))
    .map((p) => (p.indexOf(' -> ') >= 0 ? p.split(' -> ').pop() : p));
}

/** 从 `git diff --name-only` 里取变更路径 */
function changedPathsFromDiff(out) {
  return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 源码变更 ⇒ 两个版本真源都必须变。
 * 缺任一基线（无 git / 浅仓 / 文件读不到）时**跳过**，不把环境缺陷误判成漏 bump。
 */
function bumpDecision(changed, appVersion, headAppVersion, cacheName, headCacheName) {
  if (!changed) return { fail: false, reason: '源码未变', appBumped: false, cacheBumped: false };
  if (!appVersion || !headAppVersion || !cacheName || !headCacheName) {
    return { fail: false, reason: '读不到版本基线，跳过（不误红）', appBumped: false, cacheBumped: false };
  }
  const appBumped = appVersion !== headAppVersion;
  const cacheBumped = cacheName !== headCacheName;
  const missing = [];
  if (!appBumped) missing.push('app-version');
  if (!cacheBumped) missing.push('SW CACHE_NAME');
  return {
    fail: missing.length > 0,
    appBumped: appBumped,
    cacheBumped: cacheBumped,
    reason: missing.length
      ? '源码有变更但 ' + missing.join(' 与 ') + ' 未 bump'
      : 'app-version 与 SW CACHE_NAME 均已 bump'
  };
}

module.exports = {
  parseAppVersion, parseCacheName, parseV, listAssetRefs, checkVRefs,
  parseVersionJson, isSourcePath, changedPathsFromPorcelain, changedPathsFromDiff,
  bumpDecision
};
