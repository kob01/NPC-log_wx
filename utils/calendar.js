/**
 * 手机系统日历写入
 *
 * 为什么要多这一条通道：微信一次性订阅「授权一次只能发一条」，user_sub_quota 是那条链路上
 * 唯一的硬瓶颈（攒一次花一次，额度见底就转 status=2）。系统日历不消耗额度、不依赖 openid
 * 绑定、服务端挂了也照样到点响 —— 所以它是「兜底的那只闹钟」，不是微信/邮件渠道的替代品：
 * 提醒该不该写日历由用户决定，微信那一路无论如何都照原样跑。
 *
 * 四条来自微信、本项目没法商量的约束：
 * 1. 需要 scope.addPhoneCalendar 授权，且必须在 MP 后台「设置 → 服务内容声明 → 用户隐私保护
 *    指引」里声明「使用日历（仅写入）」。没声明不是弹窗被拒，而是接口直接 errno 112 不可用；
 *    该指引改的是已发布的现网版本，开发版只在提审页底部填 —— 所以真机测不通先查这里，别改代码。
 * 2. 只有 addPhoneCalendar / addPhoneRepeatCalendar 两个写接口，**没有按 ID 更新或删除已写
 *    事件的能力**。同一行再点一次，日历里就是两条。所以这里在 storage 记一份「写过什么」的
 *    指纹，重复写之前先把话说清楚（指纹只用于提示，写失败不该留下记录）。
 * 3. 重复事件只有 day/week/month/year 四档：既没有后端 custom 的「每 N 天」，month 档还要求
 *    日期 ≤ 28 日。这两类必须退化成单次事件，并把退化的原因回传给调用方显示。
 * 4. 时间戳是 unix 秒，按**本机时区**解释表单上那个 'YYYY-MM-DD HH:mm' 墙钟串：日历要落在
 *    用户手机的那一格，而不是服务器的某一格。用户与服务器同为东八区时两者一致；真的跨时区时
 *    以手机为准更符合直觉（闹钟本来就在手机上响）。
 */
const CFG = require("../config");

/** 写过哪些日历事件的指纹表（有意不用 CACHE_KEY_PREFIX：清缓存不该把「已写过」抹掉，
 *  抹掉就等于下一次点击会在用户看不见的情况下静默多出一条日历事件） */
const WRITTEN_KEY = CFG.CAL_WRITTEN_KEY;

/** 日历事件默认时长（秒）：微信允许 endTime 与 startTime 相同，但零时长事件在日历里
 *  只显示一行「提醒」，看不出占了多久；给半小时是日历类 App 的通行默认值 */
const EVENT_SPAN = 30 * 60;

/** 后端 repeat_rule → 微信 repeatInterval 的精确对应档；落不进这张表的都要退化 */
const REPEAT_MAP = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** 后端 INTERVAL_UNIT → 退化提示里的中文单位（只用于拼「每 3 天日历里没这一档」那句） */
const UNIT_LABEL = { month: "个月", day: "天", hour: "小时", minute: "分钟" };

/** 能力探测：基础库 <2.15.0 没有这两个接口，页面要据此把入口整行隐掉 */
function supported() {
  return typeof wx.addPhoneCalendar === "function";
}

/**
 * 'YYYY-MM-DD HH:mm[:ss]' → unix 秒
 * 在字符串空间里拆，再交给 Date 按本机时区组装：不用 new Date(str)，
 * 因为 iOS 对 'YYYY-MM-DD HH:mm'（空格分隔）解析结果在版本间不一致，
 * 拿到 NaN 会写出一个 1970 年的日历事件。
 */
