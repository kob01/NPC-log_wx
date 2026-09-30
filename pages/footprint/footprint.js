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
    year: "",
    tag: "",
    loading: true,
    selected: null,
    showPoster: false,
    presetCopy: null,
    presetImage: "",
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
          loading: false,
        });
      } else {
        this.setData({
          points: [],
          markers: [],
          includePoints: [],
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
    const markers = valid.map((p) => ({
      id: Number(p.id),
      latitude: Number(p.lat),
      longitude: Number(p.lng),
      width: 28,
      height: 28,
      callout: {
        content: p.event || "日志",
        color: "#333333",
        fontSize: 12,
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

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}`,
    });
  },

  // 生成足迹分享卡：先截屏地图（含点位分布），高频标签作话题
  onSharePoster() {
    const points = this.data.points || [];
    if (!points.length) {
      wx.showToast({ title: "暂无足迹", icon: "none" });
      return;
    }
    wx.showLoading({ title: "生成中", mask: true });
    const open = (mapImage) => {
      wx.hideLoading();
      const counter = {};
      points.forEach((p) =>
        (p.tags || []).forEach((tg) => {
          counter[tg] = (counter[tg] || 0) + 1;
        }),
      );
      const hashtags = Object.keys(counter)
        .sort((a, b) => counter[b] - counter[a])
        .slice(0, 6)
        .map((t) => (t.charAt(0) === "#" ? t : "#" + t));
      const yy = this.data.year ? ` · ${this.data.year}` : "";
      const presetCopy = {
        title: "我把世界走成了足迹",
        body: `走过 ${this.data.total} 个地点${yy}，每一枚坐标都是一段值得回味的旅程 🧭`,
        hashtags,
      };
      this.setData({ presetCopy, presetImage: mapImage, showPoster: true });
    };
    this.captureMap()
      .then(open)
      .catch(() => open(""));
  },

  /**
   * 截取地图当前可见画面（含撒点分布）
   * 部分真机上 takeScreenShot 回调可能永不触发，这里做三重保护：
   * 1) 同步异常 try/catch；2) 超时兜底 settle；3) done 标记保证只结算一次，
   * 调用方 loading 必然关闭（失败仅降级为不带地图的纯文字版式）
   */
  captureMap() {
    const TIMEOUT_MS = 4000;
    return new Promise((resolve) => {
      let done = false;
      const finish = (path) => {
        if (done) return;
        done = true;
        resolve(path);
      };
      if (!this.data.markers.length) {
        finish("");
        return;
      }
      setTimeout(() => finish(""), TIMEOUT_MS);
      try {
        wx.createMapContext("footprintMap").takeScreenShot({
          toFile: true,
          success: (res) => finish(res.tempFilePath || res.tempImagePath || ""),
          fail: () => finish(""),
        });
      } catch (e) {
        finish("");
      }
    });
  },

  onHidePoster() {
    this.setData({ showPoster: false });
  },
});
