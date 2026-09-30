/**
 * wx.request / wx.uploadFile 的 Promise 封装
 * - 自动前缀 BASE_URL、注入 Authorization 与 X-Only-Mine
 * - HTTP 401：清 token 跳登录；业务 code!==200：toast 错误（相同文案 1.5s 去重）
 * - silent:true 时不弹 toast，交由调用方处理（如「AI 未配置」降级）
 */
const { BASE_URL, TIMEOUT } = require('../config')
const auth = require('./auth')

// 错误提示去重
const recentErrors = {}
const ERROR_COOLDOWN = 1500

function showError(msg) {
  const content = msg || '请求失败'
  const now = Date.now()
  if (recentErrors[content] && now - recentErrors[content] < ERROR_COOLDOWN) {
    return
  }
  recentErrors[content] = now
  wx.showToast({ title: content, icon: 'none', duration: 2500 })
}

function buildHeader(extra) {
  const header = Object.assign({ 'Content-Type': 'application/json' }, extra || {})
  const token = auth.getToken()
  if (token) {
    header.Authorization = `Bearer ${token}`
  }
  if (auth.getOnlyMine()) {
    header['X-Only-Mine'] = '1'
  }
  return header
}

function handleUnauthorized() {
  auth.clear()
  wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
  setTimeout(() => auth.toLogin(), 800)
}

/**
 * 发起请求
 * @param {Object} options
 * @param {string} options.url - 以 / 开头的接口路径
 * @param {string} [options.method] - 默认 GET
 * @param {Object} [options.data] - query 或 body
 * @param {boolean} [options.silent] - 业务失败不弹 toast
 * @param {boolean} [options.loading] - 显示全屏 loading
 * @param {string} [options.loadingText]
 * @returns {Promise<{code:number,message:string,data:any}>}
 */
function request(options) {
  const { url, method = 'GET', data, silent, loading, loadingText = '加载中' } = options
  if (loading) {
    wx.showLoading({ title: loadingText, mask: true })
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      timeout: TIMEOUT,
      header: buildHeader(options.header),
      success: (res) => {
        const status = res.statusCode
        if (status === 401) {
          handleUnauthorized()
          reject(new Error('unauthorized'))
          return
        }
        if (status < 200 || status >= 300) {
          const msg = (res.data && res.data.message) || `请求失败（${status}）`
          if (!silent) showError(msg)
          reject(new Error(msg))
          return
        }
        const body = res.data || {}
        if (Number(body.code) !== 200) {
          if (!silent) showError(body.message)
        }
        resolve(body)
      },
      fail: (err) => {
        const msg = '网络异常，请检查服务是否可用'
        if (!silent) showError(msg)
        reject(err)
      },
      complete: () => {
        if (loading) wx.hideLoading()
      }
    })
  })
}

/**
 * 上传文件（wx.uploadFile 返回字符串，统一 JSON.parse）
 * @param {string} filePath - 本地临时文件路径
 * @param {string} [name] - 字段名（后端 .any() 兼容任意名称）
 * @returns {Promise<{code:number,message:string,data:any}>}
 */
function upload(filePath, name = 'file') {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE_URL + '/api/authority/file/upload-file',
      filePath,
      name,
      timeout: TIMEOUT,
      header: buildHeader({ 'Content-Type': 'multipart/form-data' }),
      success: (res) => {
        if (res.statusCode === 401) {
          handleUnauthorized()
          reject(new Error('unauthorized'))
          return
        }
        let body = {}
        try {
          body = JSON.parse(res.data)
        } catch (e) {
          showError('上传响应解析失败')
          reject(e)
          return
        }
        if (Number(body.code) !== 200) {
          showError(body.message || '图片上传失败')
        }
        resolve(body)
      },
      fail: (err) => {
        showError('图片上传失败')
        reject(err)
      }
    })
  })
}

module.exports = {
  request,
  get: (url, data, opt = {}) => request(Object.assign({ url, method: 'GET', data }, opt)),
  post: (url, data, opt = {}) => request(Object.assign({ url, method: 'POST', data }, opt)),
  put: (url, data, opt = {}) => request(Object.assign({ url, method: 'PUT', data }, opt)),
  del: (url, data, opt = {}) => request(Object.assign({ url, method: 'DELETE', data }, opt)),
  upload,
  showError
}
