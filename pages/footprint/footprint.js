const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { resolveFileUrl } = require("../../utils/format");

// 点位超过这个数量就不再逐点带 callout：一个 callout 有 7 个样式字段，
// 上千个点位光这一项就多传几千个字段，地图首屏渲染明显变慢。
// 少点位保持「点标记弹标题」的原体验；超阈值后标题改在选中面板里显示（见 map-actions）
const CALLOUT_MAX_POINTS = 200;
// 地图 marker 与列表共用的分页大小：首屏只拉 30 个点，余下的自动续拉。
// 「全部年份几百上千个点」一次性下发会让 setData 体积与节点数同时爆掉
const PAGE_SIZE = 30;
// 一次最多加载的点位数：到顶就停并提示，由用户自己切年份/标签缩小范围。
// 666 不是 30 的整数倍，最后一页会多带回几条，截断后丢弃即可（不动态改 pageSize，
// 否则后端按 page*pageSize 算的 offset 会错位）
const MAX_POINTS = 666;
// 自动续拉的间隔：一页到手立刻排下一页，串行但不用等用户滚到底；
// 留这点间隙是为了在两页之间给版本切换/页面隐藏一个插话的机会
const AUTO_LOAD_GAP = 120;
// 进页整轮加载的节流窗口：自动续拉会把最多 666 个点全拉一遍，
// 60s 内切 tab 回来没必要原样重来（下拉刷新、切年/切标签都会绕过这一层）；
// 刚刚写过日志（globalData.timelineDirty）时不节流，否则新点要等窗口过期才看得到
const REFRESH_MS = 60 * 1000;
// callout 标题字号：与下面按屏宽估算可容纳字符数共用这一处定义
const CALLOUT_FONT_SIZE = 12;