function toSeconds(time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(time || "").trim(),
  );
  if (!m) return 0;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0),
  );
  const sec = Math.floor(d.getTime() / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/** 读指纹表（storage 坏了当空表处理，不能让日历入口整个报错） */
function writtenMap() {
  try {
    const raw = wx.getStorageSync(WRITTEN_KEY);
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) {
    return {};
  }
}

function markWritten(id, fingerprint) {
  try {
    const map = writtenMap();
    map[String(id)] = fingerprint;
    wx.setStorageSync(WRITTEN_KEY, map);
  } catch (e) {
    // 记不上「写过」只影响下一次提示文案，不影响这次写入本身，不值得报错
  }
}

/**
 * 这一行是否已经写进过日历（列表按钮据此显示「已在日历」）
 * @param {object} row 提醒行
 * @param {object} [map] 已读好的指纹表：一次渲染多行时先读一次再逐行传进来，
 *   否则每行都要同步读一次整个表（列表 30 条就是 30 次同步 storage 读）
 */
function isWritten(row, map) {
  if (!row || !row.id) return false;
  const table = map || writtenMap();
  const fp = table[String(row.id)];
  return !!fp && fp === fingerprintOf(row);
}

/**
 * 指纹 = 行 ID + 决定日历事件内容的字段
 * 时间/标题/重复规则任一变了都算「另一件事」：旧那条还躺在用户日历里，
 * 必须提醒他去删，而不是假装这次是「更新」。
 */
function fingerprintOf(row) {
  return [
    row.id,
    row.time,
    row.title,
    row.repeat,
    row.intervalValue || "",
    row.intervalUnit || "",
  ].join("|");
}

/**
 * 算出这一行该怎么写：用哪个接口、哪些参数、要不要退化
 * @returns {{startTime:number, endTime:number, repeatInterval?:string, degrade:string}}
 *          degrade 非空表示「后端说重复、日历写不成重复」的原因，必须显示给用户
 */
function planOf(row) {
  const startTime = toSeconds(row.time);
  const repeat = String(row.repeat || "none");
  const dayOfMonth = Number(String(row.time || "").slice(8, 10));

  let repeatInterval = REPEAT_MAP[repeat] || "";
  let degrade = "";

  if (repeat === "custom") {
    // 「每 1 天 / 每 1 个月」正好落在微信的两档上；其余间隔（每 3 天、每 2 小时）日历里没有对应概念，
    // 只能按 remind_time 写这一次 —— 后端那一路仍然会按间隔继续排期，退化只发生在手机日历这一侧。
    const n = Number(row.intervalValue);
    const unit = String(row.intervalUnit || "");
    if (n === 1 && (unit === "day" || unit === "month")) {
      repeatInterval = unit === "day" ? "day" : "month";
    } else {
      degrade = `手机日历没有「每${n || "?"}${UNIT_LABEL[unit] || "?"}」这一档，只写了这一次`;
    }
  }

  // month 档（「每月」与「每 1 个月」都算）落不到 29~31 日：微信明确写了这条限制，
  // 硬传过去是接口报错而不是静默忽略，所以先自己退化成单次事件
  if (repeatInterval === "month" && dayOfMonth > 28) {
    degrade = `手机日历的每月重复只支持到 28 日，${dayOfMonth} 日这条只写了这一次`;
    repeatInterval = "";
  }

  return {
    startTime,
    endTime: startTime ? startTime + EVENT_SPAN : 0,
    repeatInterval,
    degrade,
  };
}

/** 把微信的失败码翻成人话（errno 112 是隐私声明没配，属于「服务端配错」，不该让用户背锅） */
function failText(err) {
  const msg = String((err && (err.errMsg || err.message)) || "");
  const code = Number(err && err.errCode);
  if (code === 112 || /privacy|隐私/.test(msg))
    return "服务端未声明日历用途（需在小程序隐私保护指引里补「使用日历」）";
  if (/deny/.test(msg)) return "未授权日历写入，请在「…」→设置里允许后重试";
  if (/system permission|系统权限/.test(msg))
    return "手机系统未授予微信日历权限，请到系统设置里开启";
  if (!supported()) return "当前微信版本过低，不支持写入系统日历";
  return msg ? `写入日历失败：${msg.slice(0, 60)}` : "写入日历失败";
}

/**
 * 拿写入日历的授权
 * 已拒绝过时 wx.authorize 不会再弹窗（微信的规则是「拒绝过一次就只能去设置页」），
 * 所以先查 getSetting，拒过就直接引导 openSetting，避免「点了没反应」的体感。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function ensureAuth() {
  return new Promise((resolve) => {
    if (!supported()) {
      resolve({ ok: false, reason: "当前微信版本过低，不支持写入系统日历" });
      return;
    }
    wx.getSetting({
      success: (res) => {
        const auth = (res.authSetting || {})["scope.addPhoneCalendar"];
        if (auth === true) {
          resolve({ ok: true });
          return;
        }
        if (auth === false) {
          resolve({
            ok: false,
            reason: "你之前拒绝过日历授权，请在设置里开启后重试",
            denied: true,
          });
          return;
        }
        wx.authorize({
          scope: "scope.addPhoneCalendar",
          success: () => resolve({ ok: true }),
          fail: (err) => resolve({ ok: false, reason: failText(err) }),
        });
      },
      fail: () => resolve({ ok: false, reason: "读不到授权状态，请重试" }),
    });
  });
}

/** 打开设置页让用户自己补授权（拒绝过的唯一出路） */
function openSettingForCalendar() {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (res) =>
        resolve(!!((res.authSetting || {})["scope.addPhoneCalendar"] === true)),
      fail: () => resolve(false),
    });
  });
}

