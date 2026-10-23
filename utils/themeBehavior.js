/**
 * 主题 Behavior：让页面跟随系统/微信深浅色实时切换。
 * - 进入（onLoad/onShow）时从 app.globalData 同步当前主题，避免冷启动/返回时闪色
 * - 暴露 setTheme，由 app.js 的 wx.onThemeChange 在切换瞬间推给栈上所有页面
 * 页面只需在根节点挂 class="page-root {{themeClass}}"，深色 token 定义在 app.wxss 的 .theme-dark 上。
 */
function sync(instance) {
  const app = getApp();
  const theme = app && app.globalData && app.globalData.theme;
  applyTheme(instance, theme);
}

/**
 * 切换根节点 .theme-dark 类，并同步窗口底色（消除 iOS 下拉回弹时露出的浅色边缘）
 *
 * 值没变就直接返回：onLoad/onShow 每次进页都会走这里，无脑写一遍等于每个页面每次曝光
 * 都白发一次 setData（跨线程）+ 一次原生调用；切 tab、从详情页返回都属于这种高频场景。
 * 记在实例上的 `_themeApplied` 而不是读 data.themeClass：后者首次进页是空串，
 * 与「浅色」无法区分，会漏掉第一轮真正需要落地的那次。
 */
function applyTheme(instance, theme) {
  if (instance._themeApplied === theme) return;
  instance._themeApplied = theme;
  const dark = theme === "dark";
  instance.setData({ themeClass: dark ? "theme-dark" : "" });
  if (wx.setBackgroundColor) {
    wx.setBackgroundColor({ backgroundColor: dark ? "#17181a" : "#f5f6f8" });
  }
}

module.exports = Behavior({
  data: {
    themeClass: "",
  },

  methods: {
    setTheme(theme) {
      applyTheme(this, theme);
    },
  },

  // 页面生命周期（behavior 与页面自身的同名钩子都会执行）
  onLoad() {
    sync(this);
  },

  onShow() {
    sync(this);
  },
});
