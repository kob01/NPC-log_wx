/**
 * wx.request / wx.uploadFile 的 Promise 封装
 * - 自动前缀 BASE_URL、注入 Authorization；「只看自己」由调用方按接口逐请求传 onlyMine:true
 *   （分析类接口在 api.js 里恒为 true，日志列表按页内筛选传），不再全局注入
 * - HTTP 401：清 token 跳登录（并发只跳一次）；业务 code!==200：toast 错误（相同文案 1.5s 去重）
 * - silent:true 时不弹 toast，交由调用方处理（如「AI 未配置」降级）
 *
 * 抗突发三件套（后端过载时靠这三条把流量摊平，而不是把用户卡在白屏上）：
 * 1. 分级超时：普通 8s、AI 接口 50s（原来统一 60s，用户会白屏一分钟）；
 * 2. 幂等 GET 退避重试：429/503/超时按 300ms×2^n + 抖动重试，尊重 Retry-After；
 * 3. 在途去重 + 结果短缓存：同一接口同一参数的并发只发一次请求，
 *    聚合类数据（标签/人物/年度回顾/足迹/组织列表）按 TTL 直接命中本地缓存。
 */
const CFG = require("../config");
const auth = require("./auth");

// ==================== 错误提示去重 ====================
const recentErrors = {};
const ERROR_COOLDOWN = 1500;

function showError(msg) {
  const content = msg || "请求失败";
  const now = Date.now();
  if (recentErrors[content] && now - recentErrors[content] < ERROR_COOLDOWN) {
    return;
  }
  recentErrors[content] = now;
  wx.showToast({ title: content, icon: "none", duration: 2500 });
}

// ==================== 结果缓存（内存 + 本地存储）====================
// 内存 Map 负责本次生命周期，存储层负责冷启动秒开；
// 只缓存调用方显式声明了 cache 的只读接口，写接口一律不缓存。
const memoryCache = {};

/** 可收窄可见范围的取值（'all' 是默认，不进这张表） */
const VIEW_SCOPES = ["mine", "others", "private"];

/** 归一化本次请求的查看范围：优先 options.scope，兼容旧的 options.onlyMine 布尔 */
function scopeOf(options) {
  const s = options.scope;
  if (VIEW_SCOPES.indexOf(s) !== -1) return s;
  if (options.onlyMine) return "mine";
  return "all";
}

function cacheKeyOf(key, scope) {
  // 查看范围（all/mine/others/private）会改变同一接口的返回内容，必须进 key，
  // 否则切换范围后会读到另一种范围的数据
  return `${key}|${scope}|${auth.getToken() ? "1" : "0"}`;
}

function readCache(key, scope) {
  const full = cacheKeyOf(key, scope);
  if (memoryCache[full] && memoryCache[full].exp > Date.now()) {
    return memoryCache[full].data;
  }
  try {
    const raw = wx.getStorageSync(CFG.CACHE_KEY_PREFIX + full);
    if (raw && raw.exp > Date.now()) {
      memoryCache[full] = raw;
      return raw.data;
    }
    if (raw) wx.removeStorageSync(CFG.CACHE_KEY_PREFIX + full);
  } catch (e) {
    /* 存储不可用时静默降级为不缓存 */
  }
  return undefined;
}

function writeCache(key, data, ttl, scope) {
  if (!(ttl > 0) || data === undefined || data === null) return;
  const full = cacheKeyOf(key, scope);
  memoryCache[full] = { data, exp: Date.now() + ttl };
  try {
    // 体积保护：单条 > 64KB 不落盘（小程序本地存储上限 10MB，且大对象序列化本身耗时）
    const size = JSON.stringify(data).length;
    if (size <= 64 * 1024) {
      wx.setStorageSync(CFG.CACHE_KEY_PREFIX + full, {
        data,
        exp: Date.now() + ttl,
      });
    }
  } catch (e) {
    /* 存储写满时忽略，不影响请求本身 */
  }
}

/**
 * 失效缓存：按 key 前缀清掉内存与存储里的条目
 * @param {string} prefix 例如 "memory:" 或 "org:"；不传则全清
 */
function invalidateCache(prefix) {
  const p = CFG.CACHE_KEY_PREFIX;
  Object.keys(memoryCache).forEach((k) => {
    if (!prefix || k.indexOf(prefix) === 0) delete memoryCache[k];
  });
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((full) => {
      if (full.indexOf(p) !== 0) return;
      const bare = full.slice(p.length);
      if (!prefix || bare.indexOf(prefix) === 0) wx.removeStorageSync(full);
    });
  } catch (e) {
    /* 忽略 */
  }
}

