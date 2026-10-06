const api = require("../../utils/api");
const auth = require("../../utils/auth");

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    user: {},
    isAdmin: false,
    onlyMine: false,
    avatarText: "?",
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

  /** 进入「账号资料」页：用户名/邮箱/登录密码/微信登录 都在那里改 */
  goAccount() {
    wx.navigateTo({ url: "/pages/account/account" });
  },

  onLogout() {
    wx.showModal({
      title: "提示",
      content: "确定退出登录吗？",
      success: (res) => {
        if (res.confirm) {
          // 先打标记再清登录态：不然到了登录页，静默微信登录会把刚退出去的那个
          // 微信立刻又送回首页（绑过微信的账号占绝大多数，看起来就是退出无效）
          auth.markManualLogout();
          auth.clear();
          auth.toLogin();
        }
      },
    });
  },
});
