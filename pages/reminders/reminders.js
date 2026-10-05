/**
 * 定时提醒管理页
 *
 * 这一页要同时解释清楚两件微信侧的硬限制，所以界面结构是围绕它们排的：
 * 1. 推送目标是 openid：没绑定微信就绝对收不到（提示语里排在第一位）；
 * 2. 一次性订阅「授权一次只能发一条」：所以页面上必须有「攒次数」的入口，
 *    而新建提醒时会先看现有额度够不够，够就不打扰用户。
 *
 * 提醒本身可以独立存在，也可以挂在某条日志上（详情页「设提醒」带 eventId + title 跳过来）。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const subscribe = require("../../utils/subscribe");
const { nowDate } = require("../../utils/format");

/** 与后端 REPEAT_RULES 一一对应（顺序即 picker 顺序，后端不认识顺序，只认 value） */
const REPEATS = [
  { label: "不重复", value: "none" },
  { label: "每天", value: "daily" },
  { label: "每周", value: "weekly" },
  { label: "每月", value: "monthly" },
];

/**
 * 后端 remind_status 是数字（本项目约定：状态由后端算成数字，前端直接比较）
 * 1 启用待发 / 2 待重新授权 / 3 发送中 / 0 停用或已完成
 */
const STATUS_MAP = {
  1: { text: "等待推送", cls: "tag-blue" },
  2: { text: "需重新授权", cls: "tag-red" },
  3: { text: "推送中", cls: "tag-gold" },
  0: { text: "已结束", cls: "tag-gray" },
};

function repeatLabel(value) {
  const hit = REPEATS.filter((r) => r.value === value)[0];
  return hit ? hit.label : "不重复";
}

function repeatIndexOf(value) {
  const idx = REPEATS.map((r) => r.value).indexOf(value || "none");
  return idx < 0 ? 0 : idx;
}

/** 明天（默认提醒日期：约未来的事很少落在「今天此刻」） */
function tomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 'YYYY-MM-DD HH:mm:ss' → 尽量短的展示串
 * 只在字符串空间里切片，不 new Date()：小程序运行时的时区与服务器墙钟不一致时，
 * Date 会把提醒时间整体挪几个小时
 */
function prettyTime(s) {
  if (!s) return "";
  const day = String(s).slice(0, 10);
  const hm = String(s).slice(11, 16);
  const today = nowDate();
  if (day === today) return `今天 ${hm}`;
  if (day === tomorrowDate()) return `明天 ${hm}`;
  if (day.slice(0, 4) === today.slice(0, 4)) return `${day.slice(5)} ${hm}`;
  return `${day} ${hm}`;
}

/**
 * 安全解码：小程序的 query 参数在不同版本里可能被框架预先解一次，
 * 再手动 decodeURIComponent 碰到「100%完成」这类标题会直接抛 URIError 把页面弄白
 */
