const auth = require('./utils/auth')

App({
  globalData: {
    userInfo: null,
    // 日志列表脏标记：新增/保存/删除后置 true，列表 onShow 据此重拉
    timelineDirty: false,
    // 当前主题：'light' | 'dark'，由系统/微信深浅色驱动，页面据此挂 .theme-dark 类实时切换
    theme: 'light'
  },

  onLaunch() {
    // 启动时同步一次本地用户信息，供各页读取（真正的登录校验在各页 onShow 拦截）
    const user = auth.getUser()
    if (user) {
      this.globalData.userInfo = user
    }
    this.initTheme()
  },

  /**
   * 初始化主题并监听切换。
   * @media (prefers-color-scheme) 在小程序运行中不会实时重算（尤其 Android），
   * 必须靠 wx.onThemeChange 主动把新主题推给所有存活页面，才能免重进即时换色。
   */
  initTheme() {
    try {
      const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
      this.globalData.theme = info.theme === 'dark' ? 'dark' : 'light'
    } catch (e) {
      this.globalData.theme = 'light'
    }
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        const theme = res && res.theme === 'dark' ? 'dark' : 'light'
        this.globalData.theme = theme
        this.applyThemeToPages(theme)
      })
    }
  },

  /** 把主题变更推给当前栈上所有页面（页面通过 themeBehavior 暴露 setTheme） */
  applyThemeToPages(theme) {
    const pages = getCurrentPages() || []
    pages.forEach((page) => {
      if (page && typeof page.setTheme === 'function') page.setTheme(theme)
    })
  }
})
