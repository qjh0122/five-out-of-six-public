/**
 * 六选五 Service Worker（根路径 scope，静态缓存 + 离线兜底）
 *
 * 缓存策略：
 *  - 导航请求（/ 与页面跳转）：network-first（保证打开最新版，离线回退缓存）
 *  - 脚本/样式（/js/* /css/*）：**cache-first，只认 URL 全等**
 *    （`?v=` 就是 app-version，是内容指纹；同版本第二次打开一条请求都不发）
 *    install 时就把 `?v=<当前版本>` 写进缓存键（C7），与页面引用精确对齐：首访不再白下两遍。
 *  - 静态资源（/icons/* /assets/* /manifest.webmanifest）：cache-first（不常变、省流量）
 *  - /version.json：纯网络、不缓存、不预缓存（版本自检的真源，必须是服务器当前值）
 *  - /ws（WebSocket）与 /api：不拦截（联机必须在线）
 *
 * 两类 cache-first 的差别只在匹配方式：脚本/样式要求 URL **全等**（多一个 `?v=`
 * 不同就不算命中），静态资源允许忽略查询串（内容与 sharecode 无关）。
 * 前者是防「HTML 新、JS 旧」混版本的关键，后者只是为了换凭据后不重下图标。
 *
 * CACHE_NAME 每次发布 bump（v1→v2→…），activate 时清理旧缓存。
 */
const CACHE_NAME = 'weile-liuxuanwu-v160';

/* network-first 的超时上限。
 *
 * 原来的写法是 `fetch().then().catch(回落缓存)` —— catch 只在**网络失败**时触发。
 * 弱网下「慢但最终成功」的请求会一直等，页面就是一片白。而这个游戏的主要场景
 * 恰好是「饭桌上扫个链接进来」，饭馆里 4G 拥塞、地铁里信号抖动都很常见，
 * 实测这种环境下 fetch 挂 10-20 秒才开始返回。
 *
 * 所以改成：同时起一个计时器，谁先到听谁的。超时先返回**缓存副本**保证首屏可交互，
 * 同时让原请求继续跑（不 abort），它回来后照常写缓存 —— 下一次打开又是最新的。
 *
 * 两个值的取法：导航是「先让用户看见东西」，4.2 秒；脚本样式是「首屏依赖」，
 * 但缓存里一定有（install 阶段预缓存过），所以可以更激进，2 秒。
 *
 * 导航为什么从 3 秒提到 4.2 秒：线上实测**冷启动**（容器唤醒 / 进程冷启）拿到
 * index.html 首字节要 3.18s，之后 0.4–0.6s。3 秒的阈值恰好卡在这个量级上 ——
 * 服务其实马上就回了，SW 却先抢着给缓存，然后网络回来再刷新一次，
 * 用户看到的是「页面闪一下、内容重排一帧」，最坏还会先看到离线兜底页。
 * 卡在「3.18s 实测值」和「用户开始怀疑卡死」之间取 4.2s：
 * 比实测慢值多 1 秒余量，又没有长到让弱网用户干等。
 * 真正慢到 4 秒还没首字节的网络，给缓存本来就是对的。 */
const NAV_TIMEOUT_MS = 4200;
/* 脚本/样式**没有**超时阈值了：它们走缓存优先（见 fetch 里的 isJsCss 分支），
 * 命中就是 0 网络、0 等待；只有未命中才走网络。原来的 ASSET_TIMEOUT_MS = 2000
 * 是给 network-first 做兜底的，拿掉 network-first 之后它已无引用。 */