// ==================== 在途去重 ====================
const inflight = {};

function requestKeyOf(method, url, data, scope) {
  let q = "";
  try {
    q = data ? JSON.stringify(data) : "";
  } catch (e) {
    q = "";
  }
  return `${method} ${url}${q ? `?${q}` : ""}|${scope}`;
}

// ==================== 401 single-flight ====================
// 突发时多个并发请求会同时收到 401，各弹一次 toast + 各 reLaunch 一次登录页
// 不仅体验差，还会造成二次请求风暴，所以只处理第一个。
let handling401 = false;

function handleUnauthorized() {
  if (handling401) return;
  handling401 = true;
  auth.clear();
  invalidateCache();
  wx.showToast({ title: "登录已过期，请重新登录", icon: "none" });
  setTimeout(() => {
    auth.toLogin();
    handling401 = false;
  }, 800);
}

function buildHeader(extra, scope) {
  const header = Object.assign(
    { "Content-Type": "application/json" },
    extra || {},
  );
  const token = auth.getToken();
  if (token) {
    header.Authorization = `Bearer ${token}`;
  }
  // 查看范围逐请求决定：mine 带 X-Only-Mine，others/private 带 X-View-Scope（后端据此收窄可见范围）
  if (scope === "mine") {
    header["X-Only-Mine"] = "1";
  } else if (scope === "others" || scope === "private") {
    header["X-View-Scope"] = scope;
  }
  return header;
}

/** AI 类接口走长超时（非 AI 但同步出网的接口走 SLOW_TIMEOUT，见 config.js） */
function timeoutOf(url) {
  const isAi = (CFG.AI_URL_PREFIXES || []).some(
    (p) => String(url).indexOf(p) === 0,
  );
  if (isAi) return CFG.AI_TIMEOUT;
  const isSlow = (CFG.SLOW_URL_PREFIXES || []).some(
    (p) => String(url).indexOf(p) === 0,
  );
  return isSlow ? CFG.SLOW_TIMEOUT || CFG.TIMEOUT : CFG.TIMEOUT;
}

/** 可重试的状态码：只针对幂等 GET */
function retriableStatus(status) {
  return status === 429 || status === 503 || status === 504;
}

/** 退避等待：优先按服务端 Retry-After（秒），否则指数退避 + 抖动 */
function backoffDelay(attempt, retryAfterHeader) {
  const after = parseInt(retryAfterHeader, 10);
  if (Number.isFinite(after) && after > 0) return Math.min(after, 5) * 1000;
  const base = (CFG.RETRY_BASE_DELAY || 300) * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一次真实的 wx.request（不含重试与缓存） */
function once(options) {
  const { url, method = "GET", data, header } = options;
  return new Promise((resolve, reject) => {
    wx.request({
      url: CFG.BASE_URL + url,
      method,
      data,
      timeout: timeoutOf(url),
      header: buildHeader(header, scopeOf(options)),
      success: resolve,
      fail: (err) => reject(Object.assign(err, { __networkError: true })),
    });
  });
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
 * @param {{key:string, ttl:number}} [options.cache] - 仅用于幂等 GET：结果缓存 ttl 毫秒
 * @param {boolean} [options.force] - 配合 cache 使用：跳过读缓存（下拉刷新/进页重拉），结果仍回写缓存
 * @param {boolean} [options.dedupe] - 在途去重开关（默认对 GET 开启）
 * @returns {Promise<{code:number,message:string,data:any}>}
 */
async function request(options) {
  const {
    url,
    method = "GET",
    data,
    silent,
    loading,
    loadingText = "加载中",
  } = options;
  // 逐请求的查看范围（all/mine/others）：既决定请求头，也进缓存/在途去重 key，避免串范围
  const scope = scopeOf(options);
  const isGet = String(method).toUpperCase() === "GET";
  const cache = options.cache;
  const cacheKey = cache && cache.key;

  // 1) 命中缓存直接返回（不发请求，也不显示 loading）；force 时跳过这一步真发请求
  if (isGet && cacheKey && !options.force) {
    const hit = readCache(cacheKey, scope);
    if (hit !== undefined)
      return { code: 200, message: "ok", data: hit, fromCache: true };
  }

  // 2) 在途去重：同一时刻同参数的 GET 只发一次，其余复用同一 Promise
  const key = requestKeyOf(String(method).toUpperCase(), url, data, scope);
  if (isGet && options.dedupe !== false && inflight[key]) {
    return inflight[key];
  }

  if (loading) {
    wx.showLoading({ title: loadingText, mask: true });
  }

  const task = (async () => {
    const maxRetry = isGet ? CFG.RETRY_MAX || 0 : 0;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await once(options);
      } catch (err) {
        // 网络失败/超时：GET 退避重试，其余直接报错
        if (attempt < maxRetry) {
          await sleep(backoffDelay(attempt));
          attempt += 1;
          continue;
        }
        const msg = "网络异常，请检查服务是否可用";
        if (!silent) showError(msg);
        throw err;
      }

      const status = res.statusCode;
      if (status === 401) {
        handleUnauthorized();
        throw new Error("unauthorized");
      }
      if (status < 200 || status >= 300) {
        const body = res.data || {};
        const msg = body.message || `请求失败（${status}）`;
        if (attempt < maxRetry && retriableStatus(status)) {
          await sleep(
            backoffDelay(attempt, res.header && res.header["Retry-After"]),
          );
          attempt += 1;
          continue;
        }
        if (!silent) showError(msg);
        throw new Error(msg);
      }

      const body = res.data || {};
      if (Number(body.code) !== 200) {
        // 业务失败（HTTP 200 + code!==200）不重试：交由调用方按 message 降级
        if (!silent) showError(body.message);
      } else if (isGet && cacheKey) {
        writeCache(cacheKey, body.data, cache.ttl, scope);
      }
      return body;
    }
  })();

  if (isGet && options.dedupe !== false) {
    inflight[key] = task;
    task.finally(() => {
      delete inflight[key];
    });
  }
  try {
    return await task;
  } finally {
    if (loading) wx.hideLoading();
  }
}

