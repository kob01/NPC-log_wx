const auth = require("../../utils/auth");
const wxLogin = require("../../utils/wxLogin");
const {
  USERNAME_RE,
  USERNAME_HINT,
  PWD_RE,
  PWD_HINT,
} = require("../../utils/validate");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    username: "",
    password: "",
    password2: "",
    loading: false,
  },

  onShow() {
    // 走到这里却已经有登录态（例如在填的时候另一台设备把这个微信登进去了）：
    // 直接进首页，别再让用户建一个用不上的号
    if (auth.getToken()) this.goHome(0);
  },

  onInput(e) {
    // 不用计算属性名 { [key]: value }（会被增强编译转成
    // require('@swc/runtime/_define_property.js')，该 runtime 缺失时整页注册失败），
    // 改用先建对象再 setData 的等价写法
    const patch = {};
    patch[e.currentTarget.dataset.key] = e.detail.value;
    this.setData(patch);
  },

  async onSubmit() {
    if (this.data.loading) return;
    const name = String(this.data.username || "").trim();
    const { password, password2 } = this.data;
    if (!name) {
      wx.showToast({ title: "请填写账号", icon: "none" });
      return;
    }
    if (!USERNAME_RE.test(name)) {
      wx.showToast({ title: USERNAME_HINT, icon: "none", duration: 2500 });
      return;
    }
    if (!PWD_RE.test(password)) {
      wx.showToast({ title: PWD_HINT, icon: "none", duration: 2500 });
      return;
    }
    if (password !== password2) {
      wx.showToast({ title: "两次输入的密码不一致", icon: "none" });
      return;
    }
    try {
      this.setData({ loading: true });
      // 这里要重新 wx.login 取一次 code：登录页探测用的那个已经被后端消费掉了
      // （一次性凭证，用过就废），而且账号与密码是这一页才刚拿到的
      const r = await wxLogin.wxLogin({
        allowRegister: true,
        username: name,
        password,
      });
      if (r.ok) {
        // saveLogin 已在 utils/wxLogin.js 里做过，这一页不必再管 token
        wx.showToast({ title: "注册成功", icon: "success", duration: 1500 });
        this.goHome(800);
        return;
      }
      // 重名等后端文案直接透出来：要改的输入框就在手边，不用再看第二句解释
      wx.showToast({
        title: r.message || "注册失败，请稍后重试",
        icon: "none",
        duration: 2500,
      });
    } catch (err) {
      wx.showToast({ title: "注册失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goHome(delay) {
    setTimeout(() => {
      wx.reLaunch({ url: "/pages/timeline/timeline" });
    }, delay || 0);
  },
});