/* 访问凭据失效时的兜底页：比浏览器默认的「链接不完整」有用得多 */
const ACCESS_HINT = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>需要重新进入</title><style>'
  + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:linear-gradient(160deg,#1E5A44,#0E2A20);color:#FFF7E8;'
  + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}'
  + '.b{max-width:330px;text-align:center}'
  + '.t{font-size:20px;font-weight:700;margin:0 0 14px;color:#F5C15C}'
  + '.d{font-size:14px;line-height:1.8;color:rgba(255,247,232,.72);margin:0}'
  + '</style></head><body><div class="b">'
  + '<p class="t">访问链接已失效</p>'
  + '<p class="d">请让房主重新发一次邀请链接，<br>用新链接打开就能继续玩。</p>'
  /* 已安装到桌面的用户看不到任何「入口」，必须明说怎么办，
   * 否则他们的唯一判断是「这应用坏了」然后删掉。 */
  + '<p class="d" style="margin-top:14px;font-size:12px;opacity:.55">'
  + '已添加到桌面的话，用新链接打开一次，图标会自动恢复。</p>'
  /* 先试着自救，再谈「请找房主」。
   *
   * 桌面图标启动时请求的是 "/"（manifest.start_url），不带 sharecode；
   * 网关只认 30 天的 __wb_rsc cookie，cookie 没了就 403，而拿到 403 的这张页
   * 不是 index.html，index.html 顶部那段「补回 sharecode」的脚本根本不会执行 ——
   * 于是明明 localStorage 里还留着码，用户却只能看到一句「请让房主重发链接」，
   * 而他手里只有一个图标，没有一个能粘链接的地方。
   *
   * 这里补上同一段自救：有码就带着码重新打开一次（顺带刷新网关那 30 天 cookie）。
   * 用 sessionStorage 记一次「已经试过」：万一存的是个过期码，第二轮就别再跳，
   * 老老实实显示这句话 —— 否则就是一个跳不出去的死循环。 */
  + '<script>(function(){try{'
  + 'var KEY="lxw_sharecode_v1",FLAG="lxw_sc_retried";'
  + 'var code=localStorage.getItem(KEY);'
  + 'if(!code)return;'
  + 'try{if(sessionStorage.getItem(FLAG)==="1")return;sessionStorage.setItem(FLAG,"1");}catch(e2){return;}'
  + 'location.replace("/?sharecode="+encodeURIComponent(code));'
  + '}catch(e){}})();</' + 'script>'
  + '</div></body></html>';

/* 部署网关要求**每一个请求**都带 ?sharecode=xxx（连 /api/health 都不例外）。
 * 页面是用 ?sharecode=xxx 打开的，而 SW 的脚本 URL 是 /sw.js —— 它自己拿不到页面上的查询串，
 * 所以 register 时就把查询串接在 SW 脚本地址后面（index.html 里做），这里再从 self.location 取。
 *
 * 这一步是必须的：以前 PRECACHE 里全是裸路径，生产环境每一条都被网关 403，
 * 而 install 里的 `.catch(function(){ return null; })` 把失败全吞了 ——
 * 表现是 SW 装得上、离线却什么都打不开，且没有任何一处日志能看出来。 */
const SHARE_QUERY = (function () {
  try { return new URL(self.location.href).search || ''; } catch (e) { return ''; }
})();
function withShare(u) {
  if (!SHARE_QUERY) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + SHARE_QUERY.slice(1);
}

/* C7：js/css 的 **缓存键**要带 app-version，与 index.html 的 `?v=` 逐字一致。
 * 注意 withShare() 只用于**网络请求**（生产网关每个请求都要 sharecode）；页面侧
 * 的 script/link 并不带 sharecode，所以真正被命中的键是这里生成的「只有 ?v=」那一版。
 * 两个键指向同一份响应：少一个则首访白下一遍（原来的 35 裸 + 35 版本化）。 */
