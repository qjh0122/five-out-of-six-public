/**
 * 对局页的座位交互：点头像弹面板（表情 / 短语 / 信息）+ 表情收发与播报
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 554 行，全部围绕「点一个人的头像」这一件事：怎么区分「拖动座位条」和
 * 「点座位」、「面板贴着座位弹在哪」、「发出去的表情怎么在别人屏幕上播」。
 * 它原来是牌桌渲染的邻居，但两者的生命周期完全不同 —— 牌桌每次广播重画，
 * 面板却要在重画之间保持打开。混在一起最容易踩的就是「重画把面板冲掉」。
 *
 * ── 三个已经踩过的坑（原注释逐条保留）─────────────────────────────
 *   ① 座位条 .gt-opps 是横向滚动容器：全程移动 < 8px 才算点击，
 *      拖动后 450ms 内抑制合成 click（移动端同一手势会再发 click）。
 *   ② 面板内所有点击走**事件委托**：13 个表情 + 8 条短语 + N 个人各绑一个监听，
 *      每开一次就多 20 多个闭包，开几十次就是内存泄漏现场。
 *   ③ 信息档内容是**异步**来的，填完必须 `placeSeatSheet()` 重新定位 ——
 *      不重排就会按「加载中」那个矮盒子定位，然后往下长出去（矮横屏直接出屏）。
 *
 * ── 注入 ────────────────────────────────────────────────────────
 * 只有 7 项，而且都是纯查询/纯渲染：avatarInner / profileBodyHtml / getMe /
 * flash / stageScale / esc / short。面板自己持有全部内部状态
 * （ssPid / ssTab / emojiTarget / oppTap），不向外部暴露。
 *
 * 浏览器全局：`window.LXW.seatSheetView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var U = global.LXW.utils;
    var $ = U.$, el = U.el, esc = U.esc, short = U.short;
    var colorFor = U.colorFor, netText = U.netText, netCls = U.netCls, cardText = U.cardText;

    /* ★ state 必须注入，理由见 settleView.js 同处注释：模块是独立作用域。 */
    var state = deps.state;
    var avatarInner = deps.avatarInner, profileBodyHtml = deps.profileBodyHtml;
    var getMe = deps.getMe, flash = deps.flash, stageScale = deps.stageScale;

  /* ---------------------------- 对局页座位：区分「拖动」与「点击」 ----------------------------
   * 座位条 .gt-opps 是横向滚动容器，手指滑动时不能误弹战绩卡。
   * 规则：全程移动距离 < 8px 才算点击；拖动后 450ms 内抑制合成 click（移动端同一手势会再发 click）。
   * 命中目标 .gt-opp（对手）和 .gt-me（右上角自己）一视同仁 —— 点自己也要能看战绩。 */
  var PROF_TAP_SEL = '.gt-opp, .gt-me';
  var oppTap = { x: 0, y: 0, moved: false, suppressUntil: 0 };

  function bindOppSeatTap() {
    var top = $('#game-top');
    if (!top) return;
    top.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      oppTap.x = t.clientX; oppTap.y = t.clientY; oppTap.moved = false;
    }, { passive: true });
    top.addEventListener('touchmove', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - oppTap.x) > 8 || Math.abs(t.clientY - oppTap.y) > 8) oppTap.moved = true;
    }, { passive: true });
    top.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      oppTap.suppressUntil = Date.now() + 450;
      if (oppTap.moved || !t) return;                      // 拖动过 → 不弹卡
      var hit = document.elementFromPoint ? document.elementFromPoint(t.clientX, t.clientY) : null;
      /* 表情钮必须先判：这一条后面会把紧随其后的合成 click 压掉 450ms，
       * 若不在 touchend 里处理，移动端这个按钮会变成「点了没反应」。 */
      var emo = hit && hit.closest ? hit.closest('#btn-emoji') : null;
      if (emo) { openEmojiSheet(); return; }
      var card = hit && hit.closest ? hit.closest(PROF_TAP_SEL) : null;
      /* v89：点座位不再直接弹战绩卡，而是弹「贴着他的面板」——
       * 战绩只是其中一档，另两档是表情与短语（设计稿 §6.1）。 */
      if (card && card.dataset.pid) openSeatSheet(card.dataset.pid, card);
    }, { passive: true });
    top.addEventListener('click', function (e) {
      if (Date.now() < oppTap.suppressUntil) return;       // 移动端触摸后紧跟的合成 click
      var emo = e.target.closest ? e.target.closest('#btn-emoji') : null;
      if (emo) { openEmojiSheet(); return; }
      var card = e.target.closest ? e.target.closest(PROF_TAP_SEL) : null;
      if (card && card.dataset.pid) openSeatSheet(card.dataset.pid, card);
    });
  }

  /* ============================ 表情 / 短语（v82 R4） ============================
   * 链路：RoomStore.sendEmoji →（ws 服务端旁路广播 / local BroadcastChannel）→
   *        RoomStore.onEmoji → playEmoji()
   *
   * **不做乐观渲染**：自己发的那条也从同一条回程路径回来。这样「我能看见、
   * 别人看不见」这类只在一个方向上出错的问题，自测时立刻暴露 —— 自己都看不见
   * 就说明链路断了，而不是「看起来成功了」。
   *
   * 服务端只转发、不落库：表情 1.6 秒就消失，进回放/云同步只会变成脏数据。
   */
  var emojiTarget = null;        // '*' 或某个 playerId
  var emojiLastSend = 0;         // 客户端 2 秒节流（服务端还有一层，这里只为给出提示）

  function emojiReady() {
    return typeof Emoji !== 'undefined' && Emoji && typeof Emoji.isValid === 'function';
  }

  /* 表情开关的运行时覆盖：?emoji=0 / ?emoji=1。
   *
   * 为什么要有，而 `CONFIG.EMOJI` 不够：**回滚能力必须对称**。
   * 准备态那个开关有 `?tableready=0`，值班的人改个 URL 就能验老路径；
   * 表情没有的话，"关掉表情会看到什么"这件事只能靠改 config.js 再部署一次
   * 才能验 —— 而灰度期最不该做的事就是"为了验证回滚再发一次版"。
   *
   * 三种人用得上：
   *   ① 值班的人 —— 单台设备上验一遍退回去的样子，不影响别人；
   *   ② 探针 —— 「关掉开关后行为与 R3 一致」这句承诺必须能被自动验证
   *      （scripts/probe-rollback.js）；
   *   ③ 排障 —— 玩家说"表情发不出去"，先让他 ?emoji=0 看是不是这一块的问题。
   *
   * 只认 0/1，其余一律按 CONFIG 走 —— 与 tableReadyFlag 同一条规矩：
   * 一个笔误不该把功能关掉。 */
  function emojiFlag() {
    var q = '';
    try { q = new URLSearchParams(location.search || '').get('emoji') || ''; } catch (e) { q = ''; }
    if (q === '0') return false;
    if (q === '1') return true;
    return CONFIG.EMOJI !== false;
  }

  /* 座位锚点：顶栏里带 data-pid 的那一格（对手在 .gt-opps，自己在 .gt-me）。
   * 不用 document.querySelector('[data-pid="..."]')：playerId 是外部字符串，
   * 直接拼进选择器会被引号/方括号打断，遍历比对最稳且人数最多 5 个。 */
  function seatEl(pid) {
    var top = $('#game-top');
    if (!top || !pid) return null;
    var all = top.querySelectorAll('[data-pid]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-pid') === String(pid)) return all[i];
    }
    return null;
  }

  function seatRect(pid) {
    var e = seatEl(pid);
    return e ? e.getBoundingClientRect() : null;
  }

  function emojiOthers() {
    var room = state.room;
    if (!room || !room.players) return [];
    return room.players.filter(function (p) { return p.id !== state.myId && !p.left; });
  }

  /* ★ 这里原本有 renderEmojiTargets()：面板顶部一行「全 全场 / 机器人1 / 机器人2…」，
   * 让人在面板里再选一次发给谁。2026-11-14 删掉，理由两条：
   *
   *   ① 目标在**入口**就已经确定了，那一行是重复提问。点桌面表情钮进来必然是全场
   *      （面板标题已经写着「发给全场 / 所有人都看得到」），点某个人头像进来必然是
   *      他（标题就是他名字）—— 同一件事问两遍，第二遍还允许改主意，反而让人怀疑
   *      「我刚点的到底发给谁」。
   *   ② 它和标题区冲突。标题说「机器人3」，下面那行高亮的却是「全场」，两个都像
   *      当前选中项，玩家不知道该信哪个。
   *
   * 删掉之后 `emojiTarget` 完全由 `ssPid` 决定（见 renderSeatSheet 里那一行），
   * 只有一条赋值路径，不可能出现「标题一个人、实发另一个人」。 */

  function renderEmojiGrid() {
    var box = $('#emoji-grid');
    if (!box || !emojiReady()) return;
    var list = Emoji.list();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="emoji-cell" type="button" data-emoji="' + list[i].id + '"'
        + ' aria-label="' + esc(list[i].name) + '">'
        + '<img src="' + list[i].src + '" alt="" aria-hidden="true" draggable="false"></button>';
    }
    box.innerHTML = html;
  }

  function renderEmojiPhrases() {
    var box = $('#emoji-phr');
    if (!box || !emojiReady()) return;
    var list = Emoji.phrases();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="phrase-row" type="button" data-emoji="' + list[i].id + '">'
        + esc(list[i].text) + '</button>';
    }
    box.innerHTML = html;
  }

  /* ======================= 统一浮层面板（v89 · 设计稿 §6.1）=======================
   *
   * 早先是两个互不相干的入口：底部表情 sheet（#emoji-modal）+ 战绩弹窗（openProfile）。
   * 同一件事（看这个人 / 对他做个表情）要玩家自己记住从哪儿进，而且表情面板
   * 永远不知道该发给谁 —— 得先选「发给谁」再选表情。
   *
   * 现在只有一张面板，**对着谁**由「点了谁」决定：
   *   点对手 → 表情 / 短语 / 信息 三档，面板贴着他弹（右 → 左 → 下 → 上）
   *   点自己 → 只有信息档（自己给自己发表情没有意义）
   *   点表情钮 → 对着「全场」，只有表情 / 短语两档
   *
   * 面板是 #stage 里的绝对定位元素（设计像素坐标），不是 fixed 弹窗 ——
   * 贴着座位要求它跟着舞台缩放走，而 #stage 有 transform: scale()。
   * ★ 表情飞行动画仍然在 #stage 外面（见 index.html 注释），两套坐标各管各的。 */
  var ssPid = null;        // 面板当前对着谁；null = 全场
  var ssAnchorEl = null;   // 锚点（被点的座位 / 表情钮），重排时重新定位
  var ssTab = 'emoji';     // 当前档：emoji / phr / info

  function ssPlayer(pid) {
    var room = state.room;
    if (!room || !pid) return null;
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === pid) return room.players[i];
    }
    return null;
  }

  /* 兜底署名的昵称（规格 §4.3）：按 `ev.from` 去 `state.room.players` 里取。
   * 取不到（人已经离房 / 不在本房间）用「对方」—— 署名宁可含糊，也不能空着：
   * 空着等于「不指人且不署名」，那是 Q10 明确不允许的那一档。 */
  function senderName(pid) {
    var p = pid ? ssPlayer(pid) : null;
    var n = p && p.nickname ? String(p.nickname) : '';
    return n || '对方';
  }

  function seatSheetOpen() {
    /* 不要叫 el —— 会遮蔽顶层那个造 DOM 的 el() 工具函数（ui.test 有专门一条守这个） */
    var sheet = $('#seat-sheet');
    return !!(sheet && !sheet.classList.contains('hidden'));
  }

  /* 落点：右 → 左 → 下 → 上。
   * 为什么是这个顺序：右手持机时「右边」最容易看到且不遮住牌桌左半；
   * 左右都放不下才落上下 —— 上下会盖住组槽或座位，代价更大。
   * 四个方向都放不下（极小屏）就把面板夹回舞台内，宁可稍微压一点锚点，
   * 也不能让面板跑到屏幕外（那比位置难看严重得多）。 */
  function placeSeatSheet() {
    var sheet = $('#seat-sheet');
    var anchor = ssAnchorEl;
    if (!sheet || sheet.classList.contains('hidden')) return;
    var sc = stageScale() || 1;
    var stage = $('#stage');
    var sr = stage.getBoundingClientRect();
    var sw = stage.offsetWidth || 750;
    var sh = stage.offsetHeight || 1624;
    var w = sheet.offsetWidth || 520;
    var h = sheet.offsetHeight || 400;
    var pad = 16;
    var gap = 18;
    var left, top, side;

    if (anchor && anchor.getBoundingClientRect) {
      var ar = anchor.getBoundingClientRect();
      var ax = (ar.left - sr.left) / sc;
      var ay = (ar.top - sr.top) / sc;
      var aw = ar.width / sc;
      var ah = ar.height / sc;
      if (ax + aw + gap + w <= sw - pad) {
        side = 'right'; left = ax + aw + gap; top = ay + ah / 2 - h / 2;
      } else if (ax - gap - w >= pad) {
        side = 'left'; left = ax - gap - w; top = ay + ah / 2 - h / 2;
      } else if (ay + ah + gap + h <= sh - pad) {
        side = 'below'; left = ax + aw / 2 - w / 2; top = ay + ah + gap;
      } else {
        side = 'above'; left = ax + aw / 2 - w / 2; top = ay - gap - h;
      }
      /* 缩放原点朝锚点：弹出来的方向要「从那个人身上长出来」，而不是从中间炸开 */
      sheet.style.setProperty('--ss-origin',
        (side === 'right' ? '0%' : side === 'left' ? '100%' : '50%')
        + ' ' + (side === 'below' ? '0%' : side === 'above' ? '100%' : '50%'));
    } else {
      side = 'center'; left = (sw - w) / 2; top = (sh - h) / 2;
    }

    left = Math.max(pad, Math.min(left, sw - w - pad));
    top = Math.max(pad, Math.min(top, sh - h - pad));
    sheet.style.left = Math.round(left) + 'px';
    sheet.style.top = Math.round(top) + 'px';
    sheet.setAttribute('data-side', side);
  }

  /* 信息档 = **整张战绩卡**（`profileBodyHtml`），不再是「摘要 + 看完整战绩」。
   *
   * 为什么改（v107，用户反馈）：原来这里放三个数字 + 胜平负，再给一个「看完整战绩」
   * 按钮。点进去之后，那张卡的头两行**和刚才一模一样**，多出来的只有一次点击、
   * 一次请求和一次动画。玩家以为自己在「进详情」，其实只是在同一个东西上又点了一下。
   *
   * 现在点一次就看到全部。面板本来就有 max-height + 内部滚动（emoji.css 的
   * `.seat-sheet` / `.ss-info`），内容再高也兜得住；但**填完必须重新定位**，
   * 原因见下面 placeSeatSheet() 那处注释。
   *
   * 空态仍然分开：这里一句话就够，整卡那张才需要插画。 */
  function renderSeatInfo(pid) {
    var box = $('#ss-info');
    if (!box || !pid) return;
    var p = ssPlayer(pid);
    if (p && p.isBot) {
      box.innerHTML = '<p class="ss-note">AI 没有战绩。补齐人头用的，走了也不留痕。</p>';
      placeSeatSheet();
      return;
    }
    if (typeof RoomStore === 'undefined' || !RoomStore.canQueryProfile || !RoomStore.canQueryProfile()) {
      box.innerHTML = '<p class="ss-note">本地演示模式看不了别人的战绩。</p>';
      placeSeatSheet();
      return;
    }
    box.innerHTML = '<p class="pf-loading">加载中…</p>';
    RoomStore.getProfile(pid).then(function (res) {
      if (ssPid !== pid || !seatSheetOpen()) return;   // 已经切到别人 / 面板关了
      if (!res || res.ok === false) {
        box.innerHTML = '<p class="ss-note">' + esc((res && res.error) || '加载失败') + '</p>';
        placeSeatSheet();
        return;
      }
      var pr = res.profile;
      if (!pr) {
        box.innerHTML = '<p class="ss-note">还没有战绩，打完一局就有了。</p>';
        placeSeatSheet();
        return;
      }
      box.innerHTML = profileBodyHtml(pr);
      /* ★ 内容变高之后必须重新定位。
       * placeSeatSheet() 是拿 sheet.offsetHeight 算落点的，而这里的内容是异步填的 ——
       * 打开那一刻量到的是「加载中…」的高度。不重算的话，面板会按一个矮盒子定位，
       * 然后向下长出一大截，在矮屏上直接出屏。 */
      placeSeatSheet();
    }).catch(function () {
      if (ssPid !== pid) return;
      box.innerHTML = '<p class="ss-note">这位玩家的战绩没读上来，关掉面板重新打开</p>';
      placeSeatSheet();
    });
  }

  function setSeatTab(tab) {
    var g = $('#emoji-grid'), ph = $('#emoji-phr'), info = $('#ss-info');
    var allowed = { emoji: 1, phr: 1, info: 1 };
    ssTab = allowed[tab] ? tab : 'emoji';
    var tabs = document.querySelectorAll('#ss-tabs [data-ss-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-ss-tab') === ssTab;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (g) g.classList.toggle('hidden', ssTab !== 'emoji');
    if (ph) ph.classList.toggle('hidden', ssTab !== 'phr');
    if (info) info.classList.toggle('hidden', ssTab !== 'info');
    /* 换档会换掉整块内容（表情格子 ↔ 整张战绩卡），面板高度随之变化，
     * 而面板是按高度算落点的 —— 不重排就会「按上一档的盒子贴在新内容上」。 */
    placeSeatSheet();
    if (ssTab === 'info' && ssPid) renderSeatInfo(ssPid);
  }

  /* 重建面板内容：标题区 + tab 条 + 当前档。
   * 每次都重建 tab 条（不是 hide/show）—— 对着自己时只有一档，对着对手时三档，
   * 两套按钮留在 DOM 里靠 hidden 切换，迟早会出现「点了不存在的那一档」。 */
  function renderSeatSheet() {
    var sheet = $('#seat-sheet');
    if (!sheet) return;
    var me = getMe(state.room);
    var isSelf = !!(ssPid && me && ssPid === me.id);
    var p = ssPlayer(ssPid);
    var name = p ? (p.nickname || '玩家') : '全场';

    var av = $('#ss-avatar');
    if (av) {
      /* 没选座位（发给全场）时用「全」字 + 桌面绿底；
       * 选了座位就跟座位卡同一款头像 —— 面板头和座位长得一致，
       * 才不会出现「点了 A 弹出、标题却是另一个图案」的错位感。 */
      if (ssPid) {
        av.innerHTML = avatarInner(ssPid, p && p.avatar, (name.charAt(0) || '?'), !!(p && p.isBot), p && p.photo);
        av.classList.toggle('is-bot', !!(p && p.isBot));
      } else {
        av.textContent = '全';
        av.classList.remove('is-bot');
      }
    }
    var nm = $('#ss-name');
    if (nm) nm.textContent = ssPid ? name : '发给全场';
    var sub = $('#ss-sub');
    if (sub) {
      sub.textContent = !ssPid ? '所有人都看得到'
        : (p && p.isBot ? 'AI' : (p ? (p.score | 0) + ' 分' : ''));
    }

    /* 能不能发：自己不能发给自己；开关关了也不给这两档（连入口都不留，
     * 与「?emoji=0 时按钮直接不渲染」同一个口径）。 */
    var canEmoji = emojiFlag() && (ssPid ? !isSelf : true);
    var canInfo = !!ssPid;
    var tabs = [];
    if (canEmoji) tabs.push({ key: 'emoji', label: '表情' }, { key: 'phr', label: '短语' });
    if (canInfo) tabs.push({ key: 'info', label: '信息' });
    if (!tabs.length) tabs.push({ key: 'emoji', label: '表情' });

    var bar = $('#ss-tabs');
    if (bar) {
      var html = '';
      tabs.forEach(function (t) {
        html += '<button class="emoji-tab" type="button" role="tab" data-ss-tab="' + t.key + '"'
          + ' aria-selected="false">' + t.label + '</button>';
      });
      bar.innerHTML = html;
      /* 只有一档时把分档条整个藏掉（v107）。
       * 点自己、或者关掉表情开关时，面板里就剩「信息」一档 —— 一个只有一个选项的
       * 切换条不是导航，是装饰：它看起来能点、点下去什么都不会变。
       * 分档本身仍然保留（setSeatTab / ssTab 那套逻辑不动），只是不再显示。 */
      bar.classList.toggle('hidden', tabs.length <= 1);
    }

    if (canEmoji) {
      /* 发给谁 = 面板对着谁，**只此一处赋值**。
       * ssPid 为空（桌面表情钮那条路）就是全场；点了某个人就是他。
       * 面板里不再有第二个地方能改它 —— 详见上面 renderEmojiTargets 的删除说明。 */
      emojiTarget = ssPid || Emoji.BROADCAST;
      renderEmojiGrid();
      renderEmojiPhrases();
    }
    var want = ssTab;
    if (!tabs.some(function (t) { return t.key === want; })) want = tabs[0].key;
    setSeatTab(want);
  }

  /* 打开面板。pid 为空 = 对全场（表情钮那条路）。 */
  function openSeatSheet(pid, anchor) {
    if (!state.roomId || !state.myId) return;
    var me = getMe(state.room);
    var isSelf = !!(pid && me && pid === me.id);
    if (!pid && !emojiFlag()) return;                 // 全场面板只服务表情
    if (!pid && emojiOthers().length === 0) { flash('桌上只有你一个人'); return; }
    if (pid && !isSelf && emojiFlag() && !emojiReady() && !ssPlayer(pid)) return;
    ssPid = pid || null;
    ssAnchorEl = anchor || null;
    ssTab = isSelf ? 'info' : (emojiFlag() ? 'emoji' : 'info');
    renderSeatSheet();
    var sheet = $('#seat-sheet'), bd = $('#seat-sheet-bd');
    if (bd) bd.classList.remove('hidden');
    if (sheet) {
      sheet.classList.remove('hidden');
      /* 先让内容落定再量宽高 —— offsetWidth 拿到 0 会把面板贴到左上角 */
      placeSeatSheet();
      placeSeatSheet();
    }
    Sfx.play('select');
  }

  function closeSeatSheet() {
    var sheet = $('#seat-sheet'), bd = $('#seat-sheet-bd');
    if (sheet) sheet.classList.add('hidden');
    if (bd) bd.classList.add('hidden');
    ssPid = null;
    ssAnchorEl = null;
  }

  /* 保留旧名字：表情钮、键盘、以及外部调试调用都还走它。
   * 它现在的含义是「打开对全场的那张面板」。 */
  function openEmojiSheet() {
    if (!emojiFlag()) return;                // 开关关掉时连键盘/脚本调起来也不开
    if (!emojiReady()) { flash('表情没加载出来，刷新试试'); return; }
    openSeatSheet(null, $('#btn-emoji'));
  }

  /* 真发一条。三道闸的顺序有讲究：
   *   ① 客户端 2 秒节流 —— 先给提示，不要让人以为点漏了（服务端那条是静默丢弃）；
   *   ② 传输层返回 false —— 表示连接不在（ws）或本地限流（local），这时才说「没发出去」；
   *   ③ 发送成功就关面板 —— 面板盖着牌桌时看不见表情飞到谁那儿，等于白发。 */
  function sendEmojiNow(id) {
    if (!emojiReady() || !state.roomId || !state.myId) return;
    if (!Emoji.isValid(String(id))) return;
    var now = Date.now();
    if (now - emojiLastSend < Emoji.MIN_INTERVAL_MS) {
      flash('慢一点，2 秒只能发一条');
      return;
    }
    emojiLastSend = now;
    var to = emojiTarget || Emoji.BROADCAST;
    var sent = RoomStore.sendEmoji(state.roomId, state.myId, to, id);
    if (!sent) { flash('表情没发出去，别人没看到；回到牌桌再点一次'); return; }
    closeSeatSheet();
    Sfx.play('emoji_send', 1.06);   // v155：我发出的表情，复用 receive 音色但更轻、更高
  }

  /* 收到一条（自己发的也走这里）。过滤规则与「谁能看见」一致：
   * 全场、发给我、我发的 —— 其余（发给第三方的）不显示。 */
  function onEmojiEvent(ev) {
    /* 回滚开关要把「收」也一起关掉：只藏入口的话，自己发不出去却能看见别人发，
     * 看起来就像「我这台手机坏了」，而不是「这个功能关了」。 */
    if (!emojiFlag()) return;
    if (!ev || !ev.id || !emojiReady() || !Emoji.isValid(String(ev.id))) return;
    var mine = ev.from === state.myId;
    var forMe = ev.to === Emoji.BROADCAST || ev.to === state.myId;
    if (!mine && !forMe) return;
    playEmoji(ev);
  }

  /* 舞台这一刻的实际缩放。竖版走 --pt-scale、横版走 --ls-scale，变量名不同，
   * 但两者最终都落在 #stage 的 transform 上 —— 读 matrix 是最不容易随实现变化出错的路。
   * 读不到（transform: none / 老浏览器）就当 1，退化成 v148 的样子。 */
  function stageScale() {
    var st = document.getElementById('stage');
    if (!st) return 1;
    var m = window.getComputedStyle(st).transform;
    if (!m || m === 'none') return 1;
    var hit = m.match(/matrix\(([^)]+)\)/);
    if (!hit) return 1;
    var v = parseFloat(hit[1].split(',')[0]);
    return (isFinite(v) && v > 0) ? v : 1;
  }

  /* ==================== 落点：按座位可用空间四选一 + 指向锚点的尾巴 ====================
   *
   * 规格：docs/ui-emoji-placement-v2.md（v1 的「底边贴座位上方 + 居中」已作废）。
   *
   * 为什么不能「固定在头像右侧」：牌桌最外侧座位右边就是卡片栏，固定右挂必然出屏。
   * 所以方向必须**每个座位现算**；四个方向全部不可用（窄屏 + 长文案）才退回 v1 的兜底链。
   *
   * 判据（四条同时满足才算可用）：
   *   A 完整在视口内（留 MARGIN 安全边，不靠 #emoji-layer 的 overflow:hidden 兜）
   *   B 不压任何座位块（含锚点自己；表情的「末位保底」才允许压自己）
   *   D 不与存活中的气泡相交（§4：先做区间搜索让位；都不行才接受重叠）
   *
   * ★ C 不在上面的清单里 —— 它是**夹取规则**，不是否决条件（规格 §2 约束 C）。
   *   v2.3 之前把它当门槛，等于给「下」方向设了不可能条件（块内头像是「头像在上、
   *   昵称分数在下」），并且把本来能用的方向判成不可用，已删。
   *
   * ★ v2.2 改了两处（规格 §2 / §6 / §9）：
   *   ① 方向**不是固定顺序**，是现场排序：内推（朝桌心）优先，其余按可用空间降序。
   *      圆桌是环形布局，中间是空桌面 —— 朝桌心永远最宽。固定从「右」开始试，
   *      等于把最靠边的座位先浪费一次机会（390 宽上排两格对短语四方向全废就是这么来的）。
   *   ② 尾巴判据从「尖端离头像中心 ≤ 半径 + gap + 8」换成 Q4b（尖端在**座位块**
   *      rect 外扩 gap + TAIL_H 之内）。旧判据对「挂在座位下方」设了不可能条件。
   *
   * ★ v2.6 又改两处：
   *   ③ 让位从「自身边长 + 6」的整块换行改成**区间搜索**（§4.1，见 shiftSearch）；
   *   ④ Q4b 不再否决方向，只记录成 `reach`，用来触发 §4.3 的兜底署名（见 playEmoji）。
   */
  var MARGIN = 8;          // 视口安全边：与字号无关，不乘 k
  var TAIL_D_LEN = 8;      // TAIL_H：尾巴伸出量（设计像素，乘 k）—— Q1 裁剪盒 / Q4 外扩都用它
  var TAIL_D_W = 12;       // TAIL_W：尾巴宽度
  var TAIL_R_DESIGN = 18;  // 气泡圆角半径：尾巴中心离边角至少这么远，m = min(18k, L/2)
  var SHIFT_TRIES = 3;     // §4 同屏让位次数上限
  var SHIFT_GAP = 6;       // §4 让位步长里的额外留缝

  function clampNum(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function overlapArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  function hitsAny(box, list) {
    for (var i = 0; i < list.length; i++) if (overlapArea(box, list[i]) > 0) return true;
    return false;
  }

  /* 全部座位块（含自己不？取决于 skip）：spec §1 的座位块 = [data-pid] 的 rect。 */
  function seatBoxes(skipEl) {
    var top = $('#game-top'), out = [];
    if (!top) return out;
    var all = top.querySelectorAll('[data-pid]');
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== skipEl) out.push(all[i].getBoundingClientRect());
    }
    return out;
  }

  /* 存活气泡的**落点矩形**。为什么不用 getBoundingClientRect：
   * 前一条还在飞（transform 是起点）时，量到的是它在半路上的位置，
   * 于是「两条会不会重叠」这个判断会在飞行期失真，落地后才发现叠在一起。
   * 落点在上一条落地那一刻就写进了 __land，它才是这条要躲的那个矩形。 */
  function landedBoxes(skipNode) {
    var layer = $('#emoji-layer'), out = [];
    if (!layer) return out;
    var kids = layer.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== skipNode && kids[i].__land) out.push(kids[i].__land);
    }
    return out;
  }

  /* 四方向择优。返回 { left, top, dir, tail, place } 或 null。
   * allowSelf：只有**表情**能压住自己的座位块（规格 §3「末位保底」：
   * 表情是不透明图，糊住自己头像不影响读别人的话；短语糊住自己就是 v1 那个 bug）。 */
  function planSpot(w, h, anchorEl, k, gap, skipNode, allowSelf) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var ab = anchorEl.getBoundingClientRect();
    var avEl = anchorEl.querySelector('.opp-avatar');
    var av = avEl ? avEl.getBoundingClientRect() : null;
    var acx = av ? av.left + av.width / 2 : ab.left + ab.width / 2;
    var acy = av ? av.top + av.height / 2 : ab.top + ab.height / 2;
    var tailLen = Math.round(TAIL_D_LEN * k);
    var tailW = Math.round(TAIL_D_W * k);
    /* 尾巴外扩量 = gap + TAIL_H（规格 §6 Q4）。needTail 用的是 **Q4b**（碰到座位块），
     * 它必须恒真；Q4a（瞄到脸）只去探针那边做质量统计，不用来否决方向。 */
    var tailPad = gap + tailLen;
    var others = seatBoxes(anchorEl);
    var live = landedBoxes(skipNode);

    /* 该方向的可用空间 cap(dir)（QA 单 §1.6 的可复算定义，与 oracle 逐字一致）：
     *   · 座位块边沿：right → ab.right，left → ab.left，up → ab.top，down → ab.bottom
     *   · 预放位置的**横向跨度**：侧边档 = [acy − h/2, acy + h/2]，上下档 = [acx − w/2, acx + w/2]
     *     （**不夹取**，用几何式原值）—— 为什么不用座位块的跨度：气泡是按**头像中心**
     *     对齐的，头像偏在块的一侧时，块跨度算出的容量与实际可放宽度不符，排序会错位。
     *   · 阻挡者 = 视口边界，或「跨度正重叠」的其它座位块
     *   · cap = min(阻挡者坐标) − 块边沿坐标，**允许为负**（= 已经被挡住）
     */
    function availableSpace(dir) {
      var vert = (dir === 'right' || dir === 'left');
      var spanLo = vert ? (acy - h / 2) : (acx - w / 2);
      var spanHi = vert ? (acy + h / 2) : (acx + w / 2);
      var edge, best, i, o, oLo, oHi;
      if (dir === 'right') { edge = ab.right; best = vw - MARGIN; }
      else if (dir === 'left') { edge = ab.left; best = MARGIN; }
      else if (dir === 'down') { edge = ab.bottom; best = vh - MARGIN; }
      else { edge = ab.top; best = MARGIN; }
      for (i = 0; i < others.length; i++) {
        o = others[i];
        oLo = vert ? o.top : o.left;
        oHi = vert ? o.bottom : o.right;
        if (Math.min(spanHi, oHi) - Math.max(spanLo, oLo) <= 0) continue;   // 挡不住
        var at = (dir === 'right') ? o.left : (dir === 'left') ? o.right
          : (dir === 'down') ? o.top : o.bottom;
        if (at < best) best = at;
      }
      return (dir === 'right' || dir === 'down') ? (best - edge) : (edge - best);
    }

    /* 桌心 = **全部**座位块（含自己）中心的重心。inward = 从本块中心指向桌心的主轴方向，
     * 吸附到四方向里最近的一个。环形布局里这一条永远最宽，所以先试它。 */
    function inwardDir() {
      var all = seatBoxes(null), cx = 0, cy = 0;
      for (var i = 0; i < all.length; i++) {
        cx += all[i].left + all[i].width / 2;
        cy += all[i].top + all[i].height / 2;
      }
      if (!all.length) return null;
      var dx = cx / all.length - (ab.left + ab.width / 2);
      var dy = cy / all.length - (ab.top + ab.height / 2);
      if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
      return dy >= 0 ? 'down' : 'up';
    }

    /* 现场排序（规格 §2「两级排序」）：内推优先 → 其余按可用空间降序。
     * 空间相等时退回 right/left/up/down 的固定次序 —— 不依赖 Array.sort 的稳定性。 */
    var DIRS = (function () {
      var RANK = { right: 0, left: 1, up: 2, down: 3 };
      var inw = inwardDir();
      var rest = ['right', 'left', 'up', 'down'].filter(function (d) { return d !== inw; });
      rest.sort(function (a, b) {
        var d = availableSpace(b) - availableSpace(a);
        return d !== 0 ? d : (RANK[a] - RANK[b]);
      });
      return inw ? [inw].concat(rest) : rest;
    })();

    function baseOf(dir) {
      var vert = (dir === 'right' || dir === 'left');
      var left, top;
      if (dir === 'right') { left = ab.right + gap; top = acy - h / 2; }
      else if (dir === 'left') { left = ab.left - gap - w; top = acy - h / 2; }
      else if (dir === 'up') { left = acx - w / 2; top = ab.top - gap - h; }
      else { left = acx - w / 2; top = ab.bottom + gap; }
      return { left: left, top: top, vert: vert, span: vert ? h : w };
    }

    /* 一个候选位置判三条（A / B / D —— C 不是否决条件，见下面那段注释）。opt：
     *   strictD   D 是否硬约束（不够硬时返回第一个 A/B 成立的位置 = 宁叠不消失）
     *   allowSelf 表情的末位保底：可以压住自己的座位块
     *   place     写进 data-place，探针据此区分「定向落点」与「让位/兜底落点」 */
    function judge(dir, base, left, top, opt) {
      /* A：夹进视口。★ **尾巴只朝座位那一侧伸出**，所以裁剪盒是**单侧**外扩
       * （QA 单 §1.7 的可行性推导）：外扩那一侧留 MARGIN + TAIL_H，其余三边只留 MARGIN。
       * 四边都扩是算不通的 —— 320 宽上限宽 296、两侧余量只有 12，而 8 + 8 = 16 > 12，
       * 那 10 格（320/390 × 长短语）永远修不绿。 */
      var loX = MARGIN + (dir === 'right' ? tailLen : 0);
      var hiX = vw - MARGIN - (dir === 'left' ? tailLen : 0) - w;
      var loY = MARGIN + (dir === 'down' ? tailLen : 0);
      var hiY = vh - MARGIN - (dir === 'up' ? tailLen : 0) - h;
      if (hiX < loX || hiY < loY) return null;      // 这个方向连裁剪盒都放不下 → 作废
      left = clampNum(left, loX, hiX);
      top = clampNum(top, loY, hiY);
      var box = { left: left, top: top, right: left + w, bottom: top + h };
      /* B：不压任何别的座位块；锚点自己单独判（只有表情能压） */
      if (hitsAny(box, others)) return null;
      if (!opt.allowSelf && overlapArea(box, ab) > 0) return null;
      /* C：尾巴沿贴合边对齐头像中心，夹进圆角区 [m, L−m] —— m = min(18×k, L/2)，
       * 唯一出处是规格 §2 约束 C（v2 初稿 §3/§6 写的「12」已作废）。
       *
       * ★ C 是**夹取规则，不是否决条件**（规格 §2 约束 C / v2.3 裁定 2）：
       *   `m ≤ L/2` 恒成立 ⇒ clamp 恒有解 ⇒「尾巴放不下」在数学上不存在。
       *   这里原本有一段「尖端不在座位块外扩区内 → return null」，凭实测有 390 满员局
       *   41 次 / 1366×768 6 次否决（right 22 / left 18 / down 1 与 up 2 / right 1 /
       *   left 1 / down 2）—— 它把本来可用的方向判成了不可用，已整段删除。
       *   删完四方向的可否决性只剩 A（视口）/ B（不压块）/ D（不撞气泡）。
       *   现在只**记录** reach（Q4b 是否成立）：它是 §4.3 兜底署名的触发条件，
       *   不参与方向选择。
       *
       * ★ 夹取后必须复判（规格 §2 v2.5）：下面 B / D 用的 `box` 就是**夹取之后**
       *   的新矩形（left/top 已在上面被 clamp 过），不是夹取前的候选位置。
       *   反例：`pal2` 的 up 从 y = −58 被纵向夹到 8（偏移 66），夹完立刻压到同排两块 ——
       *   夹取不能当成「先夹进来再说」的通行证。 */
      var span = base.span;
      var m = Math.min(Math.round(TAIL_R_DESIGN * k), span / 2);
      var tail = clampNum(base.vert ? (acy - top) : (acx - left), m, span - m);
      var tipX, tipY;
      if (dir === 'right') { tipX = left - tailLen; tipY = top + tail; }
      else if (dir === 'left') { tipX = left + w + tailLen; tipY = top + tail; }
      else if (dir === 'up') { tipX = left + tail; tipY = top + h + tailLen; }
      else { tipX = left + tail; tipY = top - tailLen; }
      /* Q4b：尖端落在**座位块** rect 外扩 (gap + TAIL_H) 内。
       * 用块而不是头像：块内是「头像在上、昵称分数在下」，「挂在下边」离头像天然远，
       * 拿 Q4a 当门槛等于给「下」设不可能条件（Q4a 现在是两轴分解，见规格 §6）。 */
      var reach = !(tipX < ab.left - tailPad || tipX > ab.right + tailPad
        || tipY < ab.top - tailPad || tipY > ab.bottom + tailPad);
      if (opt.strictD && hitsAny(box, live)) return null;
      return {
        left: left, top: top, dir: dir, tail: tail, tailLen: tailLen, tailW: tailW,
        tip: { x: tipX, y: tipY }, reach: reach, place: opt.place
      };
    }

    /* §4.1 区间搜索（v2.6）。替掉 v2.2 的「自身边长 + 6」整块换行 —— **那个步长太粗**：
     * 明明有空间却跨不过去。390 实测：`陪练2` 的 down 气泡跨 49..205，与左侧块（右沿 92）
     * 相交；整块右移一步 162 又会撞 `陪练3`。可中间 `95..251` 这一段其实是空的 ——
     * 粗步长把「挪一点就够」判成了「没法挪」。
     *
     * 做法：轴对齐矩形相交的可行域，边界只可能落在有限个位置，把它们当候选穷举：
     *   · 对齐位置本身（位移 0，观感最自然）
     *   · 贴着某个障碍的某一边（让开后刚好擦过）—— 座位块与存活气泡都算
     *   · A 窗口的两端（再往外会被 A 夹回去，位移白费）
     * 取**位移最小**的可行解。
     *
     * 位移上限由尾巴决定：**气泡可以滑，尾巴不能撒谎**。尾巴被夹到圆角处之后
     * 尖端会跟着偏，偏差 = |位移| − (自身沿轴跨度/2 − m)；要求偏差不超过头像跨度的一半
     * （Q4a 轴一），于是 |位移| ≤ (跨度/2 − m) + 头像跨度/2。超出这条线的一律不采。 */
    function shiftSearch(dir, base, opt) {
      var vert = base.vert;                          // 侧边档在 y 上搜，上下档在 x 上搜
      var span = base.span;                          // 气泡沿**自由轴**的跨度
      var m = Math.min(Math.round(TAIL_R_DESIGN * k), span / 2);
      var acAlong = vert ? acy : acx;                // 头像中心在自由轴上的坐标
      var acHalf = (vert ? (av ? av.height : ab.height) : (av ? av.width : ab.width)) / 2;
      var cap = (span / 2 - m) + acHalf;
      var basePos = vert ? base.top : base.left;
      var lo = vert ? (MARGIN + (dir === 'down' ? tailLen : 0))
        : (MARGIN + (dir === 'right' ? tailLen : 0));
      var hi = vert ? (vh - MARGIN - (dir === 'up' ? tailLen : 0) - h)
        : (vw - MARGIN - (dir === 'left' ? tailLen : 0) - w);
      if (hi < lo) return null;                      // A 连窗口都没有 → 这个方向作废
      /* 候选整数化时**朝外取整**（右/下用 ceil、左/上用 floor）：
       * judge() 用的是未取整的位置，而落点写进 __land 的是 Math.round 之后的整数 ——
       * 从障碍边沿 round 进来的候选可能比边沿小 0.4px，于是「刚好让开」变成
       * 重叠 0.4px × 高度（1920 实测 29px²，Q6 因此判红）。朝外取整根除这一类假重叠。 */
      var cands = [], seen = {};
      function pushCand(p, mode) {
        var q = (mode === 'floor') ? Math.floor(p) : (mode === 'ceil') ? Math.ceil(p) : Math.round(p);
        if (Math.abs(q - basePos) > cap + 0.5) return;    // 尾巴补偿不到 → 跳过
        if (q < lo - 0.5 || q > hi + 0.5) return;         // 会被 A 夹回去 → 不是新候选
        if (seen[q]) return;
        seen[q] = 1; cands.push(q);
      }
      pushCand(basePos, 'round');                          // 对齐位置：位移 0，最自然
      pushCand(lo, 'ceil');                                // A 窗口两端
      pushCand(hi, 'floor');
      var i;
      for (i = 0; i < others.length; i++) {
        pushCand(vert ? others[i].bottom : others[i].right, 'ceil');
        pushCand(vert ? others[i].top - h : others[i].left - w, 'floor');
      }
      for (i = 0; i < live.length; i++) {
        pushCand(vert ? live[i].bottom : live[i].right, 'ceil');
        pushCand(vert ? live[i].top - h : live[i].left - w, 'floor');
      }
      /* 位移小的先试：观感上「离对齐位置最近」最自然 */
      cands.sort(function (a, b) {
        var d = Math.abs(a - basePos) - Math.abs(b - basePos);
        return d !== 0 ? d : (a - b);
      });
      for (i = 0; i < cands.length; i++) {
        var p = cands[i];
        var spot = judge(dir, base, vert ? base.left : p, vert ? p : base.top, opt);
        if (!spot) continue;
        /* §4.1 位移上限：尖端必须仍落在头像跨度内（轴一），否则这条位移等于让尾巴撒谎 */
        if (Math.abs((vert ? spot.tip.y : spot.tip.x) - acAlong) > acHalf + 0.5) continue;
        /* 位移量写进 spot.shift（v2.7）：探针用它判「有没有算过位移」（N18）。
         * 用实测落点减对齐位置，不是用候选 p —— judge 里可能还有夹取，两者会差几像素。
         * ★ 两轴别弄反：`vert` 表示**位移轴是竖直**（即 right/left 这种侧边放置，
         *   y 在动、x 被 gap 钉住）。所以竖直时取 `spot.top`，水平时取 `spot.left`。
         *   第一版写成了 `vert ? spot.left : spot.top` —— 拿 x 减 y 得到 200 多的数。
         *   这个量级异常被两边各误用一次：实现侧据此写了错判据，
         *   QA 侧据此引用了「位移超预算」的结论。**一个字段错了会污染两边**，
         *   所以这里只保证一件事：`shift` 忠实反映实测位移；
         *   「尾巴指没指到人」一律由上面那行尖端判据决定，不看 `shift`。 */
        spot.shift = Math.round((vert ? spot.top : spot.left) - basePos);
        return spot;
      }
      return null;
    }

    function runPass(opt) {
      for (var d = 0; d < DIRS.length; d++) {
        var dir = DIRS[d], base = baseOf(dir), spot;
        if (opt.stack) {
          /* 换行让位（区间搜索之后的次选，规格 §4.1）：只用来解**一个**问题 ——
           * 对齐位置本身是合法的，只是被存活气泡占了。如果连对齐位置都过不了 A/B
           * （长短语在窄屏上横跨整张桌子那种），换行只会把它推得更远、指向更糟，
           * 交给兜底链。侧边没有这条退路：侧边的尾巴在竖向，纵向推 = 把尖端推离人脸。 */
          if (dir === 'right' || dir === 'left') continue;
          if (!judge(dir, base, base.left, base.top, { strictD: false, allowSelf: false })) continue;
          var away = (dir === 'down') ? 1 : -1;
          for (var r = 1; r <= SHIFT_TRIES; r++) {
            spot = judge(dir, base, base.left, base.top + away * r * (h + SHIFT_GAP), opt);
            /* 同样写**实测**位移（v2.7）：这里只可能是 up/down（侧边不走这条路），
             * 位移轴是竖直。原来写的是候选偏移 `away * r * (h + SHIFT_GAP)` ——
             * judge 之后落点还可能被夹取，候选值和实际值不是一回事；
             * 一个字段两种语义，读的人没法知道哪个是「真位移」。 */
            if (spot) { spot.shift = Math.round(spot.top - base.top); return spot; }
          }
          continue;
        }
        spot = shiftSearch(dir, base, opt);
        if (spot) return spot;
      }
      return null;
    }

    /* 四轮，严格到宽松：
     *   ① 规格 §2/§4 原样（A/B/D 全满足）
     *   ② 换一行（区间搜索挪不开时的次选）—— 5 人同时发时 320 宽偶尔用到
     *   ③ 让位让不开就接受重叠（「宁可叠，不要消失」）
     *   ④ 表情的末位保底：可以压住自己的座位块 */
    return runPass({ strictD: true, place: 'dir' })
      || runPass({ strictD: true, place: 'stack', stack: true })
      || runPass({ strictD: false, place: 'dir' })
      || (allowSelf ? runPass({ strictD: false, place: 'self', allowSelf: true }) : null);
  }

  /* 兜底链（v1 那条，保证不丢内容）：上 → 放不下翻到下方 → 夹进视口 → 逐块下推。
   * 与 v1 的差别有两处，都是被真机数据逼出来的：
   *   ① 下推时躲的是**整块座位**（含昵称与分数），不再只躲 `.opp-avatar` ——
   *     只躲头像会让气泡压在别人的名字上，而 Q2 的口径是「与任何 [data-pid] 块重叠 0」。
   *   ② 下推之后还要躲**存活中的气泡**。5 个人同时发的时候，兜底那条会正好落在
   *     别人已经占住的那一行上（320 宽实测叠了 2112 px²，等于把人家的表情盖掉半个）。
   *     躲法与 §4 一致：先沿水平让位，都占满再整行下移（每行 = 自身高度 + 6）。 */
  function fallbackSpot(w, h, anchorEl, k, gap, skipNode) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var ab = anchorEl.getBoundingClientRect();
    var avEl = anchorEl.querySelector('.opp-avatar');
    var av = avEl ? avEl.getBoundingClientRect() : null;
    var acx = av ? av.left + av.width / 2 : ab.left + ab.width / 2;
    var boxes = seatBoxes(null);                       // 含锚点自己
    var live = landedBoxes(skipNode);
    var canClampX = w <= vw - MARGIN * 2;

    function clampX(x) { return canClampX ? clampNum(x, MARGIN, vw - w - MARGIN) : x; }

    /* 逐块下推：从 t 开始，被哪一块座位压住就落到它下面，最多 6 轮（座位最多 5 个） */
    function pushDown(x, t) {
      for (var guard = 0; guard < 6; guard++) {
        var low = -1;
        for (var i = 0; i < boxes.length; i++) {
          var b = boxes[i];
          if (x < b.right && x + w > b.left && t < b.bottom && t + h > b.top) {
            if (b.bottom > low) low = b.bottom;
          }
        }
        if (low < 0) break;
        t = low + gap;
      }
      return t;
    }

    function boxOf(x, t) {
      if (h <= vh - MARGIN * 2) t = clampNum(t, MARGIN, vh - h - MARGIN);
      return { left: x, top: t, right: x + w, bottom: t + h };
    }

    var baseLeft = clampX(ab.left + ab.width / 2 - w / 2);
    var baseTop = ab.top - gap - h;                    // 首选：贴座位上方
    if (baseTop < MARGIN) baseTop = ab.bottom + gap;   // 顶部放不下 → 翻到下方

    /* 候选顺序：原位置 → 左右各让 1~3 步（§4 的步长）→ 整行下移 1~3 行 */
    var cands = [];
    for (var s = 0; s <= SHIFT_TRIES * 2; s++) {
      var n = (s === 0) ? 0 : ((s % 2) ? (s + 1) / 2 : -(s / 2));
      var lx = clampX(baseLeft + n * (w + SHIFT_GAP));
      cands.push(boxOf(lx, pushDown(lx, baseTop)));
    }
    var rowTop = pushDown(baseLeft, baseTop);
    for (var row = 1; row <= SHIFT_TRIES; row++) {
      cands.push(boxOf(baseLeft, pushDown(baseLeft, rowTop + row * (h + SHIFT_GAP))));
    }

    var firstFit = null;
    for (var c = 0; c < cands.length; c++) {
      var cb = cands[c];
      if (hitsAny(cb, boxes)) continue;                // B：兜底也不压座位块
      if (!hitsAny(cb, live)) { firstFit = cb; break; } // D：也不压存活气泡 → 就是它
      if (!firstFit) firstFit = cb;                     // 都占满了：宁可叠，别消失
    }
    if (!firstFit) firstFit = boxOf(baseLeft, pushDown(baseLeft, baseTop));

    /* 气泡被推开之后仍然要指一下人：方向取「锚点在气泡哪一侧」，
     * 尾巴落在该侧边的、尽量对齐头像的那一点上（夹进圆角区）。 */
    var left = firstFit.left, top = firstFit.top;
    var dir = (top + h / 2) >= (ab.top + ab.height / 2) ? 'down' : 'up';
    /* 兜底的尾巴同样夹进 [m, L−m]（同一出处：规格 §2 约束 C）——
     * 探针 Q5 对兜底落点也照样量，两处口径必须一致。 */
    var tm = Math.min(Math.round(TAIL_R_DESIGN * k), w / 2);
    var tail = clampNum(acx - left, tm, w - tm);
    var tailLen = Math.round(TAIL_D_LEN * k);
    /* Q4b（reach）：兜底当然常常碰不到块 —— 那正是 §4.3 要署名的条件，
     * 所以这里也要算出来交给 playEmoji，不能默认它「指到了」。 */
    var tipX = left + tail;
    var tipY = (dir === 'down') ? (top - tailLen) : (top + h + tailLen);
    var tailPad = gap + tailLen;
    var reach = !(tipX < ab.left - tailPad || tipX > ab.right + tailPad
      || tipY < ab.top - tailPad || tipY > ab.bottom + tailPad);
    return {
      left: left, top: top, dir: dir, tail: tail,
      tailLen: tailLen, tailW: Math.round(TAIL_D_W * k),
      tip: { x: tipX, y: tipY }, reach: reach,
      place: 'fallback'
    };
  }

  function playEmoji(ev) {
    var layer = $('#emoji-layer');
    if (!layer) return;
    var entry = Emoji.get(ev.id);
    if (!entry) return;

    /* 锚点：广播看发送者，定向看收件人（规格 §1）。这里要的是**元素**而不只是
     * rect —— 尾巴要指向座位块里的 `.opp-avatar` 中心，必须能往下找一级。 */
    var fromEl = seatEl(ev.from);
    var toEl = (ev.to && ev.to !== Emoji.BROADCAST) ? seatEl(ev.to) : null;
    /* 顶栏没画出来（比如人在战绩页）：这条就不显示了，不抛错、不排队 ——
     * 表情是「此刻」的东西，补播一条 3 秒前的表情比不播更奇怪。 */
    if (!fromEl && !toEl) return;
    /* v155：真正要显示这一条时才响；自己发的已在 sendEmojiNow 响过，不重复。 */
    if (ev.from !== state.myId) Sfx.play('emoji_receive');
    if (!fromEl) fromEl = toEl;
    if (!toEl) toEl = fromEl;
    var fromR = fromEl.getBoundingClientRect();
    var toR = toEl.getBoundingClientRect();

    /* 尺寸跟着**舞台缩放**走，不是写死 CSS px（2026-11-14）。
     *
     * #emoji-layer 是 fixed 全屏、不在 #stage 里，拿不到那圈 transform: scale()，
     * 于是座位头像在手机竖屏是 35 CSS px、电脑窗口是 57，而气泡一直是 64 / 24 号字。
     * 电脑上就变成「表情比头像还小、短语比座位名还小」。
     *
     * 0.52 是手机竖屏的基准（62 设计 px 的座圈 ≈ 32 CSS px，实测头像 35）。
     * 取 max(1, ·) 表示**只放大不缩小**：手机上的观感已经逐张确认过，不陪小屏继续缩。
     *
     * ★ 上限 1.5（2026-11-14 晚，用户「不同设备大小要适配屏幕」）。
     *   舞台缩放是**无界**的：1366 是 1.62、1920 是 2.27，短语字号就变成 39 / 54px。
     *   但界面文字（`.opp-name` 座位名）是**固定** 20px（宽屏 24px），根本不跟舞台走 ——
     *   于是「短语字号 ÷ 座位名」在手机是 24/20 = 1.2，在 1920 变成 54/24 = 2.25。
     *   同一句话在电脑上是旁边座位名的两倍多、气泡宽占半屏，这就是「没适配屏幕」的实感；
     *   它跟落点无关（遮不遮手牌是另一件事），只能靠**封顶**治。
     *
     *   1.5 的取值：短语字号封顶 24 × 1.5 = 36px。相对座位名（桌面实测 20px）
     *   是 1.8 倍，而手机是 1.2 倍 —— 桌面略大是刻意的（屏幕远、字要够看），
     *   但不再是无界的 2.7 倍。表情直径随之封顶 96px，仍大于 1920 的 80px 头像
     *   （不会又退回「表情比头像还小」那一轮的病）。
     *   代价要说清：封顶之后气泡相对**头像**的比例会随屏幕变大而下降（1920 上 0.45），
     *   这是有意的取舍 —— 相对 UI 文字有界，优先于相对头像恒定。 */
    var k = Math.max(1, Math.min(1.5, stageScale() / 0.52));
    k = Math.round(k * 100) / 100;

    /* 同时最多 6 条：服务端虽然限到 2 秒一条，但 5 个人一起发就是 5 条同时，
     * 再加自己一条正好。超了就丢最老的，节点数不跟着房间人数涨。 */
    while (layer.children.length >= 6) layer.removeChild(layer.firstChild);

    /* 结构是「外层管位置、内层管弹一下」。
     * ★ 两层不是讲究，是必须：CSS 动画会**整个覆盖** transform。
     *   第一版把「回弹」和「位移」都写在同一个元素上，回弹动画一跑，
     *   位移就被改回 identity —— 表情会瞬间跳回屏幕左上角再消失。
     *   探针第一次跑就抓到了（rect 恒等于 0,0，而 inline style 是对的）。 */
    var wrap = document.createElement('div');
    wrap.className = 'emoji-fly' + (entry.kind === 'phrase' ? ' is-phrase' : '');
    var item;
    if (entry.kind === 'phrase') {
      item = document.createElement('span');
      item.textContent = entry.text;
    } else {
      item = document.createElement('img');
      item.src = entry.src;
      item.alt = entry.name;
      item.draggable = false;
    }
    item.className = 'emoji-pop';
    wrap.appendChild(item);
    /* 必须在 append 之前写：下面马上要 offsetWidth —— 尺寸得先定下来。 */
    wrap.style.setProperty('--emo-k', k);

    /* 起点必须**在没有过渡的情况下**先落定，否则每一条表情都会从屏幕左上角
     * 飞过来 —— 因为「插入时写下 transform」在浏览器看来也是一次属性变化，
     * 过渡的起点是 identity。做法：临时关掉过渡 → 写起点 → 强制布局提交
     * → 恢复过渡 → 下一帧写终点。只写起点不提交，等于什么都没做。 */
    wrap.style.transition = 'none';
    wrap.style.opacity = '0.25';
    layer.appendChild(wrap);

    /* 尺寸必须先量：气泡的宽高由文案决定（短句一行、长句折行），
     * 而四个方向哪个可用完全取决于这两个数 —— 算不出来，只能先量。
     *
     * ★ 必须用 getBoundingClientRect 的**小数**尺寸，不能用 offsetWidth/offsetHeight：
     *   后者是**整数**。1920 档 k=2.27 时表情实际 145.27 宽，offsetHeight 只给 145，
     *   而探针量的是渲染 rect —— 规划用整数、渲染是小数，差 0.27px 就让「刚好让开」
     *   变成 0.27 × 108 ≈ 29px² 的重叠，Q6 因此判红（1920 实测就这么红的）。
     *   两边取同一个来源，亚像素才对得上。 */
    function wrapSize() {
      var r = wrap.getBoundingClientRect();
      return { w: r.width || wrap.offsetWidth || 64, h: r.height || wrap.offsetHeight || 64 };
    }
    var sz = wrapSize();
    var w = sz.w;
    var h = sz.h;
    /* ★ 落点换成「按座位可用空间四选一 + 尾巴」（v2 · docs/ui-emoji-placement-v2.md）。
     *
     * v1 是「底边贴座位上方 + 水平居中 + 夹进视口 + 逐头像下推」：它能保证不出屏、
     * 不糊脸，但气泡始终浮在座位**上面**，和那个人没有视觉连接 —— 用户第二次
     * 反馈的正是「看不出这句话出自谁」。参考游戏的做法是气泡在头像侧边、
     * 用一个小尾巴指过去，所以这里改成按座位算方向。
     *
     * 间距两档：气泡 10、表情 4（表情是不透明图，参考图里几乎贴着人）。
     * 两个都乘 k —— 不然电脑上「间距」不跟着放大，气泡会像被座位吸住。 */
    var gap = Math.round(k * (entry.kind === 'phrase' ? 10 : 4));
    var spot = planSpot(w, h, toEl, k, gap, wrap, entry.kind !== 'phrase')
      || fallbackSpot(w, h, toEl, k, gap, wrap);

    /* ★ §4.3 兜底署名（v2.5，规格 §4.3）：Q4b 不成立 —— 尾巴碰不到座位块，
     * 归属就不能再靠尾巴了，得用文字说清是谁。这不是观感补丁：
     * 「不指人且不署名」= 用户不知道谁说的，那是**功能失效**（Q10 的否定式判据）。
     *
     * 触发用的是 `spot.reach`（= Q4b），不是 `spot.place`：place 只说明走了哪条路径，
     * 走了 dir 一样可能因为夹取而把尖端甩离座位块。
     *
     * 代价是宽度变了 → 落点要重算一次（署名会把气泡挤宽）。**只重算一次、不迭代**：
     * 加了署名只会更宽、更难找到位置，反复试就是把一个简单问题变成循环。
     * 副作用是「重算之后其实指得到了，但署名已经加上去了」—— 那不多余：署名和尾巴
     * 同时成立只是更清楚，不影响任何判据（Q10 只要求兜底那条必须有，不禁止别处有）。
     *
     * ⚠️ 不要把这段包进 while / 递归：`!spot.reach → 加署名 → 重算` 是一个**收敛不了**
     *   的环（署名只会让气泡更宽 → 更找不到位置 → reach 更容易为假）。
     *   要改也只能改成「先摘掉署名再重算」，一次为限 —— 见 docs/impl-emoji-placement-v2.md §2.3。 */
    if (!spot.reach) {
      var by = document.createElement('span');
      by.className = 'emoji-by';
      /* 短语：正文前 `昵称：`，与正文同一行内联（字号 0.8×、70% 不透明度，见 CSS）；
       * 表情：图下方一行小字，居中（0.7× 基准字号）。 */
      by.textContent = senderName(ev.from) + (entry.kind === 'phrase' ? '：' : '');
      if (entry.kind === 'phrase') item.insertBefore(by, item.firstChild);
      else { wrap.classList.add('has-by'); wrap.appendChild(by); }
      sz = wrapSize();                 // 同一来源：小数尺寸（见上面 wrapSize 的注释）
      w = sz.w;
      h = sz.h;
      spot = planSpot(w, h, toEl, k, gap, wrap, entry.kind !== 'phrase')
        || fallbackSpot(w, h, toEl, k, gap, wrap);
    }

    var fx = fromR.left + fromR.width / 2 - w / 2;
    var fy = fromR.top + fromR.height / 2 - h / 2;
    var tx = Math.round(spot.left);
    var ty = Math.round(spot.top);

    /* 尾巴：方向写在外层 data-dir 上，沿边的位置写进 --tail-off（CSS 只负责长相）。
     * 两者必须在落定那一帧之前写好，否则尾巴会先出现在「默认方向」再跳一次。 */
    wrap.setAttribute('data-dir', spot.dir);
    /* ★ 兜底落点**不画尾巴**（v2.7，QA 看图后裁定）。
     * 尾巴的全部意义是「指向那个人」，而兜底恰恰定义为「尖端够不到他的座位块」。
     * 硬画出来不会停在半空 —— 它会沿着那条边落到**另一个真实存在的头像**旁边：
     * 320 实测那条长短语的尾巴末端正好压在右边邻居（陪练4）底下，
     * 看图的人会以为这句话是他说的。
     *
     * **指错人比不指人更糟**：不指人时用户知道「没标出来」，
     * 指错人时用户会被误导。署名已经把归属补上了（`我：` 前缀），
     * 所以这里让尾巴退场，而不是退而求其次指个大概。
     *
     * 用独立属性而不是清掉 data-dir：方向本身仍然是有效信息
     * （气泡确实在那个方向），探针的 Q3「气泡在声称的那一侧」还要用它。 */
    if (!spot.reach) wrap.setAttribute('data-tail', 'off');
    wrap.setAttribute('data-place', spot.place);
    /* 位移量：只有「算过位移」的落点才有（区间搜索 / 换行让位）。
     * 兜底链没有对齐基准，所以**不写这个属性** —— 探针据此区分
     * 「没位移」与「没算过」，而不是把缺失当成 0（规格 §14 N18）。 */
    if (typeof spot.shift === 'number') wrap.setAttribute('data-shift', String(spot.shift));
    /* ⚠️ `--tail-off` **无条件写**，它的语义是「尾巴**本该**落在哪」，**不是**「有没有尾巴」。
     * 兜底落点（`data-tail="off"`）身上它照样是非 0 值，而 `::after` 已被 CSS 隐藏。
     * 判断「有没有尾巴」只认 `data-tail`（探针读成 `tailAbsent`）；
     * 拿 `--tail-off !== 0` 或 `tailLen > 0` 当判据，和把 `shift = 0` 读成「没位移」是同一个错。
     * 这是同一族的第四次（前三次：`shift` 一字段两语义、`place=fallback` 被当成「没尾巴」、
     * 探针用 `len === 0` 隐式推断退场），所以写在这里，不写在别处。 */
    wrap.style.setProperty('--tail-off', Math.round(spot.tail) + 'px');
    /* 落点矩形记在节点上：下一条来判断「会不会压住我」时用它，而不是当前 rect
     * （此刻它可能还在半路 —— 见 landedBoxes 的注释）。 */
    wrap.__land = { left: tx, top: ty, right: tx + w, bottom: ty + h };

    wrap.style.transform = 'translate3d(' + fx + 'px,' + fy + 'px,0) scale(0.72)';
    void wrap.offsetWidth;                 // 提交起点
    wrap.style.transition = '';            // 交还给 CSS 里的那条过渡

    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () {
      /* 落定就用算好的 tx / ty，不再额外减一点：那些「上浮 8px」是正中覆盖
       * 时代的补偿量，现在 ty 本身就是「座位外侧留 gap」的结果，
       * 再抬一次会把 gap 吃掉（v1 实测 gap 6 被抵消成 -2，边缘压进座位 2px）。 */
      wrap.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(1)';
      wrap.style.opacity = '1';
    });

    setTimeout(function () { wrap.classList.add('is-landed'); }, 430);
    setTimeout(function () {
      wrap.style.opacity = '0';
      wrap.style.transform = 'translate3d(' + tx + 'px,' + (ty - 34 * k) + 'px,0) scale(1)';
    }, 1500);
    setTimeout(function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }, 1900);
  }

  /* 面板内的所有点击都用委托：13 个表情 + 8 条短语 + N 个人如果各绑一个
   * 监听，面板每开一次就多 20 多个闭包（打开/关闭几十次就是内存泄漏现场）。 */
  function bindSeatSheet() {
    var sheet = $('#seat-sheet');
    if (!sheet) return;
    var close = $('#btn-ss-close');
    if (close) close.addEventListener('click', closeSeatSheet);
    /* 遮罩点击关闭：遮罩是半透明的，能看见被点的人，所以关掉它不算「丢失上下文」 */
    var bd = $('#seat-sheet-bd');
    if (bd) bd.addEventListener('click', closeSeatSheet);

    /* 面板内所有点击走委托：13 个表情 + 8 条短语，各绑一个监听
     * 就是「每开一次面板多 20 个闭包」的内存泄漏现场（v83 定下的规矩）。 */
    sheet.addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('[data-ss-tab]') : null;
      if (tab) { setSeatTab(tab.getAttribute('data-ss-tab')); return; }
      /* 信息档现在就是整张战绩卡，没有「看完整战绩」这一跳了（v107）。
       * 那个按钮和它对应的 data-ss-full 处理分支一起删掉 —— 留着就是死代码，
       * 下一轮改到这里的人会以为还有第二条路径要维护。 */
      var cell = e.target.closest ? e.target.closest('[data-emoji]') : null;
      if (cell) sendEmojiNow(cell.getAttribute('data-emoji'));
    });

    /* Esc 关闭：面板不是全屏弹窗，没有「返回键」兜底，桌面上按 Esc 是最接近的手势 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && seatSheetOpen()) { closeSeatSheet(); }
    });

    /* 收到表情（两种传输同一个入口，只注册一次） */
    if (typeof RoomStore !== 'undefined' && RoomStore.onEmoji) {
      RoomStore.onEmoji(onEmojiEvent);
    }
  }
    return {
      PROF_TAP_SEL: PROF_TAP_SEL,
      oppTap: oppTap,
      bindOppSeatTap: bindOppSeatTap,
      emojiTarget: emojiTarget,
      emojiLastSend: emojiLastSend,
      emojiReady: emojiReady,
      emojiFlag: emojiFlag,
      seatRect: seatRect,
      emojiOthers: emojiOthers,
      renderEmojiGrid: renderEmojiGrid,
      renderEmojiPhrases: renderEmojiPhrases,
      ssPid: ssPid,
      ssAnchorEl: ssAnchorEl,
      ssTab: ssTab,
      ssPlayer: ssPlayer,
      seatSheetOpen: seatSheetOpen,
      placeSeatSheet: placeSeatSheet,
      renderSeatInfo: renderSeatInfo,
      setSeatTab: setSeatTab,
      renderSeatSheet: renderSeatSheet,
      openSeatSheet: openSeatSheet,
      closeSeatSheet: closeSeatSheet,
      openEmojiSheet: openEmojiSheet,
      sendEmojiNow: sendEmojiNow,
      onEmojiEvent: onEmojiEvent,
      playEmoji: playEmoji,
      bindSeatSheet: bindSeatSheet
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.seatSheetView = create;

})(typeof self !== 'undefined' ? self : this);
