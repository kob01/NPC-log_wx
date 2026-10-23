const api = require("../../utils/api");
const auth = require("../../utils/auth");
const audioHub = require("../../utils/audioHub");
const CFG = require("../../config");
const { dayKey } = require("../../utils/format");
// 分类/评价候选与编辑页 picker 同一份，不在此重复定义（缘由见 utils/options.js）
const { TYPE_OPTIONS, RATING_OPTIONS } = require("../../utils/options");

const PAGE_SIZE = 10;

// ==================== 首屏缓存：冷启动先出内容，再后台校正 ====================
// 只缓存「无游标、无筛选、无搜索」的第一页，key 带查看范围；写入时记 userId 与时间戳，
// 读取时任一项对不上就整份丢弃。前缀 eventList: 与 api.js 的写后失效
// （invalidateCache("eventList:")）对齐：新增/编辑/删除/置顶后缓存自动作废。
const FIRST_PAGE_CACHE_TTL = 3 * 24 * 60 * 60 * 1000;
// 体积保护：正常一页 10 条约 10KB，超过这条线说明数据异常，宁可不写
const FIRST_PAGE_CACHE_MAX_BYTES = 64 * 1024;

function firstPageCacheKey(scope) {
  return CFG.CACHE_KEY_PREFIX + "eventList:first:" + (scope || "all");
}

/** 当前登录用户 id：换号/退出后上一个人的缓存不能复用 */
function currentUserId() {
  const user = typeof auth.getUser === "function" ? auth.getUser() : null;
  if (user && user.id != null) return Number(user.id);
  return typeof auth.getUserId === "function" ? Number(auth.getUserId() || 0) : 0;
}

/** 读首屏快照：任何一项校验不过都返回 null（由调用方回落到骨架屏 + 请求） */
function readFirstPageCache(scope) {
  try {
    const raw = wx.getStorageSync(firstPageCacheKey(scope));
    // 落盘的是 JSON 串（只序列化一次）；对象形态兼容旧数据
    const hit = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!hit || !Array.isArray(hit.items) || !hit.items.length) return null;
    if (Date.now() - Number(hit.ts || 0) > FIRST_PAGE_CACHE_TTL) return null;
    if (Number(hit.userId || 0) !== currentUserId()) return null;
    return {
      items: hit.items,
      pinned: Array.isArray(hit.pinned) ? hit.pinned : [],
    };
  } catch (e) {
    return null;
  }
}

function writeFirstPageCache(scope, items, pinned) {
  if (!Array.isArray(items) || !items.length) return;
  try {
    const text = JSON.stringify({
      v: 1,
      ts: Date.now(),
      userId: currentUserId(),
      items,
      pinned: Array.isArray(pinned) ? pinned : [],
    });
    if (text.length > FIRST_PAGE_CACHE_MAX_BYTES) return;
    wx.setStorageSync(firstPageCacheKey(scope), text);
  } catch (e) {
    /* 存储不可用/写满时静默降级：缓存只是加速，不影响列表本身 */
  }
}

// ==================== 结构化筛选（与搜索互斥） ====================
// 时间快捷档：除 all/custom 外都换算成本地日期区间（含当天）
const FILTER_TIMES = [
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "year", label: "今年" },
  { value: "custom", label: "自定义" },
];
// 查看范围四态：与顶部循环按钮共用 auth 里的同一份 scope
const FILTER_SCOPES = [
  { value: "all", label: "全部" },
  { value: "mine", label: "只看自己" },
  { value: "private", label: "仅自己可见" },
  { value: "others", label: "只看他人" },
];
// 内容形态：每个形态都有「有/无」两档，同一形态两档互斥（再点一次取消）。
// field → 请求参数 hasImage/hasAudio/hasLocation，want='1' 有 / '0' 无
const FILTER_MEDIA = [
  { field: "image", want: "1", label: "有图片" },
  { field: "image", want: "0", label: "无图片" },
  { field: "audio", want: "1", label: "有录音" },
  { field: "audio", want: "0", label: "无录音" },
  { field: "location", want: "1", label: "有地点" },
  { field: "location", want: "0", label: "无地点" },
];
// 形态字段 → 列表接口参数名（只在这两处之间做映射，不再散写在拼参数里）
const MEDIA_PARAM = {
  image: "hasImage",
  audio: "hasAudio",
  location: "hasLocation",
};

// 筛选入口图标（base64 内联，与查看范围按钮同一套写法）：灰=未筛选，蓝=已筛选
const FILTER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4YThmOTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA1aDE2Ii8+PHBhdGggZD0iTTcgMTJoMTAiLz48cGF0aCBkPSJNMTAgMTloNCIvPjwvc3ZnPg==";
const FILTER_ICON_ON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxNjc3ZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA1aDE2Ii8+PHBhdGggZD0iTTcgMTJoMTAiLz48cGF0aCBkPSJNMTAgMTloNCIvPjwvc3ZnPg==";