function callAdd(plan, base) {
  return new Promise((resolve) => {
    const payload = Object.assign({}, base, {
      startTime: plan.startTime,
      endTime: plan.endTime,
      alarm: true,
      alarmOffset: 0, // 0 = 到点即提醒，与后端 remind_time 同一口径
      success: () => resolve({ ok: true }),
      fail: (err) => resolve({ ok: false, err: err || {} }),
    });
    if (plan.repeatInterval && wx.addPhoneRepeatCalendar) {
      payload.repeatInterval = plan.repeatInterval;
      // repeatEndTime 不传 = 一直重复，与后端「没有结束条件的重复规则」一致
      wx.addPhoneRepeatCalendar(payload);
      return;
    }
    wx.addPhoneCalendar(payload);
  });
}

/**
 * 把一条提醒写进手机日历
 * @param {object} row 提醒行（title/time/repeat/intervalValue/intervalUnit/remark/id）
 * @param {{force?:boolean}} [opts] force=已写过仍要再写一条（重复点击时页面会先问一句）
 * @returns {Promise<{ok:boolean, reason?:string, degrade?:string, repeated?:boolean, stale?:boolean, denied?:boolean}>}
 *          stale：这一行以前写过、但内容已经变了。旧的那条还留在用户日历里且改不掉，
 *          调用方必须把这句话递到用户眼前，否则就是「手机里躺着两条时间不同的提醒」。
 */
async function addRow(row, opts = {}) {
  if (!row || !row.title || !row.time) {
    return { ok: false, reason: "这条提醒还缺标题或时间" };
  }
  const plan = planOf(row);
  if (!plan.startTime) return { ok: false, reason: "这条提醒的时间读不出来" };

  const authed = await ensureAuth();
  if (!authed.ok) return authed;

  const fp = fingerprintOf(row);
  const prev = writtenMap()[String(row.id)];
  const stale = prev !== undefined && prev !== fp;
  if (prev === fp && !opts.force) {
    return {
      ok: false,
      repeated: true,
      reason: "这条已在日历里",
    };
  }

  const res = await callAdd(plan, {
    title: String(row.title).slice(0, 200),
    // 备注带上提醒 ID：日历里事件多了以后，这串是唯一能回溯到本系统的那根线
    description: `${row.remark ? row.remark + "\n" : ""}[NPC存档提醒 #${row.id}]`,
  });
  if (!res.ok) return { ok: false, reason: failText(res.err) };

  markWritten(row.id, fp);
  return { ok: true, degrade: plan.degrade, repeated: prev === fp, stale };
}

/** 日历能力的简短状态（页面顶部那行说明用，避免「勾了却什么也没发生」） */
function capability() {
  if (!supported()) {
    return { available: false, reason: "当前微信版本过低，不支持写入系统日历" };
  }
  return { available: true, reason: "" };
}

module.exports = {
  supported,
  capability,
  isWritten,
  // 导出仅供「一次渲染多行」的调用方预读：逐行调用 isWritten 时不必自己持有它
  writtenMap,
  planOf,
  addRow,
  openSettingForCalendar,
  failText,
};
