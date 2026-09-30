const auth = require('./utils/auth')

App({
  globalData: {
    userInfo: null
  },

  onLaunch() {
    // 启动时同步一次本地用户信息，供各页读取（真正的登录校验在各页 onShow 拦截）
    const user = auth.getUser()
    if (user) {
      this.globalData.userInfo = user
    }
  }
})
