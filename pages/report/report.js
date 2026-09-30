const api = require('../../utils/api')
const auth = require('../../utils/auth')

Page({
  data: {
    report: null,
    years: [],
    year: '',
    yearIndex: 0,
    loading: true,
    error: ''
  },

  onShow() {
    if (!auth.checkLogin()) return
    if (!this.data.report) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  reload() {
    this.load(this.data.year)
  },

  async load(y) {
    try {
      this.setData({ loading: true, error: '' })
      const { code, data, message } = await api.memory.report(y)
      if (Number(code) === 200 && data) {
        // 计算分类分布百分比（纯 CSS 进度条）
        const maxCount = (data.typeDist && data.typeDist[0] && data.typeDist[0].count) || 1
        const typeDist = (data.typeDist || []).map((item) =>
          Object.assign({}, item, { percent: Math.round((item.count / maxCount) * 100) })
        )
        const report = Object.assign({}, data, { typeDist })
        const years = data.years || []
        const yearIndex = Math.max(0, years.indexOf(data.year))
        this.setData({
          report,
          years,
          year: data.year,
          yearIndex,
          loading: false
        })
      } else {
        this.setData({ loading: false, error: message || '获取年度回顾失败' })
      }
    } catch (err) {
      this.setData({ loading: false, error: '获取年度回顾失败' })
    }
  },

  onYearChange(e) {
    const index = Number(e.detail.value)
    const year = this.data.years[index]
    this.setData({ yearIndex: index })
    this.load(year)
  },

  goPersons(e) {
    const name = e.currentTarget.dataset.name
    wx.navigateTo({ url: `/pages/persons/persons?name=${encodeURIComponent(name)}` })
  }
})
