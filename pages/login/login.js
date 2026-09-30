const api = require('../../utils/api')
const auth = require('../../utils/auth')

Page({
  data: {
    username: '',
    password: '',
    loading: false
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  async onLogin() {
    const { username, password } = this.data
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    try {
      this.setData({ loading: true })
      const { code, data, message } = await api.user.login(username, password)
      if (Number(code) === 200 && data && data.token) {
        auth.saveLogin(data)
        wx.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/timeline/timeline' })
        }, 600)
      } else {
        wx.showToast({ title: message || '用户名或密码错误', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
