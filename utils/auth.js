/**
 * 登录态管理：token / user / onlyMine 的读写与页面拦截
 */
const { TOKEN_KEY, USER_KEY, ONLY_MINE_KEY } = require("../config");

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || "";
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token);
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function setUser(user) {
  wx.setStorageSync(USER_KEY, user || null);
}

function clear() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

/** 是否管理员（account_type === 1） */
function isAdmin() {
  const user = getUser();
  return !!user && Number(user.account_type) === 1;
}

/** 保存一次登录结果 */
function saveLogin(data) {
  if (data && data.token) {
    setToken(data.token);
  }
  if (data && data.user) {
    setUser(data.user);
    const app = getApp();
    if (app) {
      app.globalData.userInfo = data.user;
    }
  }
}

/** 本地缓存的用户是否已绑定微信（登录响应里的 wx_bound；后端不下发 openid，只下发这个布尔） */
function isWxBound() {
  const user = getUser();
  return !!(user && user.wx_bound);
}

/**
 * 绑定/解绑成功后同步本地用户信息
 * 不这么做的话「我的」页会拿着登录时的旧 wx_bound 一直显示相反的状态
 * @param {boolean} v
 */
function markWxBound(v) {
  const user = getUser();
  if (!user) return;
  user.wx_bound = !!v;
  setUser(user);
  const app = getApp();
  if (app) {
    app.globalData.userInfo = user;
  }
}

/** 「只看自己日志」开关 */
function getOnlyMine() {
  return !!wx.getStorageSync(ONLY_MINE_KEY);
}

function setOnlyMine(v) {
  wx.setStorageSync(ONLY_MINE_KEY, !!v);
}

/** 跳转登录页（reLaunch 清空页面栈，避免返回到需鉴权页） */
function toLogin() {
  wx.reLaunch({ url: "/pages/login/login" });
}

/**
 * 页面级登录拦截：无 token 则跳登录页并返回 false
 * @returns {boolean} 是否已登录
 */
function checkLogin() {
  if (!getToken()) {
    toLogin();
    return false;
  }
  return true;
}

module.exports = {
  getToken,
  setToken,
  getUser,
  setUser,
  saveLogin,
  clear,
  isAdmin,
  isWxBound,
  markWxBound,
  getOnlyMine,
  setOnlyMine,
  toLogin,
  checkLogin,
};
