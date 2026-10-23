#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「足迹」页：自动续拉 / 上限截断 / 默认年份 自检（纯 Node，不需要微信运行环境）
 *
 * 做法与 timeline-*.js 一致：把 pages/footprint/footprint.js 原样 require 进来，
 * 只 stub 掉 wx / Page / api / auth / format；定时器换成假时钟，让「30 条一批、
 * 到手后 120ms 再要下一批」这条链在测试里确定性地跑完。
 *
 * 覆盖：
 *  A 自动续拉：首屏 30 条后不再等用户滚到底，一路拉到上限或到底
 *  B 上限：最多 666 条，第 23 页多带回的 24 条被丢弃，触顶只提示一次
 *  C 默认年份：进页按当前年份筛（不是「全部」）
 *  D 切年份：版本号推进后旧续拉立即失效，新条件下空页不再反复请求
 *
 * 用法：node tests/footprint-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FOOTPRINT_PATH = path.join(ROOT, "pages", "footprint", "footprint.js");
const PAGE_SIZE = 30;
const MAX_POINTS = 666;
const TOTAL_POINTS = 800;

// ==================== 假时钟 ====================
const clock = {
  now: 1700000000000,
  seq: 0,
  timers: new Map(),
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + (ms || 0) });
    return id;
  },
  clear(id) {
    this.timers.delete(id);
  },
  tick(ms) {
    const target = this.now + ms;
    for (let guard = 0; guard < 2000; guard += 1) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target);
      if (!due.length) break;
      due.sort((a, b) => a[1].at - b[1].at);
      const [id, t] = due[0];
      this.now = t.at;
      this.timers.delete(id);
      t.fn();
    }
    this.now = target;
  },
  reset() {
    this.timers.clear();
    this.now = 1700000000000;
  },
};

global.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
global.clearTimeout = (id) => clock.clear(id);

// ==================== wx / Page 桩 ====================
const toasts = [];
global.wx = {
  showToast: (o) => toasts.push((o && o.title) || ""),
  stopPullDownRefresh: () => {},
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
  hideTabBar: () => {},
  showTabBar: () => {},
  navigateTo: () => {},
  openLocation: () => {},
  createMapContext: () => ({ includePoints: () => {} }),
  pageScrollTo: () => {},
};
global.getApp = () => ({ globalData: {} });

let pageConfig = null;
global.Page = (cfg) => {
  pageConfig = cfg;
};

// ==================== api / auth / format 桩 ====================
const apiState = {
  calls: [],
  emptyYears: new Set(["2025"]),
  reset() {
    this.calls = [];
    this.emptyYears = new Set(["2025"]);
  },
};

function makePoints(start, size, total) {
  const out = [];
  for (let i = start; i < Math.min(start + size, total); i += 1) {
    out.push({
      id: i + 1,
      event: `足迹${i + 1}`,
      time: "2026-05-01",
      position: "某地",
      address: "某地址",
      lng: 120 + i * 0.001,
      lat: 30 + i * 0.001,
      firstThumb: "",
    });
  }
  return out;
}

const apiMock = {
  memory: {
    footprints: (params = {}) => {
      apiState.calls.push({ ...params });
      const page = Number(params.page || 1);
      const size = Number(params.pageSize || PAGE_SIZE);
      const year = params.year ? String(params.year) : "";
      const total = apiState.emptyYears.has(year) ? 0 : TOTAL_POINTS;
      const start = (page - 1) * size;
      return Promise.resolve({
        code: 200,
        data: {
          points: makePoints(start, size, total),
          total,
          totalAllYears: TOTAL_POINTS,
          years: [{ year: "2026", count: TOTAL_POINTS }],
          regionOptions: [],
          hasMore: start + size < total,
        },
      });
    },
  },
};

