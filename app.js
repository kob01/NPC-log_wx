const auth = require("./utils/auth");
const appVisit = require("./utils/appVisit");

App({
  globalData: {
    userInfo: null,
    // 日志列表脏标记：新增/保存/删除后置 true，列表 onShow 据此重拉
    timelineDirty: false,
    // 当前主题：'light' | 'dark'，由系统/微信深浅色驱动，页面据此挂 .theme-dark 类实时切换
    theme: "light",
  },

  onLaunch() {
    // 启动时同步一次本地用户信息，供各页读取（真正的登录校验在各页 onShow 拦截）
    const user = auth.getUser();
    if (user) {
      this.globalData.userInfo = user;
    }
    this.initTheme();
    // 访问打点：起网络类型监听。真正的「这一次打开」由下面的 onShow 记（那才拿得到 scene）
    appVisit.init();
  },

  /**
   * 每次进前台记一行访问（点开次数就按这张表数）。
   * 必须挂在 App 而不是页面上：用户点进来可能一屏未看就退回微信，
   * 而登录拦截页恰好就是那种「到了但没进得去」的地方。
   */
  onShow(options) {
    // fire-and-forget：内部已全包 try/catch，这里再兜一层底，打点绝不允许把启动链路弄失败
    try {
      Promise.resolve(appVisit.onAppShow(options)).catch(() => {});
    } catch (e) {
      /* 忽略 */
    }
  },

  /** 切后台/退回微信：给刚才那一行收尾（停留时长由服务端算，发不出去也不影响记录本身） */
  onHide() {
    try {
      appVisit.onAppHide();
    } catch (e) {
      /* 忽略 */
    }
  },

  /**
   * 初始化主题并监听切换。
   * @media (prefers-color-scheme) 在小程序运行中不会实时重算（尤其 Android），
   * 必须靠 wx.onThemeChange 主动把新主题推给所有存活页面，才能免重进即时换色。
   */
  initTheme() {
    try {
      const info = wx.getAppBaseInfo
        ? wx.getAppBaseInfo()
        : wx.getSystemInfoSync();
      this.globalData.theme = info.theme === "dark" ? "dark" : "light";
    } catch (e) {
      this.globalData.theme = "light";
    }
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        const theme = res && res.theme === "dark" ? "dark" : "light";
        this.globalData.theme = theme;
        this.applyThemeToPages(theme);
      });
    }
  },

  /** 把主题变更推给当前栈上所有页面（页面通过 themeBehavior 暴露 setTheme） */
  applyThemeToPages(theme) {
    const pages = getCurrentPages() || [];
    pages.forEach((page) => {
      if (page && typeof page.setTheme === "function") page.setTheme(theme);
    });
  },
});
