/**
 * 全部后端接口集中定义（按业务域分组）
 * 所有方法返回 Promise<{code,message,data}>
 *
 * 只读聚合类接口统一带上 {cache:{key,ttl}}：突发时同参数请求只发一次、
 * 并且直接命中本地缓存；任何写操作都会按前缀失效相关缓存（见下方 invalidate 调用）。
 * TTL 单位毫秒，取值依据：后端同类结果本身有 5 分钟进程内缓存，客户端再长就会看到过期数据。
 */
const http = require("./request");
const md5 = require("./md5");

const SEC = 1000;

// ==================== 用户 ====================
const user = {
  /** 登录：password 需先 MD5 */
  login: async (username, password) => {
    const res = await http.post(
      "/api/user/login",
      { username, password: md5(password) },
      { silent: true },
    );
    if (Number(res.code) === 200) {
      // 换人了：旧用户的缓存必须清掉（缓存 key 里虽带了 token 有无，但内容按用户维度）
      http.invalidateCache();
    }
    return res;
  },
  /**
   * 微信一键登录：code 来自 wx.login（一次性、约 5 分钟过期，用过就废）
   * 后端回 4001=该微信未绑账号，4002=服务端未开启微信登录（详见 utils/wxLogin.js）
   */
  wxLogin: async (code) => {
    const res = await http.post(
      "/api/user/wx-login",
      { code },
      { silent: true },
    );
    if (Number(res.code) === 200) {
      // 与账号密码登录同理：换人了就清掉上一位用户的本地结果缓存
      http.invalidateCache();
    }
    return res;
  },
  /** 把当前微信绑到已登录账号（需 token，所以必须在登录之后调） */
  bindWx: (code) => http.post("/api/user/bind-wx", { code }, { silent: true }),
  /** 解绑微信（后端只清 openid，本地 token 仍有效） */
  unbindWx: () => http.post("/api/user/unbind-wx", {}, { silent: true }),
};

// ==================== 日志事件 ====================
const event = {
  /** 分页/游标列表（游标翻页时带 withTotal=0，让后端跳过 COUNT(*)） */
  page: (params) => http.get("/api/event/list", params),
  /** 详情 */
  detail: (id) => http.get("/api/event/detail", { id }),
  /** 新建 */
  create: (data) => http.post("/api/event", data).then(afterEventWrite),
  /** 更新 */
  update: (data) => http.put("/api/event", data).then(afterEventWrite),
  /** 删除 */
  remove: (id) => http.del(`/api/event?id=${id}`).then(afterEventWrite),
  /** 生成社媒分享文案，返回 {title,body,hashtags,degraded} */
  shareCopy: (data) =>
    http.post("/api/event/share-copy", data, { silent: true }),
  /** 语音转写文本 → AI 解析成表单字段，返回 {fields,degraded}（兼容口，正常链路已由 transcribe 一次带回） */
  parseVoiceText: (text) =>
    http.post("/api/event/parse-voice-text", { text }, { silent: true }),
  /** 录音文件 → 后端 ASR 转文字 + AI 解析填表字段，一次返回 {text,audioUrl,fields,degraded}（录音同时落盘，audioUrl 随日志保存） */
  transcribe: (filePath) =>
    http.uploadTo("/api/event/transcribe", filePath, "file", {
      silent: true,
      errorText: "语音识别失败",
    }),
  /** 上传单张图片，返回 {url,thumbUrl} */
  uploadImage: (filePath) => http.upload(filePath),
};

/** 写日志后统一失效分析类缓存（标签/人物/报告/足迹/摘要都与日志内容相关） */
function afterEventWrite(res) {
  if (Number(res && res.code) === 200) {
    http.invalidateCache("memory:");
    http.invalidateCache("eventList:");
  }
  return res;
}