const authMock = { checkLogin: () => true, isAdmin: () => false };
const formatMock = {
  resolveFileUrl: (u) => u || "",
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
stubModule(path.join(ROOT, "utils", "format.js"), formatMock);
stubModule(path.join(ROOT, "utils", "themeBehavior.js"), {});

require(FOOTPRINT_PATH);

// ==================== 实例与 setData ====================
/** 只实现本页用到的两种 key：顶层键与 arr[i] 下标路径 */
function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    const m = /^([\w$]+)\[(\d+)\]$/.exec(key);
    if (m) {
      if (!Array.isArray(data[m[1]])) data[m[1]] = [];
      data[m[1]][Number(m[2])] = patch[key];
      return;
    }
    data[key] = patch[key];
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

const flushMicro = () => new Promise((r) => setImmediate(r));

/**
 * 跑光自动续拉：只要有排期的定时器就推进时钟，直到没有下一枪。
 * 每轮都先 flush 微任务，让 api 的 Promise 落地后再推进时钟。
 */
async function drain(rounds = 200) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicro();
    if (!clock.timers.size) return;
    clock.tick(1000);
  }
  throw new Error("自动续拉没有收敛（可能有死循环）");
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

(async () => {
  clock.reset();
  toasts.length = 0;
  apiState.reset();

  const p = newPage();
  const expectedYear = String(new Date().getFullYear());
  check(
    "A0",
    "默认按当前年份筛选（不是「全部」）",
    p.data.year === expectedYear,
    `year=${p.data.year} expected=${expectedYear}`,
  );

  await p.load(p.data.year, "");
  check("A1", "首屏只请求一页 30 条", p.data.points.length === PAGE_SIZE, `n=${p.data.points.length}`);
  check("A2", "首屏 page=1 pageSize=30", apiState.calls[0].page === 1 && apiState.calls[0].pageSize === PAGE_SIZE, JSON.stringify(apiState.calls[0]));

  await drain();
  check("A3", "不等上拉就自动续拉到上限 666 条", p.data.points.length === MAX_POINTS, `n=${p.data.points.length}`);
  check("B1", "触顶后 hasMore=false", p.data.hasMore === false, `hasMore=${p.data.hasMore}`);
  check("B2", "触顶后 limitReached=true", p.data.limitReached === true, `limitReached=${p.data.limitReached}`);
  check("B3", "第 23 页请求（22×30=660 + 6）", apiState.calls.length === 23, `calls=${apiState.calls.length}`);
  check("B4", "最后一页按页大小请求、多余的点被丢弃", apiState.calls[22].page === 23 && p.data.points[665] && p.data.points[666] === undefined, JSON.stringify(apiState.calls[22]));
  const limitToasts = toasts.filter((t) => t.indexOf("最多显示 666 条") === 0);
  check("B5", "触顶提示只弹一次", limitToasts.length === 1, JSON.stringify(toasts));

  // 触顶后再推时钟不应再发请求
  const callsAtLimit = apiState.calls.length;
  await flushMicro();
  clock.tick(5000);
  await flushMicro();
  check("B6", "触顶后不再继续请求", apiState.calls.length === callsAtLimit, `calls=${apiState.calls.length}`);

  // ==================== 切年份 ====================
  apiState.calls = [];
  p.onYearChip({ currentTarget: { dataset: { year: "2025" } } });
  await drain();
  check("C1", "切到无数据年份：只请求一次首屏", apiState.calls.length === 1, JSON.stringify(apiState.calls));
  check("C2", "空结果显示到底、不进入续拉", p.data.points.length === 0 && p.data.hasMore === false, `n=${p.data.points.length} hasMore=${p.data.hasMore}`);

  // 切回有数据的年份：应从第 1 页重新开始并再次续拉
  apiState.calls = [];
  p.onYearChip({ currentTarget: { dataset: { year: "2026" } } });
  await drain();
  check("C3", "切回有数据年份：从 page=1 重新续拉", apiState.calls[0].page === 1 && p.data.points.length === MAX_POINTS, JSON.stringify(apiState.calls[0]));

  console.log(`\n共 ${passed + failed} 条断言，失败 ${failed} 条`);
  if (failed) process.exitCode = 1;
})();
