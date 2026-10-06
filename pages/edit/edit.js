const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { resolveFileUrl, nowDateTime } = require("../../utils/format");
const { SUPPORTED_EXT_RE, inspectImage } = require("../../utils/imageFormat");

const typeOptions = [
  "吃喝",
  "生活",
  "运动",
  "爱好",
  "学习",
  "Her",
  "旅游",
  "家庭",
  "社交",
  "大事件",
  "待办",
  "衣",
  "工作",
  "其他",
];
const ratingOptions = ["非常好", "好", "一般", "差", "非常差"];
const visibilityOptions = ["仅自己可见", "组织可见"];
const platformLabels = ["抖音", "小红书", "其他"];
const platformValues = ["douyin", "xiaohongshu", "other"];

// 与后端 .env 的 MAX_UPLOAD_MB 默认值对齐：超上限在本地就挡下，省一趟注定失败的上传
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
// multer 按「上传文件名的扩展名」校验，会话文件常常没有后缀，得先补一个合法后缀再传；
// 能不能传交 utils/imageFormat 按文件头魔数判定 —— HEIC 虽在扩展名白名单里，但 sharp
// 预编译包缺 HEVC 解码器，会变成一张小程序渲染不出来的裂图，属于无效上传，一并挡下

// 开发者工具与低版本微信可能没有 chooseMessageFile：拿不到就整条入口不显示，
// 免得用户点了只换来一句「不支持」
const CAN_PICK_CHAT = typeof wx.chooseMessageFile === "function";

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
    // 是否展示「从微信聊天选图」入口（基础库不支持时隐藏）
    canPickChat: CAN_PICK_CHAT,
    visibilityOptions,
    visibilityIndex: 0,
    orgOptions: [],
    links: [],
    platformLabels,
    submitting: false,
    // 录音信息（悬浮卡片）
    voice: null,
    voiceCollapsed: false,
    voiceStatus: "",
    // 识别失败的具体原因（额度不足/超时/未配置）：卡片正文整行展示，头部只放短句
    voiceReason: "",
    // 失败后给一个原地重试入口（录音临时文件还在，不必重录）
    voiceRetryable: false,
    playing: false,
    // 随日志留存的录音（相对路径 + 时长秒），详情页据此回放
    audioUrl: "",
    audioDuration: null,
    // 本次编辑主动移除了原有录音（需传 null 告知后端清空）
    audioCleared: false,
  },

  _audio: null,
  // 录音上传+转写进行中（此期间拦住保存，避免默默丢录音）
  _transcribing: false,
  // 选完图到真正起上传之间的那段把关进行中（读文件头是异步的，期间拦住再起一批）
  _checking: false,
  // 聊天选图补后缀产生的临时副本，上传完即删，onUnload 兜底再清一次
  _tmpFiles: [],

  async onLoad(options) {
    // 数组放在 Page 选项上有跨实例共用风险，这里按页面实例各自建一份（先于登录判定，
    // 未登录时 onUnload 兜底清理才有正确的空数组可用）
    this._tmpFiles = [];
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
    const audio = wx.createInnerAudioContext();
    // 只有相对路径需要拼 BASE_URL；本地临时文件原样传给原生播放器
    audio.src = src.startsWith("/") ? resolveFileUrl(src) : src;
    audio.onEnded(() => this.setData({ playing: false }));
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
    this._transcribing = true;
    this.setData({
      voiceStatus: "识别中…",
      voiceReason: "",
      voiceRetryable: false,
    });
    try {
      const { code, data, message } = await api.event.transcribe(target);
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
        this.setData({
          "voice.text": text,
          content: this.data.content || text,
          voiceRetryable: false,
        });
        if (data.fields) {
          this.applyVoiceFields(data.fields);
          this.setData({
            voiceStatus: data.degraded
              ? "AI 未启用，已保留原文"
              : "AI 已解析并填表",
            voiceReason: data.degraded
              ? "文字已识别，但 AI 解析未启用（已把原文放进正文）"
              : "",
          });
        } else {
          this.setData({
            voiceStatus: "解析失败，可手动填写",
            voiceReason:
              "文字已识别但 AI 未能拆字段，可对照原文手动填，或点重试",
            voiceRetryable: true,
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
      this.setData({
        voiceStatus: "上传失败，可重试",
        voiceReason: "录音没传上去（网络或服务异常），可点重试",
        voiceRetryable: true,
      });
    } finally {
      this._transcribing = false;
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

  /** 只填空白字段，不覆盖用户已输入内容 */
  applyVoiceFields(fields) {
    const d = this.data;
    const upd = {};
    // 时间单独策略：date/timeStr 进页就预填了当前时间，无法按「空白」判定，
    // 只在两者仍等于进页默认值（用户没手改）且格式合法时才用 AI 结果
    if (fields.time) {
      const m = String(fields.time).match(
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/,
      );
      if (m && d.date === this._initDate && d.timeStr === this._initTimeStr) {
        upd.date = m[1];
        upd.timeStr = m[2];
      }
    }
    if (fields.event && !d.event) upd.event = fields.event;
    if (fields.type && d.typeIndex < 0) {
      const i = typeOptions.indexOf(fields.type);
      if (i >= 0) {
        upd.typeIndex = i;
        upd.type = typeOptions[i];
      }
    }
    if (fields.rating && d.ratingIndex < 0) {
      const ri = ratingOptions.indexOf(fields.rating);
      if (ri >= 0) {
        upd.ratingIndex = ri;
        upd.rating = ratingOptions[ri];
      }
    }
    if (fields.experience && !d.experience) upd.experience = fields.experience;
    if (fields.witness && !d.witness) upd.witness = fields.witness;
    if (fields.position && !d.location.position) {
      upd["location.position"] = fields.position;
    }
    if (Object.keys(upd).length) this.setData(upd);
  },

  /** 点悬浮卡片 → 回到顶部 */
  voiceTapToTop() {
    this.setData({ voiceCollapsed: false });
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
  },

  toggleVoiceCollapsed() {
    this.setData({ voiceCollapsed: !this.data.voiceCollapsed });
  },

  /** ✕ 关闭卡片：不保留本次录音；若原本挂着已存录音，则标记为主动移除 */
  closeVoicePanel() {
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
    this.setData({
      voice: null,
      voiceCollapsed: false,
      voiceStatus: "",
      voiceReason: "",
      voiceRetryable: false,
      playing: false,
      audioUrl: "",
      audioDuration: null,
      audioCleared: Boolean(this.data.audioUrl),
    });
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
        url: img.url,
        thumbUrl: img.thumbUrl || img.url,
        displayUrl: resolveFileUrl(img.thumbUrl || img.url),
      }));
      const links = (data.links || []).map((l) => ({
        platformIndex: Math.max(
          0,
          platformValues.indexOf(l.platform || "other"),
        ),
        url: l.url || "",
        title: l.title || "",
      }));
      const visibilityIndex = Number(data.visibility) === 1 ? 1 : 0;
      const visibleOrgIds = data.visibleOrgIds || [];
      const orgOptions = this.data.orgOptions.map((o) =>
        Object.assign({}, o, { checked: visibleOrgIds.indexOf(o.id) !== -1 }),
      );
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
        links,
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
    // 同 login.js：避开计算属性名，防止依赖 @swc/runtime/_define_property
    const patch = {};
    patch[e.currentTarget.dataset.key] = e.detail.value;
    this.setData(patch);
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
          passed.push({ path: f.path, ext: info.ext });
        }
      });
      for (const p of passed) {
        if (SUPPORTED_EXT_RE.test(p.path)) {
          tasks.push({ tempFilePath: p.path });
          continue;
        }
        // 会话里的图、个别安卓机型的相册临时名常常没后缀，multer 会按扩展名拒收，
        // 先复制一份按真实格式补上后缀（认不出来按 jpg 兜底）再传
        const tmpPath = await copyWithExt(p.path, p.ext || "jpg");
        if (tmpPath) {
          this._tmpFiles.push(tmpPath);
          tasks.push({ tempFilePath: tmpPath, tmpPath });
        } else {
          // 副本建不了（没文件管理器等）就把原路径交上去，成不成由后端判定，至少不静默丢图
          tasks.push({ tempFilePath: p.path });
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

  async uploadImages(files) {
    this.setData({ uploading: true });
    for (const f of files) {
      try {
        const { code, data } = await api.event.uploadImage(f.tempFilePath);
        if (Number(code) === 200 && data && data.url) {
          const img = { url: data.url, thumbUrl: data.thumbUrl || data.url };
          img.displayUrl = resolveFileUrl(img.thumbUrl);
          this.setData({ images: this.data.images.concat([img]) });
        }
      } catch (err) {
        /* request 已提示，继续下一张 */
      } finally {
        // 补后缀用的副本传完就删（失败也删，重试时会重新选）
        if (f.tmpPath) {
          removeTmpFile(f.tmpPath);
          this._tmpFiles = this._tmpFiles.filter((p) => p !== f.tmpPath);
        }
      }
    }
    this.setData({ uploading: false });
  },

  removeImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    // 九宫格里用的是缩略图（省流量），点开大图必须换成原图地址，否则 300px 放大到全屏会糊
    const urls = this.data.images.map((i) =>
      resolveFileUrl(i.url || i.thumbUrl),
    );
    wx.previewImage({ current: urls[index], urls });
  },

  toggleOrg(e) {
    const id = e.currentTarget.dataset.id;
    const orgOptions = this.data.orgOptions.map((o) =>
      o.id === id ? Object.assign({}, o, { checked: !o.checked }) : o,
    );
    this.setData({ orgOptions });
  },

  addLink() {
    this.setData({
      links: this.data.links.concat([{ platformIndex: 0, url: "", title: "" }]),
    });
  },

  removeLink(e) {
    const index = e.currentTarget.dataset.index;
    const links = this.data.links.slice();
    links.splice(index, 1);
    this.setData({ links });
  },

  onLinkPlatform(e) {
    const index = e.currentTarget.dataset.index;
    const links = this.data.links.slice();
    links[index] = Object.assign({}, links[index], {
      platformIndex: Number(e.detail.value),
    });
    this.setData({ links });
  },

  onLinkUrl(e) {
    const index = e.currentTarget.dataset.index;
    const links = this.data.links.slice();
    links[index] = Object.assign({}, links[index], { url: e.detail.value });
    this.setData({ links });
  },

  buildPayload() {
    const d = this.data;
    const validLinks = d.links
      .filter((l) => l.url && l.url.trim())
      .map((l) => ({
        platform: platformValues[l.platformIndex] || "other",
        url: l.url.trim(),
        title: (l.title || "").trim(),
      }));
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
      links: validLinks,
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
    if (this.data.uploading) {
      wx.showToast({ title: "图片上传中，请稍候", icon: "none" });
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
    const badLink = this.data.links.some(
      (l) => l.url && l.url.trim() && !/^https?:\/\/.+/.test(l.url.trim()),
    );
    if (badLink) {
      wx.showToast({ title: "作品链接需以 http(s):// 开头", icon: "none" });
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
        // 乐观插入：新建用后端回传的 id，编辑用本页 id。突发时列表接口可能正在排队或被拒，
        // 先把用户刚写的那条放进列表，再后台拉第一页校正，避免“发了但看不见”
        const savedId = this.data.id || (data && data.id);
        if (savedId) {
          const first = payload.images && payload.images[0];
          app.globalData._pendingTimelineInsert = {
            id: savedId,
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
