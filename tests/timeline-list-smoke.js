#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「NPC存档」列表页：查询 / 下拉 / 搜索框 / 筛选按钮 链路自检（纯 Node，不需要微信运行环境）
 *
 * 做法：把 pages/timeline/timeline.js 原样 require 进来，只 stub 掉 wx / Page / api / auth。
 *      计时器与 Date.now 换成假时钟，用例可确定性复现「输入防抖 400ms」「翻页在途时来搜索」这类时序。
 *
 * 覆盖的四条交互（用户点名要过一遍的）：
 *  Q 列表查询与翻页：reset / loadMore 的游标、去重、hasMore、版本护栏
 *  S 搜索输入框：展开/收起、防抖、命中回填、清空回落、单飞、与在途翻页的并发
 *  P 下拉刷新：触发 reset 并收起刷新态；搜索中下拉不该留下「框里有词、列表却是全量」
 *  F 筛选按钮：三态循环 all→mine→others、写偏好、按新范围重拉
 *
 * 用法：node tests/timeline-list-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TIMELINE_PATH = path.join(ROOT, "pages", "timeline", "timeline.js");
const PAGE_SIZE = 10;

// ==================== 假时钟 ====================
const clock = {
  now: 1700000000000,
  seq: 0,
  timers: new Map(),
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + (ms || 0), every: 0 });
    return id;
  },
  setInterval(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + (ms || 0), every: Math.max(1, ms || 0) });
    return id;
  },
  clear(id) {
    this.timers.delete(id);
  },
  tick(ms) {
    const target = this.now + ms;
    for (let guard = 0; guard < 5000; guard += 1) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target);
      if (!due.length) break;
      due.sort((a, b) => a[1].at - b[1].at);
      const [id, t] = due[0];
      this.now = t.at;
      if (t.every) t.at = this.now + t.every;
      else this.timers.delete(id);
      t.fn();
    }
    this.now = target;
  },
  reset() {
    this.timers.clear();
  },
};
global.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
global.setInterval = (fn, ms) => clock.setInterval(fn, ms);
global.clearTimeout = (id) => clock.clear(id);
global.clearInterval = (id) => clock.clear(id);
Date.now = () => clock.now;

function deferred() {
  let resolve;
  let reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  p.resolve = resolve;
  p.reject = reject;
  return p;
}

// ==================== wx 桩 ====================
const toasts = [];
const stopPullDownCalls = { n: 0 };
global.wx = new Proxy(
  {
    showToast: (o) => toasts.push((o && o.title) || ""),
    stopPullDownRefresh: () => {
      stopPullDownCalls.n += 1;
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
    getRecorderManager: () => ({
      onStop() {},
      onError() {},
      start() {},
      stop() {},
    }),
    vibrateShort: () => {},
  },
  {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        const opts = args[args.length - 1] || {};
        if (opts && typeof opts.success === "function") opts.success({});
      };
    },
  },
);
global.Behavior = (o) => o;
const globalData = {};
global.getApp = () => ({ globalData });

// ==================== api / auth 桩（可按用例换实现与时序）====================
const apiState = {
  pageImpl: null,
  searchImpl: null,
  pageCalls: [],
  searchCalls: [],
  pinCalls: [],
  removeCalls: [],
  reset() {
    this.pageCalls = [];
    this.searchCalls = [];
    this.pinCalls = [];
    this.removeCalls = [];
    // 默认：列表返回一页不满（2 条）→ hasMore false；搜索返回空
    this.pageImpl = () => Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
    this.searchImpl = () => Promise.resolve({ code: 200, data: { list: [] } });
  },
};
const apiMock = {
  event: {
    page: (params, scope) => {
      apiState.pageCalls.push({ params, scope });
      return apiState.pageImpl(params, scope);
    },
    pin: (id, pinned) => {
      apiState.pinCalls.push({ id, pinned });
      return Promise.resolve({ code: 200, data: {} });
    },
    remove: (id) => {
      apiState.removeCalls.push(id);
      return Promise.resolve({ code: 200, data: {} });
    },
  },
  memory: {
    search: (q, limit, scope) => {
      apiState.searchCalls.push({ q, limit, scope });
      return apiState.searchImpl(q, limit, scope);
    },
  },
};

