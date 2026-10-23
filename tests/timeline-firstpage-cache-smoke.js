#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「存档」首屏：本地缓存秒开 + 首屏请求收敛 自检（纯 Node，不需要微信运行环境）
 *
 * 做法同 timeline-*.js：原样 require pages/timeline/timeline.js，只 stub wx / Page / api / auth，
 * 并把 storage 换成内存 Map，用来验证「首帧先出内容、后台再校正」这条链路。
 *
 * 覆盖：
 *  A 首屏请求收敛：恒带 withTotal=0（跳过 COUNT）、带 withPins、首屏不带 beforeId
 *  B 写入快照：首屏成功后落盘，key 前缀与写后失效口径一致
 *  C 秒开：有快照时 api 还没返回，groups 就已经有内容且 loading=false
 *  D 校正语义：快照里已被删除的条目在首屏替换后消失（不产生幽灵卡片）
 *  E 乐观插入：时间比第一页还早的新建条目会被补回来
 *  F 边界：userId 不符 / 过期 / 筛选态都不吃快照，筛选态也不写快照
 *
 * 用法：node tests/timeline-firstpage-cache-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TIMELINE_PATH = path.join(ROOT, "pages", "timeline", "timeline.js");
const PAGE_SIZE = 10;
const CACHE_PREFIX = "npc_cache_";
const CACHE_KEY_ALL = `${CACHE_PREFIX}eventList:first:all`;
const TTL = 3 * 24 * 60 * 60 * 1000;

// ==================== storage 桩 ====================
const storage = new Map();
function resetStorage() {
  storage.clear();
}

// ==================== wx / Page 桩 ====================
const toasts = [];
global.wx = {
  showToast: (o) => toasts.push((o && o.title) || ""),
  getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
  setStorageSync: (key, value) => {
    storage.set(key, value);
  },
  removeStorageSync: (key) => {
    storage.delete(key);
  },
  getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667 }),
  createSelectorQuery: () => ({
    select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }),
  }),
  getRecorderManager: () => ({
    onStop() {},
    onError() {},
    offStop() {},
    offError() {},
    start() {},
    stop() {},
  }),
  setBackgroundColor: () => {},
  stopPullDownRefresh: () => {},
  pageScrollTo: () => {},
  navigateTo: () => {},
  previewImage: () => {},
  setClipboardData: () => {},
  vibrateShort: () => {},
  showModal: () => {},
};
global.Behavior = (o) => o;
const globalData = {};
global.getApp = () => ({ globalData });

let pageConfig = null;
global.Page = (cfg) => {
  pageConfig = cfg;
};

// ==================== api / auth 桩 ====================
const authState = { scope: "all", userId: 1 };
const authMock = {
  checkLogin: () => true,
  isAdmin: () => false,
  getUser: () => ({ id: authState.userId }),
  getUserId: () => authState.userId,
  getFilterScope: () => authState.scope,
  setFilterScope: (s) => {
    authState.scope = s || "all";
  },
};

const apiState = {
  calls: [],
  impl: null,
  reset() {
    this.calls = [];
    this.impl = () => Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
  },
};

const apiMock = {
  event: {
    page: (params, scope) => {
      apiState.calls.push({ params, scope });
      return apiState.impl(params, scope);
    },
    detail: () => Promise.resolve({ code: 200, data: {} }),
    pin: () => Promise.resolve({ code: 200, data: {} }),
    remove: () => Promise.resolve({ code: 200, data: {} }),
    shareCopy: () => Promise.resolve({ code: 200, data: {} }),
    transcribe: () => Promise.resolve({ code: 200, data: {} }),
    uploadImage: () => Promise.resolve({ code: 200, data: {} }),
  },
  memory: {
    search: () => Promise.resolve({ code: 200, data: { list: [] } }),
    tags: () => Promise.resolve({ code: 200, data: { tags: [] } }),
    summary: () => Promise.resolve({ code: 200, data: {} }),
  },
  org: {
    mine: () => Promise.resolve({ code: 200, data: [] }),
    members: () => Promise.resolve({ code: 200, data: [] }),
  },
};

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
stubModule(path.join(ROOT, "utils", "audioHub.js"), {});
stubModule(path.join(ROOT, "utils", "options.js"), {
  TYPE_OPTIONS: ["生活"],
  RATING_OPTIONS: ["好"],
});

