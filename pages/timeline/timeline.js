const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { dayKey } = require("../../utils/format");

const PAGE_SIZE = 10;

// 录音时长上限（秒）：面板提示、自动发送、recorder.duration 共用这一处定义
const RECORD_MAX = 60;
// 波形条数：纯 CSS 动画驱动，静态参数只在 onLoad 生成一次
const WAVE_BAR_COUNT = 18;
// 左侧取消区宽 176rpx + 24rpx 容差（与 .sheet-cancel 宽度对齐）
const CANCEL_ZONE_RPX = 200;
// 面板回缩过渡时长（ms），需与 .record-sheet 的 transition 时长一致
const SHEET_ANIM_MS = 320;
// 挂载与展开之间隔一帧：同一批 setData 里就带上 .open 的话，圆→方的过渡会被直接跳过
const SHEET_FRAME_MS = 40;
// 面板底句提示：提到常量里，不在 WXML 里拼长串中文
const HINT_SEND = `松开发送 · 左滑 ✕ 取消 · 最长 ${RECORD_MAX} 秒`;
const HINT_CANCEL = "松开手指，取消本次录音";

/** 取触点横坐标：touchend 时 touches 已空，需回落 changedTouches；都拿不到返回 -1 */
function touchX(e) {
  const touches = e && e.touches && e.touches.length ? e.touches : null;
  const list = touches || (e && e.changedTouches) || [];
  const t = list[0];
  return t && typeof t.clientX === "number" ? t.clientX : -1;
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
    entries: [],
    groups: [],
    loading: false,
    hasMore: true,
    keyword: "",
    searchMode: false,
    searchExpanded: false,
    // 后端语义召回被并发闸门拒时置 true（列表仍能给出关键词结果，只用来提示质量下降）
    semanticSkipped: false,
    // 录音面板：sheetVisible 管节点挂载，recording 管「圆 → 底部方形」的展开态
    sheetVisible: false,
    recording: false,
    // 手指是否滑进了最左侧的 ✕ 取消区
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

  // 游标：已加载部分里时间最旧那条的 event_id（存实例上，不进 data）
  _cursor: null,
  _version: 0, // 列表版本号，用于丢弃过期的异步结果
  _scopeMine: null, // 列表是在哪个「只看自己」范围下取的，范围变了要重拉
  _loadFailed: false, // 上次加载是否被限流/网络错误打断（不打断 hasMore 语义）
  _searching: false, // 搜索单飞，避免连续点击变成多个并发 AI 请求
  _searchTimer: null,
  _recorder: null, // wx RecorderManager
  _recordTimer: null,
  _down: false, // 手指是否按住录音键（防授权返回时已松手仍启动录音）
  _started: false, // recorder.start 是否真的跑起来了（松手时决定要不要调 stop）
  _cancelRequested: false, // 左滑取消标记：onStop 据此丢弃音频、不上传不跳转
  _sheetTimer: null, // 面板回缩播完再卸载节点
  _pressAt: 0, // 本次按下时刻，用来识别「只是点了一下」
  _winW: 375, // 视口宽（px），面板几何与取消区阈值共用
  _winH: 667, // 视口高（px）

  onLoad() {
    this._cursor = null;
    this._loaded = false;
    this._loadFailed = false;
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
    // 首次进入时 _loaded 还是 false，交给下面的分支判定，这里只认「已经取过一次数据」
    const scopeChanged = this._loaded && this._scopeMine !== auth.getOnlyMine();
    // 新增/保存/删除后回到列表，或「只看自己日志」范围被切过：
    // 两种情况下手上的数据都是另一种口径，必须重拉，否则看到的仍是旧快照
    const app = getApp();
    if (scopeChanged || (app.globalData && app.globalData.timelineDirty)) {
      if (app.globalData) app.globalData.timelineDirty = false;
      this._loaded = true;
      // 范围变了，搜出来的结果同样不属于当前范围：连关键词一起清掉
      if (scopeChanged) this.setData({ keyword: "" });
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

  onUnload() {
    this.clearRecordTimer();
    if (this._sheetTimer) clearTimeout(this._sheetTimer);
  },

  // ==================== 录音（长按 🎙 展开面板，松手带音频跳编辑页转写） ====================
  initRecorder() {
    const recorder = wx.getRecorderManager();
    this._recorder = recorder;

    // RecorderManager 的 onStop/onError 是「注册回调的方法」，必须调用而非赋值
    // （赋值的写法原生层不会回调，导致松手后既不收起录音状态也不跳转）
    recorder.onStop((res) => this.handleRecordStop(res));

    recorder.onError(() => {
      this._started = false;
      this._cancelRequested = false;
      this.clearRecordTimer();
      this.closeSheet();
      wx.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
    });
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

  /**
   * 面板两态几何（一律算成 px）：直接在 WXSS 里用 rpx ↔ vh 做过渡，
   * 跨单位值不一定能插值，「圆逐渐扩大成方形」会退化成瞬移
   */
  buildSheetStyles() {
    const w = this._winW;
    const h = this._winH;
    const fab = this.rpx(100); // 与 .fab 同尺寸
    // 展开高：约 1/3 屏，但不低于内容所需高度（波形 + 时长 + 提示）
    const sheetH = Math.round(Math.max(h * 0.34, this.rpx(430)));
    const radius = Math.round(this.rpx(32));
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
    this._started = false;
    this.clearRecordTimer();
    const seconds = this.data.recordSeconds;
    const filePath = (res && res.tempFilePath) || "";
    const canceled = this._cancelRequested;
    this._cancelRequested = false;
    this.closeSheet();
    if (canceled) {
      // 左滑取消：临时文件不上传也不调转写接口，交给微信自行回收
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

  // ==================== 底部录音按钮：按住展开面板，松手发送，左滑 ✕ 取消 ====================
  onMicStart() {
    // 面板还在（上一轮回缩动画未播完）时忽略重复按下
    if (this.data.sheetVisible) return;
    this._down = true;
    this._cancelRequested = false;
    this._pressAt = Date.now();
    this.beginRecord();
  },

  /**
   * 手指左右滑动：只按横坐标判定是否滑进了最左侧取消区。
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

  /** 左滑到 ✕ 后松手：仍要 stop 让原生层释放麦克风，只是结果直接丢弃 */
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

  /** 取消区命中判定：整条左侧竖带都算，只看横坐标（手指左滑时高度基本不变） */
  hitCancelZone(e) {
    if (!this.data.sheetVisible) return false;
    const x = touchX(e);
    return x >= 0 && x <= this.cancelHitPx();
  },

  /** 取消区右边界（px）：每次现算，视口变了也不会拿到过期阈值 */
  cancelHitPx() {
    return Math.round(this.rpx(CANCEL_ZONE_RPX));
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
      firstUrl: item.firstUrl || "",
      // 归属作者：列表混进同组织的他人日志时，卡片底栏地址前会标出是谁写的；
      // 自己的日志（is_mine）留空串，卡片据此不显示这个名字
      author: item.is_mine ? "" : item.author || "",
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
          // 游标取「本页最后一条」而不是本页最小 id：后端按 event_time 倒序返回，
          // 最后一条就是本页时间最旧的锚点。取 min(id) 会让「id 大但时间是补记的旧日期」
          // 那条日志被 beforeId 直接跳过，翻页永远看不到它。
          const lastId = Number(items[items.length - 1].id);
          if (Number.isFinite(lastId)) this._cursor = lastId;
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
    // 记住本次加载的范围，供 onShow 判断切过开关没有
    this._scopeMine = auth.getOnlyMine();
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
