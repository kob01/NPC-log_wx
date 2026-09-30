const api = require('../../utils/api')
const auth = require('../../utils/auth')

const NOT_CONFIGURED_HINT = 'AI 未配置'
const isNotConfigured = (msg) => !!msg && msg.indexOf(NOT_CONFIGURED_HINT) !== -1

Page({
  data: {
    question: '',
    asking: false,
    askResult: null,
    askNotConfigured: false,
    askError: '',
    tags: [],
    summary: null,
    summaryLoading: false,
    summaryNotConfigured: false,
    keyword: '',
    searching: false,
    searchList: [],
    searchTotal: 0,
    searched: false,
    limit: 8,
    showPoster: false,
    posterEntry: null,
    posterCopy: null
  },

  onShow() {
    if (!auth.checkLogin()) return
    this.loadTags()
  },

  async loadTags() {
    try {
      const { code, data } = await api.memory.tags()
      if (Number(code) === 200 && data) {
        this.setData({ tags: data.tags || [] })
      }
    } catch (err) {
      /* 静默 */
    }
  },

  onQuestionInput(e) {
    this.setData({ question: e.detail.value })
  },

  async onAsk() {
    const q = (this.data.question || '').trim()
    if (!q) {
      wx.showToast({ title: '请输入你的问题', icon: 'none' })
      return
    }
    try {
      this.setData({ asking: true, askError: '', askNotConfigured: false, askResult: null })
      const { code, message, data } = await api.memory.ask(q)
      if (Number(code) === 200 && data) {
        this.setData({ askResult: data })
      } else if (isNotConfigured(message)) {
        this.setData({ askNotConfigured: true })
      } else {
        this.setData({ askError: message || 'AI 问答失败' })
      }
    } catch (err) {
      this.setData({ askError: 'AI 问答失败，请稍后重试' })
    } finally {
      this.setData({ asking: false })
    }
  },

  async onSummary() {
    try {
      this.setData({ summaryLoading: true, summaryNotConfigured: false })
      const { code, message, data } = await api.memory.summary()
      if (Number(code) === 200 && data) {
        this.setData({ summary: data })
      } else if (isNotConfigured(message)) {
        this.setData({ summaryNotConfigured: true })
      } else {
        wx.showToast({ title: message || '暂无摘要', icon: 'none' })
      }
    } catch (err) {
      /* request 已提示 */
    } finally {
      this.setData({ summaryLoading: false })
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  async onSearch(size) {
    const q = (this.data.keyword || '').trim()
    if (!q) {
      wx.showToast({ title: '请输入搜索关键词', icon: 'none' })
      return
    }
    const limit = size || this.data.limit
    try {
      this.setData({ searching: true, searched: true })
      const { code, data } = await api.memory.search(q, limit)
      if (Number(code) === 200 && data) {
        this.setData({
          searchList: data.list || [],
          searchTotal: data.total || 0,
          limit
        })
      }
    } catch (err) {
      this.setData({ searchList: [] })
    } finally {
      this.setData({ searching: false })
    }
  },

  onLoadMore() {
    this.onSearch(Math.min(this.data.limit + 8, 20))
  },

  onTagClick(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ keyword: tag })
    this.onSearch(8)
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` })
  },

  goDetailById(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` })
  },

  // 生成月度回顾分享卡（优先 AI 改写，失败降级为摘要原文）
  async onSharePoster() {
    const s = this.data.summary
    if (!s || !s.summary) {
      wx.showToast({ title: '请先生成月度摘要', icon: 'none' })
      return
    }
    wx.showLoading({ title: '生成中', mask: true })
    let copy = null
    try {
      const res = await api.memory.shareCopy({ month: s.period, platform: 'xiaohongshu' })
      if (Number(res.code) === 200 && res.data) {
        copy = { title: res.data.title, body: res.data.body, hashtags: res.data.hashtags }
      }
    } catch (err) {
      /* 降级 */
    }
    wx.hideLoading()
    if (!copy) {
      copy = {
        title: `${s.period} 月度回顾`,
        body: String(s.summary).slice(0, 200),
        hashtags: (s.keywords || []).map((k) => (k.charAt(0) === '#' ? k : '#' + k))
      }
    }
    this.setData({
      posterEntry: { event: `${s.period} 月度回顾`, time: s.period, type: '回顾' },
      posterCopy: copy,
      showPoster: true
    })
  },

  onHidePoster() {
    this.setData({ showPoster: false })
  }
})