function safeDecode(v) {
  if (!v) return "";
  try {
    return decodeURIComponent(String(v));
  } catch (e) {
    return String(v);
  }
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    loading: true,
    list: [],
    cfg: null,
    hint: "",
    subHint: subscribe.SUBSCRIBE_HINT,
    showForm: false,
    saving: false,
    busyAuth: false,
    testing: false,
    withDone: false,
    repeats: REPEATS,
    // 表单：新建与编辑共用一套字段
    form: {
      id: 0,
      title: "",
      date: "",
      timeStr: "",
      repeatIndex: 0,
      remark: "",
      eventId: 0,
      eventName: "",
      origTime: "",
    },
  },

  onLoad(options) {
    if (!auth.checkLogin()) return;
    const opt = options || {};
    // 从日志详情带过来：预填标题并直接展开表单（eventId 只用于通知里能说「是哪条」）
    const form = Object.assign({}, this.data.form, {
      date: tomorrowDate(),
      timeStr: "09:00",
      eventId: Number(opt.eventId) || 0,
      eventName: safeDecode(opt.eventName),
      title: safeDecode(opt.title),
    });
    this.setData({ form, showForm: !!form.eventId });
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /** 配置与列表一起拉：两个接口都静默失败，页面靠 hint 说清楚为什么 */
  async refresh() {
    try {
      const [cfgRes, listRes] = await Promise.all([
        api.reminder.config(),
        api.reminder.list(this.data.withDone),
      ]);
      const patch = { loading: false };
      if (Number(cfgRes.code) === 200) {
        patch.cfg = cfgRes.data || {};
        patch.hint = (cfgRes.data && cfgRes.data.hint) || "";
      }
      if (Number(listRes.code) === 200) {
        patch.list = (listRes.data || []).map((r) =>
          Object.assign({}, r, {
            timeText: prettyTime(r.time),
            lastPushText: prettyTime(r.lastPushTime),
            repeatText: repeatLabel(r.repeat),
            statusText: (STATUS_MAP[r.status] || STATUS_MAP[0]).text,
            statusCls: (STATUS_MAP[r.status] || STATUS_MAP[0]).cls,
            enabled: r.status === 1 || r.status === 3,
          }),
        );
      }
      this.setData(patch);
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  // ==================== 表单 ====================

  onInput(e) {
    // 不用计算属性名 { [key]: value }（会被增强编译转成缺失的 runtime 引用，
    // 表现为整个页面逻辑层注册失败），改成先建对象再 setData
    const patch = {};
    patch[`form.${e.currentTarget.dataset.key}`] = e.detail.value;
    this.setData(patch);
  },

  onDateChange(e) {
    this.setData({ "form.date": e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ "form.timeStr": e.detail.value });
  },

  onRepeatChange(e) {
    this.setData({ "form.repeatIndex": Number(e.detail.value) });
  },

  toggleForm() {
    const show = !this.data.showForm;
    this.setData({ showForm: show });
    if (show && !this.data.form.date) {
      this.setData({ "form.date": tomorrowDate(), "form.timeStr": "09:00" });
    }
  },

  /** 编辑：把列表行灌回表单（表单展开在顶部，滚动定位过去即可） */
  onEdit(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.list.filter((r) => r.id === id)[0];
    if (!row) return;
    this.setData({
      showForm: true,
      form: {
        id: row.id,
        title: row.title,
        date: String(row.time).slice(0, 10),
        timeStr: String(row.time).slice(11, 16),
        // origTime 记住行上的原值：只改标题时不把旧时间一起提交，
        // 否则后端会按「用户改了时间」拦一道「必须晚于现在」，已过期的提醒就再也改不了
        origTime: String(row.time).slice(0, 16),
        repeatIndex: repeatIndexOf(row.repeat),
        remark: row.remark || "",
        eventId: row.eventId || 0,
        eventName: row.eventName || "",
      },
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onCancelForm() {
    this.setData({
      showForm: false,
      form: {
        id: 0,
        title: "",
        date: tomorrowDate(),
        timeStr: "09:00",
        origTime: "",
        repeatIndex: 0,
        remark: "",
        eventId: 0,
        eventName: "",
      },
    });
  },

  /** 拼出后端要的 'YYYY-MM-DD HH:mm'，并在这里挡掉明显不可能的时间（省一次往返） */
  composedTime() {
    const f = this.data.form;
    if (!f.date || !f.timeStr) return "";
    return `${f.date} ${f.timeStr}`;
  },

  /**
   * 保存（新建或编辑）
   *
   * 为什么额度够就不弹订阅框：一次性订阅每弹一次只能攒一条额度，
   * 而额度是账号级共享的 —— 有余量时再弹一次只是骚扰用户，还会让人误以为「又要授权了」。
   */
  async onSave() {
    if (this.data.saving) return;
    const f = this.data.form;
    const time = this.composedTime();
    if (!f.title || !String(f.title).trim()) {
      wx.showToast({ title: "请填写提醒内容", icon: "none" });
      return;
    }
    if (!time) {
      wx.showToast({ title: "请选择提醒时间", icon: "none" });
      return;
    }
    // 只有用户真的改了时间才要求在未来（与后端同一条规则，这里先拦一下省一次往返）
    const timeChanged = time !== f.origTime;
    if (timeChanged && !this.isFuture(time)) {
      wx.showToast({ title: "提醒时间要晚于现在", icon: "none" });
      return;
    }
    const cfg = this.data.cfg || {};
    this.setData({ saving: true });
    let subOk = true;
    try {
      // 1) 先攒额度再落库：弹窗必须由本次点击触发，换了顺序就调不起来
      const pending = Number(cfg.pending || 0);
      const quota = Number(cfg.quota || 0);
      if (cfg.templateId && quota <= pending) {
        const sub = await subscribe.addSubscribeQuota(cfg.templateId, 1);
        subOk = !!sub.ok;
      }

      // 2) 落库
      const payload = {
        title: String(f.title).trim(),
        repeat: (REPEATS[f.repeatIndex] || REPEATS[0]).value,
        remark: f.remark || "",
      };
      if (timeChanged || !f.id) payload.time = time;
      if (f.eventId) payload.eventId = f.eventId;
      const res = f.id
        ? await api.reminder.update(Object.assign({ id: f.id }, payload))
        : await api.reminder.create(payload);
      if (Number(res.code) !== 200) {
        wx.showToast({ title: res.message || "保存失败", icon: "none" });
        return;
      }
      // 没拿到订阅授权不算失败（提醒已经入库），但必须把「收不到」说出来
      wx.showToast({
        title: subOk
          ? f.id
            ? "已更新"
            : "提醒已创建"
          : "已保存，但未授权可能收不到",
        icon: subOk ? "success" : "none",
        duration: subOk ? 1500 : 2500,
      });
      this.onCancelForm();
      this.refresh();
    } catch (err) {
      wx.showToast({ title: "保存失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 用 Date 判断「晚于现在」：这里比较的是本机时间与本机填的墙钟，只用于拦明显笔误 */
  isFuture(time) {
    const t = new Date(String(time).replace(" ", "T")).getTime();
    return Number.isFinite(t) && t > Date.now();
  },

  // ==================== 列表操作 ====================

  async onToggleStatus(e) {
    const id = Number(e.currentTarget.dataset.id);
    const enabled = !!e.detail.value;
    try {
      const res = await api.reminder.setStatus(id, enabled);
      if (Number(res.code) !== 200) {
        wx.showToast({ title: res.message || "操作失败", icon: "none" });
      }
    } catch (err) {
      wx.showToast({ title: "网络异常，请稍后重试", icon: "none" });
    }
    this.refresh();
  },

  onDelete(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.list.filter((r) => r.id === id)[0];
    wx.showModal({
      title: "删除提醒",
      content: `确定删除「${(row && row.title) || "这条提醒"}」？删除后到点不会再推送。`,
      confirmText: "删除",
      confirmColor: "#f5222d",
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await api.reminder.remove(id);
          if (Number(res.code) !== 200) {
            wx.showToast({ title: res.message || "删除失败", icon: "none" });
            return;
          }
          wx.showToast({ title: "已删除", icon: "success" });
        } catch (err) {
          wx.showToast({ title: "网络异常，请稍后重试", icon: "none" });
        }
        this.refresh();
      },
    });
  },

  goEvent(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  toggleDone() {
    const withDone = !this.data.withDone;
    this.setData({ withDone });
    this.refresh();
  },

  // ==================== 额度与自检 ====================

  /** 手动续订：一次点一下最多攒一条，重复点即可攒多条（微信的限制，不是我们的选择） */
  async onAuthorize() {
    if (this.data.busyAuth) return;
    const cfg = this.data.cfg || {};
    if (!cfg.templateId) {
      wx.showToast({ title: "服务端未配置提醒模板", icon: "none" });
      return;
    }
    this.setData({ busyAuth: true });
    try {
      const sub = await subscribe.addSubscribeQuota(cfg.templateId, 1);
      if (sub.ok) {
        wx.showToast({
          title:
            sub.released > 0
              ? `已续订，${sub.released} 条暂停的提醒将补发`
              : `已续订，当前 ${sub.quota} 次`,
          icon: "none",
          duration: 2500,
        });
        if (sub.needBind) {
          wx.showModal({
            title: "还没绑定微信",
            content:
              "提醒次数已到账，但这个账号还没绑定微信，推送找不到收件人。请到「我的」页绑定微信。",
            showCancel: false,
          });
        }
      } else {
        wx.showToast({
          title: sub.reason || "未授权",
          icon: "none",
          duration: 2500,
        });
      }
      this.refresh();
    } finally {
      this.setData({ busyAuth: false });
    }
  },

  /** 立刻给自己推一条：把「模板 ID / 字段映射 / IP 白名单 / 版本」四类配置错一次点穿 */
  async onTest() {
    if (this.data.testing) return;
    this.setData({ testing: true });
    try {
      const res = await api.reminder.test();
      if (Number(res.code) === 200) {
        wx.showToast({
          title: "已推送，去微信服务通知看看",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      const kind = res.data && res.data.kind;
      const tips = {
        noQuota: "订阅次数已用完，先点「续订提醒次数」",
        templateArgs: "模板字段与配置不匹配，检查 WX_SUBSCRIBE_FIELD_MAP",
        badOpenid: "openid 无效，请重新绑定微信",
        config: "服务端凭证不可用（AppSecret 或 IP 白名单）",
      };
      wx.showModal({
        title: "推送失败",
        content: `${res.message || "下发失败"}${tips[kind] ? `｜${tips[kind]}` : ""}`,
        showCancel: false,
      });
    } catch (err) {
      wx.showToast({ title: "推送请求失败", icon: "none" });
    } finally {
      this.setData({ testing: false });
    }
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});
