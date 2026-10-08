const api = require("../../utils/api");
const auth = require("../../utils/auth");
const audioHub = require("../../utils/audioHub");
const { dayKey } = require("../../utils/format");

const PAGE_SIZE = 10;

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
    entries: [],
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

  // 游标：已加载部分里时间最旧那条的 event_id（存实例上，不进 data）
  _cursor: null,
  _version: 0, // 列表版本号，用于丢弃过期的异步结果
  _loadFailed: false, // 上次加载是否被限流/网络错误打断（不打断 hasMore 语义）
  _searching: false, // 搜索单飞，避免连续点击变成多个并发 AI 请求
  _searchTimer: null,
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
      (!this.data.searchMode && !this.data.entries.length && !this.data.loading)
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

  /** 顶部轻提示：显示一句文字，1.2s 后自动收起（wx.showToast 不能自定义位置，故用固定视图） */
  showHint(text) {
    this.setData({ hintText: text });
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this._hintTimer = null;
      this.setData({ hintText: "" });
    }, 1200);
  },

  /** 列表滑动时收起搜索框（已输入关键词时不打断浏览搜索结果） */
  onPageScroll() {
    if (this.data.searchExpanded && !this.data.keyword) {
      this.collapseSearchBox();
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
  },

  // ==================== 录音（长按话筒按钮展开面板，松手带音频跳编辑页转写） ====================
  initRecorder() {
    const recorder = wx.getRecorderManager();
    this._recorder = recorder;

    // RecorderManager 的 onStop/onError 是「注册回调的方法」，必须调用而非赋值
    // （赋值的写法原生层不会回调，导致松手后既不收起录音状态也不跳转）
    recorder.onStop((res) => this.handleRecordStop(res));

    recorder.onError(() => {
      // 不是本页这一轮（编辑页重录报的错）就别接手，免得把本页面板与录音态搅乱
      if (!this._recExpect && !this._started) return;
      this._recExpect = false;
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
      // withPins=1：让后端把自己置顶那几条单独放在 pinned 里带回来（同时已从 items 剔掉，
      // 不会翻页翻到重复卡片）；只有日志页带这个参数，Web 表格与导出不受影响
      const params = { page: 1, pageSize: PAGE_SIZE, withPins: 1 };
      if (this._cursor != null) {
        params.beforeId = this._cursor;
        // 游标翻页时本列表只用 items.length 判有没有下一页，
        // 让后端跳过带可见性子句的 COUNT(*)（突发时这一句最贵）
        params.withTotal = 0;
      }
      const { code, data } = await api.event.page(
        params,
        auth.getFilterScope(),
      );
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
        // 置顶那几条每页都会原样带回（就三条，不占流量），直接整组覆盖：
        // 接不到 pinned 字段（旧版后端）时保留本地已有那组，不要把置顶区抹空
        const pinnedItems = Array.isArray(data.pinned)
          ? data.pinned.map(this.fromListItem)
          : this.data.pinnedEntries;
        this.setData({
          entries: merged,
          groups: this.buildGroups(merged),
          pinnedEntries: pinnedItems,
          hasMore: items.length >= PAGE_SIZE,
        });
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
    // 取消未触发的搜索防抖：既然要回到全量列表，就别让上一条待发的关键词又冒出来搜一遍
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this.setData({
      entries: [],
      groups: [],
      pinnedEntries: [],
      hasMore: true,
      searchMode: false,
      // 回到纯列表就清掉搜索框里的残留词：否则会出现「框里还写着关键词、
      // 列表却已经是全量」的错位（下拉刷新 / 切范围 / 编辑后重进都会触发）
      keyword: "",
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
    // 本地这条必是本人刚写的，补上 isMine：后端第一页回来前它已经在列表里，
    // 否则刚存的那条会先不出竖条，拉到数据后再闪一下
    const merged = [
      Object.assign({}, pending, { isMine: true }),
      ...this.data.entries,
    ];
    this.setData({ entries: merged, groups: this.buildGroups(merged) });
  },

  // ==================== 长按卡片：置顶 / 取消置顶 / 编辑 / 删除 ====================

  /** 按 id 找那条卡片：置顶区里的几条不在 entries（后端已从时间序流里剔掉），必须两个数组都查 */
  findEntry(id) {
    const key = String(id);
    return (
      (this.data.pinnedEntries || []).find((e) => String(e.id) === key) ||
      this.data.entries.find((e) => String(e.id) === key) ||
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
    const rest = this.data.entries.filter((e) => String(e.id) !== key);
    if (want) {
      // 用 Object.assign 而非对象展开：展开会被增强编译转成 @swc/runtime helper（同 buildGroups）
      const nextPinned = [Object.assign({}, entry, { pinned: true })].concat(
        pinned,
      );
      this.setData({
        pinnedEntries: nextPinned,
        entries: rest,
        groups: this.buildGroups(rest),
      });
      return;
    }
    const next = this.insertByTime(
      rest,
      Object.assign({}, entry, { pinned: false }),
    );
    this.setData({
      pinnedEntries: pinned,
      entries: next,
      groups: this.buildGroups(next),
    });
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
        const rest = this.data.entries.filter((e) => String(e.id) !== key);
        this.setData({
          entries: rest,
          groups: this.buildGroups(rest),
          pinnedEntries: pinned,
        });
        this.showHint("已删除");
      },
    });
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
      this.setData({
        entries: list,
        groups: this.buildGroups(list),
        // 后端语义召回被限流时给出明确提示，而不是让用户以为「真的搜不到」
        semanticSkipped: !!(data && data.semanticSkipped),
      });
    } catch (err) {
      if (version !== this._version) return;
      this.setData({ entries: [], groups: [] });
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
    this.setData({ searchExpanded: true });
  },

  collapseSearch() {
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
