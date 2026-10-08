/**
 * 全部后端接口集中定义（按业务域分组）
 * 所有方法返回 Promise<{code,message,data}>
 *
 * 只读聚合类接口统一带上 {cache:{key,ttl}}：突发时同参数请求只发一次、
 * 并且直接命中本地缓存；任何写操作都会按前缀失效相关缓存（见下方 invalidate 调用）。
 * TTL 单位毫秒，取值依据：后端同类结果本身有 5 分钟进程内缓存，客户端再长就会看到过期数据。
 *
 * 「只看自己」范围（逐请求 scope，对应后端 X-Only-Mine / X-View-Scope 头）：
 * - 分析类接口（AI 回忆/问答/摘要/标签/年度回顾/人物图谱/地图足迹）恒为 mine，只统计本人数据；
 * - 日志列表 event.page 与列表内检索 memory.search 由调用方按页内筛选传 scope（all/mine/others/private）。
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
   * 微信一键登录/注册：code 来自 wx.login（一次性、约 5 分钟过期，用过就废）
   * opts.allowRegister=true 才允许后端在 openid 认不出账号时建新号（用户主动点才给）；
   * 静默续期一律不带，否则每个只是打开过小程序的人都会在库里留一行。
   * opts.username/password 只在注册那一步带：账号要用户自己起一个能记住的（PC 端要手敲），
   * 服务端不代取随机名；没带则后端回 4003 让端上先去收输入。
   * 后端业务码：4001=未绑账号且不自动建档，4002=未开启微信登录，4003=可以注册但缺输入
   * （详见 utils/wxLogin.js）
   */
  wxLogin: async (code, opts) => {
    const { allowRegister, username, password } = opts || {};
    // 用 Object.assign 而非对象展开：展开会被增强编译转成 @swc/runtime helper，
    // 工具端 runtime 缺失时整页注册失败（同 timeline.js 的写法）
    const body = Object.assign(
      { code },
      allowRegister ? { allowRegister: true } : {},
      username ? { username } : {},
      // 密码与登录/注册走同一套路：端上 MD5，后端再 bcrypt
      password ? { password: md5(password) } : {},
    );
    const res = await http.post("/api/user/wx-login", body, { silent: true });
    if (Number(res.code) === 200) {
      // 与账号密码登录同理：换人了就清掉上一位用户的本地结果缓存
      http.invalidateCache();
    }
    return res;
  },
  /** 把当前微信绑到已登录账号（需 token，所以必须在登录之后调） */
  bindWx: (code) => http.post("/api/user/bind-wx", { code }, { silent: true }),
  /** 解绑微信（后端只清 openid，本地 token 仍有效）；没设过密码的账号会被后端拒 */
  unbindWx: () => http.post("/api/user/unbind-wx", {}, { silent: true }),
  /**
   * 设置/修改自己的登录密码（password/oldPassword 都需先 MD5）
   * 微信注册的账号已在注册那一步设过密码，这里主要用于改密与打通 Web 端；
   * 存量没密码的账号靠它把「解绑微信等于锁死自己」这个坑填上。
   */
  setPassword: (password, oldPassword) =>
    http.post(
      "/api/user/set-password",
      Object.assign(
        { password: md5(password) },
        oldPassword ? { oldPassword: md5(oldPassword) } : {},
      ),
      { silent: true },
    ),
  /**
   * 读自己的资料（用户名/邮箱/has_password/wx_bound），与登录响应里 user 同形状
   * 不缓存也不静默：账号资料页的下拉刷新就是为了拿服务端真值，
   * 拉失败时必须让用户看到一句提示（不然只会看到转完的圈）
   */
  profile: () => http.get("/api/user/profile", {}),
  /**
   * 修改自己的用户名/邮箱（只传 real_name / email；账号、类型等改不了）
   * 成功后失效 reminder 缓存：邮箱是邮件提醒的回落地址，不能拿着旧值发
   */
  updateProfile: (data) =>
    http.put("/api/user/profile", data, { silent: true }).then((res) => {
      if (Number(res.code) === 200) {
        http.invalidateCache("reminder:");
      }
      return res;
    }),
};

