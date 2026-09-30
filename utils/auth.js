/**
 * 登录态管理：token / user / onlyMine 的读写与页面拦截
 */
const { TOKEN_KEY, USER_KEY, ONLY_MINE_KEY } = require('../config')

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token)
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null
}

function setUser(user) {
  wx.setStorageSync(USER_KEY, user || null)
}

function clear() {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(USER_KEY)
}

/** 是否管理员（account_type === 1） */
function isAdmin() {
  const user = getUser()
  return !!user && Number(user.account_type) === 1
}

/** 保存一次登录结果 */
function saveLogin(data) {
  if (data && data.token) {
    setToken(data.token)
  }
  if (data && data.user) {
    setUser(data.user)
    const app = getApp()
    if (app) {
      app.globalData.userInfo = data.user
    }
  }
}

/** 「只看自己日志」开关 */
function getOnlyMine() {
  return !!wx.getStorageSync(ONLY_MINE_KEY)
}

function setOnlyMine(v) {
  wx.setStorageSync(ONLY_MINE_KEY, !!v)
}

/** 跳转登录页（reLaunch 清空页面栈，避免返回到需鉴权页） */
function toLogin() {
  wx.reLaunch({ url: '/pages/login/login' })
}

/**
 * 页面级登录拦截：无 token 则跳登录页并返回 false
 * @returns {boolean} 是否已登录
 */
function checkLogin() {
  if (!getToken()) {
    toLogin()
    return false
  }
  return true
}

module.exports = {
  getToken,
  setToken,
  getUser,
  setUser,
  saveLogin,
  clear,
  isAdmin,
  getOnlyMine,
  setOnlyMine,
  toLogin,
  checkLogin
}
