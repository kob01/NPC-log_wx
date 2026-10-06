/**
 * 小程序访问打点：每次「点开」上报一行，切走时收尾（表为后端 note_app_visit）
 *
 * 挂在 App.onShow / App.onHide 上，不是挂在页面上，原因有两个：
 * 1. 用户点进来可能一屏都没看就退回微信，页面 onShow 未必跑得到（登录拦截页尤其如此）；
 * 2. 「一次前台 = 一行」这个口径只有 App 级生命周期能准确表达，切后台再回来要算新的一次。
 *
 * 三条必须守住的设计：
 * 1. **绝不影响用户**：所有调用都是 fire-and-forget + try/catch，不弹 toast、不 await 到页面上，
 *    接口挂了也只是这一行没记上。
 * 2. **停留时长由服务端算**：端上只报「我进来了」和「我走了」两个动作，
 *    自己不算差值 —— 切后台后 JS 定时器被挂起、本机时间可被改，算出来的时长只会误导人。
 * 3. **关闭上报可能发不出去**：微信在 onHide 之后随时可能挂起网络与进程，
 *    所以 pending 落 storage：下次进前台先把它补报成「中断」（status=3，时长留 NULL），
 *    而不是假装那一次从没发生过，也不是给它编一个结束时间。
 *
 * 未登录也上报：后端这两条接口是软鉴权（见 NPC-log_node/src/routes/visit.js），
 * 有 token 就带上身份，没有就记成匿名行 —— 「点进来又退回登录页」是最有信息量的那批数据。
 */
const CFG = require("../config");
const api = require("./api");
const auth = require("./auth");

/** 场景值中文：只收录官方表里确定且高频的，没命中的写成「场景N」，绝不猜 */
const SCENE_LABELS = {
  1000: "其他",
  1001: "发现页「最近使用」列表",
  1005: "微信首页顶部搜索结果页",
  1006: "发现栏搜索框结果页",
  1007: "单人聊天中的小程序卡片",
  1008: "群聊中的小程序卡片",
  1010: "收藏夹",
  1011: "扫描二维码",
  1012: "长按图片识别二维码",
  1013: "相册选取二维码",
  1014: "小程序订阅消息",
  1017: "体验版入口页",
  1023: "安卓系统桌面图标",
  1024: "小程序 profile 页",
  1027: "搜索「使用过的小程序」列表",
  1035: "公众号自定义菜单",
  1036: "App 分享消息卡片",
  1037: "小程序打开小程序",
  1038: "从另一个小程序返回",
  1043: "公众号模板消息",
  1044: "带 shareTicket 的卡片",
  1058: "公众号文章",
  1065: "URL scheme",
  1074: "公众号会话的小程序卡片",
  1089: "聊天主界面下拉「最近使用」",
  1090: "长按右上角菜单的最近使用",
  1096: "聊天记录",
  1103: "发现页「我的小程序」列表",
  1104: "聊天主界面下拉「我的小程序」",
  1107: "订阅消息",
  1131: "浮窗",
  1145: "发现栏-发现小程序",
  1178: "在电脑打开手机上打开的小程序",
  1187: "浮窗（8.0）",
  1223: "安卓桌面 Widget",
  1225: "音视频通话",
};

function sceneLabel(scene) {
  if (!scene) return "";
  return SCENE_LABELS[scene] || `场景${scene}`;
}

/**
 * 会话ID：只做「重传去重」用，不当凭证
 * 真正的凭证是服务端下发的 close_key（客户端猜不到别人的），所以这里不需要加密级随机。
 * 不用对象展开/可选链：本仓的增强编译对这两样有过运行时 helper 缺失的教训（见 utils/api.js 注释）。
 */
function newVisitKey() {
  const rand = () =>
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `v${rand()}${rand()}`.slice(0, 60);
}

// ==================== 环境信息（一次生命周期内不变，只读一次）====================
let envCache = null;
let netTypeCache = "unknown";

