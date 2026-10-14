const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { resolveFileUrl } = require("../../utils/format");

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
    year: "",
    tag: "",
    loading: true,
    selected: null,
    // 全屏态：地图铺满整屏。orientation 绑到 page-meta 的 page-orientation 实现一键横屏
    // （基础库 2.12.0+；低版本忽略该属性，退化为竖屏铺满）
    // 初始留空串表示“不干预”，避免在 PC/iPad 端把窗口锁成竖向
    fs: false,
    orientation: "",
  },

  onShow() {
    if (!auth.checkLogin()) return;
    this.load(this.data.year, this.data.tag);
  },

  onPullDownRefresh() {
    this.load(this.data.year, this.data.tag).then(() =>
      wx.stopPullDownRefresh(),
    );
  },

  onHide() {
    // 横屏态泄漏防护：离开本页必须回竖屏并恢复 tabBar，否则其它页面会停在横屏
    this.resetFs();
  },

  onUnload() {
    if (this._refitTimer) clearTimeout(this._refitTimer);
    this.resetFs();
  },

  async load(year, tag) {
    try {
      this.setData({ loading: true, selected: null });
      const params = {};
      if (year) params.year = year;
      if (tag) params.tag = tag;
      const { code, data, message } = await api.memory.footprints(params);
      if (Number(code) === 200 && data) {
        const points = (data.points || []).map((p) =>
          Object.assign({}, p, { thumb: resolveFileUrl(p.firstThumb) }),
        );
        this.buildMap(points);
        this.setData({
          points,
          years: data.years || [],
          total: data.total || 0,
          // 年份 chip 的计数不受 year 过滤影响（后端另走一条直方图 SQL），
          // 所以选了 2026 之后 2025/2024 仍在；这里只拿它算「全部」那一个数
          allTotal: Number(data.totalAllYears || data.total || 0),
          loading: false,
        });
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
        });
        if (message) wx.showToast({ title: message, icon: "none" });
      }
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  buildMap(points) {
    const valid = points.filter((p) => p.lng != null && p.lat != null);
    // 原生 callout 不支持 max-width，按屏幕宽 66% 估算可容纳字符数，超出截断加省略号
    const info =
      typeof wx.getWindowInfo === "function"
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
    const winW = (info && info.windowWidth) || 375;
    const fontSize = 12;
    // 去掉左右各 8px padding 后按字号估算中文字符宽度
    const maxChars = Math.max(6, Math.floor((winW * 0.66 - 16) / fontSize));
    const clipTitle = (str) => {
      const s = (str || "").trim() || "日志";
      return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
    };
    const markers = valid.map((p) => ({
      id: Number(p.id),
      latitude: Number(p.lat),
      longitude: Number(p.lng),
      width: 28,
      height: 28,
      callout: {
        content: clipTitle(p.event),
        color: "#333333",
        fontSize,
        borderRadius: 8,
        bgColor: "#ffffff",
        padding: 8,
        display: "BYCLICK",
        textAlign: "center",
      },
    }));
    const includePoints = valid.map((p) => ({
      latitude: Number(p.lat),
      longitude: Number(p.lng),
    }));
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
    this.setData({ markers, includePoints, center, scale });
  },

  onYearChip(e) {
    const year = e.currentTarget.dataset.year || "";
    this.setData({ year });
    this.load(year, this.data.tag);
  },

  onTagInput(e) {
    this.setData({ tag: e.detail.value });
  },

  onTagSearch() {
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
