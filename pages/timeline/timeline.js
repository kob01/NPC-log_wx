const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { dayKey } = require('../../utils/format')

const PAGE_SIZE = 10

// 同声传译插件（需在小程序后台先添加该插件）
let siPlugin = null
try {
  siPlugin = requirePlugin('WechatSI')
} catch (e) {
  console.warn('[timeline] WechatSI 插件加载失败，录音功能不可用', e)
}

Page({
  data: {
    entries: [],
    groups: [],
    loading: false,
    hasMore: true,
    keyword: '',
    searchMode: false,
    searchExpanded: false,
    // 录音浮层
    recording: false,
    recordSeconds: 0,
    liveText: ''
  },

  // 游标：当前已加载的最小 event_id（存实例上，不进 data）
  _cursor: null,
  _version: 0, // 列表版本号，用于丢弃过期的异步结果
  _recorder: null, // WechatSI recordRecoManager
  _recordStopped: true,
  _recordTempFilePath: '',
  _recordTimer: null,

  onLoad() {
    this._cursor = null
    this._loaded = false
    this.initRecorder()
  },

  onShow() {
    if (!auth.checkLogin()) return
    // 首次进入或从编辑/详情返回且列表为空时（重新）加载
    if (!this._loaded || (!this.data.searchMode && !this.data.entries.length && !this.data.loading)) {
      this._loaded = true
      this.reset()
    }
  },

  onPullDownRefresh() {
    this.reset().then(() => wx.stopPullDownRefresh())
  },

  // ==================== 录音（长按 🎙） ====================
  initRecorder() {
    if (!siPlugin || typeof siPlugin.getRecordRecognitionManager !== 'function') return
    const manager = siPlugin.getRecordRecognitionManager()
    this._recorder = manager

    manager.onStart = () => {
      this._recordStopped = false
    }

    // 实时识别：边说边上屏，配合波纹动画
    manager.onRecognize = (res) => {
      this.setData({ liveText: (res && res.result) || '' })
    }

    manager.onStop = (res) => {
      this._recordStopped = true
      this.clearRecordTimer()
      const text = ((res && res.result) || '').trim()
      const duration = Math.round(((res && res.duration) || 0) / 1000)
      this._recordTempFilePath = (res && res.tempFilePath) || ''
      this.setData({ recording: false, recordSeconds: 0 })
      if (!text) {
        wx.showToast({ title: '没听清，请再说一遍', icon: 'none' })
        return
      }
      this.goEditWithVoice(text, duration)
    }

    manager.onError = (res) => {
      this._recordStopped = true
      this.clearRecordTimer()
      this.setData({ recording: false, recordSeconds: 0 })
      wx.showToast({ title: '录音失败：' + ((res && res.msg) || '请检查麦克风权限'), icon: 'none' })
    }
  },

  async ensureRecordAuth() {
    try {
      const setting = await new Promise((resolve, reject) => {
        wx.getSetting({ success: resolve, fail: reject })
      })
      if (setting.authSetting['scope.record'] === false) {
        await new Promise((resolve, reject) => {
          wx.openSetting({ success: resolve, fail: reject })
        })
      }
      await new Promise((resolve, reject) => {
        wx.authorize({ scope: 'scope.record', success: resolve, fail: reject })
      })
      return true
    } catch (err) {
      return false
    }
  },

  async onMicStart() {
    if (!this._recorder) {
      wx.showToast({ title: '录音功能未启用（未添加同声传译插件）', icon: 'none' })
      return
    }
    const ok = await this.ensureRecordAuth()
    if (!ok) {
      wx.showToast({ title: '需要麦克风权限才能录音', icon: 'none' })
      return
    }
    this._recordStopped = true
    this.setData({ recording: true, recordSeconds: 0, liveText: '' })
    this.clearRecordTimer()
    this._recordTimer = setInterval(() => {
      this.setData({ recordSeconds: this.data.recordSeconds + 1 })
    }, 1000)
    // duration 上限 60s，到时插件自动停止并回调 onStop
    this._recorder.start({ duration: 60000, lang: 'zh_CN' })
  },

  onMicEnd() {
    if (!this.data.recording) return
    if (this._recorder && !this._recordStopped) this._recorder.stop()
    // 极短误触：插件可能不会回调 onStop，兜底收起浮层
    setTimeout(() => {
      if (this.data.recording && this._recordStopped && !this.data.liveText) {
        this.clearRecordTimer()
        this.setData({ recording: false, recordSeconds: 0 })
      }
    }, 800)
  },

  clearRecordTimer() {
    if (this._recordTimer) {
      clearInterval(this._recordTimer)
      this._recordTimer = null
    }
  },

  noop() {},

  /** 录音结果经 globalData 中转（文本较长，不走 URL 参数） */
  goEditWithVoice(text, duration) {
    const app = getApp()
    app.globalData = app.globalData || {}
    app.globalData._pendingVoice = {
      text,
      tempFilePath: this._recordTempFilePath,
      duration
    }
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  onReachBottom() {
    if (!this.data.searchMode && this.data.hasMore && !this.data.loading) {
      this.loadMore()
    }
  },

  /** 列表项 → 展示条目 */
  fromListItem(item) {
    return {
      id: item.id,
      time: item.time || '',
      event: item.event || '',
      type: item.type || '',
      summary: item.summary || '',
      content: item.content || '',
      tags: item.tags || [],
      persons: item.persons || [],
      position: item.position || '',
      address: item.address || null,
      lng: item.lng != null ? item.lng : null,
      lat: item.lat != null ? item.lat : null,
      firstThumb: item.firstThumb || ''
    }
  },

  /** 搜索结果 → 展示条目 */
  fromMemoryItem(item) {
    return {
      id: item.id,
      time: item.time || '',
      event: item.event || '',
      type: item.type || '',
      summary: item.summary || '',
      content: '',
      tags: item.tags || [],
      persons: item.persons || [],
      position: item.position || '',
      address: item.address || null,
      lng: item.lng,
      lat: item.lat,
      firstThumb: item.firstThumb || '',
      score: item.score
    }
  },

  /** 由 entries 重建按日分组 */
  buildGroups(entries) {
    const groups = []
    entries.forEach((entry) => {
      const day = dayKey(entry.time)
      const last = groups[groups.length - 1]
      if (last && last.day === day) {
        last.items.push(entry)
      } else {
        groups.push({ day, items: [entry] })
      }
    })
    return groups
  },

  /** 加载下一页（游标模式） */
  async loadMore() {
    if (this.data.searchMode) return
    try {
      this.setData({ loading: true })
      const params = { page: 1, pageSize: PAGE_SIZE }
      if (this._cursor != null) {
        params.beforeId = this._cursor
      }
      const { code, data } = await api.event.page(params)
      if (Number(code) === 200 && data) {
        const items = (data.items || []).map(this.fromListItem)
        const merged = this.mergeUnique(this.data.entries, items)
        if (items.length) {
          const minId = Math.min(...items.map((e) => Number(e.id)))
          if (Number.isFinite(minId)) this._cursor = minId
        }
        this.setData({
          entries: merged,
          groups: this.buildGroups(merged),
          hasMore: items.length >= PAGE_SIZE
        })
      } else {
        this.setData({ hasMore: false })
      }
    } catch (err) {
      this.setData({ hasMore: false })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 合并去重（按 id） */
  mergeUnique(prev, incoming) {
    const ids = new Set(prev.map((e) => String(e.id)))
    return [...prev, ...incoming.filter((e) => !ids.has(String(e.id)))]
  },

  /** 重置并重新加载时间线 */
  async reset() {
    this._version += 1
    this._cursor = null
    this.setData({ entries: [], groups: [], hasMore: true, searchMode: false })
    await this.loadMore()
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  /** 搜索（记忆混合检索） */
  async onSearch() {
    const q = (this.data.keyword || '').trim()
    if (!q) {
      this.setData({ searchMode: false })
      this.reset()
      return
    }
    try {
      this.setData({ loading: true, searchMode: true })
      const { code, data } = await api.memory.search(q, 20)
      const list = Number(code) === 200 && data ? (data.list || []).map(this.fromMemoryItem) : []
      this.setData({
        entries: list,
        groups: this.buildGroups(list)
      })
    } catch (err) {
      this.setData({ entries: [], groups: [] })
    } finally {
      this.setData({ loading: false })
    }
  },

  onClear() {
    this.setData({ keyword: '', searchMode: false })
    this.reset()
  },

  // ==================== 搜索图标展开/收起 ====================
  expandSearch() {
    this.setData({ searchExpanded: true })
  },

  collapseSearch() {
    if (this.data.keyword) return
    this.setData({ searchExpanded: false, searchMode: false })
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  }
})
