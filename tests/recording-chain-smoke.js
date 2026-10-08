#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 小程序「录音 / 重录 / 移除」链路自检（纯 Node，不需要微信运行环境）
 *
 * 做法：把 pages/edit/edit.js 与 pages/timeline/timeline.js 原样 require 进来，
 *      只 stub 掉 wx / Page / api / auth；两页共用同一个假 RecorderManager，
 *      且 onStop/onError 按「累加注册、不自动摘除」的真实语义实现 —— 跨页抢答这类
 *      问题只有在这个前提下才测得出来。计时器与 Date.now 换成假时钟，用例可确定性复现
 *      「60s 原生自动收」「授权弹窗返回时页面已退」这类时序。
 *
 * 用例表（断言 id 前缀即分组，与终端输出一一对应）：
 *  A 正常链路：录一段 → 停止 → 转写 → 待存
 *   A01 卡片上没录音时也能开录，start 参数与首页一致（mp3/16k/单声道/60s）
 *   A04 停止后收回录音态、新段上卡片、只发起一次转写
 *   A07 转写成功 → audioUrl/audioDuration/voice.text/content 落地，忙标志复位
 *   A10 buildPayload 带上待存的 audioUrl + audioDuration
 *  B 替换语义（编辑一条已有录音的旧日志）
 *   B02 新段上卡片的同时旧的 audioUrl 必须先清空（否则卡片播新的、保存写旧的）
 *   B04 转写成功 → payload 指向新文件，旧文件交后端回收
 *   B06 转写失败 → payload 明确传 null，绝不把旧录音悄悄存回去
 *   B08 只录半秒 → 不算替换：原录音原样保住，不发上传（B09/B10 配套）
 *   B11 onStop 没带 duration 的机型 → 回落墙钟差，仍正常上卡片
 *  C 全局单例（两页共用一个 RecorderManager）
 *   C01 前提校验：两页回调确实挂在同一单例上（累加注册）
 *   C02 编辑页停录不被首页抢答（不跳新编辑页、不弹「说话时间太短」）
 *   C05 正录着退出页面 → 释放麦克风 + 摘监听 + 不上传（C06/C07/C08 配套）
 *   C09 低版本没 offStop/offError 时靠归属标记兜住（C10 验残留闭包）
 *   C11 录到一半点「移除」= 删除，不被 onStop 变成新增（C12/C13 配套）
 *  D 并发与时序
 *   D01 连点两次「重录」录音器只起一遍（D02 验不假报失败）
 *   D03 原生 60s 到点自己收后，计时器再收不出现二次 stop 报错（D04/D05）
 *   D06 转写未完就点「重录」→ 拦住不并发抢通道
 *   D07 还在录就点保存 → 拦住（否则发出没有新录音的日志）
 *   D08 转写未完就点保存 → 拦住
 *   D09 移除后迟到的转写结果不复活录音，也不把忙标志卡死（D10）
 *   D11 换音源时旧的 InnerAudioContext 被 destroy
 *  E 首页按住录音自身回归
 *   E02 松手发送：经 globalData 中转跳编辑页且只跳一次
 *   E03 上滑 ✕ 取消：不上传不跳转，但仍释放麦克风（E04）
 *   E05 首页 60s 自动收不出现二次 stop 报错
 *   E06 反向抢答：首页那段不被编辑页接手
 *  F 首页 → 编辑页 的中转链路
 *   F01 onLoad 吃掉 pendingVoice 并只转写一次（F02 验取用即清）
 *   F03 转写成功即登记待存 audioUrl，时长与卡片一致
 *   F04 中转来的那段仍能正常页内重录/替换
 *  G 识别结果落表的确认链路（先展示文字、问过再盖）
 *   G01 编辑旧日志（表单已有内容）→ 解析成功不静默盖：先展示文字 + 弹一次确认
 *   G02 确认覆盖 → 直接重写（事件/分类/评价/正文/时间）
 *   G03 选「只留录音」→ 表单一个字不改，录音照旧留着
 *   G04 反悔入口：卡片上点「覆盖表单」→ 同样直接重写
 *   G05 识别文字支持复制（剪贴板收到正文；没文字时不写剪贴板）
 *   G06 新建且表单全空 → 不打扰，直接填，不弹窗
 *   G07 AI 没拆出字段时只剩正文一项：正文已有值照样要问
 *   G08 用户手改过时间 → 时间归入「要覆盖的项」，不静默换时间
 *   G09 选了只留录音后又重录一段 → 上一轮待覆盖结果作废
 *   G10 移除录音 → 待覆盖结果与入口一起消失
 *  H 起录前全局静音（播放实例走 audioHub 台账）
 *   H01 点录制把本页在播的那段停掉
 *   H02 跳页也停：详情页在播的那段同样被停（stop 回枪后按钮复位）
 *   H03 destroy 即出账，已销毁的实例不会再被 stopAll 打
 *   H04 被 guard 拦住的点击（转写中/正在录）不该顺手把用户正在听的弄停
 *   H05 首页按住录音同样先静音
 *   H06 stopAll 只打在播的那一个，没在播的不空发 stop（stop 完在播集合清空）
 *   H07 同一页第二遍起录不再走 getSetting/authorize（顿感就来自这两趟往返）
 *   H08 授权被拒 → 只提示一句：不起录也不静音
 *   H09 录音器报错作废授权缓存，下一轮重新走授权
 *
 * 用法：node tests/recording-chain-smoke.js
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDIT_PATH = path.join(ROOT, "pages", "edit", "edit.js");
const TIMELINE_PATH = path.join(ROOT, "pages", "timeline", "timeline.js");

// ==================== 假时钟 ====================
const clock = {
  now: 1700000000000,
  seq: 0,
  timers: new Map(),
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + (ms || 0), every: 0 });
    return id;
  },
  setInterval(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, {
      fn,
      at: this.now + (ms || 0),
      every: Math.max(1, ms || 0),
    });
    return id;
  },
  clear(id) {
    this.timers.delete(id);
  },
  /** 推进 ms 毫秒，途中按序触发到点的定时任务 */
  tick(ms) {
    const target = this.now + ms;
    for (let guard = 0; guard < 5000; guard += 1) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target);
      if (!due.length) break;
      due.sort((a, b) => a[1].at - b[1].at);
      const [id, t] = due[0];
      this.now = t.at;
      if (t.every) t.at = this.now + t.every;
      else this.timers.delete(id);
      t.fn();
    }
    this.now = target;
  },
  reset() {
    this.timers.clear();
  },
};
global.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
global.setInterval = (fn, ms) => clock.setInterval(fn, ms);
global.clearTimeout = (id) => clock.clear(id);
global.clearInterval = (id) => clock.clear(id);
Date.now = () => clock.now;