function withAppVersion(u, v) {
  if (!v || !/^\/(js|css)\//.test(u)) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(v);
}

/* app-version 的真源只有 index.html 的 meta。SW 不另存常量 —— 多一份副本就多一处
 * 会漂移的真源，而漂移的后果正是「HTML 新、JS 旧」那次小王事故。 */
function parseAppVersion(text) {
  try {
    var m = /<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/.exec(text || '');
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

/* /version.json **故意不在 PRECACHE 里**：它是版本自检的真源，
 * 预缓存 = 把上线那一刻的版本号冻在客户端，此后自检永远报「一致」。
 * 它在 fetch 事件里单独走纯网络分支（见下方）。
 *
 * 下面仍写裸路径（清单是「要预缓存哪些文件」，不是缓存键本身）。install 会按
 * withAppVersion() 给 /js/* 与 /css/* 加当前 `?v=`，再经 withShare() 拼网关凭据。 */
const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/records.css',
  '/css/emoji.css',
  '/js/engine.js',
  '/js/errorReport.js',
  '/js/card.js',
  '/js/config.js',
/* 表情/短语清单：**前端与服务端共用同一份**。不预缓存的话离线打开面板
 * 会显示「表情没加载出来」，而这个清单本身只有几 KB。 */
  '/js/emoji.js',
/* 成就：stateMachine 结算时调 Ach.accumulate() 采集，**必须排在它前面**。
 * 不预缓存的话离线打一局，成就静默不记（Ach 是 undefined，代码里有判空兜底，
 * 所以不会报错、也不会崩 —— 只是白打）。这类「不崩但丢数据」的缺失最难发现。 */
  '/js/achievements.js',
  '/js/bestLine.js',
  '/js/stateMachine.js',
/* 存储收口（v111）：**必须**预缓存，而且是**阻塞加载**（index.html head 里没有 defer）。
 * 它 404 的话连「分享码自愈」和首帧会话判断都会失效 —— 桌面图标打开时的兜底路径
 * 正好就依赖它，而那条路径只有真实安装用户会走到，本地探针很难覆盖。 */
  '/js/storage.js',
  '/js/authStore.js',
  '/js/roomStore.js',
/* 统计口径（v111 收口）：records.js 与 server/profile.js 共用一份。
 * 它 404 的话 records.js 加载后第一次算统计就抛 —— 战绩页整页空，
 * 而且因为是 deferred 脚本，控制台里只有一条与「战绩」看起来无关的错。 */
  '/js/stats.js',
  '/js/records.js',
/* 场次档案（整场回放的数据源）。它不预缓存不会崩 —— game.js 每个调用点都用
 * typeof 判断兜底 —— 但离线时会静默退化成「只能看单把」，
 * 而整场回放正是这个模块的核心功能。所以必须在这里。 */
  '/js/sessionLog.js',
  '/js/sfx.js',
  '/js/slotLayout.js',
  /* 头像预设：离线时缺它整个座位会退成「昵称首字」，不算致命，
   * 但 48 款头像本来就是靠它现场生成 SVG 的（没有图片文件要下载）。 */
  '/js/avatar.js',
  /* 座位环几何：离线时如果它是 404，顶栏会退成「没有座位的空桌」——
   * 比缺一个统计脚本严重得多（玩家看不到任何对手）。 */
  '/js/ringGate.js',
  '/js/seatRing.js',
/* ★ v108 拆出来的 8 个模块。全部**必须**预缓存：
 * game.js 是同步 IIFE，开头就 `window.LXW.utils` 取工具函数 ——
 * 任何一个 404，整页白屏（不是降级，是 ReferenceError）。
 * 顺序与 index.html 保持一致，方便对读。 */
  '/js/gameUtils.js',
  '/js/cardView.js',
  '/js/modalKit.js',
  '/js/nextRoundHints.js',
  '/js/undoBar.js',
  '/js/historyKit.js',
  '/js/accountView.js',
  '/js/settleView.js',
  '/js/seatSheetView.js',
/* 四态的状态机（build-states v1）。**必须排在 recordsView 之前**：
 * recordsView 在 create() 时就要拿到 LXW.recordsState，拿不到会退回两态兜底 ——
 * 页面看着正常，四个态里丢了两个，只有断言能发现。 */
  '/js/recordsState.js',
  '/js/recordsView.js',
  '/js/achievementsView.js',
  '/js/game.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
/* 13 张表情（共约 190 KB）：**预缓存**而不是「用到再缓存」。
 * 表情面板第一次打开时如果断网，按需缓存就是 13 个碎图 —— 那比不显示更难看；
 * 而玩家开面板往往正是在「没网/网差」的时候。 */
  '/assets/emoji/e0-dizzy.png',
  '/assets/emoji/e1-devil.png',
  '/assets/emoji/e10-rage.png',
  '/assets/emoji/e11-shock.png',
  '/assets/emoji/e12-grit.png',
  '/assets/emoji/e2-money.png',
  '/assets/emoji/e3-confused.png',
  '/assets/emoji/e4-love.png',
  '/assets/emoji/e5-cry.png',
  '/assets/emoji/e6-grin.png',
  '/assets/emoji/e7-angry.png',
  '/assets/emoji/e8-smug.png',
  '/assets/emoji/e9-sweat.png',
  '/assets/home_bg.webp',
  '/assets/table_bg.webp',
  '/assets/card_back.webp',
/* 5 张指定头像（共约 15 KB）：同样是「预缓存」。
 * 它们是某个玩家在牌桌上的唯一标识 —— 断网时按需缓存的失败结果是
 * 那一格空着，别人认不出是谁；而这几张加起来还没一张表情大。 */
  '/assets/avatar-custom/pierrec.webp',
  '/assets/avatar-custom/shahuo.webp',
  '/assets/avatar-custom/pokergod.webp',
  '/assets/avatar-custom/daniuge.webp',
  '/assets/avatar-custom/will.webp',
  '/assets/audio/sfx_deal.mp3',
  '/assets/audio/sfx_select.mp3',
  '/assets/audio/sfx_submit.mp3',
  '/assets/audio/sfx_win.mp3',
  '/assets/audio/sfx_settle.mp3'
  // 注意：bgm_room_loop.mp3 不进 PRECACHE —— BGM 是懒加载（首次手势解锁后才创建 Audio），
  // 预缓存它等于首屏白白下载 155KB 循环背景乐。首次播放时走 cache-first 分支照样会缓存。
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        /* C7：index.html **只抓一次**，同时干两件事：
         *   ① 写离线兜底需要的 '/' 与 '/index.html' 两条缓存键（原来 PRECACHE 里各一条）；
         *   ② 从它的 meta 读当前 app-version，给 js/css 的预缓存键加 ?v=。
         * 单独再 fetch 一次 index.html 只为了读版本号会白下 92KB，与 C7 省流量的目标相反。 */
        var indexUrl = withShare('/index.html');
        return fetch(indexUrl, { cache: 'no-store' })
          .then(function (res) {
            if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
            var textP = res.clone().text();
            var putP = Promise.all([
              cache.put(indexUrl, res.clone()),
              cache.put(withShare('/'), res.clone())
            ]);
            /* 正文和写入都完成后再取版本：clone 必须在 body 被读之前建立（上面已 clone）。 */
            return Promise.all([textP, putP]).then(function (got) { return parseAppVersion(got[0]); });
          })
          .catch(function (e) {
            /* 读不到版本就退回旧行为（裸路径键），离线能力不能因此整片废掉；但要留痕迹。 */
            console.warn('[sw] 读不到 index.html/app-version，本次预缓存退回无版本键：'
              + ((e && e.message) || 'failed'));
            return { appVersion: '', failed: { url: indexUrl, err: (e && e.message) || 'failed' } };
          })
          .then(function (r) {
            var appVersion = typeof r === 'string' ? r : r.appVersion;
            var indexFailures = (r && r.failed) ? [r.failed] : [];
            /* 逐个容错 add：单个资源 404 不能整个 install 失败，否则连 SW 都装不上。
             * 但**失败必须留下痕迹** —— 之前这里是 `.catch(() => null)`，
             * 生产上 30 个资源集体 403 也一声不响，离线能力等于零而没人知道。
             * 现在收集失败项：控制台打一条带 URL 清单的警告，并挂到 self 上供诊断页读取。 */
            return Promise.all(PRECACHE.map(function (u) {
              if (u === '/' || u === '/index.html') return null; // 上面已抓并写了，别再下一遍
              var canonical = withAppVersion(u, appVersion);
              var url = withShare(canonical);
              /* ★ C7 真正省流量的一刀：defer 脚本在 load 之前就请求完了，SW 的 install
               * 是在页面 load 时才注册的，所以页面**已经**按 `?v=<当前版>` 取过并写进缓存。
               * 先查同版本键在不在：在就跳过，不再为同一份内容发第二遍网络请求。
               * 查的是**精确键**（带 v），不是 ignoreSearch —— 老版本条目不会被当成命中。 */
              var hitKey = (canonical !== u) ? canonical : url;
              return cache.match(hitKey).then(function (already) {
                if (already) return null;
                return cache.add(url).then(function () {
                  if (canonical === url) return null;
                  /* 网络键带 sharecode、页面键只有 ?v=：把同一份响应写进页面会精确命中的那个键。 */
                  return cache.match(url).then(function (cached) {
                    if (!cached) return { url: canonical, err: 'alias source missing' };
                    return cache.put(canonical, cached.clone()).then(function () { return null; })
                      .catch(function (e) { return { url: canonical, err: (e && e.message) || 'alias failed' }; });
                  });
                }).catch(function (e) { return { url: url, err: (e && e.message) || 'failed' }; });
              });
            })).then(function (results) { return indexFailures.concat(results.filter(Boolean)); });
          })
          .then(function (failed) {
            self.__precacheReport = {
              total: PRECACHE.length,
              failed: failed.length,
              detail: failed,
              sharecode: !!SHARE_QUERY,
              at: Date.now()
            };
            if (failed.length) {
              /* 一条警告说清楚：多数情况是 sharecode 没带上（全部失败）或个别资源改名 */
              console.warn('[sw] 预缓存失败 ' + failed.length + '/' + PRECACHE.length
                + ' 条' + (SHARE_QUERY ? '' : '（本次未带 sharecode，生产网关会全部 403）') + '：');
              failed.forEach(function (f) { console.warn('  - ' + f.url + '  ' + f.err); });
            }
          });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* network-first + 超时兜底。
 * 返回 Promise<Response | null>：null 表示「超时或失败」，由调用方回落缓存。
 *
 * 两个刻意的细节：
 *
 * 1. **clone 必须在 then 里立刻做，且在把 res 交给页面之前。**
 *    Response 的 body 只能被读一次，等页面消费过再 clone 会直接抛。
 * 2. **超时后不 abort。** 原请求继续跑，拿到 ok 响应照样写缓存 ——
 *    这正是「首屏快」和「下次打开是新的」能同时成立的原因。
 *    如果 abort 掉，下次打开还是旧缓存，改完代码不生效的锅又回来了。
 */
function networkFirst(req, timeoutMs) {
  const netP = fetch(req).then(function (res) {
    if (!res) return null;
    /* 网关鉴权失败（分享凭据失效）：给一句能看懂的话，别把 403 页面直接丢给玩家。
     * 只对导航做这个替换——脚本/样式拿到 403 时若返回 HTML，
     * 浏览器会把 HTML 当 JS 执行，报一堆语法错，比原来的 403 更难查。 */
    if (res.status === 403 && req.mode === 'navigate') {
      return new Response(ACCESS_HINT, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    if (res.ok) {
      try {
        const copy = res.clone();
        caches.open(CACHE_NAME)
          .then(function (c) { return c.put(req, copy); })
          .catch(function () { /* 配额满 / 隐私模式禁用缓存：不该影响页面 */ });
      } catch (e) { /* body 已被消费过，这一份就不缓存了 */ }
    }
    return res;
  }, function () { return null; });

  const timeoutP = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, timeoutMs);
  });

  return Promise.race([netP, timeoutP]);
}

/* 脚本/样式的兜底匹配：**版本号不同的缓存一律不复用**。
 *
 * 为什么不能只写 `caches.match(req, { ignoreSearch: true })`：
 * ignoreSearch 会把 `?v=`（app-version）一起忽略 —— 而那正是「这份 JS 属于哪一版」
 * 的唯一标记。于是只要网络慢过一次、命中兜底，页面就会拿到上一版的 card.js / game.js：
 * HTML 是新的、JS 是旧的、版本号看着也一致，行为却是旧的。这种「混版本」最难查。
 *
 * 实测代价（2026-11-12，加小王那天）：服务端已经发 54 张牌（含 rank 14.5 的小王），
 * 旧版 drawJoker 只画彩色、不认 small 参数 —— 两张王长得一模一样，玩家看到的是
 * 「规则没区分大小王」，实际是客户端跑着旧代码。断点单测（v144 的 card.js
 * 对 rank 15 / 14.5 的绘制调用序列完全相同）确认了这条链。
 *
 * 两个刻意的取舍：
 *   ① 缓存条目**没有 v** 视为可用。C7 之后 PRECACHE 写的是带 v 的键，这条只为
 *      历史/异常写入的无 v 条目兜底（例如 C7 前残留的缓存、读不到 meta 时退回的写入）；
 *      不放行会把那些场景的离线能力整片废掉。**它不是省流量的口子**：有 v 且不一致一律拒绝。
 *   ② 有 v 但不一致 → 返回 null（这次请求就失败了）。宁可让控制台明确报一个缺失，
 *      也不静默跑旧代码 —— 静默跑旧代码的代价是「已经修好的 bug 在用户那边原样复现」，
 *      而且没有任何人看得出来。
 */
function vOf(u) {
  try { return new URL(u, self.location.href).searchParams.get('v') || ''; } catch (e) { return ''; }
}
function matchSameVersion(req) {
  return caches.match(req).then(function (exact) {
    if (exact) return exact;
    return caches.match(req, { ignoreSearch: true }).then(function (loose) {
      if (!loose) return null;
      const want = vOf(req.url);
      const got = vOf(loose.url || '');
      return (!got || want === got) ? loose : null;
    });
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // WebSocket / REST 不走 SW（本游戏无 REST，联机必须在线）
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;

  /* 版本探针：纯网络，既不读缓存也不写缓存。
   * 它必须每次回答「服务器现在是哪一版」—— cache-first 会把旧版冻住，
   * network-first 的超时兜底会在弱网时用旧版冒充新版，两者都让自检失去意义。
   * 断网就让它失败，页面的 catch 会跳过检查（保留 403 / 离线兜底语义）。 */
  if (url.pathname === '/version.json') {
    event.respondWith(fetch(req));
    return;
  }

  const isJsCss = /^\/(js|css)\//.test(url.pathname);
  const isCacheFirst = /^\/(icons|assets)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest';

  if (req.mode === 'navigate') {
    // 导航：network-first + 超时兜底（3 秒没回来先给缓存，离线也能打开）
    event.respondWith(networkFirst(req, NAV_TIMEOUT_MS).then(function (res) {
      if (res) return res;
      /* 离线 / 超时兜底：缓存键里现在带着 sharecode（见 PRECACHE 的说明），
       * 查询串一变就匹配不上，所以一律 ignoreSearch。 */
      return caches.match(req, { ignoreSearch: true })
        .then(function (r) { return r || caches.match('/index.html', { ignoreSearch: true }); })
        .then(function (r) { return r || Response.error(); });
    }));
    return;
  }

  if (isJsCss) {
    /* 脚本/样式：**缓存优先，且只认 URL 全等的那一份**。
     *
     * 为什么可以从 network-first 改成 cache-first：
     *   `<script src="./js/game.js?v=20261112b">` 里的 `?v=` 就是 app-version，
     *   也就是内容指纹 —— 发布时版本 bump，URL 跟着变，缓存必然 miss，自然去拿新的。
     *   URL 不变 = 内容不变，可以永久复用，不存在"拿不到新代码"。
     *
     * 为什么必须改（2026-11-14 用户报「每次打开卡一会儿」）：
     *   network-first 意味着每次打开，32 个脚本 + 3 个样式**全部先过一遍网络**。
     *   网关给的是 `max-age=3600`：一小时内还算快，隔夜打开就是 1.4MB 全量重下
     *   （gzip 后约 380KB，32 个请求），首屏卡在下载上。而 SW 缓存里明明有。
     *   改成 cache-first 后，同一版本的第二次打开，脚本样式一条请求都不发。
     *
     * 与「混版本」的关系（这是之前踩过的坑，必须说清）：
     *   旧实现用 `caches.match(req, {ignoreSearch:true})` 兜底，会把 `?v=` 一起忽略，
     *   于是可能把上一版 JS 交给新版 HTML。现在**只做精确匹配**：URL 差一个字符
     *   就当没有。真拿不到（缓存被清、首次访问）就走网络；
     *   网络也失败才退回 `matchSameVersion`（它仍然校验 v，不一致就丢弃）。
     *   所以这条改动让"混版本"更不可能发生，而不是更可能。 */
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME)
              .then(function (c) { return c.put(req, copy); })
              .catch(function () { /* 配额满 / 隐私模式：不影响本次使用 */ });
          }
          return res;
        }, function () {
          /* 断网：退到"同版本任意查询串"的缓存，仍校验 v */
          return matchSameVersion(req).then(function (r) { return r || Response.error(); });
        });
      })
    );
    return;
  }

  if (isCacheFirst) {
    // 静态资源（图标/图片/音频/manifest）：cache-first（不常变、省流量）
    /* ignoreSearch 与另外两条分支保持一致：缓存键里带着 ?sharecode=xxx
     *（PRECACHE 用的就是 withShare），凭据一换、或者用户从另一条链接进来，
     * 查询串不同就匹配不上 —— 图标和牌桌背景会在有网的情况下也重新下一遍。
     * 这些文件的内容与查询串无关，忽略它才是对的。 */
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});
