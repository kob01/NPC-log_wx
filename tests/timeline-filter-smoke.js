#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「NPC存档」列表页：结构化筛选（抽屉 / 条件条 / 请求参数）链路自检
 *
 * 做法与 timeline-list-smoke.js 一致：把 timeline.js 原样 require 进来，
 * 只 stub wx / Page / api / auth，不需要微信运行环境。
 *
 * 覆盖：
 *  FF 抽屉草稿：打开快照 / 取消还原 / 重置
 *  P  条件 → 请求参数：types、时间档、自定义区间、媒体开关、标签
 *  B  条件条：单条 ✕、清空、hasFilter 与置顶参数互斥
 *  T  标签候选：已选优先、最多 4 枚 + 省略号、展开/收起
 *  S  与搜索互斥：搜索前清筛选、查看范围保留
 *
 * 用法：node tests/timeline-filter-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TIMELINE_PATH = path.join(ROOT, "pages", "timeline", "timeline.js");

// ==================== wx 桩 ====================
const toasts = [];
global.wx = new Proxy(
  {
    showToast: (o) => toasts.push((o && o.title) || ""),
    stopPullDownRefresh: () => {},
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

// ==================== api / auth 桩 ====================
const apiState = {
  pageCalls: [],
  searchCalls: [],
  tagsImpl: () =>
    Promise.resolve({
      code: 200,
      data: {
        tags: [
          { tag: "复盘", count: 9 },
          { tag: "沟通", count: 7 },
          { tag: "跑步", count: 6 },
          { tag: "运维", count: 5 },
          { tag: "里程碑", count: 4 },
          { tag: "读书", count: 3 },
        ],
      },
    }),
  reset() {
    this.pageCalls = [];
    this.searchCalls = [];
  },
};
const apiMock = {
  event: {
    page: (params, scope) => {
      apiState.pageCalls.push({ params, scope });
      return Promise.resolve({ code: 200, data: { items: [], pinned: [] } });
    },
    pin: () => Promise.resolve({ code: 200, data: {} }),
    remove: () => Promise.resolve({ code: 200, data: {} }),
  },
  memory: {
    search: (q, limit, scope) => {
      apiState.searchCalls.push({ q, limit, scope });
      return Promise.resolve({ code: 200, data: { list: [] } });
    },
    tags: () => apiState.tagsImpl(),
  },
  org: {
    mine: () =>
      Promise.resolve({
        code: 200,
        data: [{ id: 1, my_status: 1 }],
      }),
    members: () =>
      Promise.resolve({
        code: 200,
        data: [
          { id: 1, username: "me", real_name: "我自己" },
          { id: 2, username: "wanglei", real_name: "王磊" },
          { id: 3, username: "liting", real_name: "李婷" },
        ],
      }),
  },
};

const authState = { scope: "all" };
const authMock = {
  checkLogin: () => true,
  isAdmin: () => false,
  getUserId: () => 1,
  getUser: () => ({ id: 1 }),
  getFilterScope: () => authState.scope,
  setFilterScope: (s) => {
    authState.scope = s || "all";
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

// ==================== 捞出 Page 定义 ====================
let captured = null;
global.Page = (opts) => {
  captured = opts;
};
require(TIMELINE_PATH);
const timelineDef = captured;

// ==================== 页面实例 ====================
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    // 支持 "groups[2].items[5]" 这种下标路径（与 wx setData 的数组下标写法一致）
    const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== "object") {
        cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = patch[key];
  });
}
function newPage() {
  const p = Object.assign({}, timelineDef);
  p.data = clone(timelineDef.data);
  p.setData = (patch, cb) => {
    applyPatch(p.data, patch || {});
    if (cb) cb();
  };
  return p;
}
async function idle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ==================== 断言 ====================
let pass = 0;
const fails = [];
function check(id, name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${id} ${name}`);
  } else {
    fails.push(`${id} ${name}${extra ? ` → ${extra}` : ""}`);
    console.log(`  ✗ ${id} ${name}${extra ? ` → ${extra}` : ""}`);
  }
}
function lastPage() {
  return apiState.pageCalls[apiState.pageCalls.length - 1];
}
function section(title) {
  console.log(`\n${title}`);
}

function dateStr(d) {
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// ==================== 用例 ====================
(async () => {
  // ---------- FF 抽屉草稿 ----------
  section("FF 抽屉：打开快照 / 取消还原 / 重置");
  apiState.reset();
  authState.scope = "all";
  let p = newPage();
  p.openFilter();
  check(
    "FF01",
    "打开抽屉",
    p.data.filterOpen === true,
    `open=${p.data.filterOpen}`,
  );
  await idle();
  check(
    "FF02",
    "打开时拉标签候选",
    p.data.tagChips.length === 6,
    `chips=${p.data.tagChips.length}`,
  );
  check(
    "FF03",
    "打开时拉作者候选（排除自己）",
    p.data.authorOptions.length === 2,
    JSON.stringify(p.data.authorOptions),
  );

  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "工作" } },
  });
  check(
    "FF04",
    "草稿记下分类",
    p.data.filter.types.join(",") === "工作",
    JSON.stringify(p.data.filter.types),
  );
  check(
    "FF05",
    "草稿条件数刷新",
    p.data.draftCount === 1,
    `count=${p.data.draftCount}`,
  );
  p.cancelFilter();
  check(
    "FF06",
    "点遮罩取消：草稿回到打开前且不重拉",
    p.data.filter.types.length === 0 && p.data.filterOpen === false,
    JSON.stringify(p.data.filter.types),
  );
  check(
    "FF07",
    "取消不触发列表请求",
    apiState.pageCalls.length === 0,
    `calls=${apiState.pageCalls.length}`,
  );

  p.openFilter();
  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "工作" } },
  });
  p.resetFilterDraft();
  check(
    "FF08",
    "抽屉内重置清空全部条件",
    p.data.filter.types.length === 0 && p.data.draftCount === 0,
    `count=${p.data.draftCount}`,
  );

  // ---------- P 条件 → 请求参数 ----------
  section("P 条件 → 请求参数：分类 / 时间 / 媒体 / 标签");
  apiState.reset();
  p = newPage();
  p.openFilter();
  await idle();
  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "工作" } },
  });
  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "运动" } },
  });
  p.applyFilter();
  await idle();
  let call = lastPage();
  check(
    "P01",
    "多选分类 → 逗号串参数",
    call && call.params.types === "工作,运动",
    call && call.params.types,
  );
  check(
    "P02",
    "多选分类平铺成两枚摘要（不合并）",
    p.data.filterBrief.length === 2 &&
      p.data.filterBrief[0].label === "工作" &&
      p.data.filterBrief[1].label === "运动",
    JSON.stringify(p.data.filterBrief),
  );
  check("P03", "hasFilter 置起", p.data.hasFilter === true);
  check(
    "P04",
    "筛选态不传 withPins",
    call && call.params.withPins === undefined,
    JSON.stringify(call && call.params),
  );

  apiState.reset();
  p = newPage();
  p.openFilter();
  p.onFilterTime({ currentTarget: { dataset: { value: "month" } } });
  p.applyFilter();
  await idle();
  call = lastPage();
  const now = new Date();
  const monthStart = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  check(
    "P06",
    "本月档 → startTime 为月初",
    call && call.params.startTime === monthStart,
    call && call.params.startTime,
  );
  check(
    "P07",
    "本月档 → endTime 为今天",
    call && call.params.endTime === dateStr(now),
    call && call.params.endTime,
  );

  apiState.reset();
  p = newPage();
  p.openFilter();
  p.onPickStart({ detail: { value: "2026-01-01" } });
  p.onPickEnd({ detail: { value: "2026-01-31" } });
  p.applyFilter();
  await idle();
  call = lastPage();
  check(
    "P08",
    "自定义区间 → 两个日期原样带上",
    call &&
      call.params.startTime === "2026-01-01" &&
      call.params.endTime === "2026-01-31",
    JSON.stringify(call && call.params),
  );
  check(
    "P09",
    "自定义区间摘要可读",
    p.data.filterBrief[0] &&
      p.data.filterBrief[0].label === "2026-01-01 ~ 2026-01-31",
    JSON.stringify(p.data.filterBrief),
  );

  apiState.reset();
  p = newPage();
  p.openFilter();
  p.onToggleMedia({
    currentTarget: { dataset: { key: "audio", want: "1" } },
  });
  p.applyFilter();
  await idle();
  call = lastPage();
  check(
    "P10",
    "有录音 → hasAudio=1",
    call && call.params.hasAudio === 1,
    JSON.stringify(call && call.params),
  );
  check(
    "P11",
    "媒体开关摘要",
    p.data.filterBrief[0] && p.data.filterBrief[0].label === "有录音",
    JSON.stringify(p.data.filterBrief),
  );

  apiState.reset();
  p = newPage();
  p.openFilter();
  await idle();
  p.onToggleTag({ currentTarget: { dataset: { tag: "里程碑" } } });
  p.applyFilter();
  await idle();
  call = lastPage();
  check(
    "P12",
    "标签 → tags + tagMode=or（并集）",
    call && call.params.tags === "里程碑" && call.params.tagMode === "or",
    JSON.stringify(call && call.params),
  );

  // 有/无互斥：先点「有图片」再点「无图片」，最终只带 hasImage=0
  apiState.reset();
  p = newPage();
  p.openFilter();
  p.onToggleMedia({
    currentTarget: { dataset: { key: "image", want: "1" } },
  });
  p.onToggleMedia({
    currentTarget: { dataset: { key: "image", want: "0" } },
  });
  p.applyFilter();
  await idle();
  call = lastPage();
  check(
    "P12b",
    "同一形态「有/无」互斥：最终只剩 hasImage=0",
    call && call.params.hasImage === 0 && call.params.hasAudio === undefined,
    JSON.stringify(call && call.params),
  );
  check(
    "P12c",
    "互斥后摘要只剩「无图片」一枚",
    p.data.filterBrief.length === 1 &&
      p.data.filterBrief[0].label === "无图片",
    JSON.stringify(p.data.filterBrief),
  );

  apiState.reset();
  p = newPage();
  p.openFilter();
  ["image", "audio", "location"].forEach((key) =>
    p.onToggleMedia({ currentTarget: { dataset: { key, want: "1" } } }),
  );
  p.applyFilter();
  await idle();
  call = lastPage();
  check(
    "P13",
    "内容形态多选取交集：三个参数同时带上",
    call &&
      call.params.hasImage === 1 &&
      call.params.hasAudio === 1 &&
      call.params.hasLocation === 1,
    JSON.stringify(call && call.params),
  );
  check(
    "P14",
    "三条媒体条件各占一枚摘要",
    p.data.filterBrief.filter((x) => x.key.indexOf("media:") === 0).length ===
      3,
    JSON.stringify(p.data.filterBrief),
  );

  // ---------- B 条件条 ----------
  section("B 条件条：平铺摘要 / 点胶囊开抽屉 / 清空");
  apiState.reset();
  p = newPage();
  p.openFilter();
  await idle();
  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "工作" } },
  });
  p.onToggleMedia({
    currentTarget: { dataset: { key: "audio", want: "1" } },
  });
  p.applyFilter();
  await idle();
  check(
    "B01",
    "分类与媒体各自平铺成一枚摘要（按时间→形态→分类→评价→标签的顺序）",
    p.data.filterBrief.map((x) => x.label).join(",") === "有录音,工作",
    JSON.stringify(p.data.filterBrief),
  );
  p.openFilter();
  check(
    "B02",
    "点条件胶囊打开抽屉改条件（不再就地删除）",
    p.data.filterOpen === true && p.data.hasFilter === true,
    `open=${p.data.filterOpen} hasFilter=${p.data.hasFilter}`,
  );
  check(
    "B02b",
    "抽屉里回填的是当前生效条件",
    p.data.filter.types.join(",") === "工作" &&
      p.data.filter.media.audio === "1",
    JSON.stringify(p.data.filter),
  );
  p.cancelFilter();
  apiState.reset();
  p.clearFilter();
  await idle();
  call = lastPage();
  check(
    "B03",
    "清空后请求不再带筛选",
    !call.params.types && !call.params.hasAudio,
    JSON.stringify(call.params),
  );
  check(
    "B04",
    "清空后恢复 withPins（置顶区回来）",
    call.params.withPins === 1,
    JSON.stringify(call.params),
  );
  check(
    "B05",
    "清空后 hasFilter 归零",
    p.data.hasFilter === false && p.data.filterBrief.length === 0,
  );

  // ---------- T 标签组：全部展示 ----------
  section("T 标签组：已选优先 / 全部展示");
  apiState.reset();
  p = newPage();
  p.openFilter();
  await idle();
  check(
    "T01",
    "标签全部展示（不再限制 4 枚）",
    p.data.tagChips.length === 6,
    `chips=${p.data.tagChips.length}`,
  );
  check("T02", "不再出现省略号", p.data.tagHasMore === false);
  check(
    "T03",
    "不再标记 extra",
    p.data.tagChips.every((c) => !c.extra),
  );
  p.onToggleTag({ currentTarget: { dataset: { tag: "读书" } } });
  check(
    "T04",
    "选中排到最前",
    p.data.tagChips[0].tag === "读书" && p.data.tagChips[0].on === true,
    JSON.stringify(p.data.tagChips[0]),
  );
  p.onToggleTag({ currentTarget: { dataset: { tag: "读书" } } });
  check(
    "T05",
    "再次点击取消选中",
    p.data.filter.tags.indexOf("读书") === -1 &&
      p.data.tagChips.find((c) => c.tag === "读书").on === false,
    JSON.stringify(p.data.tagChips.find((c) => c.tag === "读书")),
  );

  // ---------- S 与搜索互斥 ----------
  section("S 与搜索互斥：搜索前清筛选、保留查看范围");
  apiState.reset();
  authState.scope = "mine";
  p = newPage();
  p.setData({ filterScope: "mine" });
  p.openFilter();
  await idle();
  p.onToggleChip({
    currentTarget: { dataset: { field: "types", value: "工作" } },
  });
  p.applyFilter();
  await idle();
  check("S01", "筛选已生效", p.data.hasFilter === true);
  apiState.reset();
  p.setData({ keyword: "旅行" });
  await p.onSearch();
  await idle();
  check(
    "S02",
    "搜索时清空结构化筛选",
    p.data.hasFilter === false && p.data.filterBrief.length === 0,
  );
  check(
    "S03",
    "查看范围保留（搜索仍按 mine）",
    p.data.filterScope === "mine" &&
      apiState.searchCalls[0] &&
      apiState.searchCalls[0].scope === "mine",
    JSON.stringify(apiState.searchCalls[0]),
  );
  check(
    "S04",
    "搜索请求确实发出",
    apiState.searchCalls.length === 1,
    `calls=${apiState.searchCalls.length}`,
  );

  // ---------- 汇总 ----------
  console.log(`\n共 ${pass + fails.length} 条断言，失败 ${fails.length} 条`);
  if (fails.length) {
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