// ==================== 共享的假 RecorderManager（关键：全局唯一 + 回调累加） ====================
const REC = {
  stopList: [],
  errorList: [],
  running: false,
  starts: [], // 每次 start 的参数
  stopCalls: 0, // 业务主动调 stop 的次数
  autoStops: 0, // 原生 duration 到点自己收的次数
  errorFires: 0,
  offStopCalls: 0,
  nextResult: { tempFilePath: "wxfile://take.mp3", duration: 3000 },
  onStop(cb) {
    this.stopList.push(cb);
  },
  onError(cb) {
    this.errorList.push(cb);
  },
  offStop(cb) {
    this.offStopCalls += 1;
    const i = this.stopList.indexOf(cb);
    if (i >= 0) this.stopList.splice(i, 1);
  },
  offError(cb) {
    const i = this.errorList.indexOf(cb);
    if (i >= 0) this.errorList.splice(i, 1);
  },
  start(opts) {
    // 真机语义：已在录时再 start 直接进 onError（连点两下就是这个后果）
    if (this.running) {
      this.fireError();
      return;
    }
    this.running = true;
    this.starts.push(opts || {});
  },
  stop() {
    this.stopCalls += 1;
    if (!this.running) {
      // 真机语义：没在录时 stop 同样进 onError
      this.fireError();
      return;
    }
    this.running = false;
    this.fireStop();
  },
  /** 录音时长写满（duration 参数到点），原生层自己收尾 */
  autoStop() {
    if (!this.running) return;
    this.running = false;
    this.autoStops += 1;
    this.fireStop();
  },
  fireStop() {
    this.stopList.slice().forEach((cb) => cb(this.nextResult));
  },
  fireError() {
    this.errorFires += 1;
    this.errorList
      .slice()
      .forEach((cb) => cb({ errMsg: "recorder:fail already started" }));
  },
  /** 每个用例开头清零，免得断言被上一条用例的历史污染 */
  reset() {
    // 连时钟一起清：上一条用例遗留的录音计时器如果还跳着，会替「已经不在录」的页面去调 stop，
    // 假报的「录音失败」会被当成被测代码的 bug（真机上这种残留页面确实存在，所以单独开用例测它）
    clock.reset();
    this.stopList = [];
    this.errorList = [];
    this.running = false;
    this.starts = [];
    this.stopCalls = 0;
    this.autoStops = 0;
    this.errorFires = 0;
    this.offStopCalls = 0;
    this.nextResult = { tempFilePath: "wxfile://take.mp3", duration: 3000 };
  },
};

// ==================== wx 桩 ====================
const audioTracks = { created: 0, destroyed: 0 };
// 所有创建过的播放实例（台账用例要看具体哪几个被 stop 了）
const audioCtxs = [];
const toasts = [];
const navigates = [];
const otherWxCalls = {};
// showModal / setClipboardData 的可控桩：默认选「只留录音」（cancel）
const modalCalls = [];
const clipboard = [];
// 授权 bridge 计数与开关：「同一页第二遍不再走 getSetting/authorize」就是靠这两个数字看出来的
const authBridges = { getSetting: 0, authorize: 0 };
let micGranted = true;
let modalConfirm = false;
function whenModalConfirm(v) {
  modalConfirm = v;
}
// 转写接口返回一份指定 fields 的成功结果（apiState.reset() 会把默认值换回「只有文字」，
// 所以每个要用字段的用例都得在 reset 之后重新挂一次）
function transcribeWith(fields, text) {
  apiState.transcribeImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        text: text || "识别出的正文",
        audioUrl: "/uploads/audio/g.mp3",
        fields,
      },
    });
}

global.wx = new Proxy(
  {
    getRecorderManager: () => REC,
    showToast: (o) => toasts.push((o && o.title) || ""),
    navigateTo: (o) => navigates.push((o && o.url) || ""),
    vibrateShort: () => {},
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
    getSetting: (o) => {
      authBridges.getSetting += 1;
      if (o && o.success) o.success({ authSetting: { "scope.record": true } });
    },
    authorize: (o) => {
      authBridges.authorize += 1;
      if (micGranted) {
        if (o && o.success) o.success({});
      } else if (o && o.fail) o.fail({ errMsg: "authorize:fail auth deny" });
    },
    openSetting: (o) =>
      o.success && o.success({ authSetting: { "scope.record": true } }),
    setNavigationBarTitle: () => {},
    showModal: (o) => {
      modalCalls.push({
        title: (o && o.title) || "",
        content: (o && o.content) || "",
        confirmText: (o && o.confirmText) || "",
        cancelText: (o && o.cancelText) || "",
      });
      if (o && o.success)
        o.success({ confirm: modalConfirm, cancel: !modalConfirm });
    },
    setClipboardData: (o) => {
      clipboard.push((o && o.data) || "");
      if (o && o.success) o.success({});
    },
    createInnerAudioContext: () => {
      audioTracks.created += 1;
      const ctx = {
        src: "",
        currentTime: 0,
        stops: 0,
        destroy() {
          audioTracks.destroyed += 1;
        },
        play() {},
        pause() {},
        // 真机语义：stop 会回一枪 onStop，页面靠它把播放态按钮改回 ▶
        stop() {
          ctx.stops += 1;
          if (ctx._onStop) ctx._onStop();
        },
        onEnded(cb) {
          ctx._onEnded = cb;
        },
        onStop(cb) {
          ctx._onStop = cb;
        },
        onPause(cb) {
          ctx._onPause = cb;
        },
        onPlay(cb) {
          ctx._onPlay = cb;
        },
        onError(cb) {
          ctx._onError = cb;
        },
        onTimeUpdate(cb) {
          ctx._onTimeUpdate = cb;
        },
      };
      audioCtxs.push(ctx);
      return ctx;
    },
  },
  {
    get(target, key) {
      if (key in target) return target[key];
      // 未预期的 wx API：给个「同步 success」桩并记下名字，结尾打印出来，
      // 免得用例因为缺桩而红，也避免把真实依赖悄悄吃掉
      otherWxCalls[key] = (otherWxCalls[key] || 0) + 1;
      return (...args) => {
        const opts = args[args.length - 1] || {};
        if (opts && typeof opts.success === "function") opts.success({});
      };
    },
  },
);
global.Behavior = (o) => o;
const globalData = {};
global.getApp = () => ({ globalData });

// ==================== api / auth 桩 ====================
function deferred() {
  let resolve;
  const p = new Promise((r) => {
    resolve = r;
  });
  p.resolve = resolve;
  return p;
}

const apiState = {
  // 转写接口的返回：可按用例换成失败、迟到的 deferred
  transcribeImpl: null,
  transcribeCalls: [],
  createCalls: [],
  updateCalls: [],
  detail: null,
  reset() {
    this.transcribeCalls = [];
    this.createCalls = [];
    this.updateCalls = [];
    this.transcribeImpl = () =>
      Promise.resolve({
        code: 200,
        data: {
          text: "识别到的文字",
          audioUrl: "/uploads/audio/new.mp3",
          fields: null,
        },
      });
  },
};
const apiMock = {
  event: {
    transcribe: (filePath) => {
      apiState.transcribeCalls.push(filePath);
      return apiState.transcribeImpl(filePath);
    },
    detail: async () => apiState.detail || { code: 404, message: "无" },
    create: async (d) => {
      apiState.createCalls.push(d);
      return { code: 200, data: { id: 1 } };
    },
    update: async (d) => {
      apiState.updateCalls.push(d);
      return { code: 200, data: {} };
    },
    remove: async () => ({ code: 200, data: {} }),
    shareCopy: async () => ({ code: 200, data: {} }),
    parseVoiceText: async () => ({ code: 200, data: {} }),
    uploadImage: async () => ({ code: 200, data: {} }),
    page: async () => ({ code: 200, data: { list: [], total: 0 } }),
  },
  org: {
    mine: async () => ({ code: 200, data: [] }),
  },
  memory: new Proxy(
    {},
    {
      get: () => async () => ({ code: 200, data: {} }),
    },
  ),
  user: new Proxy(
    {},
    {
      get: () => async () => ({ code: 200, data: {} }),
    },
  ),
  tag: new Proxy(
    {},
    {
      get: () => async () => ({ code: 200, data: {} }),
    },
  ),
};
const authMock = new Proxy(
  {
    checkLogin: () => true,
    isAdmin: () => false,
    getUserId: () => 1,
  },
  {
    get: (t, k) => (k in t ? t[k] : () => null),
  },
);

