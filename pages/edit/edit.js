const api = require("../../utils/api");
const auth = require("../../utils/auth");
const audioHub = require("../../utils/audioHub");
const subscribe = require("../../utils/subscribe");
const { resolveFileUrl, nowDateTime } = require("../../utils/format");
const { SUPPORTED_EXT_RE, inspectImage } = require("../../utils/imageFormat");
// 分类/评价候选与存档页筛选抽屉共用一份（为何不能各写一份见 utils/options.js）；
// 页内沿用原名：picker 的 range 与 typeIndex/ratingIndex 换算都按下标走
const { TYPE_OPTIONS, RATING_OPTIONS } = require("../../utils/options");
const typeOptions = TYPE_OPTIONS;
const ratingOptions = RATING_OPTIONS;
const visibilityOptions = ["仅自己可见", "组织可见"];

// 与后端 .env 的 MAX_UPLOAD_MB 默认值对齐：超上限在本地就挡下，省一趟注定失败的上传
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
// 与后端 IMAGE_MAX_LONG_SIDE 的默认值（2560）对齐：超过这条线后端反正要降采样，
// 端上先压一遍能把上传体量砍到几分之一（4000px 原图 5MB → 2560px 约 400KB），
// 后端 sharp 仍按 q88 转 webp 兜底，所以这里 quality 取 85 不会有可见损失
const UPLOAD_MAX_LONG_SIDE = 2560;
const UPLOAD_JPEG_QUALITY = 85;
// 尺寸没超但体积依然大的（长截图、高码率原图）也压一下
const UPLOAD_COMPRESS_IF_BYTES = 1.5 * 1024 * 1024;
// 并发上传数：9 张串行要叠 9 个往返；3 路既能把等待压到 1/3，
// 又不会在弱网下把上行带宽一次占满（上传本就是最占带宽的动作）
const UPLOAD_CONCURRENCY = 3;
// 页内重录的时长上限（秒）：与首页按住录音一致，到点自动收（走结束上传路径）
const REC_MAX_SEC = 60;
// 输入框停笔多久把草稿写回 data（ms）：textarea 的 value 是绑定的，逐字符 setData
// 等于每键一次跨线程回灌 + 一次 auto-height 重排（正文框 maxlength 4000）
const INPUT_FLUSH_MS = 300;
// multer 按「上传文件名的扩展名」校验，会话文件常常没有后缀，得先补一个合法后缀再传；
// 能不能传交 utils/imageFormat 按文件头魔数判定 —— HEIC 虽在扩展名白名单里，但 sharp
// 预编译包缺 HEVC 解码器，会变成一张小程序渲染不出来的裂图，属于无效上传，一并挡下

// 开发者工具与低版本微信可能没有 chooseMessageFile：拿不到就整条入口不显示，
// 免得用户点了只换来一句「不支持」
const CAN_PICK_CHAT = typeof wx.chooseMessageFile === "function";

/** 提醒重复规则的人读文案（回执卡那一行用，与提醒页同一口径） */
const REPEAT_TEXT = {
  none: "",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};
const UNIT_TEXT = { month: "个月", day: "天", hour: "小时", minute: "分钟" };

function remindRepeatText(draft) {
  if (draft.repeat === "custom") {
    return `每${draft.intervalValue}${UNIT_TEXT[draft.intervalUnit] || ""}`;
  }
  return REPEAT_TEXT[draft.repeat] || "";
}

/**
 * 'YYYY-MM-DD HH:mm' → 「今天 15:00」这种短句
 * 只在字符串空间里切：拿 Date 解服务器墙钟串会跟着本机时区漂移几个小时，
 * 而提醒时间本来就以服务器为准（与提醒页 prettyTime 同一做法）
 */
function prettyAt(at) {
  const day = String(at).slice(0, 10);
  const hm = String(at).slice(11, 16);
  if (day === nowDateTime().slice(0, 10)) return `今天 ${hm}`;
  return `${day.slice(5)} ${hm}`;
}

/**
 * 复制出一份带合法后缀的临时文件
 * @param {string} src - 会话文件的临时路径
 * @param {string} ext - 目标后缀（不含点）
 * @returns {Promise<string>} 成功返回新路径；失败返回空串，由调用方退回原路径试传
 */
function copyWithExt(src, ext) {
  if (
    typeof wx.getFileSystemManager !== "function" ||
    !wx.env ||
    !wx.env.USER_DATA_PATH
  ) {
    return Promise.resolve("");
  }
  const dest = `${wx.env.USER_DATA_PATH}/chat-${Date.now()}-${Math.floor(
    Math.random() * 1e6,
  )}.${ext}`;
  return new Promise((resolve) => {
    wx.getFileSystemManager().copyFile({
      srcPath: src,
      filePath: dest,
      success: () => resolve(dest),
      fail: () => resolve(""),
    });
  });
}

/** 删临时副本：USER_DATA_PATH 只有 200MB 额度，用完必须还回去 */
function removeTmpFile(p) {
  if (!p || typeof wx.getFileSystemManager !== "function") return;
  try {
    wx.getFileSystemManager().unlinkFileSync(p);
  } catch (e) {
    /* 已经不在了，正合意 */
  }
}

/** 读图片宽高：失败返回 null，调用方按原图继续（压缩是优化，不是必经步骤） */
function imageSizeOf(path) {
  if (typeof wx.getImageInfo !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: path,
      success: (res) =>
        resolve({
          width: Number(res.width) || 0,
          height: Number(res.height) || 0,
        }),
      fail: () => resolve(null),
    });
  });
}

/**
 * 上传前压缩：长边超后端封顶线、或体积偏大的 JPEG 先压一遍。
 *
 * 只处理 jpg/jpeg —— png 可能带透明通道，webp 本身已是压缩格式，压了只掉画质不省空间。
 * 任何一步拿不到结果都返回空串，调用方退回原图：压缩是加速手段，绝不能成为丢图的理由。
 * @param {string} src 本地临时路径
 * @param {string} ext 魔数/后缀判定出的格式
 * @param {number} size 原始体积（字节，可能拿不到）
 * @returns {Promise<string>} 压缩后的临时路径；不需要压或失败返回 ""
 */
