const api = require('../../utils/api')
const { resolveFileUrl } = require('../../utils/format')

// 海报逻辑尺寸（3:4 竖版），导出时按设备像素比放大
const LW = 600
const LH = 800

/** 按最大宽度逐字换行（CJK 友好），支持手动 \n */
function wrapText(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  const chars = String(text || '').split('')
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === '\n') {
      lines.push(line)
      line = ''
      continue
    }
    const test = line + ch
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = ch
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

Component({
  options: { addGlobalClass: true },

  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer(v) {
        if (v) this.render()
      }
    },
    // 日志详情对象（含 id / event / summary / content / tags / images / position / author 等）
    entry: {
      type: Object,
      value: {},
      observer() {
        if (this.data.visible) this.render()
      }
    },
    // 卡片类型：single（单篇）/ summary（回顾）/ footprint（足迹）
    type: { type: String, value: 'single' },
    // 预置文案（无 entry.id 时直接用它绘制，供总结/足迹卡片复用）
    presetCopy: {
      type: Object,
      value: null,
      observer() {
        if (this.data.visible && !this.data.entry.id) this.render()
      }
    }
  },

  data: {
    platform: 'xiaohongshu',
    platforms: [
      { key: 'xiaohongshu', label: '小红书' },
      { key: 'moments', label: '朋友圈' },
      { key: 'weibo', label: '微博' }
    ],
    copy: null,
    tip: ''
  },

  methods: {
    onPickPlatform(e) {
      this.setData({ platform: e.currentTarget.dataset.key })
      this.render()
    },

    onRegenerate() {
      this.render()
    },

    onClose() {
      this.triggerEvent('close')
    },

    /** 取文案 + 绘制 */
    render() {
      // 无 event id（回顾/足迹）→ 直接用预置文案绘制
      if (!this.data.entry.id && this.data.presetCopy) {
        this.setData({ copy: this.data.presetCopy, tip: '' })
        this.draw()
        return
      }
      this.fetchCopy().then(() => this.draw())
    },

    /** 调后端 AI 改写；失败/未配置降级为原文 */
    fetchCopy() {
      const entry = this.data.entry || {}
      if (!entry.id) return Promise.resolve()
      this.setData({ tip: 'AI 改写中…' })
      return api.event
        .shareCopy({ id: entry.id, platform: this.data.platform })
        .then((res) => {
          if (Number(res.code) === 200 && res.data) {
            const d = res.data
            this.setData({
              copy: { title: d.title || '', body: d.body || '', hashtags: d.hashtags || [] },
              tip: d.degraded ? 'AI 暂不可用，已用原文预览' : ''
            })
          } else {
            this.setData({ copy: this.fallbackCopy(), tip: res.message || '文案生成失败，已用原文' })
          }
        })
        .catch(() => {
          this.setData({ copy: this.fallbackCopy(), tip: '网络异常，已用原文预览' })
        })
    },

    /** 降级文案：标题=原名，正文=摘要/正文截断，标签=原 tags */
    fallbackCopy() {
      const entry = this.data.entry || {}
      return {
        title: entry.event || '',
        body: String(entry.summary || entry.content || '').slice(0, 200),
        hashtags: (entry.tags || []).map((t) => (t.indexOf('#') === 0 ? t : '#' + t))
      }
    },

    /** 加载封面图（需 downloadFile 域名白名单，失败返回 null） */
    loadImage(canvas, src) {
      return new Promise((resolve) => {
        if (!src) {
          resolve(null)
          return
        }
        wx.getImageInfo({
          src,
          success: (info) => {
            const img = canvas.createImage()
            img.onload = () => resolve(img)
            img.onerror = () => resolve(null)
            img.src = info.path
          },
          fail: () => resolve(null)
        })
      })
    },

    /** 核心绘制 */
    draw() {
      const entry = this.data.entry || {}
      const copy = this.data.copy || this.fallbackCopy()
      const coverSrc = this.resolveCover(entry)

      return new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#poster')
          .fields({ node: true, size: true })
          .exec((res) => {
            const item = res && res[0]
            if (!item || !item.node) {
              resolve()
              return
            }
            const canvas = item.node
            const dpr = (wx.getSystemInfoSync().pixelRatio || 2)
            canvas.width = LW * dpr
            canvas.height = LH * dpr
            const ctx = canvas.getContext('2d')
            ctx.scale(dpr, dpr)

            // 背景
            const grd = ctx.createLinearGradient(0, 0, 0, LH)
            grd.addColorStop(0, '#fdfbfb')
            grd.addColorStop(1, '#ebedee')
            ctx.fillStyle = grd
            ctx.fillRect(0, 0, LW, LH)

            const afterCover = (topY) => {
              ctx.textBaseline = 'top'
              const pad = 40
              const maxW = LW - pad * 2

              // 元信息（类型 + 时间）
              let y = topY + 24
              ctx.font = '12px sans-serif'
              ctx.fillStyle = '#95a5a6'
              const meta = [(entry.time || ''), (entry.type || '')].filter(Boolean).join('  ·  ')
              ctx.fillText(meta, pad, y)
              y += 28

              // 标题
              ctx.font = 'bold 30px sans-serif'
              ctx.fillStyle = '#2c3e50'
              const titleLines = wrapText(ctx, copy.title || entry.event || '', maxW).slice(0, 2)
              titleLines.forEach((ln) => {
                ctx.fillText(ln, pad, y)
                y += 40
              })

              // 正文
              y += 6
              ctx.font = '20px sans-serif'
              ctx.fillStyle = '#4a5568'
              const bodyLines = wrapText(ctx, copy.body || '', maxW).slice(0, 10)
              bodyLines.forEach((ln) => {
                ctx.fillText(ln, pad, y)
                y += 32
              })

              // 话题标签
              const tags = (copy.hashtags || []).join(' ')
              if (tags) {
                y += 8
                ctx.font = '18px sans-serif'
                ctx.fillStyle = '#1677ff'
                const tagLines = wrapText(ctx, tags, maxW).slice(0, 3)
                tagLines.forEach((ln) => {
                  ctx.fillText(ln, pad, y)
                  y += 28
                })
              }

              // 底部：地点 + 作者 + 水印
              ctx.font = '16px sans-serif'
              ctx.fillStyle = '#e05a5a'
              const place = entry.position || entry.address || ''
              if (place) ctx.fillText('📍 ' + place, pad, LH - 60)
              ctx.fillStyle = '#a0aec0'
              const footer = (entry.author ? '@' + entry.author + '  ' : '') + '来自 NPC 日志'
              const fw = ctx.measureText(footer).width
              ctx.fillText(footer, LW - pad - fw, LH - 32)

              resolve()
            }

            if (coverSrc) {
              this.loadImage(canvas, coverSrc).then((img) => {
                if (img) {
                  try {
                    ctx.drawImage(img, 0, 0, LW, 300)
                    afterCover(300)
                  } catch (e) {
                    afterCover(0)
                  }
                } else {
                  this.drawHeaderBand(ctx)
                  afterCover(0)
                }
              })
            } else {
              this.drawHeaderBand(ctx)
              afterCover(0)
            }
          })
      })
    },

    /** 无封面时的占位色带 */
    drawHeaderBand(ctx) {
      const grd = ctx.createLinearGradient(0, 0, LW, 200)
      grd.addColorStop(0, '#1677ff')
      grd.addColorStop(1, '#6aa9ff')
      ctx.fillStyle = grd
      ctx.fillRect(0, 0, LW, 200)
    },

    resolveCover(entry) {
      const imgs = Array.isArray(entry.images) ? entry.images : []
      const first = imgs.length ? imgs[0].url || imgs[0].thumbUrl : entry.firstThumb
      return first ? resolveFileUrl(first) : ''
    },

    /** 导出并保存到相册 */
    onSave() {
      wx.showLoading({ title: '生成中', mask: true })
      wx.createSelectorQuery()
        .in(this)
        .select('#poster')
        .fields({ node: true })
        .exec((res) => {
          const canvas = res && res[0] && res[0].node
          if (!canvas) {
            wx.hideLoading()
            wx.showToast({ title: '导出失败', icon: 'none' })
            return
          }
          wx.canvasToTempFilePath({
            canvas,
            success: (r) => {
              wx.hideLoading()
              this.saveToAlbum(r.tempFilePath)
            },
            fail: () => {
              wx.hideLoading()
              wx.showToast({ title: '导出失败', icon: 'none' })
            }
          })
        })
    },

    saveToAlbum(path) {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
        fail: (err) => {
          const msg = String((err && err.errMsg) || '')
          if (msg.indexOf('auth') > -1 || msg.indexOf('deny') > -1 || msg.indexOf('权限') > -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中允许保存图片到相册',
              confirmText: '去设置',
              success: (m) => {
                if (m.confirm) wx.openSetting()
              }
            })
          } else {
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        }
      })
    }
  }
})
