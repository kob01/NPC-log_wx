const api = require("../../utils/api");
const auth = require("../../utils/auth");
const wxLogin = require("../../utils/wxLogin");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    user: {},
    isAdmin: false,
    onlyMine: false,
    avatarText: "?",
    wxBound: false,
    wxAvailable: true,
    wxBusy: false,
    // 提醒待授权数（只用来打徽标，拉失败不影响这一页）
    remindNeedAuth: 0,
    remindPending: 0,
  },

  onShow() {
    if (!auth.checkLogin()) return;
    const user = auth.getUser() || {};
    const name = user.real_name || user.username || "";
    this.setData({
      user,
      isAdmin: auth.isAdmin(),
      onlyMine: auth.getOnlyMine(),
      avatarText: name ? name.charAt(0).toUpperCase() : "?",
      wxBound: auth.isWxBound(),
      wxAvailable: wxLogin.isAvailable(),
    });
    this.loadRemindBadge();
  },

  /**
   * 拉一次提醒状态只为拿两个数字：静默 + 不 await，
   * 服务端没配模板或接口挂了就保持 0（这一页不该因为提醒而不显示）
   */
  async loadRemindBadge() {
    try {
      const res = await api.reminder.config();
      if (Number(res.code) !== 200 || !res.data) return;
      this.setData({
        remindNeedAuth: Number(res.data.needAuth || 0),
        remindPending: Number(res.data.pending || 0),
      });
    } catch (err) {
      /* 徽标拿不到就算了，不打扰用户 */
    }
  },

  onToggleOnlyMine(e) {
    const v = e.detail.value;
    auth.setOnlyMine(v);
    this.setData({ onlyMine: v });
    wx.showToast({ title: v ? "已开启只看自己" : "已关闭", icon: "none" });
  },

  goReport() {
    wx.navigateTo({ url: "/pages/report/report" });
  },

  goPersons() {
    wx.navigateTo({ url: "/pages/persons/persons" });
  },

  goOrg() {
    wx.navigateTo({ url: "/pages/org/org" });
  },

  goReminders() {
    wx.navigateTo({ url: "/pages/reminders/reminders" });
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
   */
  onUnbindWx() {
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

  onLogout() {
    wx.showModal({
      title: "提示",
      content: "确定退出登录吗？",
      success: (res) => {
        if (res.confirm) {
          auth.clear();
          auth.toLogin();
        }
      },
    });
  },
});
