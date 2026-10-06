const api = require("../../utils/api");
const auth = require("../../utils/auth");
const wxLogin = require("../../utils/wxLogin");

/**
 * 账号资料页：从「我的」页顶部的用户卡片进入，集中管理
 * 用户名 / 邮箱 / 登录密码 / 微信登录 这四项与账号身份相关的设置。
 */
Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    user: {},
    wxBound: false,
    wxAvailable: true,
    wxBusy: false,
    // 只有微信身份的账号（has_password===false）不能解绑微信，否则等于把自己锁在门外
    noPassword: false,
    // 资料修改提交中，防重复点
    profileBusy: false,
  },

  onShow() {
    if (!auth.checkLogin()) return;
    this.applyUser();
  },

  /**
   * 用本地用户快照重绘四行（onShow 与下拉刷新共用一套口径）
   * 邮箱/绑定态/密码都取缓存里的值，refresh() 拉到的真值也是先写回缓存再走这里
   */
  applyUser() {
    const user = auth.getUser() || {};
    this.setData({
      user,
      wxBound: auth.isWxBound(),
      wxAvailable: wxLogin.isAvailable(),
      // 旧版缓存里没这个字段（null）时不拦截：让后端按库里的真值回答
      noPassword: auth.hasPassword() === false,
    });
  },

  /**
   * 下拉刷新：本地快照是登录那一刻的一次性拷贝，网页端改了邮箱、
   * 在另一台设备上绑/解绑了微信，这里不重登就会一直显示旧状态，
   * 所以拉一次 /api/user/profile 把真值回填缓存再重绘
   */
  async refresh() {
    try {
      const r = await api.user.profile();
      // 业务失败（code!==200）与网络异常、401 都由 request 层弹提示，这里不重复弹
      if (Number(r.code) !== 200) return;
      auth.patchUser(r.data || {});
      this.applyUser();
    } catch (err) {
      // 接口抛错时提示也已经弹过了，接一下只是为了让 onPullDownRefresh 能收尾
    }
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /** 修改用户名（real_name）：弹输入框，确认后提交 */
  onEditName() {
    const cur = this.data.user.real_name || "";
    wx.showModal({
      title: "修改用户名",
      editable: true,
      placeholderText: "请输入用户名",
      content: cur,
      success: (res) => {
        if (!res.confirm) return;
        const v = (res.content || "").trim();
        if (!v) {
          wx.showToast({ title: "用户名不能为空", icon: "none" });
          return;
        }
        if (v.length > 50) {
          wx.showToast({ title: "用户名不能超过 50 个字", icon: "none" });
          return;
        }
        if (v === cur) return;
        this.saveProfile({ real_name: v });
      },
    });
  },

  /** 修改邮箱（邮件提醒的回落地址）：留空表示清除 */
  onEditEmail() {
    const cur = this.data.user.email || "";
    wx.showModal({
      title: "修改邮箱",
      editable: true,
      placeholderText: "请输入邮箱",
      content: cur,
      success: (res) => {
        if (!res.confirm) return;
        const v = (res.content || "").trim();
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          wx.showToast({ title: "邮箱格式不正确", icon: "none" });
          return;
        }
        if (v === cur) return;
        this.saveProfile({ email: v });
      },
    });
  },

  /**
   * 提交资料修改并回填本地快照（后端只回 real_name/email，合并后重绘）
   */
  async saveProfile(patch) {
    if (this.data.profileBusy) return;
    this.setData({ profileBusy: true });
    try {
      const r = await api.user.updateProfile(patch);
      if (Number(r.code) === 200) {
        auth.patchUser(r.data || patch);
        this.setData({ user: auth.getUser() || {} });
        wx.showToast({ title: "已保存", icon: "success" });
      } else {
        wx.showToast({ title: r.message || "保存失败", icon: "none" });
      }
    } catch (err) {
      wx.showToast({ title: "保存失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ profileBusy: false });
    }
  },

  goPassword() {
    wx.navigateTo({ url: "/pages/password/password" });
  },

  /** 微信登录行：未绑定去绑定，已绑定走解绑（一个入口，避免两行几乎一样的按钮） */
  async onWxTap() {
    if (this.data.wxBusy) return;
    if (this.data.wxBound) {
      this.onUnbindWx();
      return;
    }
    this.setData({ wxBusy: true });
    const r = await wxLogin.bindCurrentWx();
    this.setData({
      wxBusy: false,
      wxBound: r.bound,
      // 后端回了「未开放」就把这一行摘掉，不要再给用户一个点了只会失败的按钮
      wxAvailable: !r.notAvailable,
    });
    if (r.bound) {
      wx.showToast({ title: "已绑定，下次可微信进入", icon: "success" });
    } else if (r.notAvailable) {
      wx.showToast({ title: "微信登录暂未开放", icon: "none" });
    } else {
      wx.showToast({
        title: r.message || "绑定失败",
        icon: "none",
        duration: 2500,
      });
    }
  },

  /**
   * 解绑：二次确认
   * 解绑只影响下一次的自动进入，当前 token 仍有效（不会把人踢回登录页）
   * ⚠ 没设过密码的账号先挡一下：后端也会拒，但在这里把后果说清比弹一句错好得多
   */
  onUnbindWx() {
    if (this.data.noPassword) {
      wx.showModal({
        title: "先设置一个密码",
        content:
          "这个账号只用微信注册、还没设置密码，解绑后就再也登不上来了（日志也拿不回来）。要不要现在设一个？",
        confirmText: "去设置",
        success: (res) => {
          if (res.confirm) this.goPassword();
        },
      });
      return;
    }
    wx.showModal({
      title: "解绑微信",
      content: "解绑后这个微信不再自动进入，下次需用账号密码登录。确定解绑？",
      confirmText: "解绑",
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          this.setData({ wxBusy: true });
          const r = await api.user.unbindWx();
          if (Number(r.code) === 200) {
            auth.markWxBound(false);
            this.setData({ wxBound: false });
            wx.showToast({ title: "已解绑", icon: "success" });
          } else {
            wx.showToast({ title: r.message || "解绑失败", icon: "none" });
          }
        } catch (err) {
          wx.showToast({ title: "解绑失败，请稍后重试", icon: "none" });
        } finally {
          this.setData({ wxBusy: false });
        }
      },
    });
  },
});
