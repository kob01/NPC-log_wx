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
  // 输入草稿（不进 data）：value 绑定的输入框逐字符 setData 等于每键一次跨线程回灌，
  // 落盘时机见 onQuestionInput / onKeywordInput
  _qDraft: null,
  _kwDraft: null,

  onUnload() {
    // 防抖定时器挂着页面方法，不摘会往已卸载的页 setData
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
  },

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
    // 草稿先攒在实例上，点「提问」时一次落盘：textarea 逐字符 setData 等于
    // 每键一次跨线程回灌 + auto-height 重排（同 edit.js 的输入草稿方案）
    this._qDraft = e.detail.value;
  },

  /** 把未落盘的提问草稿写进 data：onAsk 是唯一读取方，落笔后立刻点按钮也能读到全文 */
  flushQuestion() {
    if (this._qDraft == null) return;
    const v = this._qDraft;
    this._qDraft = null;
    if (v !== this.data.question) this.setData({ question: v });
  },

  async onAsk() {
    this.flushQuestion(); // 停笔立刻点「提问」：草稿先落盘，不能按 data 里的旧值搜
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
    // 草稿先攒在实例上，停笔 400ms 一次落盘再搜（同 timeline 搜索框）：
    // 逐字符 setData 等于每键一次跨线程回灌，还会打断中文输入法组词
    this._kwDraft = e.detail.value;
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.flushKeyword();
      if ((this.data.keyword || "").trim()) this.onSearch();
    }, 400);
  },

  /** 把搜索词草稿一次写进 data：onSearch（bindconfirm/搜索按钮）与自动搜索都先过这里 */
  flushKeyword() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    if (this._kwDraft == null) return;
    const v = this._kwDraft;
    this._kwDraft = null;
    if (v !== this.data.keyword) this.setData({ keyword: v });
  },

  async onSearch(size) {
    this.flushKeyword(); // 停笔立刻点「搜索」/键盘确认：草稿先落盘，顺带取消待发的自动搜索
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
    // 程序化写词前作废草稿与待发的自动搜索：否则停笔落盘会把标签盖回手打的旧词
    this._kwDraft = null;
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
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
