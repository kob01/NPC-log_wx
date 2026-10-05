/**
 * 定时提醒管理页
 *
 * 这一页要同时解释清楚两件微信侧的硬限制，所以界面结构是围绕它们排的：
 * 1. 推送目标是 openid：没绑定微信就绝对收不到（提示语里排在第一位）；
 * 2. 一次性订阅「授权一次只能发一条」：所以页面上必须有「攒次数」的入口，
 *    而新建提醒时会先看现有额度够不够，够就不打扰用户。
 * 邮件渠道就是为了绕开这两条：不依赖绑定、不消耗额度，所以选它时不弹订阅框。
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
  { label: "每年", value: "yearly" },
  { label: "自定义间隔", value: "custom" },
];

/**
 * 自定义间隔的可选单位（与后端 INTERVAL_UNIT 一一对应）
 * 没有「周」与「年」：这两档由固定的 每周/每年 覆盖，每年要的是「同月同日同时刻」，
 * 与「每 12 个月」在 2 月 29 日这种日期上语义不同，不能拿间隔代替
 */
const INTERVAL_UNITS = [
  { label: "个月", value: "month" },
  { label: "天", value: "day" },
  { label: "小时", value: "hour" },
  { label: "分钟", value: "minute" },
];

/** 间隔数值上限（与后端 INTERVAL_MAX 一致，超了后端会直接拒） */
const INTERVAL_MAX = 999;

/** 与后端 CHANNELS 一一对应：微信服务通知 / 邮件 / 两者都发 */
const CHANNELS = [
  { label: "微信服务通知", value: "wx" },
  { label: "邮件", value: "email" },
  { label: "两者都发", value: "both" },
];

/**
 * 后端 remind_status 是数字（本项目约定：状态由后端算成数字，前端直接比较）
 * 1 启用待发 / 2 待补收件条件 / 3 发送中 / 0 停用或已完成
 */
const STATUS_MAP = {
  1: { text: "等待推送", cls: "tag-blue" },
  2: { text: "需重新授权", cls: "tag-red" },
  3: { text: "推送中", cls: "tag-gold" },
  0: { text: "已结束", cls: "tag-gray" },
};

/**
 * 状态 2 在两个通道下意思完全不同：微信是「订阅次数用完」，
 * 邮件是「解析不出收件邮箱」。按渠道换文案，而不是去猜 last_error 的内容。
 */
function statusOf(row) {
  const base = STATUS_MAP[row.status] || STATUS_MAP[0];
  if (Number(row.status) === 2 && row.channel === "email") {
    return { text: "待补收件邮箱", cls: base.cls };
  }
  return base;
}

function repeatLabel(value) {
  const hit = REPEATS.filter((r) => r.value === value)[0];
  return hit ? hit.label : "不重复";
}

/**
 * 列表行上的重复文案：custom 必须把间隔一起说出来，
 * 否则一行只写着「自定义间隔」，看不出到底是多久
 */
function repeatTextOf(row) {
  if (row.repeat !== "custom") return repeatLabel(row.repeat);
  const unit = INTERVAL_UNITS.filter((u) => u.value === row.intervalUnit)[0];
  const n = Number(row.intervalValue);
  // 间隔丢了（段 17 之前的存量行）就退回「不重复」：拼一句「每 undefined 天」更让人困惑
  if (!unit || !Number.isFinite(n) || n < 1) return "不重复";
  return `每${n}${unit.label}`;
}

function repeatIndexOf(value) {
  const idx = REPEATS.map((r) => r.value).indexOf(value || "none");
  return idx < 0 ? 0 : idx;
}

function unitIndexOf(value) {
  const idx = INTERVAL_UNITS.map((u) => u.value).indexOf(value || "day");
  return idx < 0 ? 1 : idx;
}

function channelLabel(value) {
  const hit = CHANNELS.filter((c) => c.value === value)[0];
  return hit ? hit.label : "微信服务通知";
}

