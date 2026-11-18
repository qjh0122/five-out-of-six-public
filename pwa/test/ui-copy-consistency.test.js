/**
 * 玩家可见文案一致性守（P0 批次：本局过程 / 量词 / 禁用词 / 净胜）
 *
 * 为什么单独建一个文件：这四条以前都只活在审查报告里，代码侧没有一处会红。
 * 本文件只做静态扫描，扫的是**玩家能看到的字面量**，不是注释、不是后台页：
 *   · 带引号的 JS 字符串（自己写扫描器，跳过单行与块注释）；
 *   · HTML 去掉 <!-- --> 注释后的文本。
 * 每次扫描前先做分类器自测——「没命中」必须区别于「扫描器瞎了」。
 */
'use strict';

const ASSERT = require('../../scripts/test-harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) pass++; else fail++;
  ASSERT.log(ok, c, m, extra);
}
function eq(a, b, m, extra) {
  if (a === b) pass++; else fail++;
  ASSERT.log(eq, a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

/** 取 JS 里带引号的字符串字面量；单行注释和块注释里的同款文字不算玩家可见。 */
function jsStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i++];
      let s = '';
      while (i < n) {
        if (src[i] === '\\') { s += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === q) { i++; break; }
        s += src[i++];
      }
      out.push(s);
      continue;
    }
    i++;
  }
  return out;
}
const BANNED = ['操作失败', '请稍后重试', '网络异常', '请求失败', '系统繁忙', '错误码 1023'];
/* D-2：网络层的裸技术短语曾经原样弹给玩家（roomStore 的 Error 文案经 `{ok:false,error:e.message}`
 * → flashRoomError → flash() 直达）。它们不在 BANNED 里，「0 条万能文案」就是口径内为真、口径外为假。 */
const TECH_JARGON = ['连接超时', '连接失败', '请求超时', '无法建立连接'];
const bannedIn = (strings) => {
  const hits = [];
  for (const s of strings) for (const w of BANNED.concat(TECH_JARGON)) {
    if (s.indexOf(w) >= 0) hits.push(w + ' ← ' + s.slice(0, 40));
  }
  return hits;
};

/* =================== 量词位扫描器（D-1） ===================
 * 为什么原来的写法必然漏：运行时量词是**拼出来的** ——
 *   `'共 ' + st.games + ' 局'`、`'当前 ' + n + ' 场战绩将被删除'`
 * 字面量里根本没有数字，所以 `/共\s*\d+\s*场/` 这类"匹配带数字的整句"永远命不中，
 * 只有被正面断言点名的那个节点（#rp-list-count）被钉住，其余运行时节点一律无覆盖 ——
 * 改回「场」守卫仍然全绿（QA 实测过）。
 *
 * 换判据：不猜整句，只认**量词位的终点字**。契约（P0-5）是「一整场 = 局」，所以
 * 「局 / 把」出现在量词位是对的，**「场」出现在量词位即红**，不管数字是不是拼出来的。
 *
 * 「量词位」= 两个条件同时成立：
 *   ① 前一字是「串首 / 空白 / 数字」——
 *      把成语与名词里的「场」排除在外：全场 / 清场 / 散场 / 单场之王 / 整场 / 当场
 *      （它们前面的字是 全 / 清 / 散 / 单 / 整 / 当，不是空白或数字）。
 *   ② 后一字是「串尾 / 空白 / 标点 / 标记边界」，或它修饰的名词（战绩 / 记录 / 对局 / 的 / 以上 / 以内）——
 *      把词内字排除：场次、场上（规则页「1 + 场上豹子数」里那个「场」后面接的是「上」）。
 * 两个条件都必要：只留①会误伤「1 + 场上豹子数」，只留②会误伤「全场都是小牌」。
 *
 * 为什么选这条路而不是"给每个运行时节点补一条正面断言"：
 * 正面断言只能钉住**当时列出来的那几处**，下一个人新增一个量词节点（本文件出现过 7 处运行时节点，
 * 分散在 recordsView 六个函数里）就又回到盲区；而且断言的是一整串拼接表达式，改一个字就假红。
 * 扫描器的覆盖面是"全 JS 字符串 + HTML 可见文本"，新节点天然被扫到，不需要维护清单。 */