/** callout 标题按屏宽 66% 截断（原生 callout 不支持 max-width）；每批算一次即可 */
function clipTitle(str) {
  let winW = 375;
  try {
    const info =
      typeof wx.getWindowInfo === "function"
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
    winW = (info && info.windowWidth) || 375;
  } catch (e) {
    /* 拿不到视口就按默认估值截 */
  }
  const maxChars = Math.max(
    6,
    Math.floor((winW * 0.66 - 16) / CALLOUT_FONT_SIZE),
  );
  const s = (str || "").trim() || "日志";
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    points: [],
    markers: [],
    includePoints: [],
    center: { latitude: 35, longitude: 105 },
    scale: 4,
    years: [],
    total: 0,
    // 「全部(N)」用的是所有年份之和；total 是当前这一档命中的数（两者在选了年份后并不相等）
    allTotal: 0,
    // 默认看当年：足迹页最常看的就是「今年去了哪」，往年点年份 chip 即可
    year: String(new Date().getFullYear()),
    tag: "",
    loading: true,
    selected: null,
    // 点位过多时 marker 不带 callout，标题改在选中面板显示（模板据此决定要不要出标题）
    slimCallout: false,
    // 全屏态：地图铺满整屏。orientation 绑到 page-meta 的 page-orientation 实现一键横屏
    // （基础库 2.12.0+；低版本忽略该属性，退化为竖屏铺满）
    // 初始留空串表示“不干预”，避免在 PC/iPad 端把窗口锁成竖向
    fs: false,
    orientation: "",
    // 分页态：hasMore 由后端按全量命中数算好带回；loadingMore 独立于 loading，
    // 追加页不能让整页进 loading（markers 已有内容，闪一次空态判断还会抖动）
    hasMore: false,
    loadingMore: false,
    // 到达 MAX_POINTS 上限而停时置 true：列表底部据此给一条常驻提示
    limitReached: false,
    // 上限值进 data 供模板直接展示（WXML 拿不到 JS 常量）
    maxPoints: MAX_POINTS,
  },

  // 列表版本号：切年/切标签后，旧过滤条件的迟到页直接丢弃（同 timeline 的 _version）
  _fpVersion: 0,
  // 已加载到第几页（实例态，不进 data）
  _page: 1,
  // 追加页在途标记：防止 onReachBottom 连发把同一页拉两遍
  _loadingMore: false,
  // 标签输入草稿（不进 data）：停笔前不 setData，见 onTagInput
  _tagDraft: null,
  // 自动续拉的定时器：同一时刻只排一发，避免 onReachBottom 与自动续拉互相叠
  _autoTimer: null,
  // 触顶提示只弹一次：每轮加载重置，不然切年后再触顶就不提示了
  _limitNotified: false,
  // 上一次整轮加载完成的时间与条件：onShow 的 60s 节流靠这两个值判断
  _loadedAt: 0,
  _loadedKey: "",
  // 页面是否在后台：在后台不排续拉，否则一口气把 666 条全拉完纯属白耗流量
  _hidden: false,

  onShow() {
    if (!auth.checkLogin()) return;
    this._hidden = false;
    const app = getApp();
    const dirty = !!(app && app.globalData && app.globalData.timelineDirty);
    const key = `${this.data.year}|${this.data.tag || ""}`;
    // 刚写过日志（dirty）不节流；其余 60s 内同条件直接用已加载的结果
    if (
      !dirty &&
      this._loadedKey === key &&
      Date.now() - this._loadedAt < REFRESH_MS
    ) {
      // 上次没拉完就被切走（onHide 停了续拉）：接着拉，不必整轮重来
      if (this.data.hasMore) this.scheduleAutoLoad(this._fpVersion);
      return;
    }
    this.load(this.data.year, this.data.tag);
  },

  onPullDownRefresh() {
    this.load(this.data.year, this.data.tag).then(() =>
      wx.stopPullDownRefresh(),
    );
  },

  onReachBottom() {
    this.loadMore();
  },

  onHide() {
    // 续拉在后台继续跑就是白耗流量：先停，回页时再接着拉
    this._hidden = true;
    if (this._autoTimer) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
    // 横屏态泄漏防护：离开本页必须回竖屏并恢复 tabBar，否则其它页会停在横屏
    this.resetFs();
  },

  onUnload() {
    if (this._refitTimer) clearTimeout(this._refitTimer);
    if (this._autoTimer) clearTimeout(this._autoTimer);
    this.resetFs();
  },

  /** 拉第一页（切年/切标签/下拉刷新都走这里）：清空已加载部分，视野按新一批首屏点位重算 */
  async load(year, tag) {
    const version = (this._fpVersion += 1);
    this._page = 1;
    // 追加页的在途态一并作废：迟到的旧页被版本护栏丢弃时不会再有人来收这一帧
    this._loadingMore = false;
    // 新一轮加载：取消还没醒来的自动续拉，并重新允许一次触顶提示
    if (this._autoTimer) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
    this._limitNotified = false;
    // 本轮开始即作废上一次的节流凭据：失败/空页时不能让 onShow 误以为「还是有新鲜数据」
    this._loadedAt = 0;
    this._loadedKey = "";
    this.setData({
      loading: true,
      loadingMore: false,
      selected: null,
      points: [],
      markers: [],
      includePoints: [],
      hasMore: false,
      limitReached: false,
    });
    try {
      const params = { page: 1, pageSize: PAGE_SIZE };
      if (year) params.year = year;
      if (tag) params.tag = tag;
      const { code, data, message } = await api.memory.footprints(params);
      if (version !== this._fpVersion) return; // 已切走过滤条件，丢弃过期结果
      if (Number(code) === 200 && data) {
        const points = (data.points || []).map((p) =>
          Object.assign({}, p, { thumb: resolveFileUrl(p.firstThumb) }),
        );
        // slimCallout 按过滤命中的总数判，而不是已加载的那 30 个：
        // 跟着已加载数翻页翻到一半突然全消失，点位样式会前后不一致
        const slimCallout = Number(data.total || 0) > CALLOUT_MAX_POINTS;
        this.setData({
          years: data.years || [],
          total: data.total || 0,
          // 年份 chip 的计数不受 year 过滤影响（后端另走一条直方图 SQL），
          // 所以选了 2026 之后 2025/2024 仍在；这里只拿它算「全部」那一个数
          allTotal: Number(data.totalAllYears || data.total || 0),
          slimCallout,
          loading: false,
          hasMore: !!data.hasMore,
        });
        this.appendPoints(points, { reset: true });
        // 记下本轮完成的时点：onShow 尾随进来时靠它做 60s 节流
        this._loadedAt = Date.now();
        this._loadedKey = `${this.data.year}|${this.data.tag || ""}`;
        // 首屏之后接着自动拉下一页：用户不用滚到底，也不能停在第 30 条
        this.scheduleAutoLoad(version);
      } else {
        // 年份 chips 与「全部(N)」常驻在过滤条里，失败或空数据时必须清零，否则会上次结果残留
        this.setData({
          points: [],
          markers: [],
          includePoints: [],
          years: [],
          total: 0,
          allTotal: 0,
          loading: false,
          hasMore: false,
          limitReached: false,
        });
        if (message) wx.showToast({ title: message, icon: "none" });
      }
    } catch (err) {
      if (version !== this._fpVersion) return;
      this.setData({ loading: false, hasMore: false });
    }
  },

  /**
   * 取下一页：marker 与列表行都按下标路径追加，已渲染部分不重传。
   * 自动续拉与上拉（onReachBottom）共用这一个入口，靠 _loadingMore 串行化。
   */
  async loadMore() {
    if (!this.data.hasMore || this._loadingMore || this.data.loading) return;
    if (this.data.points.length >= MAX_POINTS) return this.finishByLimit();
    this.flushTag(); // 草稿里的词算数：与 onYearChip 同一口径
    const version = this._fpVersion;
    this._loadingMore = true;
    this.setData({ loadingMore: true });
    try {
      const params = { page: this._page + 1, pageSize: PAGE_SIZE };
      if (this.data.year) params.year = this.data.year;
      if (this.data.tag) params.tag = this.data.tag;
      const { code, data } = await api.memory.footprints(params);
      if (version !== this._fpVersion) return;
      if (Number(code) === 200 && data && (data.points || []).length) {
        this._page += 1;
        const mapped = (data.points || []).map((p) =>
          Object.assign({}, p, { thumb: resolveFileUrl(p.firstThumb) }),
        );
        // 最后一页可能把 666 撑破：只收下装得下的部分，多的丢弃
        const room = MAX_POINTS - this.data.points.length;
        const batch = mapped.slice(0, room);
        this.appendPoints(batch, { reset: false });
        const reached =
          batch.length < mapped.length ||
          this.data.points.length >= MAX_POINTS;
        this.setData({
          hasMore: !reached && !!data.hasMore,
          limitReached: reached,
        });
        if (reached) this.notifyLimit();
        // 只在真正拿到新数据后继续：请求失败/到底时不再排下一枪，
        // 否则弱网下会变成每 120ms 重试一次的循环风暴（留给用户上拉重试）
        else this.scheduleAutoLoad(version);
      } else {
        // 空页/业务错误都按「到底」收口：留着 hasMore 只会每次滚到底白打一枪
        this.setData({ hasMore: false });
      }
    } catch (err) {
      // 追加页失败不打断已渲染的列表：保住 hasMore，下一轮/上拉还能重试
    } finally {
      this._loadingMore = false;
      if (version === this._fpVersion) this.setData({ loadingMore: false });
    }
  },

  /** 到达上限：停掉续拉并给一次提示（列表底部的常驻提示由 limitReached 驱动） */
  finishByLimit() {
    if (this.data.hasMore || !this.data.limitReached) {
      this.setData({ hasMore: false, limitReached: true });
    }
    this.notifyLimit();
  },

  /** 触顶提示只弹一次，避免每页都 toast 一遍 */
  notifyLimit() {
    if (this._limitNotified) return;
    this._limitNotified = true;
    wx.showToast({
      title: `最多显示 ${MAX_POINTS} 条，更多请切年份`,
      icon: "none",
    });
  },

  /**
   * 排下一次自动续拉：一页到手就继续要下一页，直到到底或触顶。
   * 用定时器而不是直接递归，一是拉开两页之间的间隔，二是给「切年/切标签/离开页面」
   * 一个插话的机会——版本号变了，旧定时器醒来第一件事就是自检并退出。
   */
  scheduleAutoLoad(version) {
    if (version !== this._fpVersion) return;
    if (this._hidden) return; // 页面在后台：不排枪，onShow 时再接着拉
    if (this._autoTimer) return; // 已排过一枪，等它醒来即可
    if (this.data.points.length >= MAX_POINTS) return this.finishByLimit();
    if (!this.data.hasMore) return;
    this._autoTimer = setTimeout(() => {
      this._autoTimer = null;
      if (version !== this._fpVersion) return;
      this.loadMore();
    }, AUTO_LOAD_GAP);
  },

  /**
   * 把一批点位同时追加进地图 marker 与列表：一律按下标路径下发
   * （markers[i]/points[i]），整组重发会让已渲染的几百个点反复过桥。
   * reset 时另外按这批点位算地图视野——center/scale/includePoints 只在首屏算一次，
   * 追加不再动 include-points，否则每翻一页用户的视角就被拽回去一次
   */
  appendPoints(batch, opts) {
    const reset = !!(opts && opts.reset);
    const pointStart = reset ? 0 : this.data.points.length;
    const markerStart = reset ? 0 : this.data.markers.length;
    const slim = this.data.slimCallout;
    const patch = {};
    const valid = [];
    batch.forEach((p, i) => {
      patch[`points[${pointStart + i}]`] = p;
      // 与旧 buildMap 的 valid 过滤同口径：无坐标的点只进列表，不上图
      if (p.lng == null || p.lat == null) return;
      const marker = {
        id: Number(p.id),
        latitude: Number(p.lat),
        longitude: Number(p.lng),
        width: 28,
        height: 28,
      };
      if (!slim) {
        marker.callout = {
          content: clipTitle(p.event),
          color: "#333333",
          fontSize: CALLOUT_FONT_SIZE,
          borderRadius: 8,
          bgColor: "#ffffff",
          padding: 8,
          display: "BYCLICK",
          textAlign: "center",
        };
      }
      patch[`markers[${markerStart + valid.length}]`] = marker;
      valid.push(p);
    });
    if (reset) {
      let center = this.data.center;
      let scale = 4;
      if (valid.length) {
        const latSum = valid.reduce((s, p) => s + Number(p.lat), 0);
        const lngSum = valid.reduce((s, p) => s + Number(p.lng), 0);
        center = {
          latitude: latSum / valid.length,
          longitude: lngSum / valid.length,
        };
        scale = valid.length === 1 ? 14 : 4;
      }
      patch.includePoints = valid.map((p) => ({
        latitude: Number(p.lat),
        longitude: Number(p.lng),
      }));
      patch.center = center;
      patch.scale = scale;
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  onYearChip(e) {
    this.flushTag(); // 草稿里的词算数：标签没点「筛选」就切年份，按已输入的词一起筛
    const year = e.currentTarget.dataset.year || "";
    this.setData({ year });
    this.load(year, this.data.tag);
  },

  /**
   * 标签输入草稿：停笔前不 setData。逐字符写回 value 绑定的输入框等于每键一次
   * 跨线程回灌，还会打断中文输入法组词（同 timeline 搜索框、edit 页输入草稿）
   */
  onTagInput(e) {
    this._tagDraft = e.detail.value;
  },

  /** 把未落盘的标签草稿写进 data：搜筛选/切年份/翻页前都要先过这里 */
  flushTag() {
    if (this._tagDraft == null) return;
    const v = this._tagDraft;
    this._tagDraft = null;
    if (v !== this.data.tag) this.setData({ tag: v });
  },

  onTagSearch() {
    this.flushTag();
    this.load(this.data.year, (this.data.tag || "").trim());
  },

  onMarkerTap(e) {
    const id = e.markerId;
    const point = this.data.points.find((p) => Number(p.id) === Number(id));
    if (point) this.setData({ selected: point });
  },

  onListTap(e) {
    const index = e.currentTarget.dataset.index;
    const point = this.data.points[index];
    if (!point) return;
    this.setData({
      selected: point,
      center: { latitude: Number(point.lat), longitude: Number(point.lng) },
      scale: 14,
    });
  },

  openNav() {
    const p = this.data.selected;
    if (!p || p.lng == null || p.lat == null) {
      wx.showToast({ title: "无坐标", icon: "none" });
      return;
    }
    wx.openLocation({
      latitude: Number(p.lat),
      longitude: Number(p.lng),
      name: p.position || p.event || "足迹",
      address: p.address || "",
      scale: 18,
    });
  },

  /** 进入全屏（横屏） */
  enterFs() {
    this.applyFs(true);
  },

  /** 退出全屏（回竖屏） */
  exitFs() {
    this.applyFs(false);
  },

  /**
   * 切换全屏态
   * @param {boolean} fs - 是否全屏
   * @param {boolean} refit - 切换后是否重算地图视野（页面已不可见时传 false）
   */
  applyFs(fs, refit = true) {
    if (this.data.fs === fs) return;
    this.setData({
      fs,
      orientation: fs ? "landscape" : "portrait",
    });
    // 横屏下 tabBar 会吃掉一条地图高度，全屏期间收起，退出时恢复
    if (fs) {
      wx.hideTabBar({ animation: false });
    } else {
      wx.showTabBar({ animation: false });
    }
    if (refit) this.refitMap();
  },

  /** 静默复位，只用于 onHide/onUnload 防横屏泄漏 */
  resetFs() {
    this.applyFs(false, false);
  },

  /** 可视区尺寸变了要重新贴合点位，否则横屏后点位会挤在半边屏幕外 */
  refitMap() {
    const points = this.data.includePoints;
    if (!points || !points.length) return;
    // 等 setData 与旋转动画落地再算，早了会按旧尺寸出缩放
    if (this._refitTimer) clearTimeout(this._refitTimer);
    this._refitTimer = setTimeout(() => {
      this._refitTimer = null;
      wx.createMapContext("footprintMap").includePoints({
        points,
        padding: [40, 40, 40, 40],
      });
    }, 320);
  },

  /** page-meta 的 resize：横竖屏切换落地后重新贴合（键盘弹起也会触发 resize，非全屏时不干预用户当前的缩放） */
  onPageResize() {
    if (!this.data.fs) return;
    this.refitMap();
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}`,
    });
  },
});