// ==================== 日志事件 ====================
const event = {
  /** 分页/游标列表（游标翻页时带 withTotal=0，让后端跳过 COUNT(*)）；scope 由列表页筛选传入（all/mine/others/private） */
  page: (params, scope) => http.get("/api/event/list", params, { scope }),
  /** 详情 */
  detail: (id) => http.get("/api/event/detail", { id }),
  /** 新建 */
  create: (data) => http.post("/api/event", data).then(afterEventWrite),
  /** 更新 */
  update: (data) => http.put("/api/event", data).then(afterEventWrite),
  /** 删除 */
  remove: (id) => http.del(`/api/event?id=${id}`).then(afterEventWrite),
  /**
   * 置顶 / 取消置顶（每人各记自己的，上限 3 条由后端判）
   * 超限那句文案由后端给（改上限不用发小程序新版本），失败不静默：直接 toast 给用户看
   * 只失效列表相关缓存：置顶只改 note_event_pins，正文一个字没动，
   * 标签/人物/报告/足迹那些分析类结果不该跟着重算
   */
  pin: (id, pinned) =>
    http.post("/api/event/pin", { id, pinned }).then((res) => {
      if (Number(res && res.code) === 200) http.invalidateCache("eventList:");
      return res;
    }),
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
// 除 search 外，本组接口都恒定只看自己（onlyMine: true → scope 'mine'）：AI 回忆/年度回顾/
// 人物图谱/地图足迹只统计本人数据。search 例外——它被日志列表页的搜索框复用，
// 范围要跟随列表筛选，故由调用方逐次传入第三个参数 scope（all/mine/others/private）。
const memory = {
  search: (q, limit = 8, scope) =>
    http.get("/api/memory/search", { q, limit }, { scope }),
  ask: (question, limit = 8) =>
    http.post(
      "/api/memory/ask",
      { question, limit },
      { silent: true, onlyMine: true },
    ),
  summary: (month) =>
    http.get("/api/memory/summary", month ? { month } : {}, {
      silent: true,
      onlyMine: true,
      cache: { key: `memory:summary:${month || "now"}`, ttl: 120 * SEC },
    }),
  tags: () =>
    http.get(
      "/api/memory/tags",
      {},
      {
        silent: true,
        onlyMine: true,
        cache: { key: "memory:tags", ttl: 120 * SEC },
      },
    ),
  report: (year) =>
    http.get("/api/memory/report", year ? { year } : {}, {
      silent: true,
      onlyMine: true,
      cache: { key: `memory:report:${year || "now"}`, ttl: 300 * SEC },
    }),
  persons: () =>
    http.get(
      "/api/memory/persons",
      {},
      {
        silent: true,
        onlyMine: true,
        cache: { key: "memory:persons", ttl: 300 * SEC },
      },
    ),
  person: (name, year) =>
    http.get("/api/memory/person", year ? { name, year } : { name }, {
      silent: true,
      onlyMine: true,
      cache: { key: `memory:person:${name}:${year || "all"}`, ttl: 120 * SEC },
    }),
  footprints: (params = {}) =>
    http.get("/api/memory/footprints", params, {
      silent: true,
      onlyMine: true,
      cache: {
        key: `memory:foot:${params.year || "all"}:${params.tag || ""}`,
        ttl: 300 * SEC,
      },
    }),
};

// ==================== 组织 ====================
const org = {
  /** @param {boolean} [force] 进页/下拉刷新时跳过 60s 缓存真发一次请求 */
  mine: (force) =>
    http.get(
      "/api/organization/mine",
      {},
      {
        cache: { key: "org:mine", ttl: 60 * SEC },
        force: !!force,
      },
    ),
  public: (force) =>
    http.get(
      "/api/organization/public",
      {},
      {
        cache: { key: "org:public", ttl: 60 * SEC },
        force: !!force,
      },
    ),
  requests: (orgId) =>
    http.get("/api/organization/requests", orgId ? { orgId } : {}),
  requestsCount: () =>
    http.get("/api/organization/requests/count", {}, { silent: true }),
  members: (orgId) => http.get("/api/organization/members", { orgId }),
  /** 我提交的申请记录（待审/通过/拒绝都在，被拒行带拒绝理由） */
  applications: (force) =>
    http.get(
      "/api/organization/applications",
      {},
      {
        cache: { key: "org:apps", ttl: 60 * SEC },
        force: !!force,
      },
    ),
  /** 已结束的审批记录：我申请的 + 我管理的组织里别人的 */
  records: (force) =>
    http.get(
      "/api/organization/records",
      {},
      {
        cache: { key: "org:records", ttl: 60 * SEC },
        force: !!force,
      },
    ),
  /** 某人申请某组织的完整审批往来（点开一条记录看全部拒绝/通过轮次） */
  history: (orgId, userId) =>
    http.get("/api/organization/audit-history", { orgId, userId }),
  /** @param {string} [reason] 申请理由，可选，会展示给该组织管理者 */
  apply: (orgId, reason) =>
    http.post("/api/organization/apply", { orgId, reason }).then(afterOrgWrite),
  leave: (orgId) =>
    http.post("/api/organization/leave", { orgId }).then(afterOrgWrite),
  /** @param {string} [reason] 拒绝理由，可选，会回显给申请人 */
  audit: (orgId, userId, approved, reason) =>
    http
      .post("/api/organization/audit", { orgId, userId, approved, reason })
      .then(afterOrgWrite),
  setManager: (orgId, userId, role) =>
    http
      .post("/api/organization/manager", { orgId, userId, role })
      .then(afterOrgWrite),
  /** 移出成员（仅该组织的管理者/创建者，不能移自己也不能移创建者） */
  kick: (orgId, userId) =>
    http.post("/api/organization/kick", { orgId, userId }).then(afterOrgWrite),
  /** 创建组织（登录用户均可，每人最多 5 个，超限由后端报错） */
  create: (data) => http.post("/api/organization", data).then(afterOrgWrite),
  /** 改名称/描述（仅系统管理员或该组织管理者） */
  update: (orgId, data) =>
    http
      .put(`/api/organization/${orgId}`, {
        org_name: data.org_name,
        description: data.description,
      })
      .then(afterOrgWrite),
  /** 解散组织（级联清成员关系与日志可见组织关联，仅管理员或该组织管理者） */
  remove: (orgId) => http.del(`/api/organization/${orgId}`).then(afterOrgWrite),
};

/** 组织关系一变，「我加入/可申请」两个列表都要立刻反映 */
function afterOrgWrite(res) {
  if (Number(res && res.code) === 200) {
    http.invalidateCache("org:");
  }
  return res;
}

// ==================== 定时提醒 ====================
/**
 * 提醒一变就失效 config（额度/待授权数/账号邮箱都写在 config 里）
 */
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
  /**
   * 立即给自己发一条测试推送（验模板 ID / 字段映射 / IP 白名单 / state）
   * channel='email' 时验的是 SMTP 与收件地址，不消耗也不需要订阅次数
   */
  test: (channel) =>
    http.post(
      "/api/reminder/test",
      { channel: channel || "wx" },
      { silent: true },
    ),
};

// ==================== 访问打点 ====================
/**
 * 一次「点开小程序」上报一行（表与字段含义见 NPC-log_node 的 note_app_visit）
 *
 * 两个接口都是软鉴权（后端鉴权白名单 + 路由自己解 token），所以：
 * - 本地没 token 也记得上（新用户、刚退出、登录过期都算一次点开）；
 * - 永远不会回 401，也就不会误触发 request.js 里的「清 token 跳登录页」——
 *   打点是纯后台动作，绝不能把用户从当前页踢走。
 * 统一 silent：上报失败不弹任何东西（用户看不见也管不了）。
 * 不带 cache/dedupe：写接口，且每行都带唯一的 visit_key，去重没有意义。
 */
const visit = {
  /** 记一次点开，拿回 {visitId, closeKey}（closeKey 要存住，收尾时凭它回填） */
  open: (payload) => http.post("/api/visit/open", payload, { silent: true }),
  /** 收尾一次访问；orphan:true 表示「上次没等到关闭上报」，只改状态不算时长 */
  close: (payload) => http.post("/api/visit/close", payload, { silent: true }),
};

module.exports = { user, event, memory, org, reminder, visit };