const QUANT = ['场', '局', '把'];
const Q_NEXT_OK = /^(?:$|[\s·，。、：；（）()【】〈〉《》<>"'!?！？—…\/]|的|战绩|记录|对局|以上|以内)/;

/** 返回文本里所有「量词位」上的量词：`[{ q: '局', ctx: '…共 9 局…' }]`（ctx 给失败时看现场） */
function quantifierSites(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (QUANT.indexOf(text[i]) < 0) continue;
    const prev = i === 0 ? '' : text[i - 1];
    if (prev !== '' && !/[\s0-9]/.test(prev)) continue;          // 条件①
    if (!Q_NEXT_OK.test(text.slice(i + 1, i + 4))) continue;     // 条件②
    out.push({ q: text[i], ctx: text.slice(Math.max(0, i - 8), i + 8) });
  }
  return out;
}
/** 量词位上的「场」= 契约违规（一整场必须写「局」） */
function quantifierSlips(text) {
  return quantifierSites(text).filter((s) => s.q === '场').map((s) => s.ctx);
}

const htmlRaw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, '');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => /\.js$/.test(f));
const jsSrc = {};
for (const f of jsFiles) jsSrc[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
const allStrings = jsFiles.reduce((a, f) => a.concat(jsStrings(jsSrc[f])), []);

/* =================== [0] 扫描器自测 =================== */
head('[0] 扫描器自测（没命中 ≠ 扫描器瞎了）');
{
  const sample = "var a = '操作失败'; // 操作失败\n/* 网络异常，请求失败 */\nvar b = '这一把你不打';";
  const got = jsStrings(sample);
  eq(bannedIn(got).length, 1, '★ 注释里的禁用词不算（只数字符串里的那一条）');
  eq(bannedIn(got)[0].indexOf('操作失败') >= 0, true, '★ 字符串里真有的那条被抓到');
  eq(got.indexOf('这一把你不打') >= 0, true, '★ 普通文案没被误伤');
  ok(allStrings.length > 300, '前置：真的扫到了 JS 字符串（' + allStrings.length + ' 条）');
}

/* =================== [0b] 量词位扫描器自测（D-1） =================== */
head('[0b] 量词位扫描器自测（含"拼接口径"这一列）');
{
  /* 这几条样本 **必须逐字对应**下面几类真实写法，否则守卫自测就是自说自话。 */
  eq(quantifierSlips("' 场战绩将被删除'").length, 1,
    '★ 拼接口径的量词位改写「场」被抓到（就是 recordsView 清除确认框那句）');
  eq(quantifierSlips("'共 5 场'").length, 1, '★ 带数字的「5 场」同样被抓到（老判据那条继续有效）');
  eq(quantifierSlips("' 场'").length, 1, '★ 只有量词本身的碎片（只有首尾引号）也抓得到');
  eq(quantifierSlips("' 局战绩将被删除'").length, 0, '★ 正确写法「局」不报');
  eq(quantifierSlips("'全场都是小牌，输的还是你'").length, 0, '★ 「全场」不误伤');
  eq(quantifierSlips("'一巡清场' + '一巡散场' + '单场之王' + '整场 9 把'").length, 0,
    '★ 清场 / 散场 / 单场 / 整场 都不误伤');
  eq(quantifierSlips("'场次与连胜看还差多少'").length, 0, '★ 「场次」是另一个词，不误伤');
  eq(quantifierSlips("'1 + 场上豹子数'").length, 0, '★ 「场上」不误伤（规则页真有这句）');

  const sites = [];
  for (const f of jsFiles) for (const s of jsStrings(jsSrc[f])) {
    for (const h of quantifierSites(s)) sites.push(f + ' → ' + h.q + ' ← ' + h.ctx);
  }
  const ju = sites.filter((x) => x.indexOf('→ 局') >= 0);
  ok(ju.length >= 8, '前置：量词位上的「局」扫到 ' + ju.length + ' 处（扫描器不是瞎的，运转时节点都在里面）',
    ju.slice(0, 3).join(' | '));
  ok(sites.some((x) => x.indexOf('→ 把') >= 0), '★ 量词位上的「把」也在用（单次发牌这一档契约没丢）');
  ok(ju.some((x) => x.indexOf('recordsView.js') >= 0), '前置：战绩页的运行时量词在被扫的集合里');
}

/* =================== [1] 回放弹窗只有一个名字（P0-2） =================== */
head('[1] 本局过程');
{
  ok(/<button id="btn-replay"[^>]*>本局过程<\/button>/.test(html), '★ 结算页按钮写「本局过程」');
  ok(/<h2 id="replay-title">本局过程<\/h2>/.test(html), '★★ 弹窗标题与按钮同名（改回「本场过程」必须红）');
  ok(jsSrc['recordsView.js'].indexOf("这一局的牌面过程") >= 0, '★ 战绩页 aria-label 也统一到「局」');
  const leakage = allStrings.filter((s) => /本场过程|这一场的牌面过程/.test(s));
  eq(leakage.length, 0, '★★ 玩家可见字符串里没有「本场 / 这一场过程」', leakage.slice(0, 3).join(' | '));
}

/* =================== [2] 量词契约（P0-5） =================== */
head('[2] 把 = 单次发牌 / 局 = 一整场');
{
  ok(html.indexOf('一把两轮') >= 0, '★ 契约样板：「一把两轮」仍在');
  ok(/<span id="rp-list-count"[^>]*>共 0 局</.test(html), '★ 战绩列表静态空态写「共 0 局」');
  const badHtml = [
    /最近\s*\d+\s*场/, /单场最高/, />\s*\d+\s*场\s*</, /共\s*\d+\s*场/, /最长连(胜|败)[\s\S]{0,80}?<i>场<\/i>/
  ].filter((re) => re.test(html));
  eq(badHtml.length, 0, '★★ HTML 可见文案里同一战绩口径不再出现「场」', badHtml.map(String).join(' | '));
  const badJs = allStrings.filter((s) => /最近\s*\d+\s*场|单场最高|共\s*['"]?\s*\d+\s*场|列表近\s*\d+\s*场|\d+\s*场记录|第\s*\d+\s*场/.test(s));
  eq(badJs.length, 0, '★★ JS 动态文案里同一口径不再出现「场」', badJs.slice(0, 3).join(' | '));
  ok(jsSrc['recordsView.js'].indexOf("'共 ' + st.games + ' 局'") >= 0,
    '★★ 运行时覆写 #rp-list-count 的也是「局」（只改静态 HTML 等于没改）');

  /* D-1 主断言：不再依赖"带数字的整句"，直接判量词位的终点字。
   * 覆盖面 = 全部 JS 字符串 + HTML 可见文本，所以 recordsView 那 8 处运行时节点
   * （:96 最近 N 局 / :637-638 共 N 局·列表近 N 局 / :654-655 AI N 局 / :1153 第 N 局 /
   *   :1220 N 局·N 把 / :1591 榜上 N 局 / :1819 当前 N 局战绩 / :1875 将清除 N 局）全在里面。
   * 变异自证：把 :1819 的「局战绩」改回「场战绩」→ 本条必须红（此前是绿的）。 */
  const jsSlips = [];
  for (const f of jsFiles) for (const s of jsStrings(jsSrc[f])) {
    for (const h of quantifierSlips(s)) jsSlips.push(f + ' → ' + h);
  }
  eq(jsSlips.length, 0,
    '★★ 量词位上一律写「局」：拼接口径改回「场」也必须红（D-1 盲区已补）', jsSlips.slice(0, 3).join(' | '));
  const htmlSlips = quantifierSlips(html);
  eq(htmlSlips.length, 0, '★★ HTML 可见文案的量词位同样没有「场」', htmlSlips.slice(0, 3).join(' | '));
  /* 两处刻意保留：'这一局你在旁边看' 描述整局旁听，'这一把你不打' 描述单次发牌退出。 */
  ok(jsSrc['game.js'].indexOf('这一局你在旁边看') >= 0 && jsSrc['game.js'].indexOf('这一把你不打') >= 0,
    '★ 两处刻意区分整局/单把的文案保留不改（取舍，不是漏改）');
}

/* =================== [3] 禁用词清零（P0-6） =================== */
head('[3] 禁用词在玩家可见字符串里命中数 = 0');
{
  const hits = bannedIn(allStrings);
  eq(hits.length, 0, '★★ 玩家可见 JS 字符串里禁用词命中 0（后台 admin.html 不在扫描面）', hits.slice(0, 5).join(' | '));
  ok(allStrings.some((s) => s.indexOf('账号数据没读上来') >= 0 || s.indexOf('没读上来') >= 0),
    '★ 具体动词文案已经落地（不是把禁用词换成空话）');
}

/* =================== [4] 净胜只有一个说法（P0-7） =================== */
head('[4] 净胜 / 净得分裂');
{
  ok(/<p id="rb-sub"[^>]*>本轮各家净胜<\/p>/.test(html), '★★ 轮次交替卡静态文案写「净胜」');
  ok(jsSrc['settleView.js'].indexOf("'本轮各家净胜'") >= 0, '★★ JS 覆写值也写「净胜」');
  const leakage = allStrings.filter((s) => s.indexOf('净得') >= 0);
  eq(leakage.length, 0, '★★ 玩家可见字符串里没有孤例「净得」', leakage.slice(0, 3).join(' | '));
  eq(/净得/.test(html), false, '★ HTML 可见文案里也没有「净得」');
}

/* =================== [5] 战绩只有一个说法（P1-P5） =================== */
head('[5] 战绩 / 记录 不再混用');
{
  ok(html.indexOf('>清除战绩</button>') >= 0, '★★ 清除按钮写「战绩」（改回「清除记录」必须红）');
  ok(html.indexOf('当前 0 局战绩将被删除') >= 0, '★ 确认框计数也是「战绩」');
  ok(html.indexOf('先把本机战绩给你看') >= 0, '★ 本机副本统一写「本机战绩」');
  const badHtml = [/清除记录/, /暂无战绩记录/, /局记录将被删除/, /设备上的记录/].filter((re) => re.test(html));
  eq(badHtml.length, 0, '★★ HTML 可见文案里没有「记录」指战绩数据', badHtml.map(String).join(' | '));
  const badJs = allStrings.filter((s) => /清除记录|战绩记录|局记录|设备上的记录|已清除这台设备上的记录/.test(s));
  eq(badJs.length, 0, '★★ JS 可见字符串里没有「记录」指战绩数据', badJs.slice(0, 3).join(' | '));
  ok(allStrings.some((s) => s.indexOf('本机战绩已清除') >= 0), '★ 两种回执收敛成「本机战绩已清除」');
  ok(jsSrc['recordsView.js'].indexOf("+ '战绩' + (withCloud") >= 0,
    '★ 撤销条的 msg 也是拼接出「战绩」（只改确认框等于没改）');
  /* 「过程记录」「下载记录」是别的语义（回放步骤 / 浏览器下载列表），刻意保留。 */
  ok(allStrings.some((s) => s.indexOf('过程记录') >= 0), '★ 不同语义的「过程记录」保留，不被误伤');
}

/* =================== [6] 开局动作统一（P1-P6） =================== */
head('[6] 状态提示「开局」/ 等人按钮「开牌」');
{
  const game = allStrings;
  ok(game.indexOf('全部准备好，马上开局') >= 0, '★★ 「马上开始」已并到「开局」');
  ok(game.indexOf('已放行，人齐就开局') >= 0, '★ 放行状态提示写「开局」');
  ok(jsSrc['nextRoundHints.js'].indexOf('点「开始下一局」就开局') >= 0, '★ 下一局提示写「开局」');
  const bad = game.filter((s) => s.indexOf('添加到桌面') < 0 && /马上开始|才能开 ·|就开$|人齐就开牌/.test(s));
  eq(bad.length, 0, '★★ 状态提示里没有孤立的「开始 / 开 / 开牌」', bad.slice(0, 3).join(' | '));
  ok(html.indexOf('>开始下一局</button>') >= 0, '★ 主按钮文案不变（保留「开始下一局」）');
  ok(/aria-label="先别开牌，我等个人"/.test(htmlRaw), '★ 等人按钮 aria-label 用「开牌」');
  ok(jsSrc['settleView.js'].indexOf("'人齐了，开牌'") >= 0, '★ 运行时覆写的 aria-label 也用「开牌」');
  ok(!/先别开局|人齐了，开局/.test(htmlRaw + jsSrc['settleView.js']), '★ 等人按钮没有混进「开局」');
}

/* =================== [7] 错误文案说清后果（P1-P7） =================== */
head('[7] 没有万能「出了点问题」/ 泛化「稍后再试」');
{
  const bad = allStrings.filter((s) => /出了点问题|稍后再试|请稍后再试|检查一下网络|暂时进不去|进不了修改/.test(s));
  eq(bad.length, 0, '★★ 玩家可见字符串里 0 条万能文案（改回旧句必须红）', bad.slice(0, 4).join(' | '));
  ok(allStrings.some((s) => s.indexOf('已经记下了') >= 0), '★ 「已经记下了」的上报语义保留');
  const verbs = /回房间|回首页|重新点|看一眼|核对|换张照片|再点一次/;
  const rewrites = allStrings.filter((s) => /已经记下了|没有改上|没登录上|没传上去|没改成|没清掉|没连上服务器|已经开了/.test(s));
  ok(rewrites.length >= 8, '前置：扫到 ' + rewrites.length + ' 条重写后的具体文案');
  const noVerb = rewrites.filter((s) => !verbs.test(s));
  eq(noVerb.length, 0, '★★ 每条重写文案都带具体动词（不是换个说法的泛词）', noVerb.slice(0, 3).join(' | '));
  eq(bannedIn(allStrings).length, 0, '★ P0 已清零的禁用词没有被带回来');

  /* D-2：网络层的裸技术短语（roomStore 的 Error 文案原样进 flash()）。
   * 它们既不说后果也不给动词，玩家看到「请求超时」不知道房间到底动了没。
   * 变异自证：把 roomStore 任一处改回「请求超时」→ 本条必须红。 */
  const jargon = allStrings.filter((s) => TECH_JARGON.some((w) => s.indexOf(w) >= 0));
  eq(jargon.length, 0, '★★ 裸技术短语不再直达玩家（连接超时 / 连接失败 / 请求超时 / 无法建立连接）',
    jargon.slice(0, 4).map((s) => s.slice(0, 40)).join(' | '));
  const roomFails = allStrings.filter((s) => s.indexOf('这步没送到') >= 0);
  ok(roomFails.length >= 3, '★ 房间操作的失败文案改成「没送到 + 房间没变化 + 再点一次」（' + roomFails.length + ' 句）',
    roomFails.slice(0, 2).join(' | '));
  /* 同一句失败提示的口径：项目里既有的写法是「这步没成功，房间没变化，再点一次」（game.js 4 处），
   * 后补的几句不能写「这一步」—— 同一屏两个说法正是本批要消灭的东西。 */
  const stepVoice = allStrings.filter((s) => s.indexOf('没送到') >= 0 && s.indexOf('这步没送到') < 0);
  eq(stepVoice.length, 0, '★ 失败提示统一说「这步没送到」（与既有「这步没成功」同口径，不写「这一步」）',
    stepVoice.slice(0, 3).join(' | '));
}

/* =================== [8] AI 只有一个叫法（P1-P8） =================== */
head('[8] AI / 含 AI 对局');
{
  ok(html.indexOf('>补 AI</button>') >= 0, '★★ 补位按钮写「补 AI」');
  ok(html.indexOf('<span class="rp-ai-chip">含 AI</span>') >= 0, '★ 徽标写「含 AI」');
  ok(html.indexOf('含 AI 的对局不计入战绩与排行榜') >= 0, '★★ 说明句统一（改回「人机对局不计入」必须红）');
  ok(html.indexOf('不含 AI 对局') >= 0, '★ 榜单/成就页脚也写「不含 AI 对局」');
  const badHtml = [/AI 队友/, /AI 玩家/, /含人机/, /人机对局/].filter((re) => re.test(htmlRaw));
  eq(badHtml.length, 0, '★★ HTML（含注释）里没有第三种叫法', badHtml.map(String).join(' | '));
  const badJs = allStrings.filter((s) => /AI 队友|AI 玩家|人机/.test(s));
  eq(badJs.length, 0, '★★ JS 可见字符串里没有第三种叫法', badJs.slice(0, 3).join(' | '));
  ok(jsSrc['settleView.js'].indexOf('本局含 AI · 不计入战绩与排行榜') >= 0, '★ 结算页那句与战绩页同口径');
}

/* =================== [9] 成就用阿拉伯数字（P1-P10） =================== */
head('[9] 成就文案数字与量词');
{
  const ach = jsStrings(jsSrc['achievements.js']);
  const bad = ach.filter((s) => /[一二三四五六七八九十百]+场/.test(s));
  eq(bad.length, 0, '★★ 成就描述里没有中文数字 + 场（改回「十场」必须红）', bad.slice(0, 3).join(' | '));
  for (const want of ['第 1 局', '10 局', '50 局', '5 局', '15 局']) {
    ok(ach.some((s) => s.indexOf(want) >= 0), '★ 成就描述出现「' + want + '」');
  }
  ok(!ach.some((s) => /\d+场/.test(s)), '★ 阿拉伯数字后也必须留空格（「10 场」写法不许回潮）');
}

/* =================== [10] aria-label 用字（P1-P11） =================== */
head('[10] 可访问性文本用字');
{
  ok(/id="rp-bests"[^>]*aria-label="记录"/.test(htmlRaw), '★★ 最佳成绩区 aria-label 写「记录」（「纪录」必须红）');
  ok(!/aria-label="纪录"/.test(htmlRaw), '★ 全页没有第二处「纪录」');
  const room = /<input\b[^>]*\bid="room-input"[^>]*>/.exec(htmlRaw);
  ok(!!room && /placeholder="6 位房间号"/.test(room[0]) && /aria-label="6 位房间号"/.test(room[0]),
    '★★ 房间号 placeholder 与 aria-label 同为「6 位房间号」');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