// ==================== AI 超级记忆 ====================
const memory = {
  search: (q, limit = 8) => http.get("/api/memory/search", { q, limit }),
  ask: (question, limit = 8) =>
    http.post("/api/memory/ask", { question, limit }, { silent: true }),
  summary: (month) =>
    http.get("/api/memory/summary", month ? { month } : {}, {
      silent: true,
      cache: { key: `memory:summary:${month || "now"}`, ttl: 120 * SEC },
    }),
  tags: () =>
    http.get(
      "/api/memory/tags",
      {},
      {
        silent: true,
        cache: { key: "memory:tags", ttl: 120 * SEC },
      },
    ),
  report: (year) =>
    http.get("/api/memory/report", year ? { year } : {}, {
      silent: true,
      cache: { key: `memory:report:${year || "now"}`, ttl: 300 * SEC },
    }),
  persons: () =>
    http.get(
      "/api/memory/persons",
      {},
      {
        silent: true,
        cache: { key: "memory:persons", ttl: 300 * SEC },
      },
    ),
  person: (name, year) =>
    http.get("/api/memory/person", year ? { name, year } : { name }, {
      silent: true,
      cache: { key: `memory:person:${name}:${year || "all"}`, ttl: 120 * SEC },
    }),
  footprints: (params = {}) =>
    http.get("/api/memory/footprints", params, {
      silent: true,
      cache: {
        key: `memory:foot:${params.year || "all"}:${params.tag || ""}`,
        ttl: 300 * SEC,
      },
    }),
  /** 回顾分享文案（月度/年度，未配置 AI 时后端降级） */
  shareCopy: (data) =>
    http.post("/api/memory/share-copy", data, { silent: true }),
};

// ==================== 组织 ====================
const org = {
  mine: () =>
    http.get(
      "/api/organization/mine",
      {},
      {
        cache: { key: "org:mine", ttl: 60 * SEC },
      },
    ),
  public: () =>
    http.get(
      "/api/organization/public",
      {},
      {
        cache: { key: "org:public", ttl: 60 * SEC },
      },
    ),
  requests: (orgId) =>
    http.get("/api/organization/requests", orgId ? { orgId } : {}),
  requestsCount: () =>
    http.get("/api/organization/requests/count", {}, { silent: true }),
  members: (orgId) => http.get("/api/organization/members", { orgId }),
  apply: (orgId) =>
    http.post("/api/organization/apply", { orgId }).then(afterOrgWrite),
  leave: (orgId) =>
    http.post("/api/organization/leave", { orgId }).then(afterOrgWrite),
  audit: (orgId, userId, approved) =>
    http
      .post("/api/organization/audit", { orgId, userId, approved })
      .then(afterOrgWrite),
  setManager: (orgId, userId, role) =>
    http
      .post("/api/organization/manager", { orgId, userId, role })
      .then(afterOrgWrite),
};

/** 组织关系一变，「我加入/可申请」两个列表都要立刻反映 */
function afterOrgWrite(res) {
  if (Number(res && res.code) === 200) {
    http.invalidateCache("org:");
  }
  return res;
}

// ==================== 定时提醒 ====================
/** 提醒一变就失效 config（额度/待授权数都写在 config 里） */
function afterReminderWrite(res) {
  if (Number(res && res.code) === 200) {
    http.invalidateCache("reminder:");
  }
  return res;
}

const reminder = {
  /** 能力开关 + 模板 ID + 剩余订阅次数（模板 ID 只能由服务端下发，两边必须同一个） */
  config: () =>
    http.get(
      "/api/reminder/config",
      {},
      {
        silent: true,
        cache: { key: "reminder:config", ttl: 30 * SEC },
      },
    ),
  list: (withDone) =>
    http.get("/api/reminder/list", withDone ? { withDone: 1 } : {}, {
      silent: true,
    }),
  create: (data) =>
    http.post("/api/reminder", data, { silent: true }).then(afterReminderWrite),
  update: (data) =>
    http.put("/api/reminder", data, { silent: true }).then(afterReminderWrite),
  setStatus: (id, enabled) =>
    http
      .post("/api/reminder/status", { id, enabled }, { silent: true })
      .then(afterReminderWrite),
  remove: (id) => http.del(`/api/reminder?id=${id}`).then(afterReminderWrite),
  /** 上报一次订阅授权（只在 wx.requestSubscribeMessage 返回 accept 后调） */
  authorize: (count) =>
    http
      .post("/api/reminder/authorize", { count }, { silent: true })
      .then(afterReminderWrite),
  /** 立即给自己发一条测试推送（验模板 ID / 字段映射 / IP 白名单 / state） */
  test: () => http.post("/api/reminder/test", {}, { silent: true }),
};

module.exports = { user, event, memory, org, reminder };
