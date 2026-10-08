#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「长按卡片 → 置顶 / 取消置顶 / 编辑 / 删除」链路自检（纯 Node，不需要微信运行环境）
 *
 * 做法：把 pages/timeline/timeline.js 原样 require 进来，只 stub 掉 wx / Page / api / auth，
 *      再用可控的 showActionSheet 替用户点菜单项。断言的是页面真正的 data 变化，
 *      而不是重抄一遍逻辑。为什么值得单独测：卡片「就地移动」全靠本地维护两个数组
 *      （pinnedEntries + entries），一旦某处漏改，就会出现「置顶后同一条在列表里出现两次」
 *      或「取消置顶后卡片凭空消失」这种只有真机长按才暴露的问题。
 *
 * 用例表（断言 id 前缀即分组，与终端输出一一对应）：
 *  P 长按菜单与本地移动
 *   P01 长按自己的未置顶卡片：菜单三项，选「置顶」后卡片进置顶区、离开时间序流
 *   P02 长按已置顶卡片：首项是「取消置顶」，卡片按时间落回它原来那段
 *   P03 长按他人卡片：只给置顶相关一项，没有编辑/删除（后端按 event_user 拦）
 *   P04 搜索模式长按：不开置顶入口（检索结果里没有 pinned 状态），仍给编辑/删除
 *   P05 置顶被后端拒（超限）：列表一个字符都不动
 *   P06 连钉两条：后钉的在前，与后端 ORDER BY p.create_time DESC 同口径
 *   P07 菜单被手指收回：不发任何请求
 *   P08 删除已置顶的卡片：先确认，再两个数组一起摘掉
 *  L 列表接口回来的置顶
 *   L01 请求带 withPins=1，返回的 pinned 落到 pinnedEntries，items 里不含那几条
 *   L02 旧版后端没有 pinned 字段：本地已有那组不被抹空
 *   L03 翻页时游标仍取「本页最后一条」，不受置顶区影响
 *
 * 用法：node tests/pin-chain-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TIMELINE_PATH = path.join(ROOT, "pages", "timeline", "timeline.js");

// ==================== wx 桩 ====================
const toasts = [];
const navigates = [];
// 长按菜单：由用例决定点第几项（或干脆收回）
const sheets = [];
let sheetPick = 0;
let sheetCancel = false;
function whenSheetPick(i) {
  sheetPick = i;
  sheetCancel = false;
}
function whenSheetCancel() {
  sheetCancel = true;
}
let modalConfirm = true;
function whenModalConfirm(v) {
  modalConfirm = v;
}

const REC = {
  stopList: [],
  errorList: [],
  onStart() {},
  onStop(cb) {
    this.stopList.push(cb);
  },
  onError(cb) {
    this.errorList.push(cb);
  },
  start() {},
  stop() {},
};

