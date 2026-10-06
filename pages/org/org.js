const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { formatDateTime } = require("../../utils/format");

function roleText(role) {
  const r = Number(role);
  if (r === 2) return "创建者";
  if (r === 1) return "管理者";
  return "成员";
}

/**
 * 后端日期统一被 JSON 化成 UTC 串（2026-10-06T04:00:00.000Z），
 * 直接上屏会是一串机器读，这里转成本地 YYYY-MM-DD HH:mm
 * @param {string} v 后端时间
 */
function fmtTime(v) {
  if (!v) return "";
  const s = String(v);
  if (s.indexOf("T") < 0) return s.slice(0, 16); // 已是后端格式化好的本地时间
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : formatDateTime(d);
}

/** 只取日期部分 YYYY-MM-DD */
function fmtDate(v) {
  return fmtTime(v).slice(0, 10);
}

/** 申请状态文案：0 待审批 / 1 已通过 / 2 已拒绝 */
function applyStatusText(status) {
  const s = Number(status);
  if (s === 1) return "已通过";
  if (s === 2) return "已拒绝";
  return "待审批";
}

/** 展示名：昵称为空时回落登录账号（后端两个字段都给了，只取昵称会整行空白） */
function displayName(row) {
  return row.real_name || row.username || "未知用户";
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
    // 我提交的进行中申请 / 已结束的审批记录（两个方向合一张表）
    applications: [],
    records: [],
    // 记录详情弹层：列表只放结论，理由点开看
    detailOpen: false,
    detail: {},
    canManage: false,
    manageOpen: false,
    curOrg: {},
    members: [],
    // 新建/编辑组织表单（formId=0 为新建）
    formOpen: false,
    formId: 0,
    formName: "",
    formDesc: "",
    submitting: false,
  },

  onShow() {
    if (!auth.checkLogin()) return;
    // 每次进页强制重拉：组织成员/审批状态在 Web 端也会变，60s 本地缓存会让人看到旧数据
    this.loadAll(true);
  },

  onPullDownRefresh() {
    this.loadAll(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * @param {boolean} [force] 跳过本地缓存真发请求（进页/下拉刷新）
   */
  async loadAll(force) {
    // 已有数据时不再整页换成 loading，否则下拉刷新会把列表闪没
    if (!this.data.myOrgs.length && !this.data.square.length) {
      this.setData({ loading: true });
    }
    try {
      await Promise.all([
        this.loadMyOrgs(force),
        this.loadSquare(force),
        this.loadPendingAll(),
        this.loadApplications(force),
        this.loadRecords(force),
      ]);
    } catch (err) {
      // 请求层的提示已经弹过了，这里接一下只为让下拉刷新能收尾、列表不卡在 loading
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMyOrgs(force) {
    const { code, data } = await api.org.mine(force);
    if (Number(code) === 200) {
      const myOrgs = (data || []).map((o) =>
        Object.assign({}, o, {
          roleText: roleText(o.my_role),
          my_status: Number(o.my_status),
          is_manager: Number(o.is_manager),
          // 卡片 meta：谁建的、什么时候建的（自己加入的组织也得能分辨同名组织）
          creatorText: o.creator_name || "",
          createdText: fmtDate(o.created_at),
        }),
      );
      this.setData({
        myOrgs,
        canManage: myOrgs.some((o) => o.is_manager === 1),
      });
    }
  },

  async loadSquare(force) {
    const { code, data } = await api.org.public(force);
    if (Number(code) === 200) {
      this.setData({
        square: (data || []).map((o) =>
          Object.assign({}, o, {
            creatorText: o.creator_name || "",
            createdText: fmtDate(o.created_at),
          }),
        ),
      });
    }
  },

  async loadPendingAll() {
    const { code, data } = await api.org.requests();
    if (Number(code) === 200) {
      const list = (data || []).map((r) =>
        Object.assign({}, r, {
          key: `${r.orgId}-${r.userId}`,
          nameText: displayName(r),
          applyText: fmtTime(r.apply_time),
          reasonText: r.apply_reason || "",
        }),
      );
      this.setData({ pendingAll: list, pendingCount: list.length });
    }
  },

  /** 我提交的进行中申请：已通过的在「我的组织」，已出结果的在「审批结束」 */
  async loadApplications(force) {
    const { code, data } = await api.org.applications(force);
    if (Number(code) === 200) {
      const list = (data || [])
        .filter((r) => Number(r.status) === 0)
        .map((r) =>
          Object.assign({}, r, {
            statusText: applyStatusText(r.status),
            applyText: fmtTime(r.apply_time),
            reasonText: r.apply_reason || "",
          }),
        );
      this.setData({ applications: list });
    }
  },

  /**
   * 已结束的审批记录：direction=mine 是我申请的，org 是我管的组织里别人的
   * 列表只放结论，理由收在详情弹层里
   */
  async loadRecords(force) {
    const { code, data } = await api.org.records(force);
    if (Number(code) === 200) {
      const list = (data || []).map((r) =>
        Object.assign({}, r, {
          key: `${r.direction}-${r.orgId}-${r.userId}`,
          directionText: r.direction === "mine" ? "我申请的" : "我的组织",
          nameText: displayName(r),
          resultText: Number(r.status) === 1 ? "已通过" : "已拒绝",
          ok: Number(r.status) === 1 ? 1 : 0,
          reasonText: r.apply_reason || "",
          rejectText: r.audit_reason || "",
          auditorText: r.auditor_name || "",
          applyText: fmtTime(r.apply_time),
          auditText: fmtTime(r.audit_time),
          // 自己申请且被拒、组织还在启用 → 允许再试一次
          canReapply:
            r.direction === "mine" &&
            Number(r.status) === 2 &&
            Number(r.org_status) === 1
              ? 1
              : 0,
        }),
      );
      this.setData({ records: list });
    }
  },

  /** 点开记录看理由 */
  openDetail(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const row = this.data.records[idx];
    if (!row) return;
    this.setData({ detailOpen: true, detail: row });
  },

  closeDetail() {
    this.setData({ detailOpen: false });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === "mine") this.loadMyOrgs();
    if (tab === "square") this.loadSquare();
    if (tab === "pending") this.loadPendingAll();
    if (tab === "applications") this.loadApplications();
    if (tab === "records") this.loadRecords();
  },

  /**
   * 申请加入：用 showModal 的 editable 收一个可选理由，
   * 为一个输入框再开一层弹层面板不划算
   */
  onApply(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || "该组织";
    wx.showModal({
      title: `申请加入 ${name}`,
      editable: true,
      placeholderText: "说说你为什么想加入（选填）",
      success: async (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || "").trim();
        const { code, message } = await api.org.apply(id, reason);
        if (Number(code) === 200) {
          wx.showToast({ title: message || "申请已提交", icon: "none" });
          // 重新申请会让这条记录从「审批结束」回到「我的申请」，两边都要重拉
          this.setData({ detailOpen: false });
          this.loadSquare();
          this.loadApplications();
          this.loadRecords();
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
          // 退出会连成员行一起删，申请记录里的那行也要跟着消
          this.loadApplications();
          this.loadRecords();
          if (Number(this.data.curOrg.id) === Number(id))
            this.setData({ manageOpen: false });
        }
      },
    });
  },

  onAuditGlobal(e) {
    const { org, user, approved, name } = e.currentTarget.dataset;
    this.doAudit(org, user, approved === "1", name, () => {
      this.loadPendingAll();
      this.loadRecords();
      this.loadMyOrgs();
      this.loadApplications();
      if (Number(this.data.curOrg.id) === Number(org) && this.data.manageOpen) {
        this.loadMembers(org);
      }
    });
  },

  /**
   * 审批：通过保持一句确认；拒绝改成可输入理由（选填，会回显给申请人）
   * @param {number} orgId 组织ID
   * @param {number} userId 申请人
   * @param {boolean} approved 是否通过
   * @param {string} name 申请人展示名（拼进标题）
   * @param {Function} after 成功后的回调
   */
  doAudit(orgId, userId, approved, name, after) {
    const who = name || "该用户";
    if (approved) {
      wx.showModal({
        title: "通过申请",
        content: `确定通过 ${who} 的加入申请吗？`,
        success: async (res) => {
          if (!res.confirm) return;
          await this.submitAudit(orgId, userId, true, "", after);
        },
      });
      return;
    }
    wx.showModal({
      title: `拒绝 ${who} 的申请`,
      editable: true,
      placeholderText: "拒绝理由（选填，会回显给对方）",
      success: async (res) => {
        if (!res.confirm) return;
        await this.submitAudit(
          orgId,
          userId,
          false,
          String(res.content || "").trim(),
          after,
        );
      },
    });
  },

  async submitAudit(orgId, userId, approved, reason, after) {
    const { code, message } = await api.org.audit(
      Number(orgId),
      Number(userId),
      approved,
      reason,
    );
    if (Number(code) !== 200) return;
    wx.showToast({ title: message || "操作成功", icon: "none" });
    after && after();
  },

  /**
   * 打开成员名单：管理者与普通成员同一个入口，差别只在名单里给不给操作按钮
   * 待审批不在这里：顶部「待审批」tab 就是同一份数据的跳组织视图，不重复放一份
   */
  openMembers(e) {
    const id = e.currentTarget.dataset.id;
    const org = this.data.myOrgs.find((o) => Number(o.id) === Number(id)) || {};
    this.setData({ manageOpen: true, curOrg: org });
    this.loadMembers(id);
  },

  /** 拉当前弹层组织的成员名单 */
  async loadMembers(orgId) {
    const { code, data } = await api.org.members(orgId);
    if (Number(code) !== 200) return;
    // 名单里的操作按钮按身份收：普通成员只读，不给提升/降级/移出
    const isManager = Number(this.data.curOrg.is_manager) === 1;
    // 登录用户快照里的 id 就是 user_id；移自己没意义（该用退出组织）
    const meId = Number((auth.getUser() || {}).id);
    this.setData({
      members: (data || []).map((m) =>
        Object.assign({}, m, {
          role: Number(m.role),
          roleText: roleText(m.role),
          nameText: displayName(m),
          // 创建者不可被移出，自己也不能移自己，普通成员则谁都不能移
          canKick:
            isManager && Number(m.role) !== 2 && Number(m.id) !== meId ? 1 : 0,
        }),
      ),
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
          this.loadMembers(orgId);
          this.loadMyOrgs();
        }
      },
    });
  },

  /** 移出成员：只删成员关系，他立即看不到本组织的日志 */
  onKick(e) {
    const { user, name } = e.currentTarget.dataset;
    const orgId = this.data.curOrg.id;
    wx.showModal({
      title: "移出组织",
      content: `确定把 ${name || "该成员"} 移出组织吗？移出后他立即看不到本组织的日志。`,
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.kick(
          Number(orgId),
          Number(user),
        );
        if (Number(code) !== 200) return;
        wx.showToast({ title: message || "已移出", icon: "none" });
        this.loadMembers(orgId);
        this.loadMyOrgs();
      },
    });
  },

  closeManage() {
    this.setData({ manageOpen: false });
  },

  // ==================== 新建 / 编辑 / 解散组织 ====================

  openCreate() {
    this.setData({
      formOpen: true,
      formId: 0,
      formName: "",
      formDesc: "",
    });
  },

  /** 从成员名单弹层里改自己组织的名称/描述（只给管理者） */
  openEdit() {
    const org = this.data.curOrg || {};
    if (!Number(org.is_manager)) return;
    this.setData({
      formOpen: true,
      formId: Number(org.id),
      formName: org.org_name || "",
      formDesc: org.description || "",
    });
  },

  closeForm() {
    this.setData({ formOpen: false });
  },

  onFormName(e) {
    this.setData({ formName: e.detail.value });
  },

  onFormDesc(e) {
    this.setData({ formDesc: e.detail.value });
  },

  async submitForm() {
    if (this.data.submitting) return;
    const name = String(this.data.formName || "").trim();
    if (!name) {
      wx.showToast({ title: "请输入组织名称", icon: "none" });
      return;
    }
    const id = Number(this.data.formId);
    const body = {
      org_name: name,
      description: String(this.data.formDesc || "").trim(),
    };
    this.setData({ submitting: true });
    // 编辑只放开名称与描述：启停用是平台治理权，一般用户传了后端也会拦下
    const res = id
      ? await api.org.update(id, body)
      : await api.org.create(body);
    this.setData({ submitting: false });
    if (Number(res.code) !== 200) return;
    wx.showToast({
      title: res.message || (id ? "已保存" : "创建成功"),
      icon: "none",
    });
    if (id && Number(this.data.curOrg.id) === id) {
      this.setData({
        formOpen: false,
        "curOrg.org_name": name,
        "curOrg.description": body.description,
      });
    } else {
      // 新建后回到「我的组织」，才能马上看到自己当创建者的那个
      this.setData({ formOpen: false, tab: "mine" });
    }
    this.loadAll();
  },

  /** 解散组织：后端会级联清掉成员关系与日志的可见组织关联，不可恢复 */
  onDismiss() {
    const org = this.data.curOrg || {};
    const id = Number(org.id);
    if (!id) return;
    wx.showModal({
      title: "解散组织",
      content:
        "解散后成员关系与日志的组织可见范围一并清除，且不可恢复，确定解散吗？",
      confirmColor: "#f5222d",
      success: async (res) => {
        if (!res.confirm) return;
        const { code, message } = await api.org.remove(id);
        if (Number(code) !== 200) return;
        wx.showToast({ title: message || "已解散", icon: "none" });
        this.setData({ manageOpen: false, formOpen: false, tab: "mine" });
        this.loadAll();
      },
    });
  },
});
