const api = require("../../utils/api");
const auth = require("../../utils/auth");

function roleText(role) {
  const r = Number(role);
  if (r === 2) return "创建者";
  if (r === 1) return "管理者";
  return "成员";
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    tab: "mine",
    loading: true,
    myOrgs: [],
    square: [],
    pendingAll: [],
    pendingCount: 0,
    canManage: false,
    manageOpen: false,
    manageTab: "requests",
    curOrg: {},
    requests: [],
    members: [],
  },

  onShow() {
    if (!auth.checkLogin()) return;
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ loading: true });
    await Promise.all([
      this.loadMyOrgs(),
      this.loadSquare(),
      this.loadPendingAll(),
    ]);
    this.setData({ loading: false });
  },

  async loadMyOrgs() {
    const { code, data } = await api.org.mine();
    if (Number(code) === 200) {
      const myOrgs = (data || []).map((o) =>
        Object.assign({}, o, {
          roleText: roleText(o.my_role),
          my_status: Number(o.my_status),
          is_manager: Number(o.is_manager),
        }),
      );
      this.setData({
        myOrgs,
        canManage: myOrgs.some((o) => o.is_manager === 1),
      });
    }
  },

  async loadSquare() {
    const { code, data } = await api.org.public();
    if (Number(code) === 200) this.setData({ square: data || [] });
  },

  async loadPendingAll() {
    const { code, data } = await api.org.requests();
    if (Number(code) === 200) {
      const list = (data || []).map((r) =>
        Object.assign({}, r, { key: `${r.orgId}-${r.userId}` }),
      );
      this.setData({ pendingAll: list, pendingCount: list.length });
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === "mine") this.loadMyOrgs();
    if (tab === "square") this.loadSquare();
    if (tab === "pending") this.loadPendingAll();
  },

  onApply(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "申请加入",
      content: "确定申请加入该组织吗？",
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.apply(id);
        if (Number(code) === 200) {
          wx.showToast({ title: message || "申请已提交", icon: "none" });
          this.loadSquare();
        }
      },
    });
  },

  onLeave(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "退出组织",
      content: "确定退出该组织吗？",
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.leave(id);
        if (Number(code) === 200) {
          wx.showToast({ title: message || "已退出", icon: "none" });
          this.loadMyOrgs();
          this.loadSquare();
          if (Number(this.data.curOrg.id) === Number(id))
            this.setData({ manageOpen: false });
        }
      },
    });
  },

  onAuditGlobal(e) {
    const { org, user, approved } = e.currentTarget.dataset;
    this.doAudit(org, user, approved === "1", () => {
      this.loadPendingAll();
      this.loadMyOrgs();
      if (Number(this.data.curOrg.id) === Number(org) && this.data.manageOpen) {
        this.refreshManage(org);
      }
    });
  },

  doAudit(orgId, userId, approved, after) {
    wx.showModal({
      title: approved ? "通过申请" : "拒绝申请",
      content: `确定${approved ? "通过" : "拒绝"}该用户的加入申请吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.audit(
          Number(orgId),
          Number(userId),
          approved,
        );
        if (Number(code) === 200) {
          wx.showToast({ title: message || "操作成功", icon: "none" });
          after && after();
        }
      },
    });
  },

  openManage(e) {
    const id = e.currentTarget.dataset.id;
    const org = this.data.myOrgs.find((o) => Number(o.id) === Number(id)) || {};
    this.setData({ manageOpen: true, curOrg: org, manageTab: "requests" });
    this.refreshManage(id);
  },

  async refreshManage(orgId) {
    const [req, mem] = await Promise.all([
      api.org.requests(orgId),
      api.org.members(orgId),
    ]);
    if (Number(req.code) === 200) this.setData({ requests: req.data || [] });
    if (Number(mem.code) === 200) {
      const members = (mem.data || []).map((m) =>
        Object.assign({}, m, {
          role: Number(m.role),
          roleText: roleText(m.role),
        }),
      );
      this.setData({ members });
    }
  },

  switchManageTab(e) {
    this.setData({ manageTab: e.currentTarget.dataset.mt });
  },

  onAudit(e) {
    const { user, approved } = e.currentTarget.dataset;
    const orgId = this.data.curOrg.id;
    this.doAudit(orgId, user, approved === "1", () => {
      this.refreshManage(orgId);
      this.loadMyOrgs();
      this.loadPendingAll();
    });
  },

  onSetManager(e) {
    const { user, role } = e.currentTarget.dataset;
    const orgId = this.data.curOrg.id;
    const isPromote = Number(role) === 1;
    wx.showModal({
      title: isPromote ? "提升为管理者" : "降级为成员",
      content: `确定${isPromote ? "提升" : "降级"}该成员吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.setManager(
          Number(orgId),
          Number(user),
          Number(role),
        );
        if (Number(code) === 200) {
          wx.showToast({ title: message || "操作成功", icon: "none" });
          this.refreshManage(orgId);
          this.loadMyOrgs();
        }
      },
    });
  },

  closeManage() {
    this.setData({ manageOpen: false });
  },
});
