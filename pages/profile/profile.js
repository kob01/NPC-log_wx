const auth = require("../../utils/auth");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    user: {},
    isAdmin: false,
    onlyMine: false,
    avatarText: "?",
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
    });
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