/** 同步读各类设备/环境信息；基础库过旧或某个 API 不可用时逐块降级，不整体丢掉 */
function readEnv() {
  if (envCache) return envCache;
  const env = {};
  const grab = (fn) => {
    try {
      return fn() || {};
    } catch (e) {
      return {};
    }
  };

  const device = grab(() => (wx.getDeviceInfo ? wx.getDeviceInfo() : {}));
  const base = grab(() => (wx.getAppBaseInfo ? wx.getAppBaseInfo() : {}));
  const win = grab(() => (wx.getWindowInfo ? wx.getWindowInfo() : {}));
  const setting = grab(() =>
    wx.getSystemSetting ? wx.getSystemSetting() : {},
  );
  const account = grab(() =>
    wx.getAccountInfoSync ? wx.getAccountInfoSync().miniProgram || {} : {},
  );

  // 基础库没有拆分 API 时（2.20.1 之前）整体回落 getSystemInfoSync：一次调用就够，别拼三份
  const legacy =
    device.brand || base.SDKVersion || win.screenWidth
      ? null
      : grab(() => wx.getSystemInfoSync());
  const merged = Object.assign({}, legacy || {});

  env.brand = device.brand || merged.brand;
  env.model = device.model || merged.model;
  env.platform = device.platform || merged.platform;
  env.system = device.system || merged.system;
  env.memory_size = device.memorySize || merged.memorySize;
  env.orientation = device.deviceOrientation || merged.deviceOrientation;

  env.screen_width = win.screenWidth || merged.screenWidth;
  env.screen_height = win.screenHeight || merged.screenHeight;
  env.window_width = win.windowWidth || merged.windowWidth;
  env.window_height = win.windowHeight || merged.windowHeight;
  env.pixel_ratio = win.pixelRatio || merged.pixelRatio;
  env.status_bar_height = win.statusBarHeight || merged.statusBarHeight;
  const safe = win.safeArea || merged.safeArea;
  // safe_bottom 存的是「屏幕底边到安全区底边的留白」（全面屏手势条高度），不是坐标本身
  env.safe_area_bottom =
    safe && env.screen_height ? env.screen_height - safe.bottom : undefined;

  env.language = base.language || merged.language;
  env.theme = base.theme || merged.theme;
  env.sdk_version = base.SDKVersion || merged.SDKVersion;
  // 微信客户端版本号在开发者工具里是 devtools，只有真机才有意义（后端原样存，不做判断）
  env.wx_version = base.version || merged.version;

  env.wifi_enabled = setting.wifiEnabled;
  env.location_enabled = setting.locationEnabled;
  env.brightness = setting.screenBrightness;

  env.app_id = account.appId;
  env.env_version = account.envVersion; // develop/trial/release
  env.mp_version = account.version; // 线上版本号；开发版/体验版这里是空串

  try {
    const battery = wx.getBatteryInfoSync ? wx.getBatteryInfoSync() : null;
    if (battery) {
      env.battery = battery.level;
      env.battery_charging = battery.isCharging;
    }
  } catch (e) {
    /* 电量读不到就算了，不影响其余字段 */
  }

  envCache = env;
  return env;
}

/**
 * 网络类型只能异步拿（wx.getNetworkType），所以：
 * 冷启动时 await 一次（最多等 800ms，超时就以 unknown 上报）,
 * 之后靠 onNetworkStatusChange 持续更新，后续上报直接读缓存不再等待。
 */
function refreshNetType() {
  if (netTypeCache !== "unknown") return Promise.resolve(netTypeCache);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      netTypeCache = v;
      resolve(v);
    };
    setTimeout(() => finish("unknown"), 800);
    try {
      wx.getNetworkType({
        success: (res) => finish(res.networkType || "unknown"),
        fail: () => finish("unknown"),
      });
    } catch (e) {
      finish("unknown");
    }
  });
}

/** 挂一次网络监听（App.onLaunch 调，重复调用无害） */
function watchNetwork() {
  try {
    if (wx.onNetworkStatusChange) {
      wx.onNetworkStatusChange((res) => {
        netTypeCache = res && res.networkType ? res.networkType : "unknown";
      });
    }
  } catch (e) {
    /* 忽略 */
  }
}

