/**
 * 全部后端接口集中定义（按业务域分组）
 * 所有方法返回 Promise<{code,message,data}>
 */
const http = require('./request')
const md5 = require('./md5')

// ==================== 用户 ====================
const user = {
  /** 登录：password 需先 MD5 */
  login: (username, password) =>
    http.post('/api/user/login', { username, password: md5(password) }, { silent: true })
}

// ==================== 日志事件 ====================
const event = {
  /** 分页/游标列表 */
  page: (params) => http.get('/api/event/list', params),
  /** 详情 */
  detail: (id) => http.get('/api/event/detail', { id }),
  /** 新建 */
  create: (data) => http.post('/api/event', data),
  /** 更新 */
  update: (data) => http.put('/api/event', data),
  /** 删除 */
  remove: (id) => http.del(`/api/event?id=${id}`),
  /** 生成社媒分享文案，返回 {title,body,hashtags,degraded} */
  shareCopy: (data) => http.post('/api/event/share-copy', data, { silent: true }),
  /** 语音转写文本 → AI 解析成表单字段，返回 {fields,degraded} */
  parseVoiceText: (text) => http.post('/api/event/parse-voice-text', { text }, { silent: true }),
  /** 上传单张图片，返回 {url,thumbUrl} */
  uploadImage: (filePath) => http.upload(filePath)
}

// ==================== AI 超级记忆 ====================
const memory = {
  search: (q, limit = 8) => http.get('/api/memory/search', { q, limit }),
  ask: (question, limit = 8) => http.post('/api/memory/ask', { question, limit }, { silent: true }),
  summary: (month) =>
    http.get('/api/memory/summary', month ? { month } : {}, { silent: true }),
  tags: () => http.get('/api/memory/tags', {}, { silent: true }),
  report: (year) => http.get('/api/memory/report', year ? { year } : {}, { silent: true }),
  persons: () => http.get('/api/memory/persons', {}, { silent: true }),
  person: (name, year) =>
    http.get('/api/memory/person', year ? { name, year } : { name }, { silent: true }),
  footprints: (params = {}) => http.get('/api/memory/footprints', params, { silent: true }),
  /** 回顾分享文案（月度/年度，未配置 AI 时后端降级） */
  shareCopy: (data) => http.post('/api/memory/share-copy', data, { silent: true })
}

// ==================== 组织 ====================
const org = {
  mine: () => http.get('/api/organization/mine'),
  public: () => http.get('/api/organization/public'),
  requests: (orgId) => http.get('/api/organization/requests', orgId ? { orgId } : {}),
  requestsCount: () => http.get('/api/organization/requests/count', {}, { silent: true }),
  members: (orgId) => http.get('/api/organization/members', { orgId }),
  apply: (orgId) => http.post('/api/organization/apply', { orgId }),
  leave: (orgId) => http.post('/api/organization/leave', { orgId }),
  audit: (orgId, userId, approved) =>
    http.post('/api/organization/audit', { orgId, userId, approved }),
  setManager: (orgId, userId, role) =>
    http.post('/api/organization/manager', { orgId, userId, role })
}

module.exports = { user, event, memory, org }