global.wx = new Proxy(
  {
    getRecorderManager: () => REC,
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
    showToast: (o) => toasts.push((o && o.title) || ""),
    navigateTo: (o) => navigates.push((o && o.url) || ""),
    vibrateShort: () => {},
    showActionSheet: (o) => {
      sheets.push((o && o.itemList) || []);
      if (sheetCancel) {
        if (o && o.fail) o.fail({ errMsg: "showActionSheet:fail cancel" });
        return;
      }
      if (o && o.success) o.success({ tapIndex: sheetPick });
    },
    showModal: (o) => {
      if (o && o.success) {
        o.success({ confirm: modalConfirm, cancel: !modalConfirm });
      }
    },
  },
  {
    get(target, key) {
      if (key in target) return target[key];
      // 未预期的 wx API：给个「同步 success」桩，用例结尾会打印被调过哪些名字
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

// ==================== api / auth 桩 ====================
const apiState = {
  pinCalls: [],
  pinImpl: () => Promise.resolve({ code: 200, data: { pinned: true } }),
  removeCalls: [],
  pageCalls: [],
  pageImpl: () =>
    Promise.resolve({ code: 200, data: { items: [], pinned: [] } }),
  reset() {
    this.pinCalls = [];
    this.pinImpl = () => Promise.resolve({ code: 200, data: { pinned: true } });
    this.removeCalls = [];
    this.pageCalls = [];
    this.pageImpl = () =>
      Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
  },
};
const apiMock = {
  event: {
    pin: (id, pinned) => {
      apiState.pinCalls.push([id, pinned]);
      return apiState.pinImpl(id, pinned);
    },
    remove: (id) => {
      apiState.removeCalls.push(id);
      return Promise.resolve({ code: 200, data: {} });
    },
    page: (params) => {
      apiState.pageCalls.push(params);
      return apiState.pageImpl(params);
    },
  },
  memory: { search: async () => ({ code: 200, data: { list: [] } }) },
};
const authMock = new Proxy(
  {
    checkLogin: () => true,
    getFilterScope: () => "all",
    isAdmin: () => false,
    getUserId: () => 1,
  },
  { get: (t, k) => (k in t ? t[k] : () => null) },
);

function stubModule(absPath, exports) {
  require.cache[absPath] = {
    id: absPath,
    filename: absPath,
    paths: [],
    loaded: true,
    exports,
  };
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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function newPage(def) {
  const p = Object.assign({}, def);
  p.data = clone(def.data);
  p.setData = (patch) => {
    Object.assign(p.data, patch || {});
  };
  return p;
}
async function idle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 起一个已经加载好两条日志的列表页（一条本人、一条他人；时间一新一旧） */
function newLoadedPage(extraPins) {
  const p = newPage(timelineDef);
  const entries = [
    {
      id: 21,
      time: "2026-10-05 09:00",
      event: "十月的",
      isMine: true,
      pinned: false,
    },
    {
      id: 20,
      time: "2026-03-05 09:00",
      event: "三月的",
      isMine: true,
      pinned: false,
    },
    {
      id: 19,
      time: "2026-02-05 09:00",
      event: "他人的",
      isMine: false,
      pinned: false,
    },
  ];
  p.setData({
    entries,
    groups: p.buildGroups(entries),
    pinnedEntries: extraPins || [],
  });
  return p;
}

/** 置顶区 + 时间序流里一共出现了几次那个 id（查重用） */
function occurrences(p, id) {
  const inPinned = (p.data.pinnedEntries || []).filter(
    (e) => String(e.id) === String(id),
  ).length;
  const inEntries = (p.data.entries || []).filter(
    (e) => String(e.id) === String(id),
  ).length;
  return inPinned + inEntries;
}
function rowIds(p) {
  return (p.data.groups || []).reduce(
    (acc, g) => acc.concat(g.items.map((it) => String(it.id))),
    [],
  );
}

// ==================== 断言小工具 ====================
let pass = 0;
const fails = [];
function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${id}`);
  } else {
    fails.push(id);
    console.log(`  ✗ ${id}${detail ? ` —— ${detail}` : ""}`);
  }
}

// ==================== P 长按菜单与本地移动 ====================
async function groupP() {
  console.log("\nP 长按菜单与本地移动");

  // P01 长按自己的未置顶卡片 → 三项，点「置顶」
  apiState.reset();
  sheets.length = 0;
  toasts.length = 0;
  let p = newLoadedPage();
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  check(
    "P01a 长按本人卡片给出置顶/编辑/删除三项",
    sheets[0] && sheets[0].join("|") === "置顶|编辑|删除",
    JSON.stringify(sheets[0]),
  );
  check(
    "P01b 点置顶后请求为 (20,true)，卡片进置顶区且不再出现在时间序流",
    apiState.pinCalls[0] &&
      apiState.pinCalls[0][0] === 20 &&
      apiState.pinCalls[0][1] === true &&
      p.data.pinnedEntries.length === 1 &&
      p.data.pinnedEntries[0].id === 20 &&
      p.data.pinnedEntries[0].pinned === true &&
      !p.data.entries.some((e) => e.id === 20) &&
      rowIds(p).indexOf("20") === -1 &&
      occurrences(p, 20) === 1,
    `${JSON.stringify(apiState.pinCalls)} | pinned=${p.data.pinnedEntries.length}`,
  );

  // P02 长按已置顶卡片 → 首项取消置顶，卡片按时间落回原位
  apiState.reset();
  sheets.length = 0;
  p = newLoadedPage([
    {
      id: 20,
      time: "2026-03-05 09:00",
      event: "三月的",
      isMine: true,
      pinned: true,
    },
  ]);
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  check(
    "P02a 已置顶卡片的菜单首项是取消置顶",
    sheets[0] && sheets[0][0] === "取消置顶",
    JSON.stringify(sheets[0]),
  );
  check(
    "P02b 取消后卡片回到三月的这一段（时间序不被打乱、不重复）",
    apiState.pinCalls[0] &&
      apiState.pinCalls[0][1] === false &&
      p.data.pinnedEntries.length === 0 &&
      occurrences(p, 20) === 1 &&
      rowIds(p).join(",") === "21,20,19",
    `${JSON.stringify(apiState.pinCalls)} | rows=${rowIds(p).join(",")}`,
  );

  // P03 长按他人卡片 → 只有置顶一项
  apiState.reset();
  sheets.length = 0;
  p = newLoadedPage();
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 19 } });
  await idle();
  check(
    "P03 他人卡片只给置顶一项（编辑/删除后端会按 event_user 拦）",
    sheets[0] &&
      sheets[0].join("|") === "置顶" &&
      apiState.pinCalls.length === 1,
    JSON.stringify(sheets[0]),
  );

  // P04 搜索模式 → 不开置顶入口
  apiState.reset();
  sheets.length = 0;
  navigates.length = 0;
  p = newLoadedPage();
  p.setData({ searchMode: true });
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 21 } });
  await idle();
  check(
    "P04 搜索模式菜单没有置顶项，也不发 pin 请求",
    sheets[0] &&
      sheets[0].join("|") === "编辑|删除" &&
      apiState.pinCalls.length === 0 &&
      navigates[navigates.length - 1] === "/pages/edit/edit?id=21",
    JSON.stringify({ sheet: sheets[0], calls: apiState.pinCalls, navigates }),
  );

  // P05 后端拒绝（超限）→ 列表不动
  apiState.reset();
  sheets.length = 0;
  apiState.pinImpl = () =>
    Promise.resolve({ code: 1, message: "最多置顶 3 条，先取消一条再钉这条" });
  p = newLoadedPage();
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  check(
    "P05 置顶被拒时卡片与分组都不动",
    apiState.pinCalls.length === 1 &&
      p.data.pinnedEntries.length === 0 &&
      p.data.entries.length === 3 &&
      rowIds(p).join(",") === "21,20,19",
    JSON.stringify({
      pinned: p.data.pinnedEntries.length,
      rows: rowIds(p).join(","),
    }),
  );

  // P06 连钉两条 → 后钉的在前
  apiState.reset();
  sheets.length = 0;
  p = newLoadedPage();
  whenSheetPick(0);
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  p.onCardLongPress({ detail: { id: 21 } });
  await idle();
  check(
    "P06 后钉的那条排在置顶区最前",
    p.data.pinnedEntries.map((e) => e.id).join(",") === "21,20" &&
      occurrences(p, 20) === 1 &&
      occurrences(p, 21) === 1,
    p.data.pinnedEntries.map((e) => e.id).join(","),
  );

  // P07 收回菜单 → 什么都不发
  apiState.reset();
  sheets.length = 0;
  p = newLoadedPage();
  whenSheetCancel();
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  check(
    "P07 菜单被收回时不发任何请求、不动列表",
    apiState.pinCalls.length === 0 &&
      p.data.pinnedEntries.length === 0 &&
      p.data.entries.length === 3,
    JSON.stringify(apiState.pinCalls),
  );

  // P08 删除已置顶的卡片 → 两个数组一起摘掉
  apiState.reset();
  sheets.length = 0;
  navigates.length = 0;
  p = newLoadedPage([
    {
      id: 20,
      time: "2026-03-05 09:00",
      event: "三月的",
      isMine: true,
      pinned: true,
    },
  ]);
  whenModalConfirm(true);
  whenSheetPick(2); // 置顶区那条：取消置顶 | 编辑 | 删除
  p.onCardLongPress({ detail: { id: 20 } });
  await idle();
  check(
    "P08 删除已置顶卡片：请求发出且置顶区与列表都清掉",
    sheets[0] &&
      sheets[0].join("|") === "取消置顶|编辑|删除" &&
      apiState.removeCalls.join(",") === "20" &&
      occurrences(p, 20) === 0 &&
      rowIds(p).join(",") === "21,19",
    JSON.stringify({
      sheet: sheets[0],
      rm: apiState.removeCalls,
      rows: rowIds(p).join(","),
    }),
  );
}

// ==================== L 列表接口回来的置顶 ====================
async function groupL() {
  console.log("\nL 列表接口回来的置顶");

  // L01 带 withPins=1，pinned 落到置顶区
  apiState.reset();
  let p = newPage(timelineDef);
  apiState.pageImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        items: [
          { id: 21, time: "2026-10-05 09:00", event: "十月的", is_mine: true },
          { id: 19, time: "2026-02-05 09:00", event: "他人的" },
        ],
        pinned: [
          {
            id: 20,
            time: "2026-03-05 09:00",
            event: "三月的",
            is_mine: true,
            pinned: true,
          },
        ],
      },
    });
  await p.loadMore();
  check(
    "L01a 请求带上 withPins=1",
    apiState.pageCalls[0] && Number(apiState.pageCalls[0].withPins) === 1,
    JSON.stringify(apiState.pageCalls[0]),
  );
  check(
    "L01b 置顶区一条、时间序流两条，卡片左竖条仍按 is_mine 出",
    p.data.pinnedEntries.length === 1 &&
      p.data.pinnedEntries[0].id === 20 &&
      p.data.pinnedEntries[0].isMine === true &&
      p.data.entries.length === 2 &&
      rowIds(p).join(",") === "21,19",
    JSON.stringify({
      pinned: p.data.pinnedEntries.length,
      entries: p.data.entries.length,
      rows: rowIds(p).join(","),
    }),
  );

  // L02 旧版后端没有 pinned 字段 → 本地那组不被抹空
  apiState.reset();
  p = newLoadedPage([
    {
      id: 20,
      time: "2026-03-05 09:00",
      event: "三月的",
      isMine: true,
      pinned: true,
    },
  ]);
  apiState.pageImpl = () =>
    Promise.resolve({
      code: 200,
      data: { items: [{ id: 18, time: "2026-01-05 09:00", event: "一月的" }] },
    });
  await p.loadMore();
  check(
    "L02 后端没回 pinned 时保留本地已有那组",
    p.data.pinnedEntries.length === 1 && p.data.pinnedEntries[0].id === 20,
    JSON.stringify(p.data.pinnedEntries),
  );

  // L03 游标取本页最后一条，与置顶区无关
  apiState.reset();
  p = newPage(timelineDef);
  p._cursor = null;
  apiState.pageImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        items: [
          { id: 21, time: "2026-10-05 09:00", event: "a" },
          { id: 12, time: "2026-09-05 09:00", event: "b" },
        ],
        pinned: [{ id: 99, time: "2020-01-01 09:00", event: "很久以前但钉着" }],
      },
    });
  await p.loadMore();
  check(
    "L03 游标推进到本页最后一条（12），不被置顶那条 99 带偏",
    p._cursor === 12 && occurrences(p, 99) === 1,
    `cursor=${p._cursor}`,
  );
}

(async () => {
  await groupP();
  await groupL();
  console.log(
    `\n${fails.length ? "✗" : "✓"} 小程序置顶链路自检：${pass} 通过 / ${fails.length} 失败`,
  );
  if (fails.length) {
    console.log("  失败用例：" + fails.join(", "));
    process.exitCode = 1;
  }
})();
