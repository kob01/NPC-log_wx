const api = require('../../utils/api')
const auth = require('../../utils/auth')

Page({
  data: {
    persons: [],
    filtered: [],
    keyword: '',
    selected: '',
    year: '',
    yearChips: [],
    timeline: null,
    listLoading: true,
    timelineLoading: false
  },

  _deepName: '',

  onLoad(options) {
    this._deepName = options.name ? decodeURIComponent(options.name) : ''
  },

  onShow() {
    if (!auth.checkLogin()) return
    this.loadPersons()
  },

  withInitial(persons) {
    return persons.map((p) =>
      Object.assign({}, p, { initial: (p.person || '?').charAt(0) })
    )
  },

  async loadPersons() {
    try {
      this.setData({ listLoading: true })
      const { code, data } = await api.memory.persons()
      if (Number(code) === 200 && data) {
        const list = this.withInitial(data.persons || [])
        this.setData({ persons: list, filtered: list })
        const target =
          list.find((p) => p.person === this._deepName)?.person ||
          (list[0] && list[0].person) ||
          ''
        if (target) this.selectPersonByName(target)
      }
      this._deepName = ''
    } catch (err) {
      /* 已提示 */
    } finally {
      this.setData({ listLoading: false })
    }
  },

  onKeywordInput(e) {
    const v = (e.detail.value || '').trim()
    this.setData({
      keyword: v,
      filtered: v
        ? this.withInitial(this.data.persons.filter((p) => p.person.indexOf(v) !== -1))
        : this.data.persons
    })
  },

  selectPerson(e) {
    this.selectPersonByName(e.currentTarget.dataset.name)
  },

  selectPersonByName(name) {
    this.setData({ selected: name, year: '' })
    this.loadTimeline(name, '')
  },

  async loadTimeline(person, year) {
    if (!person) return
    try {
      this.setData({ timelineLoading: true })
      const { code, data } = await api.memory.person(person, year)
      if (Number(code) === 200 && data) {
        const yearChips = [{ label: '全部', value: '' }].concat(
          (data.years || []).map((y) => ({
            label: `${y.year}(${y.count})`,
            value: String(y.year)
          }))
        )
        this.setData({ timeline: data, yearChips })
      } else {
        this.setData({ timeline: null, yearChips: [] })
      }
    } catch (err) {
      this.setData({ timeline: null })
    } finally {
      this.setData({ timelineLoading: false })
    }
  },

  onYearChip(e) {
    const year = e.currentTarget.dataset.year || ''
    this.setData({ year })
    this.loadTimeline(this.data.selected, year)
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` })
  }
})