async function compressForUpload(src, ext, size) {
  if (!src || typeof wx.compressImage !== "function") return "";
  const kind = String(ext || "").toLowerCase();
  if (kind !== "jpg" && kind !== "jpeg") return "";
  const info = await imageSizeOf(src);
  if (!info || !info.width || !info.height) return "";
  const longSide = Math.max(info.width, info.height);
  const overSize = Number(size) > UPLOAD_COMPRESS_IF_BYTES;
  if (longSide <= UPLOAD_MAX_LONG_SIDE && !overSize) return "";

  const opts = { src, quality: UPLOAD_JPEG_QUALITY };
  // 尺寸参数要基础库 2.26.0+；低版本只降质量也能省一截，不能因此让整条链路走不通
  if (
    longSide > UPLOAD_MAX_LONG_SIDE &&
    typeof wx.canIUse === "function" &&
    wx.canIUse("compressImage.object.compressedWidth")
  ) {
    if (info.width >= info.height) {
      opts.compressedWidth = UPLOAD_MAX_LONG_SIDE;
      opts.compressedHeight = Math.max(
        1,
        Math.round((info.height * UPLOAD_MAX_LONG_SIDE) / info.width),
      );
    } else {
      opts.compressedHeight = UPLOAD_MAX_LONG_SIDE;
      opts.compressedWidth = Math.max(
        1,
        Math.round((info.width * UPLOAD_MAX_LONG_SIDE) / info.height),
      );
    }
  }
  return new Promise((resolve) => {
    // 不用对象展开：会被增强编译转成 @swc/runtime helper（见 utils/api.js 注释）
    wx.compressImage(
      Object.assign({}, opts, {
        success: (res) => resolve((res && res.tempFilePath) || ""),
        fail: () => resolve(""),
      }),
    );
  });
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    id: "",
    date: "",
    timeStr: "",
    event: "",
    typeOptions,
    typeIndex: -1,
    type: "",
    content: "",
    ratingOptions,
    ratingIndex: -1,
    rating: "",
    experience: "",
    location: { position: "", address: "", lng: null, lat: null },
    witness: "",
    images: [],
    uploading: false,
    // 图片拖拽排序：长按某张图进入拖拽态，浮层跟手，越过其它格子时实时换位
    dragging: false,
    // 被拖图当前所在下标（随移动更新，-1 表示未拖拽）；下标即 sort，保存时按序落库
    dragIndex: -1,
    // 拖拽浮层的视口坐标（position: fixed，用 clientX/clientY 跟手）
    dragPos: { x: 0, y: 0 },
    // 浮层里定格显示的那张图，避免实时换位时浮层内容乱跳
    dragUrl: "",
    // 是否展示「从微信聊天选图」入口（基础库不支持时隐藏）
    canPickChat: CAN_PICK_CHAT,
    visibilityOptions,
    visibilityIndex: 0,
    orgOptions: [],
    submitting: false,
    // 录音信息（悬浮卡片）
    voice: null,
    voiceCollapsed: false,
    voiceStatus: "",
    // 识别失败的具体原因（额度不足/超时/未配置）：卡片正文整行展示，头部只放短句
    voiceReason: "",
    // 失败后给一个原地重试入口（录音临时文件还在，不必重录）
    voiceRetryable: false,
    // 识别结果已到手但还没写进表单（用户选了「只留录音」）：卡片上留一个「覆盖表单」给他反悔
    voiceApplyable: false,
    // 识别结果已经写进表单了（控制不重复问、也不重复显示覆盖入口）
    voiceApplied: false,
    // 语音里「只是在要求提醒」的那一类：直接建好了提醒，回执卡留在页内（null=没建或已撤销）
    remindDone: null,
    playing: false,
    // 随日志留存的录音（相对路径 + 时长秒），详情页据此回放
    audioUrl: "",
    audioDuration: null,
    // 本次编辑主动移除了原有录音（需传 null 告知后端清空）
    audioCleared: false,
    // 页内录音：点一下开录、再点结束（与图片的加/删对称）——卡片上已有录音时叫「重录」，没有时是「录一段」
    recording: false,
    recSeconds: 0,
  },

  _audio: null,
  // 页内重录用到的录音器。wx.getRecorderManager() 是「全局唯一单例」：首页与本页挂的是
  // 同一个对象，onStop/onError 是累加注册（多个回调都会响）、但可用 offStop/offError
  // 按引用逐个删。所以退出页面时必须摘干净，且回调里要靠 _recActive 认领「这段录音归谁」
  _recorder: null,
  _recTimer: null,
  _recStartAt: 0,
  // 本页正在录、且等着认领 onStop 结果的标记：移除/卸载时先置假，那段音频即作废
  _recActive: false,
  // 授权弹窗到真正 start 之间的异步窗口，拦住连点「重录」把录音器起两遍
  _recStarting: false,
  // 本页已经拿到过麦克风授权：下一轮起录就跳过 getSetting/authorize 那两趟往返
  // （录音器报错时会作废，权限被关也能下一轮重新走授权）
  _recAuthOk: false,
  // 开录前的 voiceStatus 快照：太短/报错退回路时恢复它，免得卡片卡在「录音中…」下不去
  _preRecStatus: "",
  // 挂到全局录音器上的回调引用（offStop/offError 按引用摘除才取得掉）
  _recStopHandler: null,
  _recErrorHandler: null,
  // 录音上传+转写进行中（此期间拦住保存，避免默默丢录音）
  _transcribing: false,
  // 每轮转写的序号：接口回来对不上号就说明这轮已被重录/移除/退出作废，结果不再写回页面
  _transcribeSeq: 0,
  // 最近一次成功的识别结果（{fields,text,degraded}）：弹窗里选了「只留录音」后，
  // 点「覆盖表单」还要拿它重写一遍，不必重跑转写接口
  _voiceParsed: null,
  // 选完图到真正起上传之间的那段把关进行中（读文件头是异步的，期间拦住再起一批）
  _checking: false,
  // 聊天选图补后缀产生的临时副本，上传完即删，onUnload 兜底再清一次
  _tmpFiles: [],
  // 拖拽开始时缓存的各图片格子矩形（页面坐标）：网格定宽 flex，槽位几何固定，
  // 换位只改内容不改位置，故缓存一次即可；用页面坐标以便拖拽中页面滚动仍判定准确
  _imgRects: [],
  // touchstart 记下的按下点（client 坐标），longpress 触发时取用给浮层定初始位
  _startPoint: null,
  // 文本输入草稿（key → 未落盘的值，见 onInput）：不进 data，避免逐字符跨线程
  _inputDraft: {},
  _inputTimer: null,

  async onLoad(options) {
    // 数组/对象放在 Page 选项上有跨实例共用风险，这里按页面实例各自建一份（先于登录判定，
    // 未登录时 onUnload 兜底清理才有正确的空数组可用）
    this._tmpFiles = [];
    this._imgRects = [];
    this._startPoint = null;
    this._inputDraft = {};
    this._inputTimer = null;
    if (!auth.checkLogin()) return;
    const [date, timeStr] = nowDateTime().split(" ");
    this.setData({ date, timeStr });
    // 记下进页时的默认时间：AI 解析出口径下「用户没动过」才允许覆盖（编辑旧日志时
    // loadDetail 会改成原时间，天然偏离此快照，不会被 AI 结果误盖）
    this._initDate = date;
    this._initTimeStr = timeStr;
    // 首页录音后经 globalData 中转过来（只带音频临时文件与时长，转写+解析在本页进行）
    const app = getApp();
    const pendingVoice = app.globalData && app.globalData._pendingVoice;
    if (pendingVoice && pendingVoice.tempFilePath) {
      app.globalData._pendingVoice = null;
      this.setData({
        voice: {
          tempFilePath: pendingVoice.tempFilePath,
          duration: pendingVoice.duration || 0,
          text: "",
        },
        voiceStatus: "识别中…",
      });
      this.initAudio(pendingVoice.tempFilePath);
      this.transcribeAndParse(pendingVoice.tempFilePath);
    }
    await this.loadOrgOptions();
    if (options.id) {
      wx.setNavigationBarTitle({ title: "编辑日志" });
      this.setData({ id: options.id });
      this.loadDetail(options.id);
    }
  },

  onUnload() {
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
    // 重录中途退出：先作废再拆监听，最后才 stop。顺序反了的话 stop 必然触发的
    // onStop 会把「用户已经不要的那段」传上后端并开始转写，还会往已卸载的页 setData
    this.clearRecTimer();
    this._transcribeSeq += 1; // 让在飞的转写结果落地时认不出归属，不再写回页面
    this.discardRecorder();
    // 还想落盘的输入草稿已无意义（页面没了），把定时器收掉就行
    if (this._inputTimer) clearTimeout(this._inputTimer);
    this._inputTimer = null;
    this._inputDraft = {};
    // 兜底：选完图还没传完就退出的话，副本会一直躺在本地目录里
    (this._tmpFiles || []).forEach(removeTmpFile);
    this._tmpFiles = [];
  },

  // ==================== 录音悬浮卡片 ====================
  /**
   * @param {string} src 本地临时录音路径（wxfile://）或服务器录音路径（/uploads/...）
   */
  initAudio(src) {
    if (!src) return;
    // 先拆掉上一个：重录后新旧两个 InnerAudioContext 并存，旧的那个还在发声，
    // 它的 onEnded 会把新录音的 playing 状态改掉（按钮显示与声音对不上）
    if (this._audio) {
      try {
        this._audio.destroy();
      } catch (err) {
        /* 忽略 */
      }
      this._audio = null;
    }
    const audio = audioHub.create();
    // 只有相对路径需要拼 BASE_URL；本地临时文件原样传给原生播放器
    audio.src = src.startsWith("/") ? resolveFileUrl(src) : src;
    audio.onEnded(() => this.setData({ playing: false }));
    audio.onStop(() => this.setData({ playing: false }));
    audio.onError(() => {
      this.setData({ playing: false });
      wx.showToast({ title: "录音文件已失效", icon: "none" });
    });
    this._audio = audio;
  },

  togglePlay() {
    if (!this._audio) {
      wx.showToast({ title: "录音文件已失效", icon: "none" });
      return;
    }
    if (this.data.playing) {
      this._audio.pause();
      this.setData({ playing: false });
    } else {
      this._audio.play();
      this.setData({ playing: true });
    }
  },

  /** 语音转写 + 录音留存：后端一次返回 {text, audioUrl, fields}，转写与 AI 解析均在服务端完成 */
  async transcribeAndParse(filePath) {
    const target =
      filePath || (this.data.voice && this.data.voice.tempFilePath);
    if (!target) {
      this.setData({
        voiceStatus: "录音文件已失效",
        voiceReason: "请重新录制",
      });
      return;
    }
    // 本轮领个号：接口回来后只对得上号才落地，否则「移除录音后旧请求才返回」
    // 会把刚删掉的那段又塞回卡片与 payload
    const seq = this._transcribeSeq + 1;
    this._transcribeSeq = seq;
    this._transcribing = true;
    // 新一轮转写先把上一张提醒回执收掉：否则页上会同时挂着「已建提醒」与「识别中」两张卡
    this.setData({
      voiceStatus: "识别中…",
      voiceReason: "",
      voiceRetryable: false,
      remindDone: null,
    });
    try {
      const { code, data, message } = await api.event.transcribe(target);
      if (seq !== this._transcribeSeq) return; // 已被重录/移除/退出作废
      if (Number(code) === 200 && data && data.audioUrl) {
        // 录音已落盘，记下路径与时长，保存日志时一并写入
        this.setData({
          audioUrl: data.audioUrl,
          audioCleared: false,
          audioDuration: this.data.voice
            ? Number(this.data.voice.duration) || null
            : null,
        });
        const text = data.text || "";
        if (!text) {
          // 后端把成因一并带回来（额度不足 / 超时 / 未配置 / 没听清），
          // 全归成一句“识别失败”会让用户反复重录，而真正的问题是不知情的账户问题
          this.setData({
            voiceStatus: "识别失败，可重试",
            voiceReason: data.failReason || "语音识别未返回文字，录音已保留",
            voiceRetryable: true,
          });
          return;
        }
        // 文字先摆上卡片（附复制入口），要不要盖掉已填的表单项等用户点头再说 ——
        // 录音可以随手重录，手打的正文被识别结果一口盖掉就真没了
        this.setData({
          "voice.text": text,
          voiceRetryable: false,
          voiceCollapsed: false,
          voiceApplyable: false,
          voiceApplied: false,
        });
        this._voiceParsed = {
          fields: data.fields || null,
          text,
          degraded: Boolean(data.degraded),
        };
        // 后端在同一轮转写里顺手判过意图：整句只是在「要求未来某时提醒我」时直接建提醒，
        // 不再把这句话塞进日志表单（建完不跳走：fields 仍在 _voiceParsed 里，想改成记一条不用重录）
        const remind = data.reminder;
        if (remind && remind.auto) {
          await this.createReminderFromVoice(remind, text);
          return;
        }
        // 认得出是提醒，但下面那三条本地判据没全部满足（多个时间、时间在过去）：照常填表，
        // 但要说清「为什么没自动建」，
        // 否则用户会当成「它怎么没提醒我」去反复重录
        const remindWhy = remind && remind.why ? remind.why : "";
        // 没碰到已有内容就直接填，碰到了就问一句（录音无论如何都已先留在卡片上）
        this.settleVoiceFields();
        if (remindWhy) {
          this.setData({
            voiceReason: `听着像提醒，但${remindWhy}，先按日志填表`,
          });
        }
      } else {
        this.setData({
          voiceStatus: "识别失败，可重试",
          voiceReason: message || "录音保存失败，可手动填写",
          voiceRetryable: true,
        });
      }
    } catch (err) {
      if (seq !== this._transcribeSeq) return;
      this.setData({
        voiceStatus: "上传失败，可重试",
        voiceReason: "录音没传上去（网络或服务异常），可点重试",
        voiceRetryable: true,
      });
    } finally {
      // 只有还是自己这一轮才解锁：被作废的那轮不该把新一轮的忙标志抹掉
      if (seq === this._transcribeSeq) this._transcribing = false;
    }
  },

  /** 识别失败后原地重试：本地录音临时文件还在，直接再跑一次转写，不要求用户重录 */
  retryTranscribe() {
    if (this._transcribing) return;
    const p = this.data.voice && this.data.voice.tempFilePath;
    if (!p) {
      wx.showToast({ title: "录音文件已失效，请重新录制", icon: "none" });
      return;
    }
    this.transcribeAndParse(p);
  },

  // ==================== 页内录音（点按开/停）+ 移除（与图片的加/删对称） ====================
  /** 懒建录音器：onStop 里带临时文件走「转写+解析」，与首页录音进编辑页同一套后端链路 */
  initRecorder() {
    if (this._recorder) return;
    const rec = wx.getRecorderManager();
    // 回调按引用挂上并存在实例上，discardRecorder 才取得掉；否则本页退出后
    // 这个闭包仍挂在录音单例上，首页每次停录都会多打一发本页的处理
    this._recStopHandler = (res) => this.handleReRecordStop(res);
    this._recErrorHandler = () => this.handleReRecordError();
    rec.onStop(this._recStopHandler);
    rec.onError(this._recErrorHandler);
    this._recorder = rec;
  },

  /**
   * 丢弃本页的录音会话：抹掉归属标记 → 摘本页监听 → 最后才 stop 释放麦克风。
   * 移除录音与退出页面都走这里：stop 一定会触发 onStop，标记不先抹掉的话，
   * 回调会把用户明确不要的那段重新塞回卡片并上传转写。
   */
  discardRecorder() {
    this._recActive = false;
    this._recStartAt = 0;
    const rec = this._recorder;
    if (!rec) return;
    try {
      if (this._recStopHandler && typeof rec.offStop === "function") {
        rec.offStop(this._recStopHandler);
      }
      if (this._recErrorHandler && typeof rec.offError === "function") {
        rec.offError(this._recErrorHandler);
      }
    } catch (err) {
      /* 低版本基础库没有 offXxx：靠 _recActive 标记也能让回调空转 */
    }
    this._recorder = null;
    this._recStopHandler = null;
    this._recErrorHandler = null;
    try {
      rec.stop();
    } catch (err) {
      /* 没在录就忽略 */
    }
  },

  /** 录音器报错：只处理本页自己那段，首页那一轮的错误不该搅乱本页卡片 */
  handleReRecordError() {
    if (!this._recActive && !this._recStarting && !this.data.recording) return;
    this._recActive = false;
    // 报错多半是麦克风被占或权限在设置里被关了：作废缓存，下一轮重新走授权
    this._recAuthOk = false;
    this.clearRecTimer();
    this._recStartAt = 0;
    this.setData({
      recording: false,
      recSeconds: 0,
      voiceStatus: this._preRecStatus || "",
    });
    wx.showToast({ title: "录音失败，请重试", icon: "none" });
  },

  /** 麦克风授权：与首页一致——被拒过就走设置页，再失败给一句提示 */
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

  /** 「重录」= 点一下开录、再点结束；结束即上传转写并替换当前录音（卡片上没录音时就是「录一段」） */
  async toggleReRecord() {
    if (this.data.recording) {
      this.stopReRecord();
      return;
    }
    // 授权弹窗还没回来、或 start 还没发出去：此时再点一次会把录音器起两遍（第二次直接进 onError）
    if (this._recStarting) return;
    // 上一段还在上传+转写：再起一轮会并发抢转写通道，先拦住
    if (this._transcribing) {
      wx.showToast({ title: "上一条录音处理中，请稍候", icon: "none" });
      return;
    }
    if (typeof wx.getRecorderManager !== "function") {
      wx.showToast({ title: "当前微信版本不支持录音", icon: "none" });
      return;
    }
    this.initRecorder();
    // 授权结果记在页面上：getSetting + authorize 是两趟 JSBridge 往返，而它们又正好卡在
    // 「原生从放音切到录音」前面，多等一趟就多一分顿感；同一页录第二遍就不必再问了
    let ok = this._recAuthOk;
    if (!ok) {
      this._recStarting = true;
      try {
        ok = await this.ensureRecordAuth();
      } finally {
        this._recStarting = false;
      }
      if (ok) this._recAuthOk = true;
    }
    if (!ok) {
      wx.showToast({ title: "需要麦克风权限才能录音", icon: "none" });
      return;
    }
    // 授权弹窗那一会里页面可能已经退了（discardRecorder 拆了监听），此时不能再 start
    if (!this._recorder) return;
    // 确定要起录了才静音：上面拦住回头的分支（含授权被拒）不该把用户正在听的东西弄停。
    // 正在放的旧录音不掐就会串进这段新录音里，连转写文字都会混进上一段的内容
    audioHub.stopAll();
    this._recActive = true; // 之后由 handleReRecordStop 认领并清零
    this._recStartAt = Date.now();
    // 记下开录前的状态文案：半秒太短/报错退回路时要能原样恢复，不然卡片顶着一句「录音中…」下不去
    this._preRecStatus = this.data.voiceStatus;
    this.setData({
      recording: true,
      recSeconds: 0,
      voiceStatus: "录音中…",
      voiceReason: "",
      voiceRetryable: false,
    });
    this.clearRecTimer();
    this._recTimer = setInterval(() => {
      const s = this.data.recSeconds + 1;
      this.setData({ recSeconds: s });
      if (s >= REC_MAX_SEC) this.stopReRecord(); // 上限自动收（走结束路径）
    }, 1000);
    // mp3 体积小、SenseVoice 直接支持（与首页录音参数一致）
    this._recorder.start({
      duration: REC_MAX_SEC * 1000,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
    });
  },

  /** 再点「停止」：停录音器触发 onStop，结果在 handleReRecordStop 里接住 */
  stopReRecord() {
    this.clearRecTimer();
    // 归属标记留给回调去清零，这里不能提前抹掉（抹了就是把刚录的那段当丢弃）：
    // 60s 到点原生层会自己 stop 并把标记消掉，计时器这一轮再打 stop 就是二次 stop，只会进 onError
    if (this._recActive && this._recorder) {
      this._recorder.stop();
      return;
    }
    this.setData({ recording: false, recSeconds: 0 });
  },

  /** 停录回调：本地先上卡片，再走转写+解析（成功即把 audioUrl 替换成新这段） */
  handleReRecordStop(res) {
    this.clearRecTimer();
    // 全局单例的 onStop 会打到所有挂过回调的页面：不是本页这段（已被移除/卸载，
    // 或是首页那一轮录的）就直接丢，不能往别的页的录音结果上抢话
    if (!this._recActive) return;
    this._recActive = false; // 结果已被认领，后面再来的 stop/onError 都不归本页管
    this.setData({ recording: false, recSeconds: 0 });
    const tempFilePath = (res && res.tempFilePath) || "";
    // 时长先算成毫秒再判太短：Math.round(500 / 1000) 正好进位成 1，半秒的杂音就靠这个
    // 进位躲过检查、把原录音替换掉了。另只有「res.duration 压根没给」才回落墙钟差（个别机型）
    const reported = res && typeof res.duration === "number";
    let ms = reported ? res.duration : 0;
    if (!reported && this._recStartAt) ms = Date.now() - this._recStartAt;
    this._recStartAt = 0;
    const sec = Math.round(ms / 1000);
    if (!tempFilePath || ms < 1000) {
      // 太短不算替换：卡片上仍是原来那段，audioUrl 跟着清就会把已有录音弄丢
      this.setData({ voiceStatus: this._preRecStatus || "" });
      wx.showToast({ title: "说话时间太短", icon: "none" });
      return;
    }
    const hadSaved = !!this.data.audioUrl;
    // 新一段的识别结果还没来，上一段“待覆盖”的结果先作废（不然点错能盖到错的文字上去）
    this._voiceParsed = null;
    this.setData({
      voice: { tempFilePath, duration: sec, text: "", saved: false },
      // 新这段还没落盘前，旧的 audioUrl 不能再算数：否则卡片播的是新的、保存写的是旧的
      audioUrl: "",
      audioDuration: null,
      // 原来那段是已存日志的录音 → 告知后端清空（旧文件随之排队回收）
      audioCleared: hadSaved,
      voiceCollapsed: false,
      voiceRetryable: false,
      voiceApplyable: false,
      voiceApplied: false,
      playing: false,
    });
    this.initAudio(tempFilePath);
    this.transcribeAndParse(tempFilePath);
  },

  clearRecTimer() {
    if (this._recTimer) {
      clearInterval(this._recTimer);
      this._recTimer = null;
    }
  },

  /** 移除当前录音：新日志只是丢掉没提交的录音；编辑旧日志置 audioCleared，保存时传 null 让后端清空并回收旧文件 */
  removeVoice() {
    const hadSaved = !!this.data.audioUrl;
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
    this.clearRecTimer();
    // 作废在飞的转写：不然接口回来后会把刚删的录音又重新挂上 audioUrl
    this._transcribeSeq += 1;
    this._transcribing = false;
    this._voiceParsed = null; // 待覆盖的识别结果跟着录音一起走
    // 正在重录时点移除：先 discardRecorder（抹归属标记 + 拆监听）再 stop，
    // 否则 stop 触发的 onStop 会把这段用户明确不要的音频塞回卡片并上传
    this.discardRecorder();
    this.setData({
      voice: null,
      audioUrl: "",
      audioDuration: null,
      // 原本挂着（已存或已上传待存的）录音才需主动告知后端清空
      audioCleared: hadSaved,
      voiceStatus: "",
      voiceReason: "",
      voiceRetryable: false,
      voiceApplyable: false,
      voiceApplied: false,
      playing: false,
      recording: false,
      recSeconds: 0,
    });
  },

  /**
   * 把识别结果摊成一张「要往哪些格子写什么」的清单，并标出哪些格子当前已经有值。
   * 已经有值的那些就是会被覆盖的项 —— 得先问过用户，不能静默盖。
   * 时间是个特例：进页就预填了当前时间，不能按「非空」判有没有值，
   * 只有仍是进页那份快照（用户没手改）才算空白可直填
   */
  planVoiceFields(fields, text) {
    const d = this.data;
    const items = [];
    const push = (label, patch, occupied) =>
      items.push({ label, patch, occupied });
    const f = fields || {};
    if (f.time) {
      const m = String(f.time).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
      if (m) {
        const untouched =
          d.date === this._initDate && d.timeStr === this._initTimeStr;
        push("时间", { date: m[1], timeStr: m[2] }, !untouched);
      }
    }
    if (f.event) push("事件", { event: f.event }, !!this.fieldOf("event"));
    if (f.type) {
      const i = typeOptions.indexOf(f.type);
      if (i >= 0)
        push("分类", { type: typeOptions[i], typeIndex: i }, d.typeIndex >= 0);
    }
    if (f.rating) {
      const ri = ratingOptions.indexOf(f.rating);
      if (ri >= 0)
        push(
          "评价",
          { rating: ratingOptions[ri], ratingIndex: ri },
          d.ratingIndex >= 0,
        );
    }
    if (f.experience)
      push(
        "经验教训",
        { experience: f.experience },
        !!this.fieldOf("experience"),
      );
    if (f.witness)
      push("见证者", { witness: f.witness }, !!this.fieldOf("witness"));
    if (f.position)
      push("地点", { "location.position": f.position }, !!d.location.position);
    // 识别原文本体也是一个可落表的项（正文），AI 没拆出字段时就只剩这一项
    if (text) push("正文", { content: text }, !!this.fieldOf("content"));
    return {
      items,
      blanks: items.filter((it) => !it.occupied),
      overrides: items.filter((it) => it.occupied),
    };
  },

  /** 按清单落表：fill 只写空白格（不问了直接填），override 全部重写（用户已点过确认） */
  writeVoiceFields(plan, mode) {
    const picked = mode === "override" ? plan.items : plan.blanks;
    const patch = {};
    const wrote = [];
    picked.forEach((it) => {
      Object.keys(it.patch).forEach((k) => {
        patch[k] = it.patch[k];
      });
      wrote.push(it.label);
    });
    if (Object.keys(patch).length) {
      // 程序化写入前先作废这些格子的输入草稿：不然后续停笔把旧草稿落盘会把 AI 结果盖回去
      this.discardInputDraft(Object.keys(patch));
      this.setData(patch);
    }
    return wrote;
  },

  /**
   * 识别完成后怎么落表：不碰已有内容就直填；要盖东西先问一句
   * 确认→直接重写表单；取消→只保留录音，但卡片上留一个「覆盖表单」入口给反悔
   */
  settleVoiceFields() {
    const parsed = this._voiceParsed;
    if (!parsed) return;
    const plan = this.planVoiceFields(parsed.fields, parsed.text);
    if (!plan.overrides.length) {
      const wrote = this.writeVoiceFields(plan, "fill");
      this.setData({
        voiceApplied: wrote.length > 0,
        voiceApplyable: false,
        voiceStatus: parsed.fields
          ? parsed.degraded
            ? "AI 未启用，已保留原文"
            : "AI 已解析并填表"
          : "未拆出字段，已把原文填进正文",
        voiceReason: parsed.fields
          ? parsed.degraded
            ? "文字已识别，但 AI 解析未启用（已把原文放进正文）"
            : ""
          : "AI 未能拆字段，可对照识别文字手动填，或点重试",
        voiceRetryable: !parsed.fields,
      });
      return;
    }
    const labels = plan.overrides.map((it) => it.label).join("、");
    this.setData({
      voiceStatus: "识别完成，待确认是否覆盖",
      voiceReason: `录音已保留；「${labels}」已有内容，要覆盖请点下面的「覆盖表单」`,
      voiceApplyable: true,
      voiceApplied: false,
      // 没拆出字段时重试还有意义（下一轮可能就拆出来了），拆出来了就不用重试
      voiceRetryable: !parsed.fields,
    });
    wx.showModal({
      title: "用识别结果覆盖表单？",
      content: `当前「${labels}」已有内容，覆盖会按识别结果重写这些项；只留录音则表单不动。`,
      confirmText: "覆盖表单",
      cancelText: "只留录音",
      success: (res) => {
        if (res && res.confirm) this.applyVoiceResult();
        else this.keepVoiceOnly();
      },
      // 弹窗本身出错（开发者工具偶发）不能把链路卡死：默认不动表单，留下可反悔的入口
      fail: () => this.keepVoiceOnly(),
    });
  },

  /** 把识别结果直接重写进表单项（弹窗确认、或事后点卡片上的「覆盖表单」都走这里） */
  applyVoiceResult() {
    const parsed = this._voiceParsed;
    if (!parsed) {
      wx.showToast({ title: "识别结果已失效", icon: "none" });
      return;
    }
    const wrote = this.writeVoiceFields(
      this.planVoiceFields(parsed.fields, parsed.text),
      "override",
    );
    this.setData({
      voiceApplyable: false,
      voiceApplied: true,
      voiceStatus: wrote.length
        ? `已覆盖：${wrote.join("、")}`
        : "已应用识别结果",
      voiceReason: "",
    });
  },

  /** 只保留录音：表单一个字不改，但留着覆盖入口让用户能反悔 */
  keepVoiceOnly() {
    this.setData({
      voiceApplyable: true,
      voiceApplied: false,
      voiceStatus: "只保留录音，未改动表单",
      voiceReason: "需要时可点下面的「覆盖表单」把识别结果写进去",
    });
  },

  // ==================== 语音直接建提醒（不建日志那一条岔路）====================

  /**
   * 语音识别出「只是一条提醒」时直接建
   *
   * 为什么建完不问一句：录这句就是为了省事，再点一下把省下的事又还回去了；
   * 所以换成「建完给一张可撤销的回执」。微信 toast 不带按钮，撤销只能做在卡片上。
   * 为什么渠道固定微信：邮件那一路要账号有邮箱或行上填地址，语音里没这句话；
   * 拿不准就退回那条「到点会提示补授权」的老路，比默默发到别处安全。
   */
  async createReminderFromVoice(draft, text) {
    const payload = {
      title: draft.title,
      time: draft.at,
      repeat: draft.repeat || "none",
      channel: "wx",
      // 原话留在备注里：事后看着一条「交报告」想不起是哪句语音建的，比没建还让人困扰
      remark: String(text || "").slice(0, 200),
    };
    if (draft.repeat === "custom") {
      payload.intervalValue = draft.intervalValue;
      payload.intervalUnit = draft.intervalUnit;
    }
    let res = null;
    try {
      res = await api.reminder.create(payload);
    } catch (err) {
      res = null;
    }
    if (!res || Number(res.code) !== 200) {
      // 建不成（时间已过/条数上限/登录态失效）不能把这句口述丢了：回落成填表
      this.setData({
        voiceStatus: "没能建成提醒，已回落填表",
        voiceReason: (res && res.message) || "建提醒失败，可手动填写",
        voiceRetryable: false,
      });
      this.settleVoiceFields();
      return;
    }

    // 额度不够不拦建提醒（建了总比不建好），但要把「到点可能收不到」说出来；
    // 订阅弹窗不能在这里自动弹：转写回来那一刻早已离开用户点击的窗口，真机直接会被拒
    let cfg = {};
    try {
      const cfgRes = await api.reminder.config();
      cfg = (cfgRes && cfgRes.data) || {};
    } catch (err) {
      cfg = {};
    }
    this._voiceCfg = cfg;
    const needAuth =
      !!cfg.templateId && Number(cfg.quota || 0) <= Number(cfg.pending || 0);

    this.setData({
      remindDone: {
        id: (res.data && res.data.id) || 0,
        title: draft.title,
        timeText: prettyAt(draft.at),
        repeatText: remindRepeatText(draft),
        needAuth,
        busy: false,
        tip:
          draft.note ||
          (needAuth
            ? "微信提醒次数用完了，点下面「补一次授权」才会推到手机"
            : ""),
      },
      voiceStatus: "已建成提醒，未改动表单",
      voiceReason: "",
      // 给一个反悔入口：想「既要提醒也要记一条」时点覆盖表单就行，不必重录
      voiceApplyable: true,
      voiceApplied: false,
    });
    wx.showToast({ title: "已建提醒", icon: "success" });
  },

  /**
   * 回执卡上的「补一次授权」
   * 必须由这一下点击现调 subscribe.addSubscribeQuota（与提醒页 onSave 同一做法），
   * 额度到账后后端会把因没额度而挂起来的提醒重新放回队列
   */
  async onAuthorizeFromVoice() {
    const done = this.data.remindDone;
    if (!done || done.busy) return;
    const tmplId = (this._voiceCfg || {}).templateId || "";
    if (!tmplId) {
      this.setData({
        "remindDone.tip": "服务端未配置提醒模板，找服务端看一下",
      });
      return;
    }
    this.setData({ "remindDone.busy": true });
    const sub = await subscribe.addSubscribeQuota(tmplId, 1);
    this.setData({
      "remindDone.busy": false,
      "remindDone.needAuth": !sub.ok,
      "remindDone.tip": sub.ok
        ? `次数已到账（共 ${sub.quota} 次），到点会推`
        : sub.reason || "没拿到授权，到点推不到",
    });
    // 额度攒到了但账号没绑 openid，等于「有钱没地址」，得单独递一句
    if (sub.ok && sub.needBind) {
      this.setData({
        "remindDone.tip":
          "次数到账了，但这个账号还没绑微信，去「我的」里绑一下",
      });
    }
  },

  /** 撤销刚才那句语音建的提醒（直接剔行：反正到点还没到，留一条不发的那条在列表里只是碍事）*/
  onUndoReminder() {
    const done = this.data.remindDone;
    if (!done || !done.id) return;
    wx.showModal({
      title: "撤销这条提醒",
      content: `确定删掉「${done.title}」？这是刚才那句语音建的，删掉后到点不会再推送。`,
      confirmText: "撤销",
      confirmColor: "#f5222d",
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await api.reminder.remove(done.id);
          if (Number(res.code) !== 200) {
            wx.showToast({ title: res.message || "撤销失败", icon: "none" });
            return;
          }
          // 回执收起，但表单一个字没动；覆盖入口留着，用户想改记一条仍然点得到
          this.setData({
            remindDone: null,
            voiceStatus: "提醒已撤销",
            voiceApplyable: true,
          });
          wx.showToast({ title: "已撤销", icon: "success" });
        } catch (err) {
          wx.showToast({ title: "网络异常，请重试", icon: "none" });
        }
      },
    });
  },

  goReminders() {
    wx.navigateTo({ url: "/pages/reminders/reminders" });
  },

  /** 复制识别出的文字：录的内容经常要捭到别处，先给一个能带走文本的出口 */
  copyVoiceText() {
    const text = this.data.voice && this.data.voice.text;
    if (!text) {
      wx.showToast({ title: "还没有识别文字", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "文字已复制", icon: "none" }),
      fail: () => wx.showToast({ title: "复制失败", icon: "none" }),
    });
  },

  toggleVoiceCollapsed() {
    this.setData({ voiceCollapsed: !this.data.voiceCollapsed });
  },

  async loadOrgOptions() {
    try {
      const { code, data } = await api.org.mine();
      if (Number(code) === 200) {
        const orgOptions = (data || [])
          .filter((o) => Number(o.my_status) === 1)
          .map((o) => ({ id: o.id, org_name: o.org_name, checked: false }));
        this.setData({ orgOptions });
      }
    } catch (err) {
      /* 忽略 */
    }
  },

  async loadDetail(id) {
    try {
      const { code, data } = await api.event.detail(id);
      if (Number(code) !== 200 || !data) return;
      const [date, timeStr] = (data.time || nowDateTime()).split(" ");
      const images = (data.images || []).map((img) => ({
        // key 供 wx:key 用：上传占位项与已存项共处一个数组，必须有稳定的唯一键
        key: `srv-${img.url}`,
        url: img.url,
        thumbUrl: img.thumbUrl || img.url,
        displayUrl: resolveFileUrl(img.thumbUrl || img.url),
      }));
      const visibilityIndex = Number(data.visibility) === 1 ? 1 : 0;
      const visibleOrgIds = data.visibleOrgIds || [];
      const orgOptions = this.data.orgOptions.map((o) =>
        Object.assign({}, o, { checked: visibleOrgIds.indexOf(o.id) !== -1 }),
      );
      // 服务端值要盖掉表单：先把还没落盘的输入草稿作废，
      // 否则用户刚敲的几个字会在 300ms 后把详情请求回来的原文盖掉
      this.discardInputDraft(["event", "content", "experience", "witness"]);
      this.setData({
        date,
        timeStr,
        event: data.event || "",
        type: data.type || "",
        typeIndex: typeOptions.indexOf(data.type),
        content: data.content || "",
        rating: data.rating || "",
        ratingIndex: ratingOptions.indexOf(data.rating),
        experience: data.experience || "",
        witness: data.witness || "",
        location: {
          position: data.position || "",
          address: data.address || "",
          lng: data.lng != null ? data.lng : null,
          lat: data.lat != null ? data.lat : null,
        },
        images,
        visibilityIndex,
        orgOptions,
        // 已有录音原样保留，否则保存时会被置空
        audioUrl: data.audioUrl || "",
        audioDuration: data.audioDuration || null,
      });
      // 已存录音也上卡片（回放/移除），但不覆盖刚录待转写的那一条
      if (data.audioUrl && !this.data.voice) {
        this.setData({
          voice: {
            url: resolveFileUrl(data.audioUrl),
            duration: Number(data.audioDuration) || 0,
            text: "",
            saved: true,
          },
          voiceStatus: "已附录音",
        });
        this.initAudio(data.audioUrl);
      }
    } catch (err) {
      /* 忽略 */
    }
  },

  onInput(e) {
    // 同 login.js：避开计算属性名，防止依赖 @swc/runtime/_define_property。
    // 但不能逐字符 setData：textarea 的 value 是绑定的，一敲一键就回灌一次内容、
    // 并让 auto-height 重新量一遍高度（正文框 4000 字），这是输入卡顿的主要来源。
    // 草稿先攒在实例上，停笔后一次落进 data；提交与「表单算不算已填」都先读草稿，不会漏字
    const key = e.currentTarget.dataset.key;
    this._inputDraft[key] = e.detail.value;
    if (this._inputTimer) clearTimeout(this._inputTimer);
    this._inputTimer = setTimeout(() => {
      this._inputTimer = null;
      this.flushInputs();
    }, INPUT_FLUSH_MS);
  },

  /** 把输入草稿一次性落进 data（与 data 已一致的不写，避免空转 setData） */
  flushInputs() {
    if (this._inputTimer) {
      clearTimeout(this._inputTimer);
      this._inputTimer = null;
    }
    const draft = this._inputDraft;
    const patch = {};
    Object.keys(draft).forEach((key) => {
      if (draft[key] !== this.data[key]) patch[key] = draft[key];
    });
    this._inputDraft = {};
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 读文本字段当前值：有还没落盘的草稿时以草稿为准（判「格子是否已填」不能看落后的 data） */
  fieldOf(key) {
    return Object.prototype.hasOwnProperty.call(this._inputDraft, key)
      ? this._inputDraft[key]
      : this.data[key];
  },

  /** 作废若干字段的草稿：程序化写表前调用，否则停笔那一刻旧草稿会把新值盖回去 */
  discardInputDraft(keys) {
    (keys || []).forEach((key) => {
      delete this._inputDraft[key];
    });
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ timeStr: e.detail.value });
  },

  onTypeChange(e) {
    const i = Number(e.detail.value);
    this.setData({ typeIndex: i, type: typeOptions[i] });
  },

  onRatingChange(e) {
    const i = Number(e.detail.value);
    this.setData({ ratingIndex: i, rating: ratingOptions[i] });
  },

  onVisibilityChange(e) {
    this.setData({ visibilityIndex: Number(e.detail.value) });
  },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          location: {
            position: res.name || res.address || "",
            address: res.address || "",
            lng: res.longitude,
            lat: res.latitude,
          },
        });
      },
      fail: () => {
        wx.showToast({ title: "未选择地点", icon: "none" });
      },
    });
  },

  clearLocation() {
    this.setData({
      location: { position: "", address: "", lng: null, lat: null },
    });
  },

  chooseImage() {
    // 上一批还没传完就再起一批，先结束的那批会把 uploading 提前抹掉
    if (this.data.uploading) return;
    const remaining = 9 - this.data.images.length;
    if (remaining <= 0) return;
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      // 传原图：微信的 compressed 会先把长边压到 1080 上下，放大看就糊了。
      // 尺寸与质量统一交给后端 sharp 封顶（长边 2560 / webp q88），
      // 超过 MAX_UPLOAD_MB 的原图会被后端挡下并提示，不会静默失败
      sizeType: ["original"],
      success: (res) =>
        this.pickAndUpload(
          (res.tempFiles || []).map((t) => ({
            path: t.tempFilePath,
            size: t.size,
          })),
        ),
    });
  },

  /**
   * 从微信会话（单聊/群聊/文件传输助手）里选图：wx.chooseMessageFile
   * 微信生态独有玩法：不要类目资质、不要后端配合，基础库 2.5.0+ 就有（本项目 3.x）。
   * 两个前置条件都不在代码里：
   * 1) 它属于隐私接口「收集你选中的文件」，需在 MP 后台「设置 - 服务内容声明 -
   *    用户隐私保护指引」里勾上并写清用途，否则调用直接报 errno 112（补充声明约 5 分钟生效）；
   *    app.json 的 requiredPrivateInfos 只管定位类接口，这里不需要加。
   * 2) 朋友圈本身读不到图，需先长按图片「发送给朋友」，再回这里从会话里选。
   */
  pickFromChat() {
    if (this.data.uploading) return;
    const remaining = 9 - this.data.images.length;
    if (remaining <= 0) return;
    wx.chooseMessageFile({
      count: remaining,
      // 只放图片进来，避开用户误选压缩包/文档后的一串报错
      type: "image",
      success: (res) => this.pickAndUpload(res.tempFiles || []),
      fail: (err) => {
        const msg = (err && err.errMsg) || "";
        // 用户自己退回不算失败，不弹 toast 打扰
        if (msg.indexOf("cancel") >= 0) return;
        if (Number(err && err.errno) === 112) {
          // 走到这里说明后台那项隐私声明还没勾上（或没等到生效）
          wx.showToast({
            title: "聊天文件未声明隐私项，暂不可选",
            icon: "none",
          });
          return;
        }
        wx.showToast({ title: "没能打开微信聊天文件", icon: "none" });
      },
    });
  },

  /**
   * 两条选图入口共用的把关：认格式 → 卡体积 → 补后缀，只把后端收得下的送进上传队列
   * @param {Array<{path:string,name?:string,size?:number}>} files 微信返回的临时文件
   */
  async pickAndUpload(files) {
    const list = (files || []).filter((f) => f && f.path);
    if (!list.length) return;
    // 判格式要异步读文件头，这段空窗里再点一次会起两批上传，先结束的那批会把
    // uploading 提前抹掉 —— 与 chooseImage 里那条注释是同一个坑，这里单独拦一道
    if (this._checking) return;
    this._checking = true;
    let rejected = [];
    let oversize = 0;
    const tasks = [];
    try {
      // 多张并发读比逐张等快一截
      const inspected = await Promise.all(list.map((f) => inspectImage(f)));
      const passed = [];
      list.forEach((f, i) => {
        const info = inspected[i];
        if (!info.ok) {
          rejected = rejected.concat([info]);
        } else if (Number(f.size) > MAX_UPLOAD_BYTES) {
          oversize += 1;
        } else {
          passed.push({
            path: f.path,
            ext: info.ext,
            size: Number(f.size) || 0,
          });
        }
      });
      // 压缩有意串行：一张 4000×3000 的图解码后位图就占约 48MB，多张同时解会直接把
      // 低端机的内存打满；它比传原图快得多，串行这一两秒是值得换的保险
      for (const p of passed) {
        // 先压再传：这一步把「传原图」的等待从分钟级压到十几秒（9 张 4000px 原图）
        const compressed = await compressForUpload(p.path, p.ext, p.size);
        const src = compressed || p.path;
        if (SUPPORTED_EXT_RE.test(src)) {
          // localPath 留给九宫格占位：压完的图先拿原图预览，用户能立刻看到自己选了哪几张
          tasks.push({ tempFilePath: src, localPath: p.path });
          continue;
        }
        // 会话里的图、个别安卓机型的相册临时名常常没后缀，multer 会按扩展名拒收，
        // 先复制一份按真实格式补上后缀（认不出来按 jpg 兜底）再传
        const tmpPath = await copyWithExt(src, p.ext || "jpg");
        if (tmpPath) {
          this._tmpFiles.push(tmpPath);
          tasks.push({ tempFilePath: tmpPath, localPath: p.path, tmpPath });
        } else {
          // 副本建不了（没文件管理器等）就把原路径交上去，成不成由后端判定，至少不静默丢图
          tasks.push({ tempFilePath: src, localPath: p.path });
        }
      }

      const tip = this.buildSkipTip(rejected, oversize);
      if (tasks.length) {
        // 还有图能传：一句 toast 报数就够，别拿弹窗打断上传
        if (tip) wx.showToast({ title: tip, icon: "none" });
        // uploadImages 开头同步立 uploading，与这里无空窗
        this.uploadImages(tasks);
        return;
      }
      // 一张都没过：把「为什么 + 怎么办」讲透，这段指引长到 toast 撑不住
      const labels = rejected.map((r) => r.label);
      if (labels.indexOf("HEIC") >= 0 || labels.indexOf("HEIF") >= 0) {
        wx.showModal({
          title: "图片格式不支持",
          content:
            "选的是 HEIC（iPhone 默认格式），后端转不了、小程序也显示不出来。" +
            "请在 iPhone「设置 - 相机 - 格式」里选「兼容性最佳」后重拍，或转成 JPG 再选。",
          showCancel: false,
          confirmText: "知道了",
        });
      } else if (tip) {
        wx.showToast({ title: tip, icon: "none" });
      }
    } catch (err) {
      /* 临时文件读不了：不默默丢图，说一句让用户重选 */
      wx.showToast({ title: "图片读取失败，请重试", icon: "none" });
    } finally {
      this._checking = false;
    }
  },

  /** 一句跳过提示：点名不支持的格式，超体积的另算 */
  buildSkipTip(rejected, oversize) {
    const parts = [];
    if (rejected.length) {
      const labels = Array.from(
        new Set(rejected.map((r) => r.label || "未知")),
      );
      parts.push(`${labels.join("/")} ${rejected.length} 张格式不支持`);
    }
    if (oversize) parts.push(`${oversize} 张超过 ${MAX_UPLOAD_MB}MB`);
    return parts.length ? parts.join("，") + "，已跳过" : "";
  },

  /**
   * 并发上传（最多 3 路），每张先以本地占位进九宫格、成功后原地换成服务器地址：
   * 1. 顺序稳定：占位一就位就不再移动，并发完成序不会打乱用户选图的次序（次序即 sort）；
   * 2. 即时反馈：选完立刻能看到图（本地临时路径可直渲），不必只盯一行「图片上传中…」；
   * 3. 失败即摘：被后端拒/网络断的格子直接移除，不留一张永远转圈的空图。
   */
  async uploadImages(files) {
    if (!files.length) return;
    this.setData({ uploading: true });
    const stamp = Date.now();
    const placeholders = files.map((f, i) => ({
      key: `up-${stamp}-${i}`,
      pending: true,
      url: "",
      thumbUrl: "",
      displayUrl: f.localPath || f.tempFilePath,
    }));
    this.setData({ images: this.data.images.concat(placeholders) });

    // 按 key 定位而不是按下标：上传途中用户可能删掉前面某张，下标会漂
    const replaceOne = (key, img) => {
      const images = this.data.images.slice();
      const idx = images.findIndex((x) => x && x.key === key);
      if (idx < 0) return; // 这张已被用户移除：结果丢弃（服务端文件由清理任务回收）
      images[idx] = img;
      this.setData({ images });
    };
    const dropOne = (key) => {
      this.setData({
        images: this.data.images.filter((x) => !(x && x.key === key)),
      });
    };

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= files.length) return;
        const f = files[i];
        const key = placeholders[i].key;
        try {
          const { code, data } = await api.event.uploadImage(f.tempFilePath);
          if (Number(code) === 200 && data && data.url) {
            replaceOne(key, {
              key: `srv-${data.url}`,
              url: data.url,
              thumbUrl: data.thumbUrl || data.url,
              displayUrl: resolveFileUrl(data.thumbUrl || data.url),
            });
          } else {
            // 业务失败（体积/格式被后端拒）request 已提示：摘掉占位
            dropOne(key);
          }
        } catch (err) {
          // 网络异常同样已提示，继续下一张
          dropOne(key);
        } finally {
          // 补后缀用的副本传完就删（失败也删，重试时会重新选）
          if (f.tmpPath) {
            removeTmpFile(f.tmpPath);
            this._tmpFiles = this._tmpFiles.filter((p) => p !== f.tmpPath);
          }
        }
      }
    };
    const lanes = Math.min(UPLOAD_CONCURRENCY, files.length);
    const runners = [];
    for (let i = 0; i < lanes; i += 1) runners.push(worker());
    try {
      await Promise.all(runners);
    } finally {
      this.setData({ uploading: false });
    }
  },

  removeImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  previewImage(e) {
    if (this.data.dragging) return; // 拖拽落指时可能误带一次 tap，忽略
    const index = e.currentTarget.dataset.index;
    // 九宫格里用的是缩略图（省流量），点开大图必须换成原图地址，否则 300px 放大到全屏会糊；
    // 还在上传的占位项没有服务器地址，直接拿本地临时文件预览（长度与 images 对齐）
    const urls = this.data.images.map((i) =>
      i && i.pending
        ? i.displayUrl
        : resolveFileUrl((i && (i.url || i.thumbUrl)) || ""),
    );
    wx.previewImage({ current: urls[index], urls });
  },

  // ==================== 图片拖拽排序 ====================
  /** 记下按下点：longpress 触发时用它给浮层定初始位（touchmove 之前先要有个落点） */
  onImgTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (t) this._startPoint = { x: t.clientX, y: t.clientY };
  },

  /** 长按某张图进入拖拽态：查一次各格子位置（页面坐标）缓存，浮层定格这张图 */
  onImgLongPress(e) {
    if (this.data.uploading || this.data.dragging) return;
    const index = e.currentTarget.dataset.index;
    const img = this.data.images[index];
    // 还挂着占位（正在上传）的那格没有服务器地址，拖了也没法落库
    if (!img || img.pending) return;
    const q = wx.createSelectorQuery();
    q.selectAll(".img-cell").boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const rects = res && res[0];
      if (!rects || !rects.length) return;
      const scrollTop = (res[1] && res[1].scrollTop) || 0;
      // 存成页面坐标：拖拽中页面若滚动，client 坐标会变而页面坐标不变，命中判定才稳
      this._imgRects = rects.map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top + scrollTop,
        bottom: r.bottom + scrollTop,
      }));
      const p = this._startPoint || { x: 0, y: 0 };
      this.setData({
        dragging: true,
        dragIndex: index,
        dragUrl: img.displayUrl,
        dragPos: { x: p.x, y: p.y },
      });
      try {
        wx.vibrateShort({ type: "medium" });
      } catch (err) {
        /* 部分机型/开发者工具不支持震动，忽略 */
      }
    });
  },

  /**
   * 拖拽中移动：越过别的格子就把被拖图实时挪到该格（下标即 sort）。
   * 浮层的跟手位移由 WXS 在渲染层直接改（见 drag.wxs），这里只做命中判定 ——
   * 只有真的换位时才 setData，原来每帧回传一次坐标是这条拖拽最贵的开销。
   */
  onGridTouchMove(e) {
    if (!this.data.dragging) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const target = this.hitImageSlot(t.pageX, t.pageY);
    if (target < 0 || target === this.data.dragIndex) return;
    const images = this.data.images.slice();
    const moved = images.splice(this.data.dragIndex, 1)[0];
    images.splice(target, 0, moved);
    this.setData({ images, dragIndex: target });
  },

  /** 命中判定：手指（页面坐标）落在哪个格子；落在网格纵向范围外则就近夹到首/尾 */
  hitImageSlot(px, py) {
    const rects = this._imgRects || [];
    if (!rects.length) return -1;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)
        return i;
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (py < first.top) return 0;
    if (py > last.bottom) return rects.length - 1;
    return -1;
  },

  /** 松手结束拖拽：新顺序已落在 images 里，保存时按数组下标写 sort */
  onGridTouchEnd() {
    if (!this.data.dragging) return;
    this.setData({ dragging: false, dragIndex: -1, dragUrl: "" });
  },

  toggleOrg(e) {
    const id = e.currentTarget.dataset.id;
    const orgOptions = this.data.orgOptions.map((o) =>
      o.id === id ? Object.assign({}, o, { checked: !o.checked }) : o,
    );
    this.setData({ orgOptions });
  },

  buildPayload() {
    // 先把停笔中的输入草稿落盘：从这里开始读的都是 data
    this.flushInputs();
    const d = this.data;
    const payload = {
      time: `${d.date} ${d.timeStr}`,
      event: d.event,
      type: d.type,
      content: d.content,
      rating: d.rating,
      experience: d.experience,
      position: d.location.position,
      address: d.location.address || null,
      lng: d.location.lng,
      lat: d.location.lat,
      witness: d.witness,
      visibility: d.visibilityIndex,
      visibleOrgIds:
        d.visibilityIndex === 1
          ? d.orgOptions.filter((o) => o.checked).map((o) => o.id)
          : [],
      images: d.images.map((img, i) => ({
        url: img.url,
        thumbUrl: img.thumbUrl || img.url,
        sort: i,
      })),
    };
    // 只在「挂着录音」或「本次主动移除」时带录音字段：
    // 未迁移 event_audio_url 列的环境也不会因为无录音的常规保存而写失败
    if (d.audioUrl || d.audioCleared) {
      payload.audioUrl = d.audioUrl || null;
      payload.audioDuration = d.audioUrl ? d.audioDuration || null : null;
    }
    return payload;
  },

  async onSubmit() {
    // 输入框是防抖回写的：先把草稿落盘，否则「刚敲完标题立刻点发布」会报「请填写事件标题」
    this.flushInputs();
    if (this.data.uploading) {
      wx.showToast({ title: "图片上传中，请稍候", icon: "none" });
      return;
    }
    // 还开着麦克风就点保存：这段既没落盘也没转写，会默默发出去一条没有新录音的日志
    if (this.data.recording) {
      wx.showToast({ title: "请先点「停止录音」", icon: "none" });
      return;
    }
    // 刚录完就点保存：录音还没落盘，直接发布会默默丢掉这条录音
    if (this._transcribing) {
      wx.showToast({ title: "录音保存中，请稍候", icon: "none" });
      return;
    }
    if (!this.data.event.trim()) {
      wx.showToast({ title: "请填写事件标题", icon: "none" });
      return;
    }
    try {
      this.setData({ submitting: true });
      const payload = this.buildPayload();
      const req = this.data.id
        ? api.event.update(Object.assign({ id: this.data.id }, payload))
        : api.event.create(payload);
      const { code, message, data } = await req;
      if (Number(code) === 200) {
        // 通知列表下次 onShow 重新加载（新日志可能属于本月/需插入开头）
        const app = getApp();
        app.globalData = app.globalData || {};
        app.globalData.timelineDirty = true;
        // 乐观插入只对「新建」开放：新建时列表里还没有这条，突发下接口排队/被拒会「发了看不见」，
        // 先把刚写的置顶，再后台拉第一页校正。编辑则相反——这条本就在列表里、时间还可能很早，
        // 置顶会让被改的那条突兀地跳到最上面；交给 timelineDirty 的 reset 按时间序重拉即可落回原位
        if (!this.data.id && data && data.id) {
          const imgs = payload.images || [];
          const first = imgs[0];
          app.globalData._pendingTimelineInsert = {
            id: data.id,
            time: payload.time,
            event: payload.event,
            type: payload.type,
            summary: "",
            content: payload.content || "",
            tags: [],
            persons: [],
            position: payload.position || "",
            address: payload.address || null,
            lng: payload.lng != null ? payload.lng : null,
            lat: payload.lat != null ? payload.lat : null,
            firstThumb: (first && (first.thumbUrl || first.url)) || "",
            firstUrl: (first && first.url) || "",
            // 整条图集一起带上：否则刚存的多图日志在列表上只能看首图，
            // 要等后端第一页回来才能滑动浏览
            thumbs: imgs.map((im) => im.thumbUrl || im.url).filter(Boolean),
            imageUrls: imgs.map((im) => im.url).filter(Boolean),
          };
        }
        wx.showToast({
          title: this.data.id ? "已保存" : "发布成功",
          icon: "success",
        });
        setTimeout(() => wx.navigateBack(), 700);
      } else {
        wx.showToast({ title: message || "保存失败", icon: "none" });
      }
    } catch (err) {
      /* request 已提示 */
    } finally {
      this.setData({ submitting: false });
    }
  },
});