// auth 的查看范围用可读写变量模拟（getFilterScope/setFilterScope 落到这里）
const authState = { scope: "all" };
const authMock = {
  checkLogin: () => true,
  isAdmin: () => false,
  getUserId: () => 1,
  getFilterScope: () => authState.scope,
  setFilterScope: (s) => {
    authState.scope = s || "all";
  },
};

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, paths: [], loaded: true, exports };
}
stubModule(path.join(ROOT, "utils", "api.js"), apiMock);
stubModule(path.join(ROOT, "utils", "auth.js"), authMock);

// ==================== 捞出 Page 定义 ====================
let captured = null;
global.Page = (opts) => {
  captured = opts;
};
require(TIMELINE_PATH);
const timelineDef = captured;

// ==================== 页面实例（setData 支持 a.b 点号路径）====================
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    if (key.indexOf(".") === -1) {
      data[key] = patch[key];
      return;
    }
    const parts = key.split(".");
    let cur = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = patch[key];
  });
}
function newPage(def) {
  const p = Object.assign({}, def);
  p.data = clone(def.data);
  p.setData = (patch, cb) => {
    applyPatch(p.data, patch || {});
    if (cb) cb();
  };
  return p;
}
async function idle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ==================== 造数据 ====================
/** 列表接口的一条（走 fromListItem） */
function mkItem(id, time, event) {
  return {
    id,
    time: time || "2026-10-05 09:00",
    event: event || `事件${id}`,
    content: `正文${id}`,
    tags: ["t"],
    is_mine: true,
  };
}
/** 满 PAGE_SIZE 的一条起始 id 的连续列表（用于测 hasMore=true） */
function mkFullPage(baseId) {
  const items = [];
  for (let i = 0; i < PAGE_SIZE; i += 1) {
    const id = baseId - i;
    items.push(mkItem(id, `2026-10-${String(20 - i).padStart(2, "0")} 10:00`, `事件${id}`));
  }
  return items;
}
/** 搜索结果的一条（走 fromMemoryItem） */
function mkSearch(id, event) {
  return { id, time: "2026-10-05 09:00", event: event || `命中${id}`, tags: ["t"], score: 0.9 };
}

// ==================== 迷你断言框架 ====================
const results = [];
function check(id, desc, cond, detail) {
  results.push({ id, desc, pass: Boolean(cond), detail });
}
function section(title) {
  results.push({ section: title });
}