require(TIMELINE_PATH);

// ==================== 实例与 setData ====================
/** 支持 a、a[0]、a[0].b、a[0].b[1] 四种路径 */
function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    const parts = key
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter(Boolean);
    let target = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const prop = parts[i];
      if (target[prop] == null || typeof target[prop] !== "object") {
        target[prop] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      target = target[prop];
    }
    target[parts[parts.length - 1]] = patch[key];
  });
}

function newPage() {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = (patch, cb) => {
    applyPatch(inst.data, patch || {});
    if (typeof cb === "function") cb();
  };
  return inst;
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function listItem(id, time = "2026-05-01 10:00") {
  return {
    id,
    time,
    event: `日志${id}`,
    type: "生活",
    content: "正文",
    thumbs: [],
    imageUrls: [],
  };
}

function writeSnapshot(items, opts = {}) {
  storage.set(
    opts.key || CACHE_KEY_ALL,
    JSON.stringify({
      v: 1,
      ts: opts.ts || Date.now(),
      userId: opts.userId == null ? 1 : opts.userId,
      items,
      pinned: opts.pinned || [],
    }),
  );
}

function groupsIds(p) {
  return (p.data.groups || []).reduce(
    (acc, g) => acc.concat((g.items || []).map((it) => String(it.id))),
    [],
  );
}

// ==================== 断言 ====================
let passed = 0;
let failed = 0;
function check(id, name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${id} ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${id} ${name}${detail ? `\n      → ${detail}` : ""}`);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- A 首屏请求收敛 ----------
  resetStorage();
  authState.scope = "all";
  apiState.reset();
  apiState.impl = () =>
    Promise.resolve({
      code: 200,
      data: { items: [listItem(1), listItem(2)], pinned: [] },
    });

  let p = newPage();
  await p.reset();
  const first = apiState.calls[0];
  check("A01", "首屏不带 beforeId", first.params.beforeId === undefined, JSON.stringify(first.params));
  check("A02", "首屏也跳过 COUNT（withTotal=0）", first.params.withTotal === 0, JSON.stringify(first.params));
  check("A03", "纯列表首屏带 withPins=1", first.params.withPins === 1, JSON.stringify(first.params));
  check("A04", "pageSize 仍为 10", first.params.pageSize === PAGE_SIZE, JSON.stringify(first.params));

  // ---------- B 写入快照 ----------
  check("B01", "首屏成功后写入快照（key 含 scope）", storage.has(CACHE_KEY_ALL), [...storage.keys()].join(","));
  const saved = JSON.parse(storage.get(CACHE_KEY_ALL));
  check(
    "B02",
    "快照内容与响应一致（items 2 条）",
    Array.isArray(saved.items) && saved.items.length === 2 && saved.userId === 1,
    storage.get(CACHE_KEY_ALL),
  );

  // ---------- C 秒开：api 未返回时已渲染 ----------
  apiState.reset();
  const d = deferred();
  apiState.impl = () => d.promise;
  p = newPage();
  const pendingReset = p.reset();
  await flush(); // 让 reset 跑到 await loadMore（api 挂起）
  check(
    "C01",
    "请求未返回时列表已有快照内容",
    groupsIds(p).join(",") === "1,2",
    JSON.stringify(groupsIds(p)),
  );
  check("C02", "快照渲染时不显示整屏 loading", p.data.loading === false, `loading=${p.data.loading}`);
  check("C03", "快照不推进游标（首屏请求仍不带 beforeId）", p._cursor === null && apiState.calls[0].params.beforeId === undefined, `cursor=${p._cursor}`);
  d.resolve({ code: 200, data: { items: [listItem(1), listItem(2)], pinned: [] } });
  await pendingReset;

  // ---------- D 校正：快照里的幽灵条目被清掉 ----------
  resetStorage();
  writeSnapshot([listItem(1), listItem(2), listItem(3)]);
  apiState.reset();
  apiState.impl = () =>
    Promise.resolve({ code: 200, data: { items: [listItem(1), listItem(2)], pinned: [] } });
  p = newPage();
  await p.reset();
  check(
    "D01",
    "首屏替换后，快照里多出的旧条目消失",
    groupsIds(p).join(",") === "1,2",
    JSON.stringify(groupsIds(p)),
  );
  check(
    "D02",
    "替换后快照也更新为最新一页",
    JSON.parse(storage.get(CACHE_KEY_ALL)).items.length === 2,
    storage.get(CACHE_KEY_ALL),
  );

  // ---------- E 乐观插入：旧日期的新建条目要保住 ----------
  resetStorage();
  writeSnapshot([listItem(1)]);
  apiState.reset();
  apiState.impl = () =>
    Promise.resolve({ code: 200, data: { items: [listItem(1)], pinned: [] } });
  globalData._pendingTimelineInsert = { id: 999, event: "补记的旧日期", time: "2019-01-01 09:00" };
  p = newPage();
  await p.reset();
  check(
    "E01",
    "首屏替换后仍保留乐观插入的那条",
    groupsIds(p).indexOf("999") >= 0,
    JSON.stringify(groupsIds(p)),
  );

  // ---------- F 边界 ----------
  // F1 userId 不符
  resetStorage();
  writeSnapshot([listItem(1), listItem(2)], { userId: 2 });
  apiState.reset();
  const dF1 = deferred();
  apiState.impl = () => dF1.promise;
  p = newPage();
  const pendingF1 = p.reset();
  await flush();
  check(
    "F01",
    "换号后上一个人的快照不参与渲染",
    (p.data.groups || []).length === 0 && p.data.loading === true,
    `groups=${JSON.stringify(groupsIds(p))} loading=${p.data.loading}`,
  );
  dF1.resolve({ code: 200, data: { items: [], pinned: [] } });
  await pendingF1;

  // F2 过期
  resetStorage();
  writeSnapshot([listItem(1)], { ts: Date.now() - TTL - 1000 });
  apiState.reset();
  apiState.impl = () => Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
  p = newPage();
  const pendingF2 = p.reset();
  await flush();
  check("F02", "过期快照被丢弃", (p.data.groups || []).length === 0, JSON.stringify(groupsIds(p)));
  await pendingF2;

  // F3 筛选态：不读快照、也不写快照
  resetStorage();
  writeSnapshot([listItem(1), listItem(2)]);
  storage.delete(CACHE_KEY_ALL);
  apiState.reset();
  apiState.impl = () =>
    Promise.resolve({ code: 200, data: { items: [listItem(7)], pinned: [] } });
  p = newPage();
  p.data.hasFilter = true;
  p.data.filterBrief = [{ key: "type:生活", label: "生活" }];
  await p.reset();
  check("F03", "筛选态不吃快照", groupsIds(p).join(",") === "7", JSON.stringify(groupsIds(p)));
  check("F04", "筛选态不写快照", !storage.has(CACHE_KEY_ALL), [...storage.keys()].join(","));

  // F5 scope 隔离
  resetStorage();
  authState.scope = "mine";
  apiState.reset();
  apiState.impl = () =>
    Promise.resolve({ code: 200, data: { items: [listItem(5)], pinned: [] } });
  p = newPage();
  await p.reset();
  check(
    "F05",
    "快照 key 带查看范围（mine 与 all 互不覆盖）",
    storage.has(`${CACHE_PREFIX}eventList:first:mine`) && !storage.has(CACHE_KEY_ALL),
    [...storage.keys()].join(","),
  );

  console.log(`\n共 ${passed + failed} 条断言，失败 ${failed} 条`);
  if (failed) process.exitCode = 1;
})();