function stubModule(absPath, exports) {
  require.cache[absPath] = {
    id: absPath,
    filename: absPath,
    paths: [],
    loaded: true,
    exports,
  };
}
stubModule(path.join(ROOT, "utils", "api.js"), apiMock);
stubModule(path.join(ROOT, "utils", "auth.js"), authMock);

// ==================== 把两页的 Page 定义捞出来 ====================
let captured = null;
global.Page = (opts) => {
  captured = opts;
};
require(EDIT_PATH);
const editDef = captured;
require(TIMELINE_PATH);
const timelineDef = captured;
require(path.join(ROOT, "pages", "detail", "detail.js"));
const detailDef = captured;
// 页面用的是同一个模块实例（路径一致），拿到的就是它们写音源时用的那份台账
const audioHub = require(path.join(ROOT, "utils", "audioHub.js"));

// ==================== 页面实例（setData 支持 a.b 这种点号路径） ====================
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    if (key.indexOf(".") === -1) {
      data[key] = patch[key];
      return;
    }
    const parts = key.split(".");
    let cur = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object")
        cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = patch[key];
  });
}

function newPage(def) {
  const p = Object.assign({}, def);
  p.data = clone(def.data);
  p.setData = (patch, cb) => {
    applyPatch(p.data, patch || {});
    if (cb) cb();
  };
  return p;
}

async function idle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 起一个编辑页：options.id 走「编辑旧日志」，detail 里可带已存录音 */
async function newEditPage(options, detail) {
  apiState.detail = detail || null;
  const p = newPage(editDef);
  await p.onLoad(options || {});
  await idle();
  return p;
}

// ==================== 迷你断言框架 ====================
const results = [];
function check(id, desc, cond, detail) {
  results.push({ id, desc, pass: Boolean(cond), detail });
}
function section(title) {
  results.push({ section: title });
}

// 事件序列小工具：把「点一下重录」「点一下停止」写短
async function tapRecord(page) {
  page.toggleReRecord();
  await idle();
}
function tapStop(page) {
  page.stopReRecord();
}
/** 把原生层拨到「正在录」：用例里手工搭页面、直接调 stop 时免去先跑一遍完整 start */
function nativeRecording() {
  REC.running = true;
}

