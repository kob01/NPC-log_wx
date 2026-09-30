const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { dayKey } = require("../../utils/format");

const PAGE_SIZE = 10;

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    entries: [],
    groups: [],
    loading: false,
    hasMore: true,
    keyword: "",
    searchMode: false,
    searchExpanded: false,
    // 后端语义召回被并发闸门拒时置 true（列表仍能给出关键词结果，只用来提示质量下降）
    semanticSkipped: false,
    // 录音浮层
    recording: false,
    recordSeconds: 0,
  },

  // 游标：当前已加载的最小 event_id（存实例上，不进 data）
  _cursor: null,
  _version: 0, // 列表版本号，用于丢弃过期的异步结果
  _loadFailed: false, // 上次加载是否被限流/网络错误打断（不打断 hasMore 语义）
  _searching: false, // 搜索单飞，避免连续点击变成多个并发 AI 请求
  _searchTimer: null,
  _recorder: null, // wx RecorderManager
  _recordTimer: null,
  _down: false, // 手指是否按住录音键（防授权返回时已松手仍启动录音）

  onLoad() {
    this._cursor = null;
    this._loaded = false;
    this._loadFailed = false;
    this.initRecorder();
  },

  onShow() {
    if (!auth.checkLogin()) return;
    // 新增/保存/删除后回到列表：强制重新加载，否则看到的仍是旧快照
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
      (!this.data.searchMode && !this.data.entries.length && !this.data.loading)
    ) {
      this._loaded = true;
      this.reset();
    }
  },

  /** 列表滑动时收起搜索框（已输入关键词时不打断浏览搜索结果） */
  onPageScroll() {
    if (this.data.searchExpanded && !this.data.keyword) {
      this.setData({ searchExpanded: false, searchMode: false });
    }
  },

  onPullDownRefresh() {
    this.reset().then(() => wx.stopPullDownRefresh());
  },

  // ==================== 录音（长按 🎙，松手带音频跳编辑页转写） ====================
  initRecorder() {
    const recorder = wx.getRecorderManager();
    this._recorder = recorder;

    // RecorderManager 的 onStop/onError 是「注册回调的方法」，必须调用而非赋值
    // （赋值的写法原生层不会回调，导致松手后既不收起录音状态也不跳转）
    recorder.onStop((res) => this.handleRecordStop(res));

    recorder.onError(() => {
      this.clearRecordTimer();
      this.setData({ recording: false, recordSeconds: 0 });
      wx.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
    });
  },

  /** 松手后：立即带录音文件跳编辑页，转写与解析在编辑页进行 */
  handleRecordStop(res) {
    this.clearRecordTimer();
    const seconds = this.data.recordSeconds;
    const filePath = (res && res.tempFilePath) || "";
    this.setData({ recording: false, recordSeconds: 0 });
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

  // ==================== 底部录音按钮：按住录音，松开发送 ====================
  onMicStart() {
    if (this.data.recording) return;
    this._down = true;
    this.beginRecord();
  },

  onMicEnd() {
    this._down = false;
    if (this.data.recording) this.stopRecord();
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
    this.setData({ recording: true, recordSeconds: 0 });
    this.clearRecordTimer();
    this._recordTimer = setInterval(() => {
      const s = this.data.recordSeconds + 1;
      this.setData({ recordSeconds: s });
      if (s >= 60) this.stopRecord(); // 60s 上限自动收
    }, 1000);
    // RecorderManager：mp3 体积小、SenseVoice 直接支持
    this._recorder.start({
      duration: 60000,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
    });
  },

  stopRecord() {
    this.clearRecordTimer();
    if (this.data.recording && this._recorder) {
      this._recorder.stop(); // 触发 onStop → handleRecordStop
    } else {
      this.setData({ recording: false, recordSeconds: 0 });
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
    if (!this.data.searchMode && this.data.hasMore && !this.data.loading) {
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
      score: item.score,
    };
  },

  /** 由 entries 重建按月分组：月份间插入分割标题，日内卡片直接顺排（日期由卡片右上角时间展示） */
  buildGroups(entries) {
    const groups = [];
    entries.forEach((entry) => {
      const day = dayKey(entry.time);
      const month = day.slice(0, 7);
      const label =
        month === "未知日期"
          ? month
          : `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
      const last = groups[groups.length - 1];
      // 用 Object.assign 而非对象展开 { ...entry }：展开会被增强编译转成
      // require('@swc/runtime/...') helper，工具端 runtime 缺失时整页注册失败
      const row = Object.assign({}, entry, {
        first: !(last && last.month === month),
      });
      if (last && last.month === month) {
        last.items.push(row);
      } else {
        groups.push({ month, label, items: [row] });
      }
    });
    return groups;
  },

  /** 加载下一页（游标模式） */
  async loadMore() {
    if (this.data.searchMode) return;
    const version = this._version;
    try {
      this.setData({ loading: true });
      const params = { page: 1, pageSize: PAGE_SIZE };
      if (this._cursor != null) {
        params.beforeId = this._cursor;
        // 游标翻页时本列表只用 items.length 判有没有下一页，
        // 让后端跳过带可见性子句的 COUNT(*)（突发时这一句最贵）
        params.withTotal = 0;
      }
      const { code, data } = await api.event.page(params);
      if (version !== this._version) return; // 已被新的 reset/搜索覆盖，丢弃过期结果
      if (Number(code) === 200 && data) {
        const items = (data.items || []).map(this.fromListItem);
        const merged = this.mergeUnique(this.data.entries, items);
        if (items.length) {
          const minId = Math.min(...items.map((e) => Number(e.id)));
          if (Number.isFinite(minId)) this._cursor = minId;
        }
        this.setData({
          entries: merged,
          groups: this.buildGroups(merged),
          hasMore: items.length >= PAGE_SIZE,
        });
      } else {
        this.setData({ hasMore: false });
      }
    } catch (err) {
      // 关键修正：服务繁忙/网络异常不等于「没有更多」。
      // 之前这里把 hasMore 永久置 false，一次限流就会让用户到底了。
      if (version === this._version) this._loadFailed = true;
    } finally {
      if (version === this._version) this.setData({ loading: false });
    }
  },

  /** 合并去重（按 id） */
  mergeUnique(prev, incoming) {
    const ids = new Set(prev.map((e) => String(e.id)));
    return [...prev, ...incoming.filter((e) => !ids.has(String(e.id)))];
  },

  /** 重置并重新加载时间线（loading 一起置 true，避免清列表后空态闪一下） */
  async reset() {
    this._version += 1;
    this._cursor = null;
    this._loadFailed = false;
    this.setData({
      entries: [],
      groups: [],
      hasMore: true,
      searchMode: false,
      loading: true,
    });
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
    if (this.data.entries.some((e) => String(e.id) === String(pending.id)))
      return;
    const merged = [pending, ...this.data.entries];
    this.setData({ entries: merged, groups: this.buildGroups(merged) });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    // 输入后 400ms 自动搜（清空则回到列表），避免每条关键字都靠用户点一下搜索重复发请求
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      const kw = (this.data.keyword || "").trim();
      if (kw) this.onSearch();
      else if (this.data.searchMode) this.onClear();
    }, 400);
  },

  /** 搜索（记忆混合检索）：防抖 + 禁止重复提交，避免突发时把 AI 接口点成一排并发 */
  async onSearch() {
    const q = (this.data.keyword || "").trim();
    if (!q) {
      this.setData({ searchMode: false });
      this.reset();
      return;
    }
    if (this._searching) return;
    this._searching = true;
    try {
      this.setData({ loading: true, searchMode: true });
      const { code, data } = await api.memory.search(q, 20);
      const list =
        Number(code) === 200 && data
          ? (data.list || []).map(this.fromMemoryItem)
          : [];
      this.setData({
        entries: list,
        groups: this.buildGroups(list),
        // 后端语义召回被限流时给出明确提示，而不是让用户以为「真的搜不到」
        semanticSkipped: !!(data && data.semanticSkipped),
      });
    } catch (err) {
      this.setData({ entries: [], groups: [] });
    } finally {
      this._searching = false;
      this.setData({ loading: false });
    }
  },

  onClear() {
    this.setData({ keyword: "", searchMode: false });
    this.reset();
  },

  // ==================== 搜索图标展开/收起 ====================
  expandSearch() {
    this.setData({ searchExpanded: true });
  },

  collapseSearch() {
    if (this.data.keyword) return;
    this.setData({ searchExpanded: false, searchMode: false });
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` });
  },

  goEdit() {
    wx.navigateTo({ url: "/pages/edit/edit" });
  },
});
