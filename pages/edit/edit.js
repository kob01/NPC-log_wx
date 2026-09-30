const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { resolveFileUrl, nowDateTime } = require("../../utils/format");

const typeOptions = [
  "工作",
  "爱好",
  "大事件",
  "学习",
  "运动",
  "旅游",
  "吃喝",
  "社交",
  "家庭",
  "生活",
  "其他",
  "Her",
  "衣",
  "待办",
];
const ratingOptions = ["非常好", "好", "一般", "差", "非常差"];
const visibilityOptions = ["仅自己可见", "组织可见"];
const platformLabels = ["抖音", "小红书", "其他"];
const platformValues = ["douyin", "xiaohongshu", "other"];

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
    feeling: "",
    experience: "",
    location: { position: "", address: "", lng: null, lat: null },
    witness: "",
    images: [],
    uploading: false,
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
  // 是否为编辑已有日志（同步判定，供 onReady 决定是否自动定位）
  _isEdit: false,
  // 本次是否由首页带录音跳转过来（这种场景不自动弹地图，免得打断转写）
  _hasPendingVoice: false,

  async onLoad(options) {
    if (!auth.checkLogin()) return;
    // 同步记录是否编辑，避免 onReady 早于 onLoad 的 await 时 this.data.id 还没赋值
    this._isEdit = Boolean(options.id);
    const [date, timeStr] = nowDateTime().split(" ");
    this.setData({ date, timeStr });
    // 首页录音后经 globalData 中转过来（只带音频临时文件与时长，转写+解析在本页进行）
    const app = getApp();
    const pendingVoice = app.globalData && app.globalData._pendingVoice;
    if (pendingVoice && pendingVoice.tempFilePath) {
      app.globalData._pendingVoice = null;
      this._hasPendingVoice = true;
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

  onReady() {
    // 新建日志（非编辑、非带录音跳转）进入时，默认把地点定位到当前位置：
    // 自动拉起地图选点，小程序原生地图会先定位到用户当前所在，确认/微调后即回填
    if (!this._isEdit && !this._hasPendingVoice) {
      this.chooseLocation({ auto: true });
    }
  },

  onUnload() {
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
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

  /** 语音转写 + 录音留存：后端回传 {text, audioUrl}，无论文字识别成败都保留录音 */
  async transcribeAndParse(filePath) {
    this._transcribing = true;
    try {
      const { code, data, message } = await api.event.transcribe(filePath);
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
          this.setData({
            voiceStatus: "语音识别失败，可手动填写（录音已保留）",
          });
          return;
        }
        this.setData({
          "voice.text": text,
          content: this.data.content || text,
          voiceStatus: "AI 解析中…",
        });
        this.parseVoice(text);
      } else {
        this.setData({ voiceStatus: message || "录音保存失败，可手动填写" });
      }
    } catch (err) {
      this.setData({ voiceStatus: "录音保存失败，可手动填写" });
    } finally {
      this._transcribing = false;
    }
  },

  /** AI 解析口述文本，拆项填入表单 */
  async parseVoice(text) {
    try {
      const { code, data } = await api.event.parseVoiceText(text);
      if (Number(code) === 200 && data && data.fields) {
        this.applyVoiceFields(data.fields);
        this.setData({
          voiceStatus: data.degraded
            ? "AI 未启用，已保留原文"
            : "AI 已解析并填表",
        });
      } else {
        this.setData({ voiceStatus: "AI 解析失败，可对照原文手动填写" });
      }
    } catch (err) {
      this.setData({ voiceStatus: "AI 解析失败，可对照原文手动填写" });
    }
  },

  /** 只填空白字段，不覆盖用户已输入内容 */
  applyVoiceFields(fields) {
    const d = this.data;
    const upd = {};
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
    if (fields.feeling && !d.feeling) upd.feeling = fields.feeling;
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
        feeling: data.feeling || "",
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

  chooseLocation(opt) {
    // auto=true 表示新建日志进入页面时的自动定位：用户取消不打提示，避免刚进来就被 toast 打扰
    const isAuto = Boolean(opt && opt.auto);
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
        if (!isAuto) wx.showToast({ title: "未选择地点", icon: "none" });
      },
    });
  },

  clearLocation() {
    this.setData({
      location: { position: "", address: "", lng: null, lat: null },
    });
  },

  chooseImage() {
    const remaining = 9 - this.data.images.length;
    if (remaining <= 0) return;
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sizeType: ["compressed"],
      success: (res) => this.uploadImages(res.tempFiles || []),
    });
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
    const urls = this.data.images.map((i) => i.displayUrl);
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
      feeling: d.feeling,
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