(async () => {
  // ==================== Q 列表查询与翻页 ====================
  section("Q 列表查询与翻页：游标 / 去重 / hasMore / 版本护栏");

  // Q01 reset 拉第一页：entries 落地、游标取时间最旧那条（末条）id
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () =>
    Promise.resolve({
      code: 200,
      data: { items: [mkItem(8, "2026-10-08 02:52"), mkItem(3, "2026-10-03 10:00")], pinned: [] },
    });
  let p = newPage(timelineDef);
  await p.reset();
  await idle();
  check("Q01", "reset 拉到第一页并建分组", p.data.entries.length === 2 && p.data.groups.length === 1, `entries=${p.data.entries.length} groups=${p.data.groups.length}`);
  check("Q01b", "游标取本页末条（时间最旧）id=3，而非 min/max 之外的值", p._cursor === 3, `cursor=${p._cursor}`);
  check("Q01c", "不足一页 → hasMore=false", p.data.hasMore === false, `hasMore=${p.data.hasMore}`);

  // Q02 满一页 → hasMore=true；loadMore 追加并按 id 去重
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: mkFullPage(20), pinned: [] } });
  p = newPage(timelineDef);
  await p.reset();
  await idle();
  check("Q02", "满一页 → hasMore=true", p.data.hasMore === true && p.data.entries.length === PAGE_SIZE, `hasMore=${p.data.hasMore} n=${p.data.entries.length}`);
  const cursorAfterFirst = p._cursor;
  check("Q02b", "游标推进到本页末条 id=11", cursorAfterFirst === 11, `cursor=${cursorAfterFirst}`);
  // 第二页：首条与上一页末条重复（id=11），应被去重
  apiState.pageImpl = () =>
    Promise.resolve({
      code: 200,
      data: { items: [mkItem(11, "2026-10-11 10:00"), mkItem(10, "2026-10-10 10:00")], pinned: [] },
    });
  await p.loadMore();
  await idle();
  const ids = p.data.entries.map((e) => Number(e.id));
  check("Q02c", "翻页按 id 去重，不出现重复卡片", ids.length === 11 && ids.filter((x) => x === 11).length === 1, `ids=${JSON.stringify(ids)}`);
  check("Q02d", "翻页带上一次游标 beforeId", apiState.pageCalls[1] && Number(apiState.pageCalls[1].params.beforeId) === 11, JSON.stringify(apiState.pageCalls[1] && apiState.pageCalls[1].params));

  // Q03 版本护栏：慢的第一页回来后，若已被新的 reset 覆盖则丢弃
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  const slow = deferred();
  apiState.pageImpl = () => slow;
  p = newPage(timelineDef);
  const firstReset = p.reset(); // version=1，loadMore 卡在慢响应上
  await idle();
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(99, "2026-10-09 09:00", "新页")], pinned: [] } });
  const secondReset = p.reset(); // version=2，快速返回
  await secondReset;
  await idle();
  slow.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 01:00", "旧页"), mkItem(2, "2026-10-02 02:00", "旧页2")], pinned: [] } });
  await firstReset;
  await idle();
  check("Q03", "过期翻页结果被版本护栏丢弃，不覆盖新数据", p.data.entries.length === 1 && p.data.entries[0].event === "新页", `entries=${JSON.stringify(p.data.entries.map((e) => e.event))}`);

  // Q04 业务错误（HTTP 200 + code!==200）不应被当成「没有更多」永久封死翻页
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 500, message: "服务繁忙" });
  p = newPage(timelineDef);
  await p.reset();
  await idle();
  check("Q04", "业务错误保留 hasMore，可再靠下拉/翻页重试", p.data.hasMore === true && p._loadFailed === true, `hasMore=${p.data.hasMore} loadFailed=${p._loadFailed}`);

  // Q05 网络异常（reject）同样保留 hasMore，不置「没有更多」
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.reject(new Error("net down"));
  p = newPage(timelineDef);
  await p.reset();
  await idle();
  check("Q05", "网络异常保留 hasMore", p.data.hasMore === true && p._loadFailed === true, `hasMore=${p.data.hasMore} loadFailed=${p._loadFailed}`);

  // ==================== S 搜索输入框 ====================
  section("S 搜索输入框：展开 / 防抖 / 命中回填 / 清空回落 / 单飞 / 并发");

  // S01 expandSearch 展开
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  p = newPage(timelineDef);
  p.expandSearch();
  check("S01", "点搜索图标展开搜索框", p.data.searchExpanded === true, `expanded=${p.data.searchExpanded}`);

  // S02 collapseSearch：有词不收起，无词收起并退出搜索态
  p.setData({ keyword: "abc" });
  p.collapseSearch();
  check("S02", "框里有词时失焦不收起（不打断正在看的检索）", p.data.searchExpanded === true, `expanded=${p.data.searchExpanded}`);
  p.setData({ keyword: "" });
  p.collapseSearch();
  check("S02b", "框里无词时失焦收起并退出搜索态", p.data.searchExpanded === false && p.data.searchMode === false, `expanded=${p.data.searchExpanded} searchMode=${p.data.searchMode}`);

  // S03 输入防抖：400ms 内不搜，到点自动搜
  apiState.reset();
  authState.scope = "all";
  apiState.searchImpl = () => Promise.resolve({ code: 200, data: { list: [mkSearch(500, "命中甲")] } });
  p = newPage(timelineDef);
  p.setData({ searchExpanded: true });
  p.onKeywordInput({ detail: { value: "甲" } });
  check("S03", "刚输入还没到防抖窗口，不发搜索", apiState.searchCalls.length === 0, `calls=${apiState.searchCalls.length}`);
  clock.tick(400);
  await idle();
  check("S03b", "防抖到点自动发起检索", apiState.searchCalls.length === 1 && apiState.searchCalls[0].q === "甲", JSON.stringify(apiState.searchCalls[0]));
  check("S03c", "命中结果回填 entries 并进入搜索态", p.data.searchMode === true && p.data.entries.length === 1 && p.data.entries[0].event === "命中甲", `n=${p.data.entries.length}`);

  // S04 连续输入只发最后一次（防抖收敛）
  apiState.reset();
  authState.scope = "all";
  p = newPage(timelineDef);
  p.setData({ searchExpanded: true });
  p.onKeywordInput({ detail: { value: "生" } });
  clock.tick(200);
  p.onKeywordInput({ detail: { value: "生化" } });
  clock.tick(200);
  p.onKeywordInput({ detail: { value: "生化危机" } });
  clock.tick(400);
  await idle();
  check("S04", "连续输入被防抖收敛，只检索最终词一次", apiState.searchCalls.length === 1 && apiState.searchCalls[0].q === "生化危机", JSON.stringify(apiState.searchCalls));

  // S05 清空关键词 → 回落全量列表（退出搜索态）
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 08:00", "普通日志")], pinned: [] } });
  p.setData({ keyword: "生化危机", searchMode: true });
  p.onKeywordInput({ detail: { value: "" } });
  clock.tick(400);
  await idle();
  check("S05", "删空关键词后回落到全量列表并退出搜索态", p.data.searchMode === false && p.data.entries[0].event === "普通日志", `searchMode=${p.data.searchMode} first=${p.data.entries[0] && p.data.entries[0].event}`);
  check("S05b", "清空走的是列表接口而非检索", apiState.searchCalls.length === 0 && apiState.pageCalls.length >= 1, `search=${apiState.searchCalls.length} page=${apiState.pageCalls.length}`);

  // S06 空词直接 onSearch → 回落列表，不发检索
  apiState.reset();
  authState.scope = "all";
  p = newPage(timelineDef);
  p.setData({ keyword: "   " });
  await p.onSearch();
  await idle();
  check("S06", "空/纯空格关键词的 onSearch 不发检索，回落列表", apiState.searchCalls.length === 0 && p.data.searchMode === false, `search=${apiState.searchCalls.length} searchMode=${p.data.searchMode}`);

  // S07 检索范围跟随筛选：把 scope 透传给 memory.search
  apiState.reset();
  authState.scope = "mine";
  apiState.searchImpl = () => Promise.resolve({ code: 200, data: { list: [] } });
  p = newPage(timelineDef);
  p.setData({ keyword: "旅行" });
  await p.onSearch();
  await idle();
  check("S07", "检索带上当前查看范围 scope", apiState.searchCalls[0] && apiState.searchCalls[0].scope === "mine", JSON.stringify(apiState.searchCalls[0]));

  // S08 并发：在途翻页还没回来就先搜出结果，随后翻页不得把列表并进搜索结果
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  const inFlightPage = deferred();
  apiState.pageImpl = () => inFlightPage;
  p = newPage(timelineDef);
  const resetting = p.reset(); // 触发一次在途 loadMore（慢）
  await idle();
  apiState.searchImpl = () => Promise.resolve({ code: 200, data: { list: [mkSearch(777, "唯一命中")] } });
  p.setData({ keyword: "唯一", searchExpanded: true });
  await p.onSearch(); // 搜索先回来，entries = [唯一命中]
  await idle();
  const afterSearch = p.data.entries.map((e) => e.event);
  inFlightPage.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 00:00", "不该出现的列表项")], pinned: [] } });
  await resetting;
  await idle();
  check("S08", "在途翻页结果不污染已返回的搜索结果", p.data.entries.length === 1 && p.data.entries[0].event === "唯一命中", `afterSearch=${JSON.stringify(afterSearch)} now=${JSON.stringify(p.data.entries.map((e) => e.event))}`);

  // S09 单飞：检索未完时重复触发只发一次请求
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  const slowSearch = deferred();
  apiState.searchImpl = () => slowSearch;
  p = newPage(timelineDef);
  p.setData({ keyword: "并发" });
  const s1 = p.onSearch(); // 起第一发：_searching=true，卡在慢响应上
  const s2 = p.onSearch(); // 上一发还在途 → 应被单飞闸门直接弹回
  await s2; // 早退的发立即 resolve，不依赖 slowSearch
  await idle();
  check("S09", "检索单飞：连点只发一次 AI 请求", apiState.searchCalls.length === 1, `calls=${apiState.searchCalls.length}`);
  slowSearch.resolve({ code: 200, data: { list: [] } });
  await s1; // 第一发收尾
  await idle();

  // S10 检索在途时发生 reset（下拉刷新）：迟到的搜索结果必须被版本护栏丢弃，
  // 不能盖回刚重拉的全量列表（否则 searchMode 已 false、列表却是旧检索命中，翻页还会往里追加）
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  const staleSearch = deferred();
  apiState.searchImpl = () => staleSearch;
  apiState.pageImpl = () =>
    Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 07:00", "全量列表")], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ keyword: "甲", searchExpanded: true });
  const sSearch = p.onSearch(); // 卡在慢检索上，searchMode 已置 true
  await idle();
  await p.onPullDownRefresh(); // 检索未完就下拉刷新 → reset 回到全量
  await idle();
  staleSearch.resolve({ code: 200, data: { list: [mkSearch(9, "迟到的命中")] } });
  await sSearch;
  await idle();
  check("S10", "检索在途时下拉刷新：迟到的结果被版本护栏丢弃，不覆盖全量列表", p.data.entries.length === 1 && p.data.entries[0].event === "全量列表" && p.data.searchMode === false, `entries=${JSON.stringify(p.data.entries.map((e) => e.event))} searchMode=${p.data.searchMode}`);

  // ==================== SC 滑动 / 失焦收起搜索框 ====================
  section("SC 滑动 / 失焦收起搜索框：空框收起、有词不打断、收起不漏旧结果");

  // SC01 空框 + 滑动 → 自动收起（用户点名要的行为）
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 07:00", "列表")], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ searchExpanded: true, keyword: "", searchMode: false });
  p.onPageScroll();
  check("SC01", "搜索框为空时滑动列表自动收起", p.data.searchExpanded === false, `expanded=${p.data.searchExpanded}`);

  // SC02 有词 + 滑动 → 不收起（不打断正在看的检索）
  p.setData({ searchExpanded: true, keyword: "123", searchMode: true });
  p.onPageScroll();
  check("SC02", "框里有词时滑动不收起（不打断正在看的检索）", p.data.searchExpanded === true, `expanded=${p.data.searchExpanded}`);

  // SC03 删空关键词但防抖未触发的窗口里滑动：收起时必须 reset 回全量，别把旧搜索结果当列表残留
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 07:00", "回落到全量")], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ searchExpanded: true, keyword: "", searchMode: true, entries: [mkSearch(9, "旧搜索结果")] });
  p.onPageScroll();
  await idle();
  check("SC03", "删空后滑动收起时完整回落全量列表，不残留旧搜索结果", p.data.searchExpanded === false && p.data.searchMode === false && p.data.entries[0].event === "回落到全量", `expanded=${p.data.searchExpanded} searchMode=${p.data.searchMode} first=${p.data.entries[0] && p.data.entries[0].event}`);

  // SC04 失焦（collapseSearch）同样：空框 + 停在搜索结果态 → 收起并 reset
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(2, "2026-10-02 07:00", "失焦回落")], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ searchExpanded: true, keyword: "", searchMode: true, entries: [mkSearch(9, "旧搜索结果")] });
  p.collapseSearch();
  await idle();
  check("SC04", "失焦收起同样回落全量，不漏旧结果", p.data.searchExpanded === false && p.data.searchMode === false && p.data.entries[0].event === "失焦回落", `expanded=${p.data.searchExpanded} first=${p.data.entries[0] && p.data.entries[0].event}`);

  // ==================== P 下拉刷新 ====================
  section("P 下拉刷新：回到全量并收起刷新态");

  // P01 下拉触发 reset 并 stopPullDownRefresh
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  stopPullDownCalls.n = 0;
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 07:00", "刷新后的日志")], pinned: [] } });
  p = newPage(timelineDef);
  await p.onPullDownRefresh();
  await idle();
  check("P01", "下拉刷新重拉列表并收起刷新动画", stopPullDownCalls.n === 1 && p.data.entries[0].event === "刷新后的日志", `stop=${stopPullDownCalls.n} first=${p.data.entries[0] && p.data.entries[0].event}`);

  // P02 搜索中下拉：清掉框里残留词、退出搜索态，回到全量（不留「有词却看全量」的错位）
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(2, "2026-10-02 07:00", "全量列表")], pinned: [] } });
  p.setData({ keyword: "123", searchMode: true, searchExpanded: true, entries: [mkSearch(9, "旧结果")] });
  await p.onPullDownRefresh();
  await idle();
  check("P02", "搜索中下拉刷新清空关键词并退出搜索态", p.data.keyword === "" && p.data.searchMode === false, `keyword=${JSON.stringify(p.data.keyword)} searchMode=${p.data.searchMode}`);
  check("P02b", "下拉刷新收起搜索框（不留空框抢焦点）", p.data.searchExpanded === false, `expanded=${p.data.searchExpanded}`);
  check("P02c", "下拉刷新后列表为全量而非旧搜索结果", p.data.entries[0] && p.data.entries[0].event === "全量列表", `first=${p.data.entries[0] && p.data.entries[0].event}`);

  // ==================== F 筛选按钮（三态查看范围）====================
  section("F 筛选按钮：三态循环 / 写偏好 / 按新范围重拉");

  // F01 循环顺序 all → mine → others → all
  clock.reset();
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ filterScope: "all" });
  p.onCycleScope();
  await idle();
  check("F01", "第一次点：全部 → 只看自己", p.data.filterScope === "mine" && authState.scope === "mine", `scope=${p.data.filterScope} auth=${authState.scope}`);
  check("F01h", "切换时给出顶部提示", p.data.hintText === "只看自己", `hint=${p.data.hintText}`);
  p.onCycleScope();
  await idle();
  check("F01b", "第二次点：只看自己 → 只看他人", p.data.filterScope === "others" && authState.scope === "others", `scope=${p.data.filterScope}`);
  p.onCycleScope();
  await idle();
  check("F01c", "第三次点：只看他人 → 回到全部", p.data.filterScope === "all" && authState.scope === "all", `scope=${p.data.filterScope}`);

  // F02 切换后按新范围重拉列表（scope 透传给 event.page）
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
  p = newPage(timelineDef);
  p.setData({ filterScope: "all" });
  p.onCycleScope(); // → mine
  await idle();
  const lastPageCall = apiState.pageCalls[apiState.pageCalls.length - 1];
  check("F02", "切换范围后重拉列表并带上新的 scope", lastPageCall && lastPageCall.scope === "mine", JSON.stringify(lastPageCall && { scope: lastPageCall.scope }));

  // F03 切换范围时若还残留搜索词，一并清回全量（筛选与搜索不共存于一屏）
  apiState.reset();
  authState.scope = "all";
  apiState.pageImpl = () => Promise.resolve({ code: 200, data: { items: [mkItem(1, "2026-10-01 06:00", "范围列表")], pinned: [] } });
  p.setData({ keyword: "残留词", searchMode: true, entries: [mkSearch(9, "旧")] });
  p.onCycleScope();
  await idle();
  check("F03", "切换范围会退出搜索态并清空关键词", p.data.searchMode === false && p.data.keyword === "", `searchMode=${p.data.searchMode} keyword=${JSON.stringify(p.data.keyword)}`);

  // ==================== 输出 ====================
  let failed = 0;
  results.forEach((r) => {
    if (r.section) {
      console.log(`\n${r.section}`);
      console.log("-".repeat(r.section.length));
      return;
    }
    if (!r.pass) failed += 1;
    console.log(`${r.pass ? "  ✓" : "  ✗"} ${r.id} ${r.desc}${r.pass ? "" : `  →  ${r.detail}`}`);
  });
  console.log(`\n共 ${results.filter((r) => !r.section).length} 条断言，失败 ${failed} 条`);
  // 用 exitCode 而非 process.exit：后者在 stdout 是管道时会截断还没刷出的输出
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error("用例跑挂了：", err && err.stack);
  process.exitCode = 2;
});