// ==================== 本次生命周期内的状态 ====================
const state = {
  launched: false, // onLaunch 之后第一次 onShow 才算冷启动
  foregroundIndex: 0, // 本次进程里第几次进前台
  lastOpenAt: 0, // 合并重复 onShow 用
};

/** 当前栈顶页面路径（冷启动 onShow 时页面栈可能还是空，回落到 options.path） */
function currentRoute(fallback) {
  try {
    const pages = getCurrentPages() || [];
    const top = pages[pages.length - 1];
    if (top && top.route) return top.route;
  } catch (e) {
    /* 忽略 */
  }
  return fallback || "";
}

// ==================== 本地待办（pending / 补发队列）====================
function readPending() {
  try {
    return wx.getStorageSync(CFG.VISIT_PENDING_KEY) || null;
  } catch (e) {
    return null;
  }
}

function writePending(p) {
  try {
    if (p) wx.setStorageSync(CFG.VISIT_PENDING_KEY, p);
    else wx.removeStorageSync(CFG.VISIT_PENDING_KEY);
  } catch (e) {
    /* 存储写不进去就不补报了，不值得为这件事影响主流程 */
  }
}

function readRetry() {
  try {
    const list = wx.getStorageSync(CFG.VISIT_RETRY_KEY);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function pushRetry(payload) {
  try {
    const list = readRetry();
    list.push({ at: Date.now(), payload });
    // 只留最近 N 条：补发队列的意义是「刚才那一下断网」，不是把几个月的欠账都背上
    const trimmed = list.slice(-CFG.VISIT_RETRY_MAX);
    wx.setStorageSync(CFG.VISIT_RETRY_KEY, trimmed);
  } catch (e) {
    /* 忽略 */
  }
}

function clearRetry() {
  try {
    wx.removeStorageSync(CFG.VISIT_RETRY_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 补发上次没送出去的 open 报文（在 onAppShow 末尾调，队空时直接返回）
 * 不 await：这只是顺手清欠，不能让它把这一次的打开也拖住。
 * 如果补发的正好是当前这次打开的报文（刚才那一下 open 失败），
 * 就把服务端返回的 closeKey 认回来，这一次的停留时长仍然能回填。
 * ⚠ 补发又失败时必须把报文重新攒回去：那一行本来就没入库，
 *    丢了它就等于「这次点开从没能记上」，而不是只缺一个时长。
 */
function drainRetry(currentVisitKey) {
  const list = readRetry();
  if (!list.length) return;
  clearRetry();
  list.forEach((item) => {
    const payload = item && item.payload;
    if (!payload || !payload.visit_key) return;
    api.visit
      .open(payload)
      .then((res) => {
        const data = res && res.data;
        if (
          Number(res && res.code) === 200 &&
          data &&
          data.closeKey &&
          payload.visit_key === currentVisitKey
        ) {
          const p = readPending();
          if (p && p.visitKey === currentVisitKey && !p.closeKey) {
            p.closeKey = data.closeKey;
            writePending(p);
          }
        }
      })
      .catch(() => {
        pushRetry(payload);
      });
  });
}

/**
 * 把上一次「没等到关闭」的访问补报成中断
 * 没有 closeKey（上次 open 就没成功）时无权也无需改，直接清掉：
 * 那一行要么根本不存在，要么由服务端的超时清扫器收尾（见后端 VISIT_STALE_MINUTES）。
 */
function flushOrphan(route) {
  const p = readPending();
  if (!p || !p.visitKey) {
    writePending(null);
    return Promise.resolve();
  }
  writePending(null);
  if (!p.closeKey) return Promise.resolve();
  return api.visit
    .close({
      visit_key: p.visitKey,
      close_key: p.closeKey,
      orphan: true,
      page_route: route,
    })
    .catch(() => {
      /* 补报也失败：交给服务端清扫器，本地不再留这个 pending（它已经过期） */
    });
}

// ==================== 对外三个动作 ====================
/**
 * 一次「进前台」：补记上一次中断 → 插一行新的进行中
 * @param {object} options App.onShow 的入参（scene/path/query/referrerInfo/shareTicket/chInfo）
 */
async function onAppShow(options) {
  if (!CFG.VISIT_TRACK) return;
  const now = Date.now();
  const cold = !state.launched;
  state.launched = true;

  // 合并窗口：非冷启动且上一次打开还没收尾时，这么短内的第二次 onShow 视为同一次点开
  const pending = readPending();
  if (!cold && pending && now - state.lastOpenAt < (CFG.VISIT_MERGE_MS || 0)) {
    return;
  }

  state.foregroundIndex += 1;
  state.lastOpenAt = now;
  const opts = options || {};
  const route = currentRoute(opts.path);

  await flushOrphan(route);
  const net_type = await refreshNetType();
  const visitKey = newVisitKey();

  // 先把 pending 立起来（没有 closeKey）：万一这次 open 请求整个发不出去，
  // 下次进前台至少知道「有一段历史要处理」，而不是完全无痕
  writePending({ visitKey, closeKey: null, openedAt: now });

  const payload = Object.assign({}, readEnv(), {
    visit_key: visitKey,
    client_open_ms: now,
    cold_start: cold,
    foreground_index: state.foregroundIndex,
    scene: opts.scene,
    scene_label: sceneLabel(opts.scene),
    path: opts.path,
    query: opts.query,
    referrerInfo: opts.referrerInfo,
    // shareTicket 本身不进报文（那是能换 openGId 的凭证，只留「有没有」这一位）
    has_share_ticket: !!opts.shareTicket,
    chInfo: opts.chInfo,
    net_type,
    page_route: route,
    // 本地有没有 token：只作为「这次打开时是不是已登录」的判断依据，身份本身仍由后端解 JWT
    has_token: !!auth.getToken(),
  });

  try {
    const res = await api.visit.open(payload);
    const data = res && res.data;
    if (Number(res && res.code) === 200 && data && data.closeKey) {
      writePending({ visitKey, closeKey: data.closeKey, openedAt: now });
    } else {
      // 后端明确拒绝（比如缺 visit_key）或业务码异常：不重试，留着 pending 让下次补记
      pushRetry(payload);
    }
  } catch (e) {
    // 网络失败/超时才值得补发：后端 4xx 走的是 code!==200 的分支，不会到这里
    pushRetry(payload);
  }
  // 顺手清欠（队空时它直接返回）：刚被 push 进去的本条报文会在这里重发一次，
  // 发成就能把 closeKey 认回来，停留时长不至于因为一次抖动就永远缺一段
  drainRetry(visitKey);
}

/**
 * 一次「离开前台」：把这一行收尾（关闭时间与时长由服务端墙钟算）
 * ⚠ 这里发出的请求有可能被微信当场挂起 —— 所以失败不清 pending，
 *    下次的 flushOrphan 会把这一行补成「中断」，宁可少一个时长也不能丢这一条打开记录。
 */
function onAppHide() {
  if (!CFG.VISIT_TRACK) return;
  const p = readPending();
  if (!p || !p.visitKey || !p.closeKey) return;
  const route = currentRoute("");
  api.visit
    .close({
      visit_key: p.visitKey,
      close_key: p.closeKey,
      page_route: route,
    })
    .then((res) => {
      if (Number(res && res.code) === 200) writePending(null);
    })
    .catch(() => {
      /* 留着 pending，下次进前台补报为中断 */
    });
}

/** App.onLaunch 调：起网络监听，并把「冷启动」这件事标记出来（真正的行由第一次 onShow 记） */
function init() {
  if (!CFG.VISIT_TRACK) return;
  watchNetwork();
  readEnv();
  refreshNetType();
}

module.exports = {
  init,
  onAppShow,
  onAppHide,
  sceneLabel,
  newVisitKey,
};
