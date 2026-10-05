const api = require("../../utils/api");
const auth = require("../../utils/auth");
const wxLogin = require("../../utils/wxLogin");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    username: "",
    password: "",
    loading: false,
    wxLoading: false,
    // 静默微信登录进行中：先占住卡片，避免用户边等边输、输完又被 reLaunch 打断
    autoLogging: true,
    // 后端未配置 AppSecret（或显式关了开关）时隐藏微信入口，而不是留个点了报错的按钮
    wxAvailable: true,
  },

  onLoad() {
    this._skippedAuto = false;
    this.trySilentLogin();
  },

  /**
   * 已绑定过微信的用户到此不再看见登录页：静默换一次 token 直接进首页
   * （token 过期被 401 踢回来时同样走这条路，用户感觉不到自己重新登录过）
   */
  async trySilentLogin() {
    if (auth.getToken()) {
      this.goHome();
      return;
    }
    const r = await wxLogin.silentLogin();
    // 用户已经点了「用账号密码登录」：这时再把他弹回首页会打断表单输入
    if (this._skippedAuto) return;
    this.setData({
      autoLogging: false,
      wxAvailable: !r.notAvailable,
    });
    if (r.ok) {
      this.goHome();
    }
  },

  /** 占位期间的逃生口：静默登录慢/卡住时不让用户干等 */
  onSkipAuto() {
    this._skippedAuto = true;
    this.setData({ autoLogging: false });
  },

  goHome(delay) {
    setTimeout(() => {
      wx.reLaunch({ url: "/pages/timeline/timeline" });
    }, delay || 0);
  },

  onInput(e) {
    // 不用计算属性名 { [key]: value }（会被增强编译转成
    // require('@swc/runtime/_define_property.js')，该 runtime 缺失时
    // 整个页面逻辑层注册失败，表现为开发者工具里按钮点了没反应），
    // 改用先建对象再 setData 的等价写法
    const patch = {};
    patch[e.currentTarget.dataset.key] = e.detail.value;
    this.setData(patch);
  },

  /** 微信一键登录：仅对「已把微信绑到某个账号」的用户有效 */
  async onWxLogin() {
    if (this.data.wxLoading) return;
    try {
      this.setData({ wxLoading: true });
      const r = await wxLogin.wxLogin();
      if (r.ok) {
        wx.showToast({ title: "登录成功", icon: "success" });
        this.goHome(600);
        return;
      }
      if (r.notAvailable) {
        // 后端没开微信登录：把入口摘掉，回到账号密码表单，不弹一句用户无法处理的错
        this.setData({ wxAvailable: false });
        return;
      }
      wx.showToast({
        title: r.needBind
          ? r.message || "请先用账号密码登录一次，之后可微信一键进入"
          : r.message || "微信登录失败，请稍后重试",
        icon: "none",
        duration: 2500,
      });
    } catch (err) {
      wx.showToast({ title: "微信登录失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ wxLoading: false });
    }
  },

  async onLogin() {
    const { username, password } = this.data;
    if (!username || !password) {
      wx.showToast({ title: "请输入账号和密码", icon: "none" });
      return;
    }
    try {
      this.setData({ loading: true });
      const { code, data, message } = await api.user.login(username, password);
      if (Number(code) === 200 && data && data.token) {
        auth.saveLogin(data);
        // 顺手把这个微信绑上：下次冷启动就能静默进首页，不用再输密码。
        // 必须在 token 落库之后再调（绑定接口要鉴权），且 code 要现取
        // —— 静默登录那一次的 code 已经被微信作废了。
        const bind = await wxLogin.bindCurrentWx();
        let title = "登录成功";
        let icon = "success";
        if (bind.bound) {
          title = "已登录并绑定微信";
        } else if (!bind.notAvailable && bind.message) {
          // 例如「该微信已绑定其他账号」：登录本身是成功的，但得说清为什么没绑上
          title = bind.message;
          icon = "none";
        }
        wx.showToast({
          title,
          icon,
          duration: icon === "success" ? 1500 : 2500,
        });
        this.goHome(600);
      } else {
        wx.showToast({ title: message || "用户名或密码错误", icon: "none" });
      }
    } catch (err) {
      wx.showToast({ title: "登录失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