/** 本地日期 YYYY-MM-DD（不能用 toISOString：那是 UTC，跨时区会差一天） */
function dateStr(d) {
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 时间档 → [start, end]；all/custom 返回空串（custom 由抽屉里选的两个日期决定） */
function timeRangeOf(kind, now) {
  const d = now || new Date();
  if (kind === "today") return [dateStr(d), dateStr(d)];
  if (kind === "week") {
    const day = (d.getDay() + 6) % 7; // 周一 = 0
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    return [dateStr(mon), dateStr(d)];
  }
  if (kind === "month") {
    return [dateStr(new Date(d.getFullYear(), d.getMonth(), 1)), dateStr(d)];
  }
  if (kind === "year") return [d.getFullYear() + "-01-01", dateStr(d)];
  return ["", ""];
}

/** 空筛选草稿（重置与「清空」共用） */
function emptyFilter() {
  return {
    time: "all",
    start: "",
    end: "",
    // 内容形态三态："" 不限 / "1" 有 / "0" 无
    media: { image: "", audio: "", location: "" },
    types: [],
    ratings: [],
    tags: [],
    tagExpanded: false,
    authorId: 0,
  };
}

// 录音时长上限（秒）：面板提示、自动发送、recorder.duration 共用这一处定义
const RECORD_MAX = 60;
// 波形条数：纯 CSS 动画驱动，静态参数只在 onLoad 生成一次
const WAVE_BAR_COUNT = 18;
// 取消横带：从面板顶边往下 150rpx 内都算取消区（✕ 就画在这条带里，判定与视觉同源）
const CANCEL_BAND_RPX = 150;
// 面板回缩过渡时长（ms），需与 .record-sheet 的 transition 时长一致
const SHEET_ANIM_MS = 320;
// 挂载与展开之间隔一帧：同一批 setData 里就带上 .open 的话，圆→方的过渡会被直接跳过
const SHEET_FRAME_MS = 40;
// 面板底句提示：提到常量里，不在 WXML 里拼长串中文
const HINT_SEND = `松开发送 · 最长 ${RECORD_MAX} 秒`;
const HINT_CANCEL = "松开手指，取消本次录音";

// 列表查看范围：四态循环 all（全部）→ mine（只看自己）→ private（只看自己写的
// 且标为「仅自己可见」的）→ others（只看组织内他人）。
// private 紧跟 mine：两档都是「我自己写的」的子集，顺着一按就继续收窄
const SCOPE_ORDER = ["all", "mine", "private", "others"];
const SCOPE_HINT = {
  all: "全部日志",
  mine: "只看自己",
  private: "只看仅自己可见",
  others: "只看他人",
};
// 图标（base64 内联，免额外网络请求）：灰单人=all，蓝单人=mine，蓝锁=private，蓝双人=others
const PERSON_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4YThmOTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjAgMjF2LTJhNCA0IDAgMCAwLTQtNEg4YTQgNCAwIDAgMC00IDR2MiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIvPjwvc3ZnPg==";
const PERSON_ICON_ON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxNjc3ZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjAgMjF2LTJhNCA0IDAgMCAwLTQtNEg4YTQgNCAwIDAgMC00IDR2MiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIvPjwvc3ZnPg==";
const USERS_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxNjc3ZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTcgMjF2LTJhNCA0IDAgMCAwLTQtNEg1YTQgNCAwIDAgMC00IDR2MiIvPjxjaXJjbGUgY3g9IjkiIGN5PSI3IiByPSI0Ii8+PHBhdGggZD0iTTIzIDIxdi0yYTQgNCAwIDAgMC0zLTMuODciLz48cGF0aCBkPSJNMTYgMy4xM2E0IDQgMCAwIDEgMCA3Ljc1Ii8+PC9zdmc+";
// 「仅自己可见」那一档用锁：与单人图标同色（#1677ff），换形状而不是在人头上叠小图，32rpx 下才看得清
const LOCK_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxNjc3ZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB3aWR0aD0iMTgiIGhlaWdodD0iMTEiIHg9IjMiIHk9IjExIiByeD0iMiIgcnk9IjIiLz48cGF0aCBkPSJNNyAxMVY3YTUgNSAwIDAgMSAxMCAwdjQiLz48L3N2Zz4=";

/** 取触点坐标：touchend 时 touches 已空，需回落 changedTouches；都拿不到返回 {-1,-1} */
function touchPoint(e) {
  const touches = e && e.touches && e.touches.length ? e.touches : null;
  const list = touches || (e && e.changedTouches) || [];
  const t = list[0];
  return t && typeof t.clientX === "number"
    ? { x: t.clientX, y: t.clientY }
    : { x: -1, y: -1 };
}

/** 录音时长展示：0:07 比 7″ 好读 */
function fmtRecordTime(sec) {
  const m = Math.floor(sec / 60);
  const rest = sec % 60;
  return m + (rest < 10 ? ":0" : ":") + rest;
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    // 只把 groups 交给视图层：entries 与 groups[].items 是同一批数据，
    // 两者都放进 data 等于每次翻页把整份列表跨线程传两遍（100 条约 180KB），
    // 而 WXML 只渲染 groups。entries 留在实例上只做合并与查找
    groups: [],
    // 本人置顶的那几条（上限 3 条，谁长按谁生效）：已从 entries 那条时间序流里剔掉，
    // 单独摆在列表最上方的置顶区，不参与按月分组（否则会出现两个同名月份标题）
    pinnedEntries: [],
    loading: false,
    hasMore: true,
    keyword: "",
    searchMode: false,
    searchExpanded: false,
    // 列表查看范围（本页局部状态，真值存 auth，切换即重拉）：all/mine/others/private
    filterScope: "all",
    // 四态图标：灰单人(all)/蓝单人(mine)/蓝锁(private)/蓝双人(others)
    personIcon: PERSON_ICON,
    personIconOn: PERSON_ICON_ON,
    lockIcon: LOCK_ICON,
    usersIcon: USERS_ICON,
    // 顶部三分之一处的低存在感文字提示（切换筛选时闪现一句，自动消失）
    hintText: "",
    // ==================== 结构化筛选（抽屉 + 顶部条件条） ====================
    // filter 是抽屉里的草稿：点「完成」才写进条件条并重拉；点遮罩关闭会还原到打开时
    filter: emptyFilter(),
    filterOpen: false,
    // 条件摘要：一条条件一枚 chip，key 用于点 ✕ 精确删除
    filterBrief: [],
    hasFilter: false,
    // 抽屉里草稿的条件数（头部「已选 N 项」，随每步操作刷新）
    draftCount: 0,
    // 候选：chips 自带 on 标记，WXML 里不做 indexOf 之类运算
    timeOptions: FILTER_TIMES,
    scopeOptions: FILTER_SCOPES,
    typeOptions: TYPE_OPTIONS,
    ratingOptions: RATING_OPTIONS,
    typeChips: TYPE_OPTIONS.map((v) => ({ value: v, on: false })),
    ratingChips: RATING_OPTIONS.map((v) => ({ value: v, on: false })),
    mediaChips: FILTER_MEDIA.map((o) => ({
      // wx:key 必须唯一：同一 field 有「有/无」两档
      key: o.field + ":" + o.want,
      field: o.field,
      want: o.want,
      label: o.label,
      on: false,
    })),
    tagChips: [],
    tagHasMore: false,
    authorOptions: [],
    filterIcon: FILTER_ICON,
    filterIconOn: FILTER_ICON_ON,
    // 后端语义召回被并发闸门拒时置 true（列表仍能给出关键词结果，只用来提示质量下降）
    semanticSkipped: false,
    // 录音面板：sheetVisible 管节点挂载，recording 管「圆 → 底部方形」的展开态
    sheetVisible: false,
    recording: false,
    // 手指是否上滑进了顶部的 ✕ 取消横带
    canceling: false,
    cancelHint: HINT_SEND,
    recordSeconds: 0,
    recordTimeText: "0:00",
    recordMax: RECORD_MAX,
    // 波形条子的基准高度/延迟/周期（内联 style，不进后续 setData）
    waveBars: [],
    // 面板收起态/展开态的几何（px 内联 style）：两态同单位，CSS 才能插值出「逐渐扩大」
    sheetStyleClosed: "",
    sheetStyleOpen: "",
  },

  // 完整条目流（不进 data，见 data 上方注释）：合并去重、长按查找、置顶移位都在这里做
  _entries: [],
  // 首屏请求在途标记：loading 在「已有内容」时不再置 true（否则整屏 loading 会盖住列表），
  // 重入保护改由这个实例字段负责
  _inflight: false,
  // 乐观插入的那条（编辑页写成功时塞进 globalData）：首屏替换后要能把它补回来
  _pendingInsert: null,
  // 行对象缓存 id → { src, first, row }：buildGroups 靠它复用没变的行，
  // 配合 renderGroups 的路径级下发，翻页时已渲染的卡片不会收到新数据、observer 不重跑
  _rowsById: null,
  // 游标：已加载部分里时间最旧那条的 event_id（存实例上，不进 data）
  _cursor: null,
  _version: 0, // 列表版本号，用于丢弃过期的异步结果
  _loadFailed: false, // 上次加载是否被限流/网络错误打断（不打断 hasMore 语义）
  _searching: false, // 搜索单飞，避免连续点击变成多个并发 AI 请求
  _searchTimer: null,
  _filterSnapshot: null, // 打开抽屉时的条件快照：点遮罩关闭要还原
  _tagsLoaded: false, // 标签候选只在首次打开抽屉时拉一次
  _membersLoaded: false, // 组织成员候选同上
  _hintTimer: null, // 顶部轻提示自动消失定时器
  _recorder: null, // wx RecorderManager
  _recordTimer: null,
  _down: false, // 手指是否按住录音键（防授权返回时已松手仍启动录音）
  _started: false, // recorder.start 是否真的跑起来了（松手时决定要不要调 stop）
  _cancelRequested: false, // 上滑取消标记：onStop 据此丢弃音频、不上传不跳转
  // 本页这段录音等着被 onStop 认领的标记：RecorderManager 是全局单例，编辑页「重录」
  // 停录时回调也会打到本页，不辨归属就会凭空弹一句「说话时间太短」甚至再跳一个编辑页
  _recExpect: false,
  _sheetTimer: null, // 面板回缩播完再卸载节点
  _pressAt: 0, // 本次按下时刻，用来识别「只是点了一下」
  _winW: 375, // 视口宽（px），面板几何与取消区阈值共用
  _winH: 667, // 视口高（px）

  onLoad() {
    this._entries = [];
    this._cursor = null;
    this._loaded = false;
    this._loadFailed = false;
    // 从本地记住的列表筛选初始化展示态（请求范围直接读 auth.getFilterScope()，不依赖这里的展示态）
    this.setData({ filterScope: auth.getFilterScope() });
    this.measure();
    // 波形静态参数与面板两态几何都只算一次，后续靠 CSS 动画与类切换驱动
    this.setData(
      Object.assign(
        { waveBars: this.buildWaveBars() },
        this.buildSheetStyles(),
      ),
    );
    this.initRecorder();
  },

  onShow() {
    if (!auth.checkLogin()) return;
    // 新增/保存/删除后回到列表：手上的数据是旧快照，必须重拉。
    // 列表查看范围已降为本页局部状态，切换由 onCycleScope 直接触发 reset，
    // 不再需要像以前那样在 onShow 里对比全局开关是否被切过
    const app = getApp();
    if (app.globalData && app.globalData.timelineDirty) {
      app.globalData.timelineDirty = false;
      this._loaded = true;
      this.reset();
      return;
    }
    // 首次进入或从编辑/详情返回且列表为空时（重新）加载
    if (
      !this._loaded ||
      (!this.data.searchMode && !this._entries.length && !this.data.loading)
    ) {
      this._loaded = true;
      this.reset();
    }
  },

  /** 循环列表查看范围：全部 → 只看自己 → 只看仅自己可见 → 只看他人 → 全部；写入本地偏好后按新范围重拉 */
  onCycleScope() {
    const idx = SCOPE_ORDER.indexOf(this.data.filterScope || "all");
    const next = SCOPE_ORDER[(idx + 1) % SCOPE_ORDER.length];
    auth.setFilterScope(next);
    this.setData({ filterScope: next });
    // 低存在感文字提示：在屏幕上方三分之一处闪现一句当前范围，不打断浏览
    this.showHint(SCOPE_HINT[next]);
    this.reset();
  },

  // ==================== 结构化筛选：抽屉 / 顶部条件条 ====================

  /**
   * 打开筛选抽屉。
   * 搜索是 AI 语义检索、不吃 type/rating 等结构条件，两者不能叠加：
   * 进来先把搜索态退出（reset 会清关键词并回全量），抽屉里的条件点「完成」再生效。
   */
  openFilter() {
    if (this.data.searchMode || this.data.keyword) {
      this.setData({ searchExpanded: false });
      this.reset();
    }
    // 快照：点遮罩/关闭时把抽屉里的改动还原，避免「关了却已经变了」
    this._filterSnapshot = JSON.stringify({
      filter: this.data.filter,
      scope: this.data.filterScope,
    });
    this.setData({ filterOpen: true });
    this.loadTagOptions();
    this.loadAuthorOptions();
  },

  /** 取消：还原到打开抽屉前的状态（点遮罩或右上角关闭） */
  cancelFilter() {
    let snap = null;
    try {
      snap = JSON.parse(this._filterSnapshot || "null");
    } catch (err) {
      snap = null;
    }
    this._filterSnapshot = null;
    if (!snap || !snap.filter) {
      this.setData({ filterOpen: false });
      return;
    }
    const scope = snap.scope || "all";
    auth.setFilterScope(scope);
    this.setData({
      filter: snap.filter,
      filterScope: scope,
      filterOpen: false,
    });
    this.buildDraftChips();
  },

  /** 抽屉里的「重置」：清空全部结构化条件 + 查看范围回 all */
  resetFilterDraft() {
    auth.setFilterScope("all");
    this.setData({ filter: emptyFilter(), filterScope: "all" });
    this.buildDraftChips();
  },

  /** 抽屉里的「完成」：草稿落成条件摘要并重拉 */
  applyFilter() {
    this.setData({ filterOpen: false });
    this.commitFilter();
  },

  /** 草稿 → 条件摘要 / 顶部占位，然后 reset 重拉（游标由 reset 清空） */
  commitFilter() {
    const brief = this.buildFilterBrief();
    const hasFilter = brief.length > 0;
    this.setData({
      filterBrief: brief,
      hasFilter,
    });
    // 先清游标再重拉：切条件绝不能沿用上一批结果的 cursors
    this.reset();
    // 条件变了就回到顶部：否则列表清空重拉时停在中间，看起来像「没刷新」
    if (typeof wx.pageScrollTo === "function") {
      setTimeout(() => {
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      }, 50);
    }
  },

  /** 只清结构化条件（不动查看范围）：搜索要沿用当前 scope */
  clearStructuredFilter() {
    this.setData({
      filter: emptyFilter(),
      filterBrief: [],
      hasFilter: false,
    });
    this.buildDraftChips();
  },

  /** 条件摘要：一条条件一枚 chip，key 用于点 ✕ 精确删除 */
  buildFilterBrief() {
    const f = this.data.filter;
    const brief = [];
    if (f.time !== "all") {
      let label = "";
      if (f.time === "custom") {
        if (f.start && f.end) label = f.start + " ~ " + f.end;
        else if (f.start) label = f.start + " 起";
        else if (f.end) label = "截至 " + f.end;
      } else {
        const hit = FILTER_TIMES.find((o) => o.value === f.time);
        label = hit ? hit.label : "";
      }
      if (label) brief.push({ key: "time", label });
    }
    FILTER_MEDIA.forEach((o) => {
      if (f.media[o.field] === o.want) {
        brief.push({
          key: "media:" + o.field + ":" + o.want,
          label: o.label,
        });
      }
    });
    // 分类/评价全部平铺，不再合并成「分类 x 项」：胶囊现在只当进抽屉的入口，
    // 平铺才能一眼看出到底选了哪几档
    f.types.forEach((t) => brief.push({ key: "type:" + t, label: t }));
    f.ratings.forEach((r) => brief.push({ key: "rating:" + r, label: r }));
    f.tags.forEach((tag) => brief.push({ key: "tag:" + tag, label: tag }));
    if (f.authorId) {
      const hit = (this.data.authorOptions || []).find(
        (a) => a.id === f.authorId,
      );
      brief.push({ key: "author", label: hit ? hit.name : "指定作者" });
    }
    return brief;
  },

  /** 条件 → 列表请求参数（不传的键后端就是不筛，与旧请求逐字一致） */
  buildFilterParams() {
    const f = this.data.filter;
    const params = {};
    let start = "";
    let end = "";
    if (f.time === "custom") {
      start = f.start;
      end = f.end;
    } else if (f.time !== "all") {
      const range = timeRangeOf(f.time);
      start = range[0];
      end = range[1];
    }
    if (start) params.startTime = start;
    if (end) params.endTime = end;
    if (f.types.length) params.types = f.types.join(",");
    if (f.ratings.length) params.ratings = f.ratings.join(",");
    if (f.tags.length) {
      params.tags = f.tags.join(",");
      // 分类/评价/标签三组多选统一取并集（任一命中）；后端默认也是 or，这里显式写出
      params.tagMode = "or";
    }
    if (f.authorId) params.authorId = f.authorId;
    // 内容形态：三态 → hasXxx=1/0；未选不传（后端据此不拼条件）
    Object.keys(MEDIA_PARAM).forEach((field) => {
      const want = f.media[field];
      if (want === "1" || want === "0") {
        params[MEDIA_PARAM[field]] = Number(want);
      }
    });
    return params;
  },

  /** 抽屉里改完条件后同步 chips 的选中态 + 草稿条件数 */
  buildDraftChips() {
    const f = this.data.filter;
    const mediaOn = FILTER_MEDIA.filter(
      (o) => f.media[o.field] === o.want,
    ).length;
    const draftCount =
      (f.time !== "all" ? 1 : 0) +
      mediaOn +
      (f.types.length ? 1 : 0) +
      (f.ratings.length ? 1 : 0) +
      f.tags.length +
      (f.authorId ? 1 : 0);
    this.setData({
      draftCount,
      typeChips: TYPE_OPTIONS.map((v) => ({
        value: v,
        on: f.types.indexOf(v) >= 0,
      })),
      ratingChips: RATING_OPTIONS.map((v) => ({
        value: v,
        on: f.ratings.indexOf(v) >= 0,
      })),
      mediaChips: FILTER_MEDIA.map((o) => ({
        key: o.field + ":" + o.want,
        field: o.field,
        want: o.want,
        label: o.label,
        on: f.media[o.field] === o.want,
      })),
    });
    this.buildTagChips();
  },

  /** 时间档：只改档位；自定义区间由两个 picker 各自回写 start/end */
  onFilterTime(e) {
    this.setData({ "filter.time": e.currentTarget.dataset.value });
    this.buildDraftChips();
  },

  onPickStart(e) {
    this.setData({ "filter.start": e.detail.value, "filter.time": "custom" });
    this.buildDraftChips();
  },

  onPickEnd(e) {
    this.setData({ "filter.end": e.detail.value, "filter.time": "custom" });
    this.buildDraftChips();
  },

  /** 查看范围：与顶部循环按钮共用 auth 里的 scope，改完两边同时生效 */
  onFilterRange(e) {
    const scope = e.currentTarget.dataset.value;
    auth.setFilterScope(scope);
    this.setData({ filterScope: scope });
  },

  onToggleMedia(e) {
    const field = e.currentTarget.dataset.key;
    const want = String(e.currentTarget.dataset.want || "1");
    const media = Object.assign({}, this.data.filter.media);
    // 再点同一档 = 取消；点另一档 = 直接切换（「有」「无」天然互斥）
    media[field] = media[field] === want ? "" : want;
    this.setData({ "filter.media": media });
    this.buildDraftChips();
  },

  /** 分类 / 评价多选：data-field 决定改哪个数组 */
  onToggleChip(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.currentTarget.dataset.value;
    const list = (this.data.filter[field] || []).slice();
    const idx = list.indexOf(value);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(value);
    const patch = {};
    patch["filter." + field] = list;
    this.setData(patch);
    this.buildDraftChips();
  },

  onToggleTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const list = (this.data.filter.tags || []).slice();
    const idx = list.indexOf(tag);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(tag);
    this.setData({ "filter.tags": list });
    this.buildTagChips();
  },

  onPickAuthor(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    this.setData({
      "filter.authorId": this.data.filter.authorId === id ? 0 : id,
    });
    this.buildDraftChips();
  },

  /** 标签 chips：已选排最前；全部展示（放下面后不再限制 4 枚） */
  buildTagChips() {
    const selected = this.data.filter.tags || [];
    const all = this.data.tagOptions || [];
    const ordered = selected.concat(
      all.filter((tag) => selected.indexOf(tag) < 0),
    );
    this.setData({
      tagChips: ordered.map((tag) => ({
        tag,
        on: selected.indexOf(tag) >= 0,
      })),
      tagHasMore: false,
    });
  },

  /** 条件条「清空」：只清结构化条件，查看范围是独立维度 */
  clearFilter() {
    this.clearStructuredFilter();
    this.commitFilter();
  },

  /**
   * 标签候选：memory/tags 恒为「只看自己」的统计（分析类接口口径），
   * 列表在「全部/他人」范围时候选可能不含他人标签，抽屉 hint 已写明来源
   */
  async loadTagOptions() {
    if (this._tagsLoaded) return;
    this._tagsLoaded = true;
    try {
      const { code, data } = await api.memory.tags();
      if (Number(code) === 200 && data) {
        this.setData({ tagOptions: (data.tags || []).map((t) => t.tag) });
        this.buildTagChips();
      }
    } catch (err) {
      this._tagsLoaded = false; // 失败允许下次重试
    }
  },

  /**
   * 作者候选：取我加入的前 3 个组织的成员（去重、排除自己）。
   * 组织多时逐个拉成员成本高，所以只取前 3 个；作者筛选只对「全部/只看他人」有意义
   */
  async loadAuthorOptions() {
    if (this._membersLoaded) return;
    this._membersLoaded = true;
    try {
      const meId = Number((auth.getUser() || {}).id);
      const { code, data } = await api.org.mine();
      if (Number(code) !== 200) return;
      const orgs = (Array.isArray(data) ? data : [])
        .filter((o) => Number(o.my_status) === 1)
        .slice(0, 3);
      const seen = {};
      const list = [];
      for (let i = 0; i < orgs.length; i += 1) {
        const resp = await api.org.members(orgs[i].id);
        if (Number(resp.code) !== 200) continue;
        (resp.data || []).forEach((m) => {
          const id = Number(m.id);
          if (!id || id === meId || seen[id]) return;
          seen[id] = true;
          // 成员接口返回的是 real_name（user_nick）与 username（登录名）
          list.push({ id, name: m.real_name || m.username || "用户" + id });
        });
      }
      this.setData({ authorOptions: list.slice(0, 30) });
    } catch (err) {
      this._membersLoaded = false;
    }
  },

  /** 顶部轻提示：显示一句文字，1.2s 后自动收起（wx.showToast 不能自定义位置，故用固定视图） */
  showHint(text) {
    this.setData({ hintText: text });
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this._hintTimer = null;
      this.setData({ hintText: "" });
    }, 1200);
  },

  /**
   * 触摸列表时收起搜索框（已输入关键词时不打断浏览搜索结果）。
   * 原先挂在 onPageScroll 上：页面只要注册了那个钩子，滚动期间每一帧都要跳一次
   * 「渲染层 → 逻辑层」，而这里要的只是「开始滑就该收起」——用一个手势只在起点
   * 到达一次的 touchstart，代价从 60 次/秒降到 1 次/手势（滑动必定从触摸开始，体感一致）。
   */
  onListTouch() {
    if (this.data.searchExpanded) {
      // 先落盘再判要不要收（不打断待发的自动搜索）：用户可能刚打完字就滑动，
      // 400ms 防抖还没到，data.keyword 还是空 —— 只看 data 会把有词的框收掉
      this.flushKeyword(false);
      if (!this.data.keyword) this.collapseSearchBox();
    }
  },

  onPullDownRefresh() {
    // 下拉刷新 = 退出当前搜索、回到全量列表：连搜索框一起收起，
    // 免得 reset 清了词却留一个空框抢焦点（focus 绑在 searchExpanded 上）
    this.setData({ searchExpanded: false });
    return this.reset().then(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this.clearRecordTimer();
    if (this._sheetTimer) clearTimeout(this._sheetTimer);
    if (this._hintTimer) clearTimeout(this._hintTimer);
    if (this._searchTimer) clearTimeout(this._searchTimer);
    // 录音回调挂在 wx.getRecorderManager() 这个进程级单例上：不摘掉就会连同页面实例
    // 一起泄漏，且下次再进本页会累加出重复回调
    this.detachRecorder();
  },

  // ==================== 录音（长按话筒按钮展开面板，松手带音频跳编辑页转写） ====================
  initRecorder() {
    if (this._recorder) return;
    const recorder = wx.getRecorderManager();
    this._recorder = recorder;

    // RecorderManager 的 onStop/onError 是「注册回调的方法」，必须调用而非赋值
    // （赋值的写法原生层不会回调，导致松手后既不收起录音状态也不跳转）
    // 回调按引用挂在实例上（不是匿名闭包）：退出页面时才能 offStop/offError 取得掉，
    // 否则这个闭包会永久挂在全局单例上（连页面实例一起泄漏），且 reLaunch 回登录页
    // 再进首页时会累加出第二份回调 —— 与编辑页 discardRecorder 同一个道理
    this._recStopHandler = (res) => this.handleRecordStop(res);
    this._recErrorHandler = () => this.handleRecordError();
    recorder.onStop(this._recStopHandler);
    recorder.onError(this._recErrorHandler);
  },

  /** 录音器报错：只处理本页这一轮（编辑页重录报的错不该搅乱本页的面板与录音态） */
  handleRecordError() {
    if (!this._recExpect && !this._started) return;
    this._recExpect = false;
    this._started = false;
    this._cancelRequested = false;
    this.clearRecordTimer();
    this.closeSheet();
    wx.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
  },

  /** 退出页面：抹掉归属标记 → 摘本页监听 → 必要时释放麦克风 */
  detachRecorder() {
    const wasRecording = this._started;
    this._recExpect = false;
    this._started = false;
    this._down = false;
    const rec = this._recorder;
    this._recorder = null;
    if (!rec) return;
    try {
      // 低版本基础库没有 offXxx：靠归属标记兜底，至少让回调白跑
      if (this._recStopHandler && typeof rec.offStop === "function") {
        rec.offStop(this._recStopHandler);
      }
      if (this._recErrorHandler && typeof rec.offError === "function") {
        rec.offError(this._recErrorHandler);
      }
    } catch (err) {
      /* 忽略：摘不掉也不影响功能 */
    }
    // 监听已摘，这段录音没人认领了；仍要 stop 一次把麦克风交还原生层
    // （顺序不能反：先 stop 后摘，onStop 会把这段当成待发送的录音接管）
    if (wasRecording) {
      try {
        rec.stop();
      } catch (err) {
        /* 没在录就忽略 */
      }
    }
    this._recStopHandler = null;
    this._recErrorHandler = null;
  },

  /** 视口尺寸取一次缓存住：拿不到就保留默认估值，不阻断录音主流程 */
  measure() {
    try {
      const info =
        typeof wx.getWindowInfo === "function"
          ? wx.getWindowInfo()
          : wx.getSystemInfoSync();
      if (info && info.windowWidth) this._winW = info.windowWidth;
      if (info && info.windowHeight) this._winH = info.windowHeight;
    } catch (err) {
      /* 忽略，按默认值算 */
    }
  },

  /** rpx → px */
  rpx(v) {
    return (v * this._winW) / 750;
  },

  /** 面板展开高（px）：约 1/3 屏，但不低于内容所需高度（波形 + 时长 + 提示） */
  sheetHeightPx() {
    return Math.round(Math.max(this._winH * 0.34, this.rpx(430)));
  },

  /**
   * 面板两态几何（一律算成 px）：直接在 WXSS 里用 rpx ↔ vh 做过渡，
   * 跨单位值不一定能插值，「圆逐渐扩大成方形」会退化成瞬移
   */
  buildSheetStyles() {
    const w = this._winW;
    const h = this._winH;
    const fab = this.rpx(100); // 与 .fab 同尺寸
    const sheetH = this.sheetHeightPx();
    // 展开态顶部圆角与全局矩形圆角 token --radius（app.wxss）保持一致，改那里也要改这里
    const radius = Math.round(this.rpx(6));
    return {
      sheetStyleClosed:
        `left:${Math.round(w - this.rpx(40) - fab)}px;` +
        `top:${Math.round(h - this.rpx(60) - fab)}px;` +
        `width:${Math.round(fab)}px;height:${Math.round(fab)}px;` +
        `border-radius:${Math.round(fab / 2)}px`,
      sheetStyleOpen:
        "left:0;top:" +
        Math.round(h - sheetH) +
        `px;width:${Math.round(w)}px;height:${sheetH}px;` +
        `border-radius:${radius}px ${radius}px 0 0`,
    };
  },

  /** 波形条子的静态参数：中间高两边低的包络 + 取模错相位，免得整排齐步走的假感 */
  buildWaveBars() {
    const bars = [];
    for (let i = 0; i < WAVE_BAR_COUNT; i += 1) {
      const envelope = Math.sin(((i + 0.5) / WAVE_BAR_COUNT) * Math.PI);
      const jitter = 0.55 + 0.45 * Math.abs(Math.sin(i * 2.3));
      const h = 26 + Math.round(110 * Math.max(0.15, envelope * jitter));
      const delay = ((i % 6) * 0.09).toFixed(2);
      const dur = (0.5 + ((i * 29) % 30) / 100).toFixed(2);
      bars.push({
        id: i,
        style: `height:${h}rpx;animation-delay:${delay}s;animation-duration:${dur}s`,
      });
    }
    return bars;
  },

  /** 停录回调：取消则留在本页（不上传不转写），否则立即带录音文件跳编辑页 */
  handleRecordStop(res) {
    // 只认本页发起的那段；编辑页重录的 onStop 打到这里是抢答，直接丢
    if (!this._recExpect) return;
    this._recExpect = false;
    this._started = false;
    this.clearRecordTimer();
    const seconds = this.data.recordSeconds;
    const filePath = (res && res.tempFilePath) || "";
    const canceled = this._cancelRequested;
    this._cancelRequested = false;
    this.closeSheet();
    if (canceled) {
      // 上滑取消：临时文件不上传也不调转写接口，交给微信自行回收
      wx.showToast({ title: "已取消录音", icon: "none" });
      return;
    }
    if (!filePath || seconds < 1) {
      wx.showToast({ title: "说话时间太短", icon: "none" });
      return;
    }
    this.goEditWithVoice(seconds, filePath);
  },

  async ensureRecordAuth() {
    try {
      const setting = await new Promise((resolve, reject) => {
        wx.getSetting({ success: resolve, fail: reject });
      });
      if (setting.authSetting["scope.record"] === false) {
        await new Promise((resolve, reject) => {
          wx.openSetting({ success: resolve, fail: reject });
        });
      }
      await new Promise((resolve, reject) => {
        wx.authorize({ scope: "scope.record", success: resolve, fail: reject });
      });
      return true;
    } catch (err) {
      return false;
    }
  },

  // ==================== 底部录音按钮：按住展开面板，松手发送，上滑 ✕ 取消 ====================
  onMicStart() {
    // 面板还在（上一轮回缩动画未播完）时忽略重复按下
    if (this.data.sheetVisible) return;
    // 按下就静音：列表页自己不放音，但从详情页返回后那条播放器可能还在跑，
    // 不停就会把旧录音录进这段里
    audioHub.stopAll();
    this._down = true;
    this._cancelRequested = false;
    this._pressAt = Date.now();
    this.beginRecord();
  },

  /**
   * 手指上下滑动：只按纵坐标判定是否滑进了顶部取消横带。
   * 手势自 touchstart 起就锁定 .fab 节点，面板盖在上面也抢不走事件，
   * 所以不需要（也不能）靠面板自己的 touch 事件跟进。
   */
  onMicMove(e) {
    if (!this.data.sheetVisible) return;
    const canceling = this.hitCancelZone(e);
    if (canceling === this.data.canceling) return;
    if (canceling) this.vibrate();
    this.setData({
      canceling,
      cancelHint: canceling ? HINT_CANCEL : HINT_SEND,
    });
  },

  onMicEnd(e) {
    this._down = false;
    if (this.hitCancelZone(e)) {
      this.cancelRecord();
      return;
    }
    if (!this._started && Date.now() - this._pressAt < 300) {
      // 只是点了一下：面板还没展开也没录音，给一句操作提示
      wx.showToast({ title: "按住不放开始录音", icon: "none" });
      this.closeSheet();
      return;
    }
    this.stopRecord();
  },

  async beginRecord() {
    if (!this._recorder) this.initRecorder();
    const ok = await this.ensureRecordAuth();
    if (!ok) {
      wx.showToast({ title: "需要麦克风权限才能录音", icon: "none" });
      return;
    }
    // 授权返回时手指已抬起则放弃，避免“松手后仍在录”
    if (!this._down) return;
    this.openSheet();
  },

  /** 先挂出与按钮同位同尺寸的圆，隔一帧再切展开态，才有「圆扩大成方形」的过渡 */
  openSheet() {
    if (this._sheetTimer) {
      clearTimeout(this._sheetTimer);
      this._sheetTimer = null;
    }
    // 重量一次视口：收起态那个圆要与 .fab 的 CSS 定位严丝合缝，否则按下会看到错位
    this.measure();
    this.setData(
      Object.assign(this.buildSheetStyles(), {
        sheetVisible: true,
        canceling: false,
        cancelHint: HINT_SEND,
        recordSeconds: 0,
        recordTimeText: "0:00",
      }),
    );
    setTimeout(() => {
      // 展开那一帧内就松手：面板回缩，不启动录音
      if (!this._down) {
        this.closeSheet();
        return;
      }
      this.startRecorder();
    }, SHEET_FRAME_MS);
  },

  startRecorder() {
    this._started = true;
    this._recExpect = true; // onStop 里靠它认领结果（取消/发送都走同一个回调）
    this.setData({ recording: true });
    this.clearRecordTimer();
    this._recordTimer = setInterval(() => {
      const s = this.data.recordSeconds + 1;
      this.setData({ recordSeconds: s, recordTimeText: fmtRecordTime(s) });
      if (s >= RECORD_MAX) this.stopRecord(); // 上限自动收（走发送路径）
    }, 1000);
    // RecorderManager：mp3 体积小、SenseVoice 直接支持
    this._recorder.start({
      duration: RECORD_MAX * 1000,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
    });
  },

  /** 松手发送：停录音 → onStop 里带音频跳编辑页（转写与解析都在编辑页发起） */
  stopRecord() {
    this.clearRecordTimer();
    if (!this._started || !this._recorder) {
      this.closeSheet();
      return;
    }
    // 抢先置假：60s 自动收与松手同时发生时，不给第二次 stop 的机会（会进 onError）
    this._started = false;
    this._cancelRequested = false;
    this._recorder.stop(); // 触发 onStop → handleRecordStop
  },

  /** 上滑到 ✕ 后松手：仍要 stop 让原生层释放麦克风，只是结果直接丢弃 */
  cancelRecord() {
    this.clearRecordTimer();
    if (!this._started || !this._recorder) {
      this._cancelRequested = false;
      this.closeSheet();
      return;
    }
    this._started = false;
    this._cancelRequested = true;
    this._recorder.stop();
  },

  /** 去掉展开态后面板回缩成按钮位置的圆，过渡播完再卸载节点 */
  closeSheet() {
    this.setData({
      recording: false,
      canceling: false,
      cancelHint: HINT_SEND,
    });
    if (this._sheetTimer) clearTimeout(this._sheetTimer);
    this._sheetTimer = setTimeout(() => {
      this._sheetTimer = null;
      if (this.data.recording) return; // 期间又按下了新一轮，由那一轮自己收
      this.setData({
        sheetVisible: false,
        recordSeconds: 0,
        recordTimeText: "0:00",
      });
    }, SHEET_ANIM_MS);
  },

  /** 取消区命中判定：整条顶部横带都算，只看纵坐标（手指上滑时横坐标基本不变） */
  hitCancelZone(e) {
    if (!this.data.sheetVisible) return false;
    const { y } = touchPoint(e);
    return y >= 0 && y <= this.cancelHitPx();
  },

  /**
   * 取消触发线（px，视口坐标系自上而下）：面板顶边往下 CANCEL_BAND_RPX。
   * 与 .sheet-cancel 那条横带同一条几何，手指进到哪儿看到 ✕，判定就切在哪儿；
   * 每次现算，视口变了也不会拿到过期阈值。
   */
  cancelHitPx() {
    const band = Math.round(this.rpx(CANCEL_BAND_RPX));
    return this._winH - this.sheetHeightPx() + band;
  },

  /** 滑进取消区给一下轻震动，微信语音消息同样的反馈感 */
  vibrate() {
    if (typeof wx.vibrateShort !== "function") return;
    try {
      wx.vibrateShort({ type: "light", fail: () => {} });
    } catch (err) {
      /* 个别机型不支持，忽略 */
    }
  },

  clearRecordTimer() {
    if (this._recordTimer) {
      clearInterval(this._recordTimer);
      this._recordTimer = null;
    }
  },

  noop() {},

  /** 录音结果经 globalData 中转（音频临时路径 + 时长），编辑页负责转写与解析 */
  goEditWithVoice(duration, tempFilePath) {
    const app = getApp();
    app.globalData = app.globalData || {};
    app.globalData._pendingVoice = { tempFilePath, duration };
    wx.navigateTo({ url: "/pages/edit/edit" });
  },

  onReachBottom() {
    // 翻页时 loading 不再置 true（见 loadMore），防重入改看在途标记
    if (!this.data.searchMode && this.data.hasMore && !this._inflight) {
      this.loadMore();
    }
  },

  /** 上次加载被限流/网络异常中断后，下拉或点重试可以再试一次 */
  onRetryLoad() {
    this._loadFailed = false;
    return this.loadMore();
  },

  /** 列表项 → 展示条目 */
  fromListItem(item) {
    return {
      id: item.id,
      time: item.time || "",
      event: item.event || "",
      type: item.type || "",
      summary: item.summary || "",
      content: item.content || "",
      tags: item.tags || [],
      persons: item.persons || [],
      position: item.position || "",
      address: item.address || null,
      lng: item.lng != null ? item.lng : null,
      lat: item.lat != null ? item.lat : null,
      firstThumb: item.firstThumb || "",
      firstUrl: item.firstUrl || "",
      // 整条图集（缩略图供卡片、原图供点开滑动浏览）：列表接口一次带回，
      // 不这样卡片就只能看首图，要滑得逐条回查详情接口
      thumbs: item.thumbs || [],
      imageUrls: item.imageUrls || [],
      // 归属作者：列表混进同组织的他人日志时，卡片底栏地址前会标出是谁写的；
      // 自己的日志（is_mine）留空串，卡片据此不显示这个名字
      author: item.is_mine ? "" : item.author || "",
      // 卡片左边缘蓝竖条只认 is_mine：不让卡片靠 author 是否为空反推，
      // 否则遇到没昵称又确实是本人的日志就会被错标成他人
      isMine: !!item.is_mine,
      // 是不是我已置顶的条目（后端只对我自己生效）：长按菜单据此出「置顶」还是「取消置顶」
      pinned: !!item.pinned,
    };
  },

  /** 搜索结果 → 展示条目 */
  fromMemoryItem(item) {
    return {
      id: item.id,
      time: item.time || "",
      event: item.event || "",
      type: item.type || "",
      summary: item.summary || "",
      content: "",
      tags: item.tags || [],
      persons: item.persons || [],
      position: item.position || "",
      address: item.address || null,
      lng: item.lng,
      lat: item.lat,
      firstThumb: item.firstThumb || "",
      firstUrl: item.firstUrl || "",
      thumbs: item.thumbs || [],
      imageUrls: item.imageUrls || [],
      score: item.score,
    };
  },

  /** 由 entries 重建按月分组：月份间插入分割标题，日内卡片直接顺排（日期由卡片右上角时间展示） */
  buildGroups(entries) {
    const prev = this._rowsById || {};
    const next = {};
    const groups = [];
    entries.forEach((entry) => {
      const day = dayKey(entry.time);
      const month = day.slice(0, 7);
      const label =
        month === "未知日期"
          ? month
          : `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
      const last = groups[groups.length - 1];
      const first = !(last && last.month === month);
      const key = String(entry.id);
      const hit = prev[key];
      // 同一条 entry（引用没变）且 first 标记也没变时复用旧行对象：
      // 翻页只新建「新拉到的那几条」，已渲染卡片的 entry property 引用不动。
      // 用 Object.assign 而非对象展开 { ...entry }：展开会被增强编译转成
      // require('@swc/runtime/...') helper，工具端 runtime 缺失时整页注册失败
      const row =
        hit && hit.src === entry && hit.first === first
          ? hit.row
          : Object.assign({}, entry, { first });
      next[key] = { src: entry, first, row };
      if (last && last.month === month) {
        last.items.push(row);
      } else {
        groups.push({ month, label, items: [row] });
      }
    });
    this._rowsById = next;
    return groups;
  },

  /**
   * 把新分组结果同步进视图，只下发真正变化的部分（原来每次都把整份列表重传一遍，
   * 100 条约 180KB，翻得越深越慢；而且新对象会让所有卡片 observer 全部重跑）：
   * - 月份前缀一致、分组数不减少时按组比对：组内是尾部追加就只写新下标，
   *   否则（删除/移位）只重写这一个组；
   * - 尾部新增的整组直接按下标续上；
   * - 中间插月、分组变少这类结构变化退回整表替换（低频且无法用下标表达）。
   * extraPatch 与分组补丁合并成一次 setData。
   */
  renderGroups(nextGroups, extraPatch) {
    const prev = this.data.groups || [];
    const patch = Object.assign({}, extraPatch);
    let full = !prev.length || nextGroups.length < prev.length;
    const overlap = Math.min(prev.length, nextGroups.length);
    for (let i = 0; i < overlap && !full; i += 1) {
      if (prev[i].month !== nextGroups[i].month) full = true;
    }
    if (full) {
      patch.groups = nextGroups;
    } else {
      for (let i = 0; i < overlap; i += 1) {
        const a = prev[i].items;
        const b = nextGroups[i].items;
        const samePrefix = a.every((row, j) => row === b[j]);
        if (samePrefix && a.length === b.length) continue;
        if (samePrefix) {
          for (let j = a.length; j < b.length; j += 1) {
            patch[`groups[${i}].items[${j}]`] = b[j];
          }
          continue;
        }
        patch[`groups[${i}].items`] = b;
      }
      for (let i = prev.length; i < nextGroups.length; i += 1) {
        patch[`groups[${i}]`] = nextGroups[i];
      }
    }
    if (!Object.keys(patch).length) return;
    this.setData(patch);
  },

  /** 加载下一页（游标模式） */
  async loadMore() {
    if (this.data.searchMode) return;
    // 重入保护：loading 在「已有内容」时不再置 true，不能拿它当锁
    if (this._inflight) return;
    this._inflight = true;
    const isFirst = this._cursor == null;
    const version = this._version;
    try {
      // 手上已有内容（首屏快照/上一页）时保持 loading=false：
      // 整屏 loading 会把刚渲染出来的列表盖住，秒开就白做了
      if (!this._entries.length) this.setData({ loading: true });
      // 结构化筛选参数与分页参数合并；筛选态不传 withPins：
      // 置顶是独立查询、不吃任何检索条件，混进筛选结果就是三条不相干的卡片
      const params = Object.assign(
        { page: 1, pageSize: PAGE_SIZE },
        this.buildFilterParams(),
      );
      if (!this.data.hasFilter) params.withPins = 1;
      // 本列表从不读 total（有没有下一页只看 items.length），首屏也一并跳过 COUNT：
      // 带可见性 OR/EXISTS 的 COUNT 是全范围扫，是这条链路上最贵的一句
      params.withTotal = 0;
      if (!isFirst) params.beforeId = this._cursor;
      const { code, data } = await api.event.page(
        params,
        auth.getFilterScope(),
      );
      if (version !== this._version) return; // 已被新的 reset/搜索覆盖，丢弃过期结果
      if (Number(code) === 200 && data) {
        const items = (data.items || []).map(this.fromListItem);
        // 首屏是「替换」不是「合并」：快照里可能留着已被删除的旧条目，
        // 合并会让幽灵卡片永远挂在列表上；翻页仍然合并去重
        const merged = isFirst
          ? this.keepPendingInsert(items)
          : this.mergeUnique(this._entries, items);
        if (items.length) {
          // 游标取「本页最后一条」而不是本页最小 id：后端按 event_time 倒序返回，
          // 最后一条就是本页时间最旧的锚点。取 min(id) 会让「id 大但时间是补记的旧日期」
          // 那条日志被 beforeId 直接跳过，翻页永远看不到它。
          const lastId = Number(items[items.length - 1].id);
          if (Number.isFinite(lastId)) this._cursor = lastId;
        }
        // 置顶那几条每页都会原样带回（就三条，不占流量），直接整组覆盖：
        // 接不到 pinned 字段（旧版后端）时保留本地已有那组，不要把置顶区抹空
        const pinnedItems = Array.isArray(data.pinned)
          ? data.pinned.map(this.fromListItem)
          : this.data.pinnedEntries;
        this._entries = merged;
        // 只把新增的那几条/新增的月份组下发到视图，已渲染的卡片不重传
        this.renderGroups(this.buildGroups(merged), {
          pinnedEntries: pinnedItems,
          hasMore: items.length >= PAGE_SIZE,
        });
        // 纯列表首屏落地后留一份快照，供下次冷启动先出内容
        if (isFirst && !this.data.hasFilter) {
          writeFirstPageCache(
            auth.getFilterScope(),
            data.items || [],
            data.pinned || [],
          );
        }
      } else {
        // 业务错误（HTTP 200 + code!==200）不等于「没有更多」：留着 hasMore、记一次失败，
        // 让用户还能靠下拉/翻页重试（与 catch 里的网络异常同一口径，别一次报错就封死到底）
        this._loadFailed = true;
      }
    } catch (err) {
      // 关键修正：服务繁忙/网络异常不等于「没有更多」。
      // 之前这里把 hasMore 永久置 false，一次限流就会让用户到底了。
      if (version === this._version) this._loadFailed = true;
    } finally {
      // 只有「这一发」能解锁：reset 期间旧请求回来不得把新请求的锁打开
      if (version === this._version) {
        this._inflight = false;
        this.setData({ loading: false });
      }
    }
  },

  /** 合并去重（按 id） */
  mergeUnique(prev, incoming) {
    const ids = new Set(prev.map((e) => String(e.id)));
    return [...prev, ...incoming.filter((e) => !ids.has(String(e.id)))];
  },

  /**
   * 首屏替换时把「乐观插入」的那条补回来：
   * 它的时间可能比第一页还早（用户手填了旧日期），服务器第一页里没有，不能因此丢掉
   */
  keepPendingInsert(items) {
    const pending = this._pendingInsert;
    if (!pending) return items;
    if (items.some((e) => String(e.id) === String(pending.id))) return items;
    return [pending, ...items];
  },

  /** 重置并重新加载时间线（有快照先用快照撑住首帧，再后台校正） */
  async reset() {
    this._version += 1;
    this._cursor = null;
    this._loadFailed = false;
    // 在途请求的锁作废：reset 后要能立刻发新请求（旧请求回来时按版本号自行退出）
    this._inflight = false;
    // 取消未触发的搜索防抖：既然要回到全量列表，就别让上一条待发的关键词又冒出来搜一遍
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    // 没落盘的搜索词草稿一起作废：reset 的目标态就是无词全量，不能被停笔落盘盖回去
    this._kwDraft = null;
    this._entries = [];
    // 乐观插入只对紧接着的这一次首屏负责，不能跨轮残留
    this._pendingInsert = null;
    // 行对象缓存跟着条目流一起作废，免得复用上一轮列表的行
    this._rowsById = null;
    // 首屏快照只在「无筛选」的纯列表视图下才有对应内容；命中就先渲染，
    // 随后那次请求把整页替换成最新——用户看到的是「秒开 + 后台校正」而不是白屏
    const cached = this.data.hasFilter
      ? null
      : readFirstPageCache(auth.getFilterScope());
    if (cached) {
      const entries = cached.items.map(this.fromListItem);
      this._entries = entries;
      // 游标保持 null：这份快照还没与服务器对齐，不能拿来当翻页锚点
      this.setData({
        groups: this.buildGroups(entries),
        pinnedEntries: cached.pinned.map(this.fromListItem),
        hasMore: entries.length >= PAGE_SIZE,
        searchMode: false,
        keyword: "",
        // 有内容就不能再点整屏 loading，否则它会把刚渲染的列表盖住
        loading: false,
      });
    } else {
      this.setData({
        groups: [],
        pinnedEntries: [],
        hasMore: true,
        searchMode: false,
        // 回到纯列表就清掉搜索框里的残留词：否则会出现「框里还写着关键词、
        // 列表却已经是全量」的错位（下拉刷新 / 切范围 / 编辑后重进都会触发）
        keyword: "",
        loading: true,
      });
    }
    // 先插本地刚保存的记录（乐观更新）：后端此时可能正在排队，
    // 先把用户自己刚写的那条展示出来，再后台拉第一页校正
    this.applyPendingInsert();
    await this.loadMore();
  },

  /** 把编辑页刚保存的记录先本地入列（有则用，无则空操作） */
  applyPendingInsert() {
    const app = getApp();
    const pending = app.globalData && app.globalData._pendingTimelineInsert;
    if (!pending) return;
    app.globalData._pendingTimelineInsert = null;
    if (!pending.id || !pending.event) return;
    if (this._entries.some((e) => String(e.id) === String(pending.id))) return;
    // 本地这条必是本人刚写的，补上 isMine：后端第一页回来前它已经在列表里，
    // 否则刚存的那条会先不出竖条，拉到数据后再闪一下
    const entry = Object.assign({}, pending, { isMine: true });
    // 记住它：首屏替换（isFirst 分支）时用它兜底，避免「刚写完的日志凭空消失」
    this._pendingInsert = entry;
    this._entries = [entry, ...this._entries];
    this.renderGroups(this.buildGroups(this._entries));
  },

  // ==================== 长按卡片：置顶 / 取消置顶 / 编辑 / 删除 ====================

  /** 按 id 找那条卡片：置顶区里的几条不在 entries（后端已从时间序流里剔掉），必须两个数组都查 */
  findEntry(id) {
    const key = String(id);
    return (
      (this.data.pinnedEntries || []).find((e) => String(e.id) === key) ||
      (this._entries || []).find((e) => String(e.id) === key) ||
      null
    );
  },

  /** 长按卡片：震动 + 弹操作菜单（置顶相关按当前状态只给一项） */
  onCardLongPress(e) {
    const entry = this.findEntry(e && e.detail ? e.detail.id : "");
    if (!entry) return;
    this.vibrate();
    const items = [];
    const actions = [];
    // 搜索结果里没有置顶信息（/api/memory/search 不返回 pinned）：既不知道这条当下
    // 是钉着还是没钉，给不出「取消置顶」那一项，钉上了又在当页看不见，干脆不开这个口
    if (!this.data.searchMode) {
      items.push(entry.pinned ? "取消置顶" : "置顶");
      actions.push(entry.pinned ? "unpin" : "pin");
    }
    // 编辑与删除只有本人写得动（后端按 event_user 拦），他人卡片只留置顶那一项
    if (entry.isMine) {
      items.push("编辑");
      actions.push("edit");
      items.push("删除");
      actions.push("delete");
    }
    if (!items.length) return;
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const action = actions[res.tapIndex];
        if (action === "pin") this.togglePin(entry, true);
        else if (action === "unpin") this.togglePin(entry, false);
        else if (action === "edit")
          wx.navigateTo({ url: `/pages/edit/edit?id=${entry.id}` });
        else if (action === "delete") this.confirmDelete(entry);
      },
      fail: () => {
        /* 菜单被手指收回，什么都不做 */
      },
    });
  },

  /**
   * 请求置顶/取消置顶：成功后卡片就地移动，不整页重拉（重拉会闪一下并回到顶部）。
   * 失败不自己弹提示：request.js 已把后端的 message 直接 toast 出来（含「最多置顶 3 条」）
   */
  async togglePin(entry, want) {
    let code;
    try {
      const res = await api.event.pin(entry.id, want);
      code = res && res.code;
    } catch (err) {
      return; // 网络/限流异常已在 request.js 里提示过
    }
    if (Number(code) !== 200) return;
    this.applyPinLocal(entry, want);
    // 顶部轻提示而不弹 toast：卡片已经自己动到位了，一句文字就够，不遮住列表
    this.showHint(want ? "已置顶" : "已取消置顶");
  },

  /**
   * 本地移动卡片：钉上就进置顶区最前（与后端 ORDER BY p.create_time DESC 同口径，
   * 刚钉的那条算最新），取消就按时间倒序放回时间序流里它原本那段
   */
  applyPinLocal(entry, want) {
    const key = String(entry.id);
    const pinned = (this.data.pinnedEntries || []).filter(
      (e) => String(e.id) !== key,
    );
    const rest = this._entries.filter((e) => String(e.id) !== key);
    if (want) {
      // 用 Object.assign 而非对象展开：展开会被增强编译转成 @swc/runtime helper（同 buildGroups）
      const nextPinned = [Object.assign({}, entry, { pinned: true })].concat(
        pinned,
      );
      this._entries = rest;
      this.renderGroups(this.buildGroups(rest), {
        pinnedEntries: nextPinned,
      });
      return;
    }
    const next = this.insertByTime(
      rest,
      Object.assign({}, entry, { pinned: false }),
    );
    this._entries = next;
    this.renderGroups(this.buildGroups(next), { pinnedEntries: pinned });
  },

  /** 按时间倒序插入一个条目（'YYYY-MM-DD HH:mm' 是定长格式，字符串比大小就是时序） */
  insertByTime(list, item) {
    const next = list.slice();
    const t = String(item.time || "");
    let idx = next.length;
    for (let i = 0; i < next.length; i += 1) {
      if (String(next[i].time || "") < t) {
        idx = i;
        break;
      }
    }
    next.splice(idx, 0, item);
    return next;
  },

  /** 长按菜单里的删除：与详情页同一句确认口吻，删完只把这条从列表里摘掉（不跳页） */
  confirmDelete(entry) {
    wx.showModal({
      title: "删除日志",
      content: "删除后不可恢复，确定删除吗？",
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { code } = await api.event.remove(entry.id);
          if (Number(code) !== 200) return; // request.js 已提示
        } catch (err) {
          return;
        }
        // 置顶区里也可能就是这一条（后端删日志时会连带清掉指向它的置顶行）
        const key = String(entry.id);
        const pinned = (this.data.pinnedEntries || []).filter(
          (e) => String(e.id) !== key,
        );
        const rest = this._entries.filter((e) => String(e.id) !== key);
        this._entries = rest;
        this.renderGroups(this.buildGroups(rest), { pinnedEntries: pinned });
        this.showHint("已删除");
      },
    });
  },

  onKeywordInput(e) {
    // 草稿先攒在实例上，停笔 400ms 一次落盘再搜：value 绑定的输入框逐字符 setData
    // 等于每键一次跨线程回灌，还会打断中文输入法组词（同 edit.js 的输入草稿方案）。
    // 落盘与自动搜索共用这一个定时器，不再各跑各的
    this._kwDraft = e.detail.value;
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.flushKeyword(false);
      const kw = (this.data.keyword || "").trim();
      if (kw) this.onSearch();
      else if (this.data.searchMode) this.onClear();
    }, 400);
  },

  /**
   * 把搜索词草稿一次写进 data。keyword 的所有读取方（搜索/收起/触摸列表）都得先过这里，
   * 否则会出现「框里看着有词、data 里还是空」的错位。
   * @param {boolean} cancelTimer - 是否连 400ms 待发的自动搜索一起取消：
   *   主动检索（bindconfirm）要取消，触摸列表（只想收搜索框）不能取消，否则这次输入就不搜了
   */
  flushKeyword(cancelTimer) {
    if (cancelTimer && this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    if (this._kwDraft == null) return;
    const v = this._kwDraft;
    this._kwDraft = null;
    if (v !== this.data.keyword) this.setData({ keyword: v });
  },

  /** 搜索（记忆混合检索）：防抖 + 禁止重复提交，避免突发时把 AI 接口点成一排并发 */
  async onSearch() {
    // 主动检索时草稿必须先落盘（键盘「搜索」键/点放大镜都可能停在停笔 400ms 之内），
    // 顺带取消还没到点的自动搜索，避免同一个词二次请求
    this.flushKeyword(true);
    const q = (this.data.keyword || "").trim();
    if (!q) {
      this.setData({ searchMode: false });
      this.reset();
      return;
    }
    if (this._searching) return;
    // 语义检索不吃结构化条件：一旦搜索先把筛选清掉，
    // 避免「看着筛选结果、实际搜的是全量」的错位（查看范围保留，search 支持 scope）
    if (this.data.hasFilter) this.clearStructuredFilter();
    // 主动检索（bindconfirm）时取消还没到点的防抖，避免同一个词二次请求
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this._searching = true;
    // 抬版本号：既让在途的列表翻页结果作废（否则会把列表并进搜索结果），
    // 也让「检索期间又发生了 reset（下拉/切范围/编辑后重进）」时，本发迟到的结果被丢弃
    const version = (this._version += 1);
    try {
      this.setData({ loading: true, searchMode: true });
      const { code, data } = await api.memory.search(
        q,
        20,
        auth.getFilterScope(),
      );
      if (version !== this._version) return; // 已被新的 reset/搜索覆盖，丢弃过期结果
      const list =
        Number(code) === 200 && data
          ? (data.list || []).map(this.fromMemoryItem)
          : [];
      this._entries = list;
      this.setData({
        groups: this.buildGroups(list),
        // 后端语义召回被限流时给出明确提示，而不是让用户以为「真的搜不到」
        semanticSkipped: !!(data && data.semanticSkipped),
      });
    } catch (err) {
      if (version !== this._version) return;
      this._entries = [];
      this.setData({ groups: [] });
    } finally {
      this._searching = false;
      if (version === this._version) this.setData({ loading: false });
    }
  },

  onClear() {
    // 清空即回到全量列表：keyword/searchMode 由 reset 统一负责清；
    // 这里不动 searchExpanded，让 ✕ 清完后搜索框仍开着、可接着输入
    this.reset();
  },

  // ==================== 搜索图标展开/收起 ====================
  expandSearch() {
    // 搜索与结构化筛选互斥：展开搜索框就收掉筛选，
    // 否则条件条被隐藏、列表却还让着 64rpx，顶部会多一条空白
    if (this.data.hasFilter) this.clearStructuredFilter();
    this.setData({ searchExpanded: true });
  },

  collapseSearch() {
    // 失焦收起前先落盘：草稿里还有词就不能收（收起会 reset 清词，等于把刚打的字弄丢）
    this.flushKeyword(true);
    if (this.data.keyword) return;
    this.collapseSearchBox();
  },

  /**
   * 收起搜索框（仅在框已空时调用）。关键：若此刻仍停在搜索结果态
   * （关键词刚删空、400ms 防抖还没来得及 onClear 的窗口里就先滑动/失焦），
   * 必须走 reset 完整回落全量列表——不能只把 searchMode 翻成 false，
   * 否则旧搜索结果会以「普通列表」的样子残留，翻页还会往这批结果里追加。
   */
  collapseSearchBox() {
    this.setData({ searchExpanded: false });
    if (this.data.searchMode) this.reset();
    else this.setData({ searchMode: false });
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` });
  },

  goEdit() {
    wx.navigateTo({ url: "/pages/edit/edit" });
  },
});
