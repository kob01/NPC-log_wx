const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { resolveFileUrl } = require("../../utils/format");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    id: "",
    detail: null,
    imageUrls: [],
    visibilityText: "仅自己可见",
    canEdit: false,
    showPoster: false,
    loading: true,
    // 录音回放
    audioSrc: "",
    audioPlaying: false,
    audioCurrent: 0,
  },

  _audio: null,

  onLoad(options) {
    if (!auth.checkLogin()) return;
    this.setData({ id: options.id });
    this.loadDetail(options.id);
  },

  onShow() {
    // 从编辑页返回时刷新
    if (this._needRefresh && this.data.id) {
      this._needRefresh = false;
      this.loadDetail(this.data.id);
    }
  },

  onUnload() {
    this.destroyAudio();
  },

  async loadDetail(id) {
    if (!id) {
      this.setData({ loading: false });
      return;
    }
    try {
      this.setData({ loading: true });
      const { code, data } = await api.event.detail(id);
      if (Number(code) !== 200 || !data) {
        this.setData({ detail: null, loading: false });
        return;
      }
      const detail = Object.assign(
        { tags: [], persons: [], images: [], links: [] },
        data,
      );
      const imageUrls = detail.images
        .map((img) => resolveFileUrl(img.url))
        .filter(Boolean);
      let visibilityText = "仅自己可见";
      if (Number(detail.visibility) === 1) {
        visibilityText = detail.visibleOrgNames
          ? `组织可见·${detail.visibleOrgNames}`
          : "组织可见";
      }
      // 录音相对路径必须经 resolveFileUrl 拼上 BASE_URL 才能播
      const audioSrc = detail.audioUrl ? resolveFileUrl(detail.audioUrl) : "";
      if (this._audio && this._audio.src !== audioSrc) this.destroyAudio();
      this.setData({
        detail,
        imageUrls,
        visibilityText,
        canEdit: !!detail.is_mine || auth.isAdmin(),
        audioSrc,
        audioPlaying: false,
        audioCurrent: 0,
        loading: false,
      });
    } catch (err) {
      this.setData({ detail: null, loading: false });
    }
  },

  // ==================== 录音回放 ====================
  destroyAudio() {
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
  },

  initAudio(src) {
    const audio = wx.createInnerAudioContext();
    audio.src = src;
    audio.onPlay(() => this.setData({ audioPlaying: true }));
    audio.onPause(() => this.setData({ audioPlaying: false }));
    audio.onStop(() => this.setData({ audioPlaying: false, audioCurrent: 0 }));
    audio.onEnded(() => this.setData({ audioPlaying: false, audioCurrent: 0 }));
    audio.onError(() => {
      this.setData({ audioPlaying: false });
      wx.showToast({ title: "录音播放失败", icon: "none" });
    });
    // 秒数变化才刷屏，避免每次 timeupdate 都 setData
    audio.onTimeUpdate(() => {
      const s = Math.floor(audio.currentTime || 0);
      if (s !== this.data.audioCurrent) this.setData({ audioCurrent: s });
    });
    this._audio = audio;
    return audio;
  },

  toggleAudio() {
    const { audioSrc } = this.data;
    if (!audioSrc) return;
    const audio = this._audio || this.initAudio(audioSrc);
    if (this.data.audioPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
  },

  onPreviewImage(e) {
    const index = e.currentTarget.dataset.index;
    wx.previewImage({
      current: this.data.imageUrls[index],
      urls: this.data.imageUrls,
    });
  },

  onOpenLocation() {
    const { detail } = this.data;
    if (!detail || detail.lng == null || detail.lat == null) {
      wx.showToast({ title: "该日志未记录坐标", icon: "none" });
      return;
    }
    wx.openLocation({
      latitude: Number(detail.lat),
      longitude: Number(detail.lng),
      name: detail.position || "日志地点",
      address: detail.address || "",
      scale: 18,
    });
  },

  onCopyLink(e) {
    const url = e.currentTarget.dataset.url;
    wx.setClipboardData({
      data: url,
      success: () =>
        wx.showToast({ title: "链接已复制，请在浏览器打开", icon: "none" }),
    });
  },

  goEdit() {
    this._needRefresh = true;
    wx.navigateTo({ url: `/pages/edit/edit?id=${this.data.id}` });
  },

  onShowPoster() {
    if (!this.data.detail) return;
    this.setData({ showPoster: true });
  },

  onHidePoster() {
    this.setData({ showPoster: false });
  },

  // 分享给好友（Phase 3 可携 shareToken 做访客只读链接）
  onShareAppMessage() {
    const detail = this.data.detail || {};
    return {
      title: detail.event || "NPC存档 · 记录这一刻",
      path: `/pages/detail/detail?id=${this.data.id}`,
    };
  },

  onShareTimeline() {
    const detail = this.data.detail || {};
    return {
      title: detail.event || "NPC存档 · 记录这一刻",
      query: `id=${this.data.id}`,
    };
  },

  onDelete() {
    wx.showModal({
      title: "删除日志",
      content: "删除后不可恢复，确定删除吗？",
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.event.remove(this.data.id);
        if (Number(code) === 200) {
          // 删掉后列表必须重拉，否则已删日志仍留在时间轴上
          const app = getApp();
          app.globalData = app.globalData || {};
          app.globalData.timelineDirty = true;
          wx.showToast({ title: "已删除", icon: "success" });
          setTimeout(() => wx.navigateBack(), 600);
        } else {
          wx.showToast({ title: message || "删除失败", icon: "none" });
        }
      },
    });
  },
});
