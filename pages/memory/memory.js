const api = require("../../utils/api");
const auth = require("../../utils/auth");

const NOT_CONFIGURED_HINT = "AI 未配置";
const isNotConfigured = (msg) =>
  !!msg && msg.indexOf(NOT_CONFIGURED_HINT) !== -1;

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    question: "",
    asking: false,
    askResult: null,
    askNotConfigured: false,
    askError: "",
    tags: [],
    summary: null,
    summaryLoading: false,
    summaryNotConfigured: false,
    keyword: "",
    searching: false,
    searchList: [],
    searchTotal: 0,
    searched: false,
    limit: 8,
  },

  // 输入防抖定时器（不进 data，避免无谓的 setData）
  _searchTimer: null,

  onShow() {
    if (!auth.checkLogin()) return;
    // 本页已固定只看自己（api.memory.* 恒带 onlyMine），范围不再随全局开关变动，
    // 无需再在 onShow 里对比范围、清理另一种范围下的旧结果
    // tags 已在 api.js 里带 120s 缓存，这里每次 onShow 调用要么命中缓存、要么在途复用
    this.loadTags();
  },

  async loadTags() {
    try {
      const { code, data } = await api.memory.tags();
      if (Number(code) === 200 && data) {
        this.setData({ tags: data.tags || [] });
      }
    } catch (err) {
      /* 静默 */
    }
  },

  onQuestionInput(e) {
    this.setData({ question: e.detail.value });
  },

  async onAsk() {
    const q = (this.data.question || "").trim();
    if (!q) {
      wx.showToast({ title: "请输入你的问题", icon: "none" });
      return;
    }
    // 后端 AI 闸门同一时刻只放 3 个并发，连续点击提问会把它们全占满
    if (this.data.asking) return;
    try {
      this.setData({
        asking: true,
        askError: "",
        askNotConfigured: false,
        askResult: null,
      });
      const { code, message, data } = await api.memory.ask(q);
      if (Number(code) === 200 && data) {
        this.setData({ askResult: data });
      } else if (isNotConfigured(message)) {
        this.setData({ askNotConfigured: true });
      } else {
        this.setData({ askError: message || "AI 问答失败" });
      }
    } catch (err) {
      this.setData({ askError: "AI 问答失败，请稍后重试" });
    } finally {
      this.setData({ asking: false });
    }
  },

  /** 月度摘要：后端 DB 缓存 + 进程内缓存 + 客户端 120s 缓存，重复点几乎不产生请求 */
  async onSummary() {
    if (this.data.summaryLoading) return;
    try {
      this.setData({ summaryLoading: true, summaryNotConfigured: false });
      const { code, message, data } = await api.memory.summary();
      if (Number(code) === 200 && data) {
        this.setData({ summary: data });
      } else if (isNotConfigured(message)) {
        this.setData({ summaryNotConfigured: true });
      } else {
        wx.showToast({ title: message || "暂无摘要", icon: "none" });
      }
    } catch (err) {
      /* request 已提示 */
    } finally {
      this.setData({ summaryLoading: false });
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    // 输入停顿 400ms 自动搜：避免用户反复点“搜索”造成并发 AI 检索请求
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      if ((this.data.keyword || "").trim()) this.onSearch();
    }, 400);
  },

  async onSearch(size) {
    const q = (this.data.keyword || "").trim();
    if (!q) {
      wx.showToast({ title: "请输入搜索关键词", icon: "none" });
      return;
    }
    if (this.data.searching) return;
    const limit = size || this.data.limit;
    try {
      this.setData({ searching: true, searched: true });
      const { code, data } = await api.memory.search(q, limit, "mine");
      if (Number(code) === 200 && data) {
        this.setData({
          searchList: data.list || [],
          searchTotal: data.total || 0,
          limit,
        });
      }
    } catch (err) {
      this.setData({ searchList: [] });
    } finally {
      this.setData({ searching: false });
    }
  },

  onLoadMore() {
    this.onSearch(Math.min(this.data.limit + 8, 20));
  },

  onTagClick(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({ keyword: tag });
    this.onSearch(8);
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}`,
    });
  },

  goDetailById(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` });
  },
});
