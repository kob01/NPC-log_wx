const api = require("../../utils/api");
const auth = require("../../utils/auth");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    username: "",
    password: "",
    loading: false,
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
        wx.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => {
          wx.reLaunch({ url: "/pages/timeline/timeline" });
        }, 600);
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
