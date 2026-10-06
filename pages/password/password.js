const api = require("../../utils/api");
const auth = require("../../utils/auth");
// 密码规则与 Web 端注册、微信注册页同源（见 utils/validate.js）
const { PWD_RE, PWD_HINT } = require("../../utils/validate");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    username: "",
    // 已有密码时才要求填当前密码（后端同样会拒「不带旧密码」的请求，这里只是提前拦住）
    needOld: false,
    oldPassword: "",
    password: "",
    password2: "",
    loading: false,
  },

  onLoad() {
    const user = auth.getUser() || {};
    // has_password 拿不到（旧版缓存没这个字段）时按「修改密码」走：
    // 宁可多问一次当前密码，也不能让用户以为「设一个新密码就能顶掉旧的」
    const needOld = auth.hasPassword() !== false;
    this.setData({ username: user.username || "", needOld });
    wx.setNavigationBarTitle({ title: needOld ? "修改密码" : "设置密码" });
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
    const { needOld, oldPassword, password, password2 } = this.data;
    if (needOld && !oldPassword) {
      wx.showToast({ title: "请输入当前密码", icon: "none" });
      return;
    }
    if (!PWD_RE.test(password)) {
      wx.showToast({ title: PWD_HINT, icon: "none", duration: 2500 });
      return;
    }
    if (password !== password2) {
      wx.showToast({ title: "两次输入的新密码不一致", icon: "none" });
      return;
    }
    if (needOld && password === oldPassword) {
      wx.showToast({ title: "新密码不能与当前密码相同", icon: "none" });
      return;
    }
    try {
      this.setData({ loading: true });
      const res = await api.user.setPassword(
        password,
        needOld ? oldPassword : "",
      );
      if (Number(res.code) === 200) {
        // 回填本地快照：不然「我的」页还拿着 has_password=false，
        // 会继续用「未设密码不能解绑」拦住一个其实已经能解绑的账号
        auth.markHasPassword(true);
        wx.showToast({
          title: res.message || "密码已设置",
          icon: "success",
          duration: 1200,
        });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      wx.showToast({
        title: res.message || "设置失败，请稍后重试",
        icon: "none",
        duration: 2500,
      });
    } catch (err) {
      wx.showToast({ title: "设置失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