(async () => {
  // ==================== A 正常链路 ====================
  section("A 正常链路：录一段 → 停止 → 转写 → 待存");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  let p = await newEditPage({});
  check(
    "A00",
    "进页时不该有录音卡片（voice 为空）",
    !p.data.voice,
    `voice=${JSON.stringify(p.data.voice)}`,
  );
  await tapRecord(p);
  check(
    "A01",
    "点「录一段」进入 recording 态",
    p.data.recording === true,
    `recording=${p.data.recording}`,
  );
  check(
    "A02",
    "recorder.start 只被调一次",
    REC.starts.length === 1,
    `starts=${REC.starts.length}`,
  );
  check(
    "A03",
    "start 参数与首页一致（mp3/16k/单声道/60s）",
    REC.starts[0] &&
      REC.starts[0].format === "mp3" &&
      REC.starts[0].sampleRate === 16000 &&
      REC.starts[0].numberOfChannels === 1 &&
      REC.starts[0].duration === 60000,
    JSON.stringify(REC.starts[0]),
  );

  REC.nextResult = { tempFilePath: "wxfile://take-1.mp3", duration: 4000 };
  tapStop(p);
  check(
    "A04",
    "停止后收回 recording 态",
    p.data.recording === false,
    `recording=${p.data.recording}`,
  );
  check(
    "A05",
    "新段立刻上卡片（本地临时路径 + 时长）",
    p.data.voice &&
      p.data.voice.tempFilePath === "wxfile://take-1.mp3" &&
      p.data.voice.duration === 4,
    JSON.stringify(p.data.voice),
  );
  check(
    "A06",
    "自动发起转写且只一次",
    apiState.transcribeCalls.length === 1,
    `calls=${apiState.transcribeCalls.length}`,
  );
  await idle();
  check(
    "A07",
    "转写成功后 audioUrl/audioDuration 落到待存字段",
    p.data.audioUrl === "/uploads/audio/new.mp3" && p.data.audioDuration === 4,
    `audioUrl=${p.data.audioUrl} duration=${p.data.audioDuration}`,
  );
  check(
    "A08",
    "转写文本回填卡片与空正文",
    p.data.voice.text === "识别到的文字" && p.data.content === "识别到的文字",
    `text=${p.data.voice.text} content=${p.data.content}`,
  );
  check(
    "A09",
    "忙标志复位，可以保存了",
    p._transcribing === false,
    `_transcribing=${p._transcribing}`,
  );
  const payloadA = p.buildPayload();
  check(
    "A10",
    "payload 带上待存的 audioUrl + audioDuration",
    payloadA.audioUrl === "/uploads/audio/new.mp3" &&
      payloadA.audioDuration === 4,
    JSON.stringify({
      audioUrl: payloadA.audioUrl,
      audioDuration: payloadA.audioDuration,
    }),
  );

  // ==================== B 替换语义 ====================
  section("B 替换语义：编辑一条已有录音的旧日志");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage(
    { id: "9" },
    {
      code: 200,
      data: {
        id: 9,
        time: "2026-10-01 09:00",
        event: "旧事件",
        content: "旧正文",
        audioUrl: "/uploads/audio/old.mp3",
        audioDuration: 7,
      },
    },
  );
  check(
    "B01",
    "旧录音原样上卡片并记在 audioUrl",
    p.data.audioUrl === "/uploads/audio/old.mp3" &&
      p.data.voice &&
      p.data.voice.saved === true,
    `audioUrl=${p.data.audioUrl} voice=${JSON.stringify(p.data.voice)}`,
  );
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-2.mp3", duration: 3000 };
  tapStop(p);
  check(
    "B02",
    "收住旧段：新段上卡片的同时 audioUrl 必须先清空",
    p.data.audioUrl === "",
    `audioUrl=${p.data.audioUrl}`,
  );
  check(
    "B03",
    "原录音是已存的 → 标记 audioCleared（保存要告知后端清空）",
    p.data.audioCleared === true,
    `audioCleared=${p.data.audioCleared}`,
  );
  await idle();
  check(
    "B04",
    "转写成功后 payload 指向新文件（旧文件由后端回收）",
    p.buildPayload().audioUrl === "/uploads/audio/new.mp3" &&
      p.buildPayload().audioDuration === 3,
    JSON.stringify(p.buildPayload().audioUrl),
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage(
    { id: "9" },
    {
      code: 200,
      data: {
        id: 9,
        time: "2026-10-01 09:00",
        event: "旧事件",
        audioUrl: "/uploads/audio/old.mp3",
        audioDuration: 7,
      },
    },
  );
  apiState.transcribeImpl = () =>
    Promise.resolve({ code: 500, message: "语音识别服务额度不足" });
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-3.mp3", duration: 3000 };
  tapStop(p);
  await idle();
  check(
    "B05",
    "转写失败时不给旧的 audioUrl 留活路（不出现播新存旧）",
    p.data.audioUrl === "" && p.data.audioCleared === true,
    `audioUrl=${p.data.audioUrl} audioCleared=${p.data.audioCleared}`,
  );
  check(
    "B06",
    "此时保存明确传 null 清空，而不是把旧录音悄悄存回去",
    p.buildPayload().audioUrl === null,
    JSON.stringify(p.buildPayload().audioUrl),
  );
  check(
    "B07",
    "失败原因说清楚并给出原地重试入口",
    p.data.voiceRetryable === true &&
      String(p.data.voiceReason).indexOf("额度不足") !== -1,
    `reason=${p.data.voiceReason}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage(
    { id: "9" },
    {
      code: 200,
      data: {
        id: 9,
        time: "2026-10-01 09:00",
        event: "旧事件",
        audioUrl: "/uploads/audio/old.mp3",
        audioDuration: 7,
      },
    },
  );
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://tiny.mp3", duration: 500 };
  clock.tick(200);
  tapStop(p);
  await idle();
  check(
    "B08",
    "只录半秒 → 不算替换，原录音原样保住",
    p.data.audioUrl === "/uploads/audio/old.mp3" &&
      p.data.voice &&
      p.data.voice.saved === true,
    `audioUrl=${p.data.audioUrl} voice=${JSON.stringify(p.data.voice)}`,
  );
  check(
    "B09",
    "半秒这段不发上传",
    apiState.transcribeCalls.length === 0,
    `calls=${apiState.transcribeCalls.length}`,
  );
  check(
    "B10",
    "太短退回后状态文案不能卡在「录音中…」",
    p.data.voiceStatus !== "录音中…",
    `voiceStatus=${p.data.voiceStatus}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://no-dur.mp3" }; // 个别机型 onStop 不带 duration
  clock.tick(3000);
  tapStop(p);
  await idle();
  check(
    "B11",
    "onStop 没带 duration 时回落墙钟差，仍正常替上卡片",
    p.data.voice &&
      p.data.voice.duration === 3 &&
      apiState.transcribeCalls.length === 1,
    `voice=${JSON.stringify(p.data.voice)} calls=${apiState.transcribeCalls.length}`,
  );

  // ==================== C 全局单例的归属与清理 ====================
  section("C 全局单例：两页共用一个 RecorderManager 的归属与清理");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  navigates.length = 0;
  globalData._pendingVoice = null;
  const tl = newPage(timelineDef);
  tl.initRecorder();
  p = await newEditPage({});
  await tapRecord(p);
  check(
    "C01",
    "前提成立：两页回调确实挂在同一单例上（累加注册）",
    REC.stopList.length >= 2,
    `stopList=${REC.stopList.length}`,
  );
  const createBefore = navigates.length;
  REC.nextResult = { tempFilePath: "wxfile://take-4.mp3", duration: 2000 };
  tapStop(p);
  await idle();
  check(
    "C02",
    "编辑页停录不被首页抢答（不跳新编辑页）",
    navigates.length === createBefore,
    `navigateTo=${JSON.stringify(navigates)}`,
  );
  check(
    "C03",
    "首页不会凭空弹「说话时间太短」",
    toasts.filter((t) => t === "说话时间太短").length === 0,
    `toasts=${JSON.stringify(toasts)}`,
  );
  check(
    "C04",
    "首页也没顺手把这段塞进 _pendingVoice",
    !globalData._pendingVoice,
    JSON.stringify(globalData._pendingVoice),
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  await tapRecord(p);
  const callsBeforeUnload = apiState.transcribeCalls.length;
  const listenersBefore = REC.stopList.length;
  p.onUnload();
  check(
    "C05",
    "退出页面时释放麦克风（调了 stop）",
    REC.stopCalls >= 1,
    `stopCalls=${REC.stopCalls}`,
  );
  check(
    "C06",
    "退出页面时摘掉本页监听",
    REC.stopList.length < listenersBefore,
    `before=${listenersBefore} after=${REC.stopList.length}`,
  );
  REC.nextResult = { tempFilePath: "wxfile://ghost.mp3", duration: 5000 };
  REC.fireStop();
  await idle();
  check(
    "C07",
    "卸载后不再上传转写（不留孤儿录音）",
    apiState.transcribeCalls.length === callsBeforeUnload,
    `calls=${apiState.transcribeCalls.length}`,
  );
  const tl2 = newPage(timelineDef);
  tl2.initRecorder();
  tl2.data.recordSeconds = 5;
  tl2._recExpect = true;
  tl2._started = true;
  nativeRecording();
  tl2.stopRecord();
  await idle();
  check(
    "C08",
    "此后首页再录一段，已卸载页的旧闭包不接手",
    navigates.length >= 1 &&
      apiState.transcribeCalls.length === callsBeforeUnload,
    `transcribe=${apiState.transcribeCalls.length} navigateTo=${JSON.stringify(navigates)}`,
  );

  const savedOffStop = REC.offStop;
  const savedOffError = REC.offError;
  delete REC.offStop;
  delete REC.offError;
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  await tapRecord(p);
  const callsNoOff = apiState.transcribeCalls.length;
  REC.nextResult = { tempFilePath: "wxfile://take-5.mp3", duration: 2000 };
  p.removeVoice();
  await idle();
  check(
    "C09",
    "低版本没有 offStop/offError 时，仍靠归属标记兜住（移除不当新增）",
    apiState.transcribeCalls.length === callsNoOff && p.data.voice === null,
    `calls=${apiState.transcribeCalls.length} voice=${JSON.stringify(p.data.voice)}`,
  );
  // 摘不掉监听时，卸载页的闭包会永久留在单例上：得靠归属标记让它白跑
  const pNoOff = await newEditPage({});
  await tapRecord(pNoOff);
  pNoOff.onUnload();
  const callsAfterNoOffUnload = apiState.transcribeCalls.length;
  navigates.length = 0;
  const homeNoOff = newPage(timelineDef);
  homeNoOff.initRecorder();
  homeNoOff._recExpect = true;
  homeNoOff._started = true;
  homeNoOff.data.recordSeconds = 6;
  globalData._pendingVoice = null;
  REC.nextResult = { tempFilePath: "wxfile://home-nooff.mp3", duration: 6000 };
  nativeRecording();
  homeNoOff.stopRecord();
  await idle();
  check(
    "C10",
    "摘不掉监听时，卸载页残留闭包也接不了首页那段",
    apiState.transcribeCalls.length === callsAfterNoOffUnload &&
      navigates.length === 1,
    `calls=${apiState.transcribeCalls.length} navigateTo=${JSON.stringify(navigates)}`,
  );
  REC.offStop = savedOffStop;
  REC.offError = savedOffError;

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  await tapRecord(p);
  const callsBeforeRemove = apiState.transcribeCalls.length;
  REC.nextResult = { tempFilePath: "wxfile://take-6.mp3", duration: 3000 };
  p.removeVoice();
  await idle();
  check(
    "C11",
    "录到一半点「移除」= 删除，不被 onStop 变成新增",
    apiState.transcribeCalls.length === callsBeforeRemove &&
      p.data.voice === null &&
      p.data.recording === false,
    `calls=${apiState.transcribeCalls.length} voice=${JSON.stringify(p.data.voice)}`,
  );
  check(
    "C12",
    "移除时释放麦克风",
    REC.stopCalls >= 1,
    `stopCalls=${REC.stopCalls}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage(
    { id: "9" },
    {
      code: 200,
      data: {
        id: 9,
        time: "2026-10-01 09:00",
        event: "旧事件",
        audioUrl: "/uploads/audio/old.mp3",
        audioDuration: 7,
      },
    },
  );
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-7.mp3", duration: 3000 };
  p.removeVoice();
  await idle();
  check(
    "C13",
    "有已存录音时「录一半移除」→ 保存传 null 清空",
    p.data.audioCleared === true && p.buildPayload().audioUrl === null,
    `audioCleared=${p.data.audioCleared} payload=${JSON.stringify(p.buildPayload().audioUrl)}`,
  );

  // ==================== D 并发与时序 ====================
  section("D 并发与时序：连点、自动收、迟到结果");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  p.toggleReRecord();
  p.toggleReRecord(); // 授权弹窗还没返回就再点一次
  await idle();
  check(
    "D01",
    "连点两次「重录」录音器只起一遍",
    REC.starts.length === 1,
    `starts=${REC.starts.length}`,
  );
  check(
    "D02",
    "连点不该假报「录音失败」",
    toasts.filter((t) => String(t).indexOf("录音失败") === 0).length === 0,
    JSON.stringify(toasts),
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  await tapRecord(p);
  clock.tick(59000); // 面板计时先走到 59s
  REC.nextResult = { tempFilePath: "wxfile://full.mp3", duration: 60000 };
  REC.autoStop(); // 原生 duration 到点先自己收（真机上就是这个先后顺序）
  const callsAfterAuto = apiState.transcribeCalls.length;
  clock.tick(3000); // 计时器随后才追上 60s 那一档
  await idle();
  check(
    "D03",
    "60s 自动收：结果只处理一次",
    callsAfterAuto === 1 && apiState.transcribeCalls.length === 1,
    `calls=${apiState.transcribeCalls.length}`,
  );
  check(
    "D04",
    "60s 自动收不出现二次 stop 报错",
    REC.errorFires === 0 &&
      toasts.filter((t) => String(t).indexOf("录音失败") === 0).length === 0,
    `errorFires=${REC.errorFires} toasts=${JSON.stringify(toasts)}`,
  );
  check(
    "D05",
    "自动收之后收回 recording 态",
    p.data.recording === false,
    `recording=${p.data.recording}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  const slow = deferred();
  apiState.transcribeImpl = () => slow;
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-8.mp3", duration: 3000 };
  tapStop(p);
  p.toggleReRecord(); // 上一段还在转写
  check(
    "D06",
    "转写未完就点「重录」→ 拦住不并发抢通道",
    p.data.recording === false &&
      REC.starts.length === 1 &&
      toasts.some((t) => String(t).indexOf("处理中") !== -1),
    `recording=${p.data.recording} toasts=${JSON.stringify(toasts)}`,
  );
  slow.resolve({
    code: 200,
    data: { text: "x", audioUrl: "/uploads/audio/slow.mp3", fields: null },
  });
  await idle();

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  apiState.createCalls.length = 0;
  p = await newEditPage({});
  p.data.event = "有标题";
  await tapRecord(p);
  await p.onSubmit();
  check(
    "D07",
    "还在录就点保存 → 拦住（否则发出没有新录音的日志）",
    apiState.createCalls.length === 0 &&
      toasts.some((t) => String(t).indexOf("停止录音") !== -1),
    `create=${apiState.createCalls.length} toasts=${JSON.stringify(toasts)}`,
  );
  REC.nextResult = { tempFilePath: "wxfile://take-9.mp3", duration: 3000 };
  tapStop(p);
  const pending = deferred();
  apiState.transcribeImpl = () => pending;
  p.transcribeAndParse("wxfile://take-9.mp3");
  await p.onSubmit();
  check(
    "D08",
    "转写未完就点保存 → 拦住「录音保存中」",
    apiState.createCalls.length === 0 &&
      toasts.some((t) => String(t).indexOf("录音保存中") !== -1),
    `create=${apiState.createCalls.length} toasts=${JSON.stringify(toasts)}`,
  );
  pending.resolve({
    code: 200,
    data: { text: "y", audioUrl: "/uploads/audio/ok.mp3", fields: null },
  });
  await idle();

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  p = await newEditPage({});
  const late = deferred();
  apiState.transcribeImpl = () => late;
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-10.mp3", duration: 3000 };
  tapStop(p);
  p.removeVoice(); // 用户等不及删了
  late.resolve({
    code: 200,
    data: { text: "z", audioUrl: "/uploads/audio/late.mp3", fields: null },
  });
  await idle();
  check(
    "D09",
    "移除后迟到的转写结果不复活录音",
    p.data.audioUrl === "" && p.data.voice === null,
    `audioUrl=${p.data.audioUrl} voice=${JSON.stringify(p.data.voice)}`,
  );
  check(
    "D10",
    "迟到结果也不该把忙标志留在 true 卡死保存",
    p._transcribing === false,
    `_transcribing=${p._transcribing}`,
  );

  audioTracks.created = 0;
  audioTracks.destroyed = 0;
  p = newPage(editDef);
  p.data = clone(editDef.data);
  p.setData = (patch) => applyPatch(p.data, patch || {});
  p.initAudio("wxfile://a.mp3");
  p.initAudio("wxfile://b.mp3");
  check(
    "D11",
    "换音源时旧的 InnerAudioContext 被 destroy",
    audioTracks.created === 2 && audioTracks.destroyed === 1,
    `created=${audioTracks.created} destroyed=${audioTracks.destroyed}`,
  );

  // ==================== E 首页自身回归 ====================
  section("E 首页按住录音：发送 / 取消 / 自动收");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  navigates.length = 0;
  globalData._pendingVoice = null;
  const home = newPage(timelineDef);
  home.onMicStart();
  await idle();
  clock.tick(50); // 面板展开那一帧
  check(
    "E01",
    "按住展开面板并起录",
    REC.starts.length === 1 && home.data.recording === true,
    `starts=${REC.starts.length} recording=${home.data.recording}`,
  );
  clock.tick(3000); // 计时器走 3 秒
  REC.nextResult = { tempFilePath: "wxfile://home-2.mp3", duration: 3000 };
  // 手指仍停在按钮中心（375x667 下触发线在 y=515，612 未越线）→ 走发送
  home.onMicEnd({
    touches: [],
    changedTouches: [{ clientX: 330, clientY: 612 }],
  });
  await idle();
  check(
    "E02",
    "松手发送：经 globalData 中转跳编辑页，且只跳一次",
    navigates.length === 1 &&
      navigates[0].indexOf("/pages/edit/edit") === 0 &&
      !!globalData._pendingVoice,
    `navigateTo=${JSON.stringify(navigates)} pending=${JSON.stringify(globalData._pendingVoice)}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  navigates.length = 0;
  globalData._pendingVoice = null;
  const home2 = newPage(timelineDef);
  home2.onMicStart();
  await idle();
  clock.tick(50);
  clock.tick(2000);
  home2.onMicEnd({
    touches: [],
    changedTouches: [{ clientX: 330, clientY: 300 }],
  }); // 上滑越过触发线
  await idle();
  check(
    "E03",
    "上滑取消：不上传不跳转，只提示一句",
    !globalData._pendingVoice &&
      navigates.length === 0 &&
      toasts.some((t) => String(t).indexOf("已取消") !== -1),
    `pending=${JSON.stringify(globalData._pendingVoice)} toasts=${JSON.stringify(toasts)}`,
  );
  check(
    "E04",
    "取消仍然要 stop 释放麦克风",
    REC.stopCalls >= 1,
    `stopCalls=${REC.stopCalls}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  navigates.length = 0;
  globalData._pendingVoice = null;
  const home3 = newPage(timelineDef);
  home3.onMicStart();
  await idle();
  clock.tick(50); // 面板展开那一帧
  clock.tick(59000); // 面板计时走到 59s
  REC.nextResult = { tempFilePath: "wxfile://home-3.mp3", duration: 60000 };
  REC.autoStop(); // 原生到点自己收
  clock.tick(3000); // 计时器随后才追上 60s → stopRecord 见 _started 已假，只收面板
  await idle();
  check(
    "E05",
    "首页 60s 自动收不出现二次 stop 报错",
    REC.errorFires === 0 && navigates.length === 1,
    `errorFires=${REC.errorFires} navigateTo=${JSON.stringify(navigates)}`,
  );

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  globalData._pendingVoice = null; // 上一段用例跳编辑页时留在 globalData 里的那段要先清，不然新页面 onLoad 会立刻吃掉它
  p = await newEditPage({});
  const callsBefore = apiState.transcribeCalls.length;
  const home4 = newPage(timelineDef);
  home4.initRecorder();
  home4._recExpect = true;
  home4._started = true;
  home4.data.recordSeconds = 4;
  globalData._pendingVoice = null;
  navigates.length = 0;
  REC.nextResult = { tempFilePath: "wxfile://home-4.mp3", duration: 4000 };
  nativeRecording();
  home4.stopRecord(); // 首页那段结束：回调会同时打到编辑页
  await idle();
  check(
    "E06",
    "反向抢答也不成立：首页那段不被编辑页处理",
    p.data.voice === null &&
      apiState.transcribeCalls.length === callsBefore &&
      !!globalData._pendingVoice,
    `voice=${JSON.stringify(p.data.voice)} transcribe=${apiState.transcribeCalls.length} pending=${JSON.stringify(globalData._pendingVoice)}`,
  );

  // ==================== F 首页→编辑页 的中转链路 ====================
  section("F 首页录完跳进来：编辑页 onLoad 接手转写");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  globalData._pendingVoice = {
    tempFilePath: "wxfile://from-home.mp3",
    duration: 8,
  };
  p = await newEditPage({});
  check(
    "F01",
    "onLoad 吃掉 pendingVoice 并只发起一次转写",
    apiState.transcribeCalls.length === 1 &&
      p.data.voice &&
      p.data.voice.tempFilePath === "wxfile://from-home.mp3",
    `calls=${apiState.transcribeCalls.length} voice=${JSON.stringify(p.data.voice)}`,
  );
  check(
    "F02",
    "取用后即从 globalData 抹掉（返回再进页不会重复转写）",
    !globalData._pendingVoice,
    JSON.stringify(globalData._pendingVoice),
  );
  await idle();
  check(
    "F03",
    "转写成功即把首页那段登记成待存 audioUrl（时长跟卡片一致）",
    p.data.audioUrl === "/uploads/audio/new.mp3" && p.data.audioDuration === 8,
    `audioUrl=${p.data.audioUrl} duration=${p.data.audioDuration}`,
  );
  // 首页中转来的那段上卡片后，页内重录/移除都还能正常接手
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://take-11.mp3", duration: 2000 };
  tapStop(p);
  await idle();
  check(
    "F04",
    "中转链路接到页内重录：新段替上去并重发一轮转写",
    p.data.voice.tempFilePath === "wxfile://take-11.mp3" &&
      apiState.transcribeCalls.length === 2 &&
      p.data.audioUrl === "/uploads/audio/new.mp3",
    `voice=${JSON.stringify(p.data.voice)} calls=${apiState.transcribeCalls.length}`,
  );

  // ==================== G 识别结果落表的确认链路 ====================
  section("G 识别结果落表：先展示文字，问过再盖");

  const richFields = {
    time: "2026-09-20 08:30",
    event: "识别出的事件",
    type: "旅游",
    rating: "好",
    experience: "识别出的经验",
    witness: "识别出的见证者",
    position: "识别出的地点",
  };
  const richDetail = {
    code: 200,
    data: {
      id: 9,
      time: "2026-10-01 09:00",
      event: "手打的事件",
      content: "手打的正文",
      type: "工作",
      rating: "拉",
      experience: "手打的经验",
      witness: "手打的见证者",
      position: "手打的地点",
      audioUrl: "/uploads/audio/old.mp3",
      audioDuration: 7,
    },
  };

  // G01/G03：选了「只留录音」
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(false);
  apiState.transcribeImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        text: "识别出的正文",
        audioUrl: "/uploads/audio/g.mp3",
        fields: richFields,
      },
    });
  p = await newEditPage({ id: "9" }, richDetail);
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g1.mp3", duration: 5000 };
  tapStop(p);
  await idle();
  check(
    "G01",
    "文字先上卡片并展开",
    p.data.voice.text === "识别出的正文" && p.data.voiceCollapsed === false,
    `text=${p.data.voice.text} collapsed=${p.data.voiceCollapsed}`,
  );
  check(
    "G01b",
    "解析成功只问一次",
    modalCalls.length === 1,
    `modals=${modalCalls.length}`,
  );
  check(
    "G01c",
    "确认弹窗给的是「覆盖表单 / 只留录音」两个出口",
    modalCalls[0].confirmText === "覆盖表单" &&
      modalCalls[0].cancelText === "只留录音",
    JSON.stringify(modalCalls[0]),
  );
  check(
    "G03",
    "选「只留录音」后表单原值全不动（连时间也不改）",
    p.data.event === "手打的事件" &&
      p.data.content === "手打的正文" &&
      p.data.type === "工作" &&
      p.data.rating === "拉" &&
      p.data.date === "2026-10-01" &&
      p.data.timeStr === "09:00",
    `event=${p.data.event} content=${p.data.content} time=${p.data.date} ${p.data.timeStr}`,
  );
  check(
    "G03b",
    "录音照旧留着（待存 audioUrl 已登记）",
    p.data.audioUrl === "/uploads/audio/g.mp3" && p.data.audioDuration === 5,
    `audioUrl=${p.data.audioUrl} duration=${p.data.audioDuration}`,
  );
  check(
    "G03c",
    "卡片上留了反悔入口",
    p.data.voiceApplyable === true && p.data.voiceApplied === false,
    `applyable=${p.data.voiceApplyable} applied=${p.data.voiceApplied}`,
  );
  p.applyVoiceResult();
  check(
    "G04",
    "事后点「覆盖表单」→ 直接重写各项",
    p.data.event === "识别出的事件" &&
      p.data.content === "识别出的正文" &&
      p.data.type === "旅游" &&
      p.data.rating === "好" &&
      p.data.experience === "识别出的经验" &&
      p.data.witness === "识别出的见证者" &&
      p.data.location.position === "识别出的地点",
    `event=${p.data.event} type=${p.data.type} pos=${p.data.location.position}`,
  );
  check(
    "G04c",
    "覆盖模式连时间一起重写",
    p.data.date === "2026-09-20" && p.data.timeStr === "08:30",
    `${p.data.date} ${p.data.timeStr}`,
  );
  check(
    "G04b",
    "覆盖完入口消失并标记已应用",
    p.data.voiceApplyable === false && p.data.voiceApplied === true,
    `applyable=${p.data.voiceApplyable}`,
  );

  // G02：弹窗里直接确认
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(true);
  transcribeWith(richFields);
  p = await newEditPage({ id: "9" }, richDetail);
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g2.mp3", duration: 5000 };
  tapStop(p);
  await idle();
  check(
    "G02",
    "弹窗里选「覆盖表单」→ 解析结果当场重写表单",
    p.data.event === "识别出的事件" &&
      p.data.content === "识别出的正文" &&
      p.data.voiceApplied === true,
    `event=${p.data.event} content=${p.data.content}`,
  );

  // G06：新建且表单全空 → 不打扰
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(false);
  transcribeWith(richFields);
  p = await newEditPage({});
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g6.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G06",
    "新建且全空 → 不弹窗，直接填空白项",
    modalCalls.length === 0 &&
      p.data.content === "识别出的正文" &&
      p.data.event === "识别出的事件" &&
      p.data.voiceApplied === true,
    `modals=${modalCalls.length} content=${p.data.content}`,
  );
  check(
    "G06b",
    "全空场景不出现「覆盖表单」入口（没东西可盖）",
    p.data.voiceApplyable === false,
    `applyable=${p.data.voiceApplyable}`,
  );

  // G07：AI 没拆出字段，只剩正文一项
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  apiState.transcribeImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        text: "只有文字",
        audioUrl: "/uploads/audio/g7.mp3",
        fields: null,
      },
    });
  p = await newEditPage({ id: "9" }, richDetail);
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g7.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G07",
    "没拆出字段时只剩正文：正文已有值照样要问，不静默盖",
    modalCalls.length === 1 &&
      modalCalls[0].content.indexOf("正文") !== -1 &&
      p.data.content === "手打的正文",
    `modals=${modalCalls.length} content=${p.data.content}`,
  );
  check(
    "G07b",
    "拆字段失败仍给重试入口（文字与录音都在）",
    p.data.voiceRetryable === true && p.data.voice.text === "只有文字",
    `retryable=${p.data.voiceRetryable}`,
  );

  // G08：时间算不算「已填」
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(true);
  transcribeWith(richFields);
  p = await newEditPage({});
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g8.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G08",
    "时间仍是进页默认（没手改）→ 归为空白，直接按识别写且不弹窗",
    modalCalls.length === 0 &&
      p.data.date === "2026-09-20" &&
      p.data.timeStr === "08:30",
    `modals=${modalCalls.length} time=${p.data.date} ${p.data.timeStr}`,
  );
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(false);
  transcribeWith(richFields);
  p = await newEditPage({});
  p.setData({ date: "2026-01-01", timeStr: "00:00" }); // 用户手改了时间，其余空着
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://g9.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G08b",
    "用户手改过时间 → 时间归入「要覆盖」清单，要问一句",
    modalCalls.length === 1 && modalCalls[0].content.indexOf("时间") !== -1,
    `modals=${modalCalls.length} content=${modalCalls[0] && modalCalls[0].content}`,
  );
  check(
    "G08c",
    "问的时候没擅自改时间",
    p.data.date === "2026-01-01" && p.data.timeStr === "00:00",
    `${p.data.date} ${p.data.timeStr}`,
  );
  p.applyVoiceResult();
  check(
    "G08d",
    "确认覆盖后时间才重写",
    p.data.date === "2026-09-20" && p.data.timeStr === "08:30",
    `${p.data.date} ${p.data.timeStr}`,
  );

  // G09/G10：上一轮的待覆盖结果不能活到下一轮
  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(false);
  apiState.transcribeImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        text: "第一轮文字",
        audioUrl: "/uploads/audio/r1.mp3",
        fields: { event: "第一轮事件" },
      },
    });
  p = await newEditPage({ id: "9" }, richDetail);
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://r1.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G09a",
    "第一轮选了只留录音 → 结果与入口都在",
    p.data.voiceApplyable === true &&
      !!p._voiceParsed &&
      p._voiceParsed.text === "第一轮文字",
    JSON.stringify(p._voiceParsed && p._voiceParsed.text),
  );
  apiState.transcribeImpl = () =>
    Promise.resolve({
      code: 200,
      data: {
        text: "第二轮文字",
        audioUrl: "/uploads/audio/r2.mp3",
        fields: null,
      },
    });
  await tapRecord(p);
  REC.nextResult = { tempFilePath: "wxfile://r2.mp3", duration: 4000 };
  tapStop(p);
  await idle();
  check(
    "G09",
    "重录后只认最新一轮：上一轮的待覆盖结果作废",
    p._voiceParsed.text === "第二轮文字" && p.data.voice.text === "第二轮文字",
    `cached=${p._voiceParsed.text} card=${p.data.voice.text}`,
  );
  check(
    "G09b",
    "重录后 event 仍没被上一轮结果盖掉",
    p.data.event === "手打的事件",
    `event=${p.data.event}`,
  );
  p.removeVoice();
  check(
    "G10",
    "移除录音 → 覆盖入口与识别结果一起清掉",
    p.data.voiceApplyable === false &&
      p.data.voiceApplied === false &&
      !p._voiceParsed,
    `applyable=${p.data.voiceApplyable} parsed=${JSON.stringify(p._voiceParsed)}`,
  );

  // G05：复制识别出的文字
  clipboard.length = 0;
  toasts.length = 0;
  p.copyVoiceText();
  check(
    "G05",
    "没有识别文字时不写剪贴板，只提示一句",
    clipboard.length === 0 &&
      toasts.some((t) => String(t).indexOf("还没有识别文字") !== -1),
    `clipboard=${clipboard.length} toasts=${JSON.stringify(toasts)}`,
  );
  const pCopy = newPage(editDef);
  pCopy.setData({
    voice: {
      tempFilePath: "wxfile://copy.mp3",
      duration: 3,
      text: "要复制的文字",
    },
  });
  clipboard.length = 0;
  pCopy.copyVoiceText();
  check(
    "G05b",
    "复制入口把识别文字交给剪贴板",
    clipboard.length === 1 && clipboard[0] === "要复制的文字",
    JSON.stringify(clipboard),
  );

  // ==================== H 起录前全局静音 ====================
  section("H 点录制时：全局在播的声音都停掉");

  REC.reset();
  apiState.reset();
  toasts.length = 0;
  modalCalls.length = 0;
  globalData._pendingVoice = null;
  whenModalConfirm(false);
  transcribeWith(richFields);
  p = await newEditPage({ id: "9" }, richDetail);
  const editCtx = p._audio;
  check(
    "H00",
    "录音卡的播放实例走的是台账（否则 stopAll 找不到它）",
    !!editCtx && audioHub.count() > 0,
    `count=${audioHub.count()}`,
  );
  editCtx.play(); // 用户点了播放：此刻原生真在放
  const editStopsBefore = editCtx.stops;
  await tapRecord(p);
  check(
    "H01",
    "点录制把本页在播的那段停掉了",
    editCtx.stops === editStopsBefore + 1 && p.data.playing === false,
    `stops=${editCtx.stops} playing=${p.data.playing}`,
  );

  // 另一个页面（详情页）在播的那段也要被停
  p.onUnload(); // 收摊：释放上一用例留在录的录音器，免得下一轮 start 撞车进 onError
  const dp = newPage(detailDef);
  const detailCtx = dp.initAudio("http://host/uploads/audio/old.mp3");
  detailCtx.play();
  dp.setData({ audioPlaying: true });
  const detailStopsBefore = detailCtx.stops;
  const pH2 = await newEditPage({});
  await tapRecord(pH2);
  check(
    "H02",
    "跳页静音：详情页在播的那段同样被停",
    detailCtx.stops === detailStopsBefore + 1,
    `stops=${detailCtx.stops}`,
  );
  check(
    "H02b",
    "stop 回一枪 onStop → 详情页播放态按钮自己复位",
    dp.data.audioPlaying === false,
    `audioPlaying=${dp.data.audioPlaying}`,
  );

  // 销毁即出账：不会留下永远停不掉的幽灵实例
  pH2.onUnload();
  const ghost = audioHub.create();
  ghost.play();
  check(
    "H03a",
    "play 当场在账（不等原生回 onPlay，手指快时也不漏停）",
    audioHub.playingCount() === 1,
    `playing=${audioHub.playingCount()}`,
  );
  ghost.destroy();
  check(
    "H03b",
    "destroy 即出账（不会留下停不掉的幽灵实例）",
    audioHub.playingCount() === 0,
    `playing=${audioHub.playingCount()}`,
  );
  const ghostStopsBefore = ghost.stops;
  const pH3 = await newEditPage({});
  await tapRecord(pH3);
  check(
    "H03",
    "destroy 后出账：已销毁的实例不会再被 stopAll 打",
    ghost.stops === ghostStopsBefore,
    `stops=${ghost.stops}`,
  );

  // 被拦回头的点击不该顺手把人正在听的弄停
  pH3.onUnload();
  const pH4 = await newEditPage({ id: "9" }, richDetail);
  const ctx4 = pH4._audio;
  ctx4.play(); // 正在听上一条
  const stops4 = ctx4.stops;
  pH4._transcribing = true; // 上一段还在转写 → 这一下会被拦住
  pH4.toggleReRecord();
  await idle();
  check(
    "H04",
    "被 guard 拦住的点击不静音（只是没起录，不该弄停用户正在听的）",
    ctx4.stops === stops4 &&
      toasts.some((t) => String(t).indexOf("处理中") !== -1),
    `stops=${ctx4.stops} toasts=${JSON.stringify(toasts)}`,
  );
  pH4._transcribing = false;
  await tapRecord(pH4);
  check(
    "H04b",
    "真的起录了才静音",
    ctx4.stops === stops4 + 1,
    `stops=${ctx4.stops}`,
  );
  // 收摊：不收的话原生层还留在「正在录」，下一轮 start 会撞车进 onError（真机上就是麦克风被占）
  pH4.onUnload();

  // 首页按住录音同样先静音
  const home5 = newPage(timelineDef);
  detailCtx.play(); // 重新拨到「在播」（上面被 stop 过一轮）
  const detailStops5 = detailCtx.stops;
  home5.onMicStart();
  await idle();
  check(
    "H05",
    "首页按住录音也先把在播的停掉",
    detailCtx.stops === detailStops5 + 1,
    `stops=${detailCtx.stops}`,
  );

  // 台账里没在播的实例不该被空发一次 stop（每发一次就是一个 bridge 往返 + 一次白刷的 setData）
  const idleCtx = audioHub.create(); // 建好从没播过
  const idleStopsBefore = idleCtx.stops;
  const pH6 = await newEditPage({ id: "9" }, richDetail);
  const ctx6 = pH6._audio;
  ctx6.play();
  const ctx6StopsBefore = ctx6.stops;
  await tapRecord(pH6);
  check(
    "H06",
    "stopAll 只打在播的那一个，没在播的不空发 stop",
    idleCtx.stops === idleStopsBefore && ctx6.stops === ctx6StopsBefore + 1,
    `idle=${idleCtx.stops} playing=${ctx6.stops}`,
  );
  check(
    "H06b",
    "stop 完在播集合清空（不致「卡在播」）",
    audioHub.playingCount() === 0,
    `playing=${audioHub.playingCount()}`,
  );

  // 同一页第二遍起录不再走授权：省掉 getSetting + authorize 两趟往返
  REC.nextResult = { tempFilePath: "wxfile://h6.mp3", duration: 3000 };
  tapStop(pH6);
  await idle(); // 转写完成，_transcribing 复位
  const bridgesBefore2nd = authBridges.getSetting + authBridges.authorize;
  check(
    "H06c",
    "第一遍确实走了两趟授权 bridge",
    bridgesBefore2nd >= 2,
    JSON.stringify(authBridges),
  );
  const ctx6b = pH6._audio; // 转写成功后换了新实例
  ctx6b.play();
  await tapRecord(pH6);
  check(
    "H07",
    "第二遍起录不再走 getSetting/authorize（顿感就来自这两趟）",
    authBridges.getSetting + authBridges.authorize === bridgesBefore2nd,
    JSON.stringify(authBridges),
  );
  check(
    "H07b",
    "第二遍照样把在播的掐掉",
    ctx6b.stops >= 1,
    `stops=${ctx6b.stops}`,
  );
  REC.nextResult = { tempFilePath: "wxfile://h7.mp3", duration: 3000 };
  tapStop(pH6);
  await idle();
  pH6.onUnload();

  // 授权被拒：既不起录，也不该把用户正在听的东西弄停
  const pH8 = await newEditPage({ id: "9" }, richDetail);
  const ctx8 = pH8._audio;
  ctx8.play();
  const ctx8StopsBefore = ctx8.stops;
  const startsBefore = REC.starts.length;
  micGranted = false;
  await tapRecord(pH8);
  micGranted = true;
  check(
    "H08",
    "授权被拒 → 只提示一句：不起录也不静音",
    ctx8.stops === ctx8StopsBefore &&
      pH8.data.recording === false &&
      REC.starts.length === startsBefore &&
      toasts.some((t) => String(t).indexOf("麦克风权限") !== -1),
    `stops=${ctx8.stops} recording=${pH8.data.recording} toasts=${JSON.stringify(toasts)}`,
  );
  pH8.onUnload();

  // 录音器报错要作废授权缓存（权限在设置里被关时，下一轮得重新走授权）
  const pH9 = await newEditPage({});
  pH9._recAuthOk = true;
  pH9.setData({ recording: true });
  pH9.handleReRecordError();
  check(
    "H09",
    "录音器报错作废授权缓存",
    pH9._recAuthOk === false && pH9.data.recording === false,
    `_recAuthOk=${pH9._recAuthOk}`,
  );
  pH9.onUnload();

  // ==================== 输出 ====================
  let failed = 0;
  let currentSection = "";
  results.forEach((r) => {
    if (r.section) {
      currentSection = r.section;
      console.log(`\n${r.section}`);
      console.log("-".repeat(r.section.length));
      return;
    }
    if (!r.pass) failed += 1;
    console.log(
      `${r.pass ? "  ✓" : "  ✗"} ${r.id} ${r.desc}${r.pass ? "" : `  →  ${r.detail}`}`,
    );
  });
  const unknown = Object.keys(otherWxCalls);
  if (unknown.length)
    console.log(`\n（用例过程中触到的其它 wx API 桩：${unknown.join(", ")}）`);
  console.log(
    `\n共 ${results.filter((r) => !r.section).length} 条断言，失败 ${failed} 条`,
  );
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("用例跑挂了：", err && err.stack);
  process.exit(2);
});
