const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { resolveFileUrl, nowDateTime } = require('../../utils/format')

const typeOptions = [
  '工作', '爱好', '大事件', '学习', '运动', '旅游', '吃喝',
  '社交', '家庭', '生活', '其他', 'Her', '衣', '待办'
]
const ratingOptions = ['非常好', '好', '一般', '差', '非常差']
const visibilityOptions = ['仅自己可见', '组织可见']
const platformLabels = ['抖音', '小红书', '其他']
const platformValues = ['douyin', 'xiaohongshu', 'other']

Page({
  data: {
    id: '',
    date: '',
    timeStr: '',
    event: '',
    typeOptions,
    typeIndex: -1,
    type: '',
    content: '',
    ratingOptions,
    ratingIndex: -1,
    rating: '',
    feeling: '',
    experience: '',
    location: { position: '', address: '', lng: null, lat: null },
    witness: '',
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
    voiceStatus: '',
    playing: false
  },

  _audio: null,

  async onLoad(options) {
    if (!auth.checkLogin()) return
    const [date, timeStr] = nowDateTime().split(' ')
    this.setData({ date, timeStr })
    // 首页长按录音后经 globalData 中转过来（文本较长，不走 URL 参数）
    const app = getApp()
    const pendingVoice = app.globalData && app.globalData._pendingVoice
    if (pendingVoice && pendingVoice.text) {
      app.globalData._pendingVoice = null
      this.setData({
        voice: pendingVoice,
        voiceStatus: 'AI 解析中…',
        content: pendingVoice.text
      })
      this.initAudio(pendingVoice.tempFilePath)
      this.parseVoice(pendingVoice.text)
    }
    await this.loadOrgOptions()
    if (options.id) {
      wx.setNavigationBarTitle({ title: '编辑日志' })
      this.setData({ id: options.id })
      this.loadDetail(options.id)
    }
  },

  onUnload() {
    if (this._audio) {
      this._audio.destroy()
      this._audio = null
    }
  },

  // ==================== 录音悬浮卡片 ====================
  initAudio(tempFilePath) {
    if (!tempFilePath) return
    const audio = wx.createInnerAudioContext()
    audio.src = tempFilePath
    audio.onEnded(() => this.setData({ playing: false }))
    audio.onError(() => {
      this.setData({ playing: false })
      wx.showToast({ title: '录音文件已失效', icon: 'none' })
    })
    this._audio = audio
  },

  togglePlay() {
    if (!this._audio) {
      wx.showToast({ title: '录音文件已失效', icon: 'none' })
      return
    }
    if (this.data.playing) {
      this._audio.pause()
      this.setData({ playing: false })
    } else {
      this._audio.play()
      this.setData({ playing: true })
    }
  },

  /** AI 解析口述文本，拆项填入表单 */
  async parseVoice(text) {
    try {
      const { code, data } = await api.event.parseVoiceText(text)
      if (Number(code) === 200 && data && data.fields) {
        this.applyVoiceFields(data.fields)
        this.setData({
          voiceStatus: data.degraded ? 'AI 未启用，已保留原文' : 'AI 已解析并填表'
        })
      } else {
        this.setData({ voiceStatus: 'AI 解析失败，可对照原文手动填写' })
      }
    } catch (err) {
      this.setData({ voiceStatus: 'AI 解析失败，可对照原文手动填写' })
    }
  },

  /** 只填空白字段，不覆盖用户已输入内容 */
  applyVoiceFields(fields) {
    const d = this.data
    const upd = {}
    if (fields.event && !d.event) upd.event = fields.event
    if (fields.type && d.typeIndex < 0) {
      const i = typeOptions.indexOf(fields.type)
      if (i >= 0) {
        upd.typeIndex = i
        upd.type = typeOptions[i]
      }
    }
    if (fields.rating && d.ratingIndex < 0) {
      const ri = ratingOptions.indexOf(fields.rating)
      if (ri >= 0) {
        upd.ratingIndex = ri
        upd.rating = ratingOptions[ri]
      }
    }
    if (fields.feeling && !d.feeling) upd.feeling = fields.feeling
    if (fields.experience && !d.experience) upd.experience = fields.experience
    if (fields.witness && !d.witness) upd.witness = fields.witness
    if (fields.position && !d.location.position) {
      upd['location.position'] = fields.position
    }
    if (Object.keys(upd).length) this.setData(upd)
  },

  /** 点悬浮卡片 → 回到顶部 */
  voiceTapToTop() {
    this.setData({ voiceCollapsed: false })
    wx.pageScrollTo({ scrollTop: 0, duration: 300 })
  },

  toggleVoiceCollapsed() {
    this.setData({ voiceCollapsed: !this.data.voiceCollapsed })
  },

  closeVoicePanel() {
    if (this._audio) {
      this._audio.destroy()
      this._audio = null
    }
    this.setData({ voice: null, voiceCollapsed: false, voiceStatus: '', playing: false })
  },

  async loadOrgOptions() {
    try {
      const { code, data } = await api.org.mine()
      if (Number(code) === 200) {
        const orgOptions = (data || [])
          .filter((o) => Number(o.my_status) === 1)
          .map((o) => ({ id: o.id, org_name: o.org_name, checked: false }))
        this.setData({ orgOptions })
      }
    } catch (err) {
      /* 忽略 */
    }
  },

  async loadDetail(id) {
    try {
      const { code, data } = await api.event.detail(id)
      if (Number(code) !== 200 || !data) return
      const [date, timeStr] = (data.time || nowDateTime()).split(' ')
      const images = (data.images || []).map((img) => ({
        url: img.url,
        thumbUrl: img.thumbUrl || img.url,
        displayUrl: resolveFileUrl(img.thumbUrl || img.url)
      }))
      const links = (data.links || []).map((l) => ({
        platformIndex: Math.max(0, platformValues.indexOf(l.platform || 'other')),
        url: l.url || '',
        title: l.title || ''
      }))
      const visibilityIndex = Number(data.visibility) === 1 ? 1 : 0
      const visibleOrgIds = data.visibleOrgIds || []
      const orgOptions = this.data.orgOptions.map((o) =>
        Object.assign({}, o, { checked: visibleOrgIds.indexOf(o.id) !== -1 })
      )
      this.setData({
        date,
        timeStr,
        event: data.event || '',
        type: data.type || '',
        typeIndex: typeOptions.indexOf(data.type),
        content: data.content || '',
        rating: data.rating || '',
        ratingIndex: ratingOptions.indexOf(data.rating),
        feeling: data.feeling || '',
        experience: data.experience || '',
        witness: data.witness || '',
        location: {
          position: data.position || '',
          address: data.address || '',
          lng: data.lng != null ? data.lng : null,
          lat: data.lat != null ? data.lat : null
        },
        images,
        links,
        visibilityIndex,
        orgOptions
      })
    } catch (err) {
      /* 忽略 */
    }
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value })
  },

  onTimeChange(e) {
    this.setData({ timeStr: e.detail.value })
  },

  onTypeChange(e) {
    const i = Number(e.detail.value)
    this.setData({ typeIndex: i, type: typeOptions[i] })
  },

  onRatingChange(e) {
    const i = Number(e.detail.value)
    this.setData({ ratingIndex: i, rating: ratingOptions[i] })
  },

  onVisibilityChange(e) {
    this.setData({ visibilityIndex: Number(e.detail.value) })
  },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          location: {
            position: res.name || res.address || '',
            address: res.address || '',
            lng: res.longitude,
            lat: res.latitude
          }
        })
      },
      fail: () => {
        wx.showToast({ title: '未选择地点', icon: 'none' })
      }
    })
  },

  clearLocation() {
    this.setData({ location: { position: '', address: '', lng: null, lat: null } })
  },

  chooseImage() {
    const remaining = 9 - this.data.images.length
    if (remaining <= 0) return
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => this.uploadImages(res.tempFiles || [])
    })
  },

  async uploadImages(files) {
    this.setData({ uploading: true })
    for (const f of files) {
      try {
        const { code, data } = await api.event.uploadImage(f.tempFilePath)
        if (Number(code) === 200 && data && data.url) {
          const img = { url: data.url, thumbUrl: data.thumbUrl || data.url }
          img.displayUrl = resolveFileUrl(img.thumbUrl)
          this.setData({ images: this.data.images.concat([img]) })
        }
      } catch (err) {
        /* request 已提示，继续下一张 */
      }
    }
    this.setData({ uploading: false })
  },

  removeImage(e) {
    const index = e.currentTarget.dataset.index
    const images = this.data.images.slice()
    images.splice(index, 1)
    this.setData({ images })
  },

  previewImage(e) {
    const index = e.currentTarget.dataset.index
    const urls = this.data.images.map((i) => i.displayUrl)
    wx.previewImage({ current: urls[index], urls })
  },

  toggleOrg(e) {
    const id = e.currentTarget.dataset.id
    const orgOptions = this.data.orgOptions.map((o) =>
      o.id === id ? Object.assign({}, o, { checked: !o.checked }) : o
    )
    this.setData({ orgOptions })
  },

  addLink() {
    this.setData({
      links: this.data.links.concat([{ platformIndex: 0, url: '', title: '' }])
    })
  },

  removeLink(e) {
    const index = e.currentTarget.dataset.index
    const links = this.data.links.slice()
    links.splice(index, 1)
    this.setData({ links })
  },

  onLinkPlatform(e) {
    const index = e.currentTarget.dataset.index
    const links = this.data.links.slice()
    links[index] = Object.assign({}, links[index], { platformIndex: Number(e.detail.value) })
    this.setData({ links })
  },

  onLinkUrl(e) {
    const index = e.currentTarget.dataset.index
    const links = this.data.links.slice()
    links[index] = Object.assign({}, links[index], { url: e.detail.value })
    this.setData({ links })
  },

  buildPayload() {
    const d = this.data
    const validLinks = d.links
      .filter((l) => l.url && l.url.trim())
      .map((l) => ({
        platform: platformValues[l.platformIndex] || 'other',
        url: l.url.trim(),
        title: (l.title || '').trim()
      }))
    return {
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
      visibleOrgIds: d.visibilityIndex === 1
        ? d.orgOptions.filter((o) => o.checked).map((o) => o.id)
        : [],
      images: d.images.map((img, i) => ({
        url: img.url,
        thumbUrl: img.thumbUrl || img.url,
        sort: i
      })),
      links: validLinks
    }
  },

  async onSubmit() {
    if (this.data.uploading) {
      wx.showToast({ title: '图片上传中，请稍候', icon: 'none' })
      return
    }
    if (!this.data.event.trim()) {
      wx.showToast({ title: '请填写事件标题', icon: 'none' })
      return
    }
    const badLink = this.data.links.some(
      (l) => l.url && l.url.trim() && !/^https?:\/\/.+/.test(l.url.trim())
    )
    if (badLink) {
      wx.showToast({ title: '作品链接需以 http(s):// 开头', icon: 'none' })
      return
    }
    try {
      this.setData({ submitting: true })
      const payload = this.buildPayload()
      const req = this.data.id
        ? api.event.update(Object.assign({ id: this.data.id }, payload))
        : api.event.create(payload)
      const { code, message } = await req
      if (Number(code) === 200) {
        wx.showToast({ title: this.data.id ? '已保存' : '发布成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 700)
      } else {
        wx.showToast({ title: message || '保存失败', icon: 'none' })
      }
    } catch (err) {
      /* request 已提示 */
    } finally {
      this.setData({ submitting: false })
    }
  }
})