/**
 * 上传文件到指定接口（wx.uploadFile 返回字符串，统一 JSON.parse）
 * 上传体本身很大且已占用一条连接，不做重试也不做缓存。
 * @param {string} url - 以 / 开头的接口路径
 * @param {string} filePath - 本地临时文件路径
 * @param {string} [name] - 字段名（后端 .any()/single 兼容）
 * @param {Object} [opts] - { silent, errorText }
 * @returns {Promise<{code:number,message:string,data:any}>}
 */
function uploadTo(url, filePath, name = "file", opts = {}) {
  const { silent, errorText = "上传失败" } = opts;
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: CFG.BASE_URL + url,
      filePath,
      name,
      timeout: timeoutOf(url),
      header: buildHeader({ "Content-Type": "multipart/form-data" }),
      success: (res) => {
        if (res.statusCode === 401) {
          handleUnauthorized();
          reject(new Error("unauthorized"));
          return;
        }
        if (res.statusCode === 429 || res.statusCode === 503) {
          const msg = "当前访问的人有点多，稍等一下再传";
          if (!silent) showError(msg);
          reject(new Error(msg));
          return;
        }
        let body = {};
        try {
          body = JSON.parse(res.data);
        } catch (e) {
          if (!silent) showError(`${errorText}响应解析失败`);
          reject(e);
          return;
        }
        if (Number(body.code) !== 200 && !silent) {
          showError(body.message || errorText);
        }
        resolve(body);
      },
      fail: (err) => {
        if (!silent) showError(errorText);
        reject(err);
      },
    });
  });
}

/**
 * 上传图片（保留旧签名，固定走 /api/authority/file/upload-file）
 * @param {string} filePath - 本地临时文件路径
 * @param {string} [name] - 字段名（后端 .any() 兼容任意名称）
 * @returns {Promise<{code:number,message:string,data:any}>}
 */
function upload(filePath, name = "file") {
  return uploadTo("/api/authority/file/upload-file", filePath, name, {
    errorText: "图片上传失败",
  });
}

module.exports = {
  request,
  get: (url, data, opt = {}) =>
    request(Object.assign({ url, method: "GET", data }, opt)),
  post: (url, data, opt = {}) =>
    request(Object.assign({ url, method: "POST", data }, opt)),
  put: (url, data, opt = {}) =>
    request(Object.assign({ url, method: "PUT", data }, opt)),
  del: (url, data, opt = {}) =>
    request(Object.assign({ url, method: "DELETE", data }, opt)),
  upload,
  uploadTo,
  showError,
  invalidateCache,
};
