/**
 * 主题 Behavior：让页面跟随系统/微信深浅色实时切换。
 * - 进入（onLoad/onShow）时从 app.globalData 同步当前主题，避免冷启动/返回时闪色
 * - 暴露 setTheme，由 app.js 的 wx.onThemeChange 在切换瞬间推给栈上所有页面
 * 页面只需在根节点挂 class="page-root {{themeClass}}"，深色 token 定义在 app.wxss 的 .theme-dark 上。
 */
function sync(instance) {
  const app = getApp()
  const theme = app && app.globalData && app.globalData.theme
  applyTheme(instance, theme)
}

/** 切换根节点 .theme-dark 类，并同步窗口底色（消除 iOS 下拉回弹时露出的浅色边缘） */
function applyTheme(instance, theme) {
  const dark = theme === 'dark'
  instance.setData({ themeClass: dark ? 'theme-dark' : '' })
  if (wx.setBackgroundColor) {
    wx.setBackgroundColor({ backgroundColor: dark ? '#17181a' : '#f5f6f8' })
  }
}

module.exports = Behavior({
  data: {
    themeClass: ''
  },

  methods: {
    setTheme(theme) {
      applyTheme(this, theme)
    }
  },

  // 页面生命周期（behavior 与页面自身的同名钩子都会执行）
  onLoad() {
    sync(this)
  },

  onShow() {
    sync(this)
  }
})