function channelIndexOf(value) {
  const idx = CHANNELS.map((c) => c.value).indexOf(value || "wx");
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

/**
 * 「现在」快捷要落在哪个分钟
 *
 * 取「服务器墙钟」与「本机时间」里更晚的一个 +1 分钟：
 * 1. 必须 +1 分钟：后端只接受「晚于当前时间」的提醒，填成此刻会被自己拦下，
 *    而且下一分钟的扫描本来就会把它带走，填整分钟对用户并不亏；
 * 2. 不能只信手机时间：手机比服务器快时看着合法，提交后后端一句
 *    「提醒时间必须晚于当前时间」让人看不出自己填得哪里不对；config 缓存 30s
 *    内取的服务器时间可能已陈，所以两个参照系取最晚的那个当基线。
 * 3. 不靠时区转换：服务端墙钟按本机时区解进去、再按本机时区格式化，
 *    同一参照系里加 60 秒是安全的（本项目无夏令时）。
 */
function nowParts(serverTime) {
  const local = new Date();
  const fromServer = serverTime
    ? new Date(String(serverTime).slice(0, 16).replace(" ", "T"))
    : null;
  const validServer = fromServer && Number.isFinite(fromServer.getTime());
  const base = validServer && fromServer > local ? fromServer : local;
  const d = new Date(base.getTime() + 60000);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    timeStr: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
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
    mailTesting: false,
    withDone: false,
    repeats: REPEATS,
    channels: CHANNELS,
    intervalUnits: INTERVAL_UNITS,
    intervalMax: INTERVAL_MAX,
    // 选中的渠道需不需要走微信那一路（决定要不要弹订阅框、按钮该叫什么）
    needWxSub: true,
    emailHint: "邮件提醒不消耗订阅次数，到点直接发到下面这个邮箱",
    // 表单：新建与编辑共用一套字段（channelIndex 选到邮件时不弹订阅框）
    form: {
      id: 0,
      title: "",
      date: "",
      timeStr: "",
      repeatIndex: 0,
      // 自定义间隔：数值走 input（给的是字符串，提交前才转数字）、单位走 picker
      intervalValue: "1",
      intervalUnitIndex: 1,
      channelIndex: 0,
      email: "",
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
    const channelIndex = Number(opt.eventId) ? channelIndexOf("email") : 0;
    const form = Object.assign({}, this.data.form, {
      date: tomorrowDate(),
      timeStr: "09:00",
      eventId: Number(opt.eventId) || 0,
      eventName: safeDecode(opt.eventName),
      title: safeDecode(opt.title),
      channelIndex,
    });
    // 从详情页进来默认走邮件：微信那条还要绑定+授权，邮件现在就能发
    this.setData({
      form,
      needWxSub: CHANNELS[channelIndex].value !== "email",
      showForm: !!form.eventId,
    });
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
        patch.list = (listRes.data || []).map((r) => {
          const st = statusOf(r);
          return Object.assign({}, r, {
            timeText: prettyTime(r.time),
            lastPushText: prettyTime(r.lastPushTime),
            repeatText: repeatTextOf(r),
            channelText: channelLabel(r.channel),
            statusText: st.text,
            statusCls: st.cls,
            enabled: r.status === 1 || r.status === 3,
          });
        });
      }
      this.setData(patch);
      this.prefillEmail();
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  /**
   * 把账号邮箱一次性填进表单（只填一次）：后端拿不到行上地址时会回落账号邮箱，
   * 但直接给用户看到目标地址比写在 placeholder 里更不容易理解错
   */
  prefillEmail() {
    if (this._emailFilled) return;
    const accountEmail = (this.data.cfg || {}).accountEmail || "";
    if (!accountEmail || !this.data.showForm || this.data.form.email) return;
    this._emailFilled = true;
    this.setData({ "form.email": accountEmail });
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

  /** 间隔数值：input 给的是字符串，提交前才转数字（非法值在 onSave 里统一拦） */
  onIntervalInput(e) {
    this.setData({ "form.intervalValue": e.detail.value });
  },

  onIntervalUnitChange(e) {
    this.setData({ "form.intervalUnitIndex": Number(e.detail.value) });
  },

  onChannelChange(e) {
    this.setChannel(Number(e.detail.value));
  },

  /**
   * 渠道切换只走这一个入口：channelIndex 与 needWxSub 必须同步，
   * 否则会出现「选了邮件却还弹订阅框」或「按钮写着续订却没得续」
   */
  setChannel(index) {
    const hit = CHANNELS[index] || CHANNELS[0];
    this.setData({
      "form.channelIndex": CHANNELS.indexOf(hit),
      needWxSub: hit.value !== "email",
    });
    // 切到邮件/两者且还没填地址时，把账号邮箱拿过来当默认值
    this.prefillEmail();
  },

  /** 快捷填上“现在”（日期一并拉回今天，默认值是明天 09:00） */
  onPickNow() {
    const parts = nowParts((this.data.cfg || {}).serverTime);
    this.setData({
      "form.date": parts.date,
      "form.timeStr": parts.timeStr,
    });
  },

  toggleForm() {
    const show = !this.data.showForm;
    this.setData({ showForm: show });
    if (show && !this.data.form.date) {
      this.setData({ "form.date": tomorrowDate(), "form.timeStr": "09:00" });
    }
    // 刚展开时 config 可能已经到了（从列表页点「新建」进），这时就能拿到账号邮箱
    if (show) this.prefillEmail();
  },

  /** 编辑：把列表行灌回表单（表单展开在顶部，滚动定位过去即可） */
  onEdit(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.list.filter((r) => r.id === id)[0];
    if (!row) return;
    const channelIndex = channelIndexOf(row.channel);
    this.setData({
      showForm: true,
      needWxSub: CHANNELS[channelIndex].value !== "email",
      form: {
        id: row.id,
        title: row.title,
        date: String(row.time).slice(0, 10),
        timeStr: String(row.time).slice(11, 16),
        // origTime 记住行上的原值：只改标题时不把旧时间一起提交，
        // 否则后端会按「用户改了时间」拦一道「必须晚于现在」，已过期的提醒就再也改不了
        origTime: String(row.time).slice(0, 16),
        repeatIndex: repeatIndexOf(row.repeat),
        // 行上的间隔：没填过（段 17 之前的存量行）就回到默认「每 1 天」
        intervalValue: row.intervalValue ? String(row.intervalValue) : "1",
        intervalUnitIndex: unitIndexOf(row.intervalUnit),
        channelIndex,
        // 行上没单独填过就展示账号邮箱（后端会自己回落，但让用户看到实际地址更不容易理解错）
        email: row.email || (this.data.cfg || {}).accountEmail || "",
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
      needWxSub: true,
      form: {
        id: 0,
        title: "",
        date: tomorrowDate(),
        timeStr: "09:00",
        origTime: "",
        repeatIndex: 0,
        intervalValue: "1",
        intervalUnitIndex: 1,
        channelIndex: 0,
        email: "",
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
   * 选了邮件时根本不弹：邮件不消耗次数，为了它弹窗只会白白浪费一次授权机会。
   */
  async onSave() {
    if (this.data.saving) return;
    const f = this.data.form;
    const time = this.composedTime();
    const channel = (CHANNELS[f.channelIndex] || CHANNELS[0]).value;
    const needWx = channel !== "email";
    const needMail = channel !== "wx";
    const cfg = this.data.cfg || {};
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
    // 邮件收件人：行上没填则后端回落账号邮箱，两边都没就直说（省一次往返与一条「发不出去」的提醒）
    const mailTo = String(f.email || "").trim();
    if (needMail && !mailTo && !cfg.accountEmail) {
      wx.showToast({ title: "邮件提醒需填接收邮箱", icon: "none" });
      return;
    }
    // 自定义间隔：先在这里拦一道（后端同样会拦，但省一次往返也少一次「建完才发现不能跑」）
    const repeat = (REPEATS[f.repeatIndex] || REPEATS[0]).value;
    let intervalValue = 0;
    let intervalUnit = "";
    if (repeat === "custom") {
      intervalValue = Number(f.intervalValue);
      intervalUnit = (INTERVAL_UNITS[f.intervalUnitIndex] || INTERVAL_UNITS[1])
        .value;
      if (
        !Number.isInteger(intervalValue) ||
        intervalValue < 1 ||
        intervalValue > INTERVAL_MAX
      ) {
        wx.showToast({
          title: `间隔数值只能是 1~${INTERVAL_MAX} 的整数`,
          icon: "none",
        });
        return;
      }
    }
    this.setData({ saving: true });
    let subOk = true;
    try {
      // 1) 先攒额度再落库：弹窗必须由本次点击触发，换了顺序就调不起来
      const pending = Number(cfg.pending || 0);
      const quota = Number(cfg.quota || 0);
      if (needWx && cfg.templateId && quota <= pending) {
        const sub = await subscribe.addSubscribeQuota(cfg.templateId, 1);
        subOk = !!sub.ok;
      }

      // 2) 落库
      const payload = {
        title: String(f.title).trim(),
        repeat,
        remark: f.remark || "",
        channel,
      };
      // 间隔只在 custom 下提交：其它规则后端会自己把两列清空，不必拿 0/空串去占位
      if (repeat === "custom") {
        payload.intervalValue = intervalValue;
        payload.intervalUnit = intervalUnit;
      }
      if (needMail) payload.email = mailTo;
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
      const mailOnlyTip = channel === "email";
      const okTip = f.id
        ? "已更新"
        : mailOnlyTip
          ? "邮件提醒已创建"
          : "提醒已创建";
      wx.showToast({
        title: mailOnlyTip || subOk ? okTip : "已保存，但未授权可能收不到",
        icon: mailOnlyTip || subOk ? "success" : "none",
        duration: mailOnlyTip || subOk ? 1500 : 2500,
      });
      this.onCancelForm();
      this.refresh();
    } catch (err) {
      wx.showToast({ title: "保存失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  /**
   * 「是否晚于现在」：优先拿服务器墙钟做字符串比较（同一参照系，不涉及时区），
   * config 还没回来时退回本机时间，只用于拦明显笔误（真拦不住后端会拦）
   */
  isFuture(time) {
    const server = String((this.data.cfg || {}).serverTime || "").slice(0, 19);
    if (server) {
      return `${time}:00` > server;
    }
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

  /** 立刻给自己推一条微信服务通知：把「模板 ID / 字段映射 / IP 白名单 / 版本」四类配置错一次点穿 */
  async onTest() {
    if (this.data.testing) return;
    this.setData({ testing: true });
    try {
      const res = await api.reminder.test("wx");
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

  /**
   * 给自己发一封测试邮件：验的是 SMTP 主机/端口/凭证/发信人，
   * 与上面那条微信测试完全不共享任何配置，所以两个入口分开给
   */
  async onTestMail() {
    if (this.data.mailTesting) return;
    this.setData({ mailTesting: true });
    try {
      const res = await api.reminder.test("email");
      if (Number(res.code) === 200) {
        wx.showToast({
          title: "已投递，去邮箱看看（含垃圾邮件）",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      const kind = res.data && res.data.kind;
      const tips = {
        disabled: "服务端未配置邮件通道（SMTP_HOST/SMTP_FROM）",
        auth: "SMTP 凭证不对（要用授权码而不是登录密码）",
        rejected: "收件地址被拒收，检查发件人与收件人",
        network:
          "邮件服务器不可达（阿里云封 25 端口，465/587 要与 SMTP_SECURE 对上）",
        rateLimit: "已达当日发信上限",
        noRecipient: "没有可用收件邮箱，先在表单里填一个",
      };
      wx.showModal({
        title: "邮件发送失败",
        content: `${res.message || "投递失败"}${tips[kind] ? `｜${tips[kind]}` : ""}`,
        showCancel: false,
      });
    } catch (err) {
      wx.showToast({ title: "邮件请求失败", icon: "none" });
    } finally {
      this.setData({ mailTesting: false });
    }
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});
