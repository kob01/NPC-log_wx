const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { resolveFileUrl } = require('../../utils/format')

Page({
  data: {
    id: '',
    detail: null,
    imageUrls: [],
    visibilityText: '仅自己可见',
    canEdit: false,
    showPoster: false,
    loading: true
  },

  onLoad(options) {
    if (!auth.checkLogin()) return
    this.setData({ id: options.id })
    this.loadDetail(options.id)
  },

  onShow() {
    // 从编辑页返回时刷新
    if (this._needRefresh && this.data.id) {
      this._needRefresh = false
      this.loadDetail(this.data.id)
    }
  },

  async loadDetail(id) {
    if (!id) {
      this.setData({ loading: false })
      return
    }
    try {
      this.setData({ loading: true })
      const { code, data } = await api.event.detail(id)
      if (Number(code) !== 200 || !data) {
        this.setData({ detail: null, loading: false })
        return
      }
      const detail = Object.assign(
        { tags: [], persons: [], images: [], links: [] },
        data
      )
      const imageUrls = detail.images
        .map((img) => resolveFileUrl(img.url))
        .filter(Boolean)
      let visibilityText = '仅自己可见'
      if (Number(detail.visibility) === 1) {
        visibilityText = detail.visibleOrgNames
          ? `组织可见·${detail.visibleOrgNames}`
          : '组织可见'
      }
      this.setData({
        detail,
        imageUrls,
        visibilityText,
        canEdit: !!detail.is_mine || auth.isAdmin(),
        loading: false
      })
    } catch (err) {
      this.setData({ detail: null, loading: false })
    }
  },

  onPreviewImage(e) {
    const index = e.currentTarget.dataset.index
    wx.previewImage({ current: this.data.imageUrls[index], urls: this.data.imageUrls })
  },

  onOpenLocation() {
    const { detail } = this.data
    if (!detail || detail.lng == null || detail.lat == null) {
      wx.showToast({ title: '该日志未记录坐标', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: Number(detail.lat),
      longitude: Number(detail.lng),
      name: detail.position || '日志地点',
      address: detail.address || '',
      scale: 18
    })
  },

  onCopyLink(e) {
    const url = e.currentTarget.dataset.url
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制，请在浏览器打开', icon: 'none' })
    })
  },

  goEdit() {
    this._needRefresh = true
    wx.navigateTo({ url: `/pages/edit/edit?id=${this.data.id}` })
  },

  onShowPoster() {
    if (!this.data.detail) return
    this.setData({ showPoster: true })
  },

  onHidePoster() {
    this.setData({ showPoster: false })
  },

  // 分享给好友（Phase 3 可携 shareToken 做访客只读链接）
  onShareAppMessage() {
    const detail = this.data.detail || {}
    return {
      title: detail.event || 'NPC 日志分享',
      path: `/pages/detail/detail?id=${this.data.id}`
    }
  },

  onShareTimeline() {
    const detail = this.data.detail || {}
    return {
      title: detail.event || 'NPC 日志分享',
      query: `id=${this.data.id}`
    }
  },

  onDelete() {
    wx.showModal({
      title: '删除日志',
      content: '删除后不可恢复，确定删除吗？',
      confirmColor: '#f5222d',
      success: async (res) => {
        if (!res.confirm) return
        const { code, message } = await api.event.remove(this.data.id)
        if (Number(code) === 200) {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        } else {
          wx.showToast({ title: message || '删除失败', icon: 'none' })
        }
      }
    })
  }
})
