/**
 * 登录态管理：token / user / onlyMine 的读写与页面拦截
 */
const {
  TOKEN_KEY,
  USER_KEY,
  ONLY_MINE_KEY,
  MANUAL_LOGOUT_KEY,
} = require("../config");

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
 * 本地缓存的用户是否已设登录密码
 * @returns {boolean|null} null = 旧版缓存里没这个字段（登录时还没带回来），别拿它做硬判断
 */
function hasPassword() {
  const user = getUser();
  if (!user || user.has_password === undefined || user.has_password === null) {
    return null;
  }
  return !!user.has_password;
}

/**
 * 把几个字段同步进本地缓存的用户快照
 * 登录响应是一次性快照，绑/解绑、设密之后不回填就会一直显示相反状态
 * @param {object} patch
 */
function patchUser(patch) {
  const user = getUser();
  if (!user) return;
  const next = Object.assign({}, user, patch);
  setUser(next);
  const app = getApp();
  if (app) {
    app.globalData.userInfo = next;
  }
}

/**
 * 绑定/解绑成功后同步本地用户信息
 * @param {boolean} v
 */
function markWxBound(v) {
  patchUser({ wx_bound: !!v });
}

/**
 * 设置密码成功后同步本地用户信息（同时把「未设密码不能解绑」的拦截摘掉）
 * @param {boolean} v
 */
function markHasPassword(v) {
  patchUser({ has_password: !!v });
}

/** 「只看自己日志」开关 */
function getOnlyMine() {
  return !!wx.getStorageSync(ONLY_MINE_KEY);
}

/**
 * 记下「用户主动点了退出」：登录页这一次不再静默微信登录
 * 只用一次（用完即清），之后的冷启动照常静默续期
 */
function markManualLogout() {
  wx.setStorageSync(MANUAL_LOGOUT_KEY, 1);
}

/**
 * 取一次并清除「主动退出」标记
 * @returns {boolean} 本次进登录页是不是因为用户刚刚退出
 */
function consumeManualLogout() {
  const hit = !!wx.getStorageSync(MANUAL_LOGOUT_KEY);
  if (hit) wx.removeStorageSync(MANUAL_LOGOUT_KEY);
  return hit;
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
  hasPassword,
  patchUser,
  markWxBound,
  markHasPassword,
  getOnlyMine,
  setOnlyMine,
  markManualLogout,
  consumeManualLogout,
  toLogin,
  checkLogin,
};
