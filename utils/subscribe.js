/**
 * 订阅消息（服务通知）授权链路
 *
 * 三条来自微信、本项目没法商量的硬约束：
 * 1. wx.requestSubscribeMessage 必须在用户点击的回调里调用。放在 onLoad/onShow 里
 *    会被直接拒（真机上不弹窗，工具里还可能给个假成功）；
 * 2. 一次性订阅是「用户授权一次 = 开发者只能下发一条」，长期订阅只对政务民生等
 *    少数类目开放、个人主体拿不到。所以提醒额度只能靠「每次用户主动操作时顺便攒一条」，
 *    攒到的次数记在后端 user_sub_quota，下发一条扣一条；
 * 3. 用户勾了「总是保持以上选择，不再询问」之后，后续调用不再弹窗、按上次选择静默返回，
 *    这正是能悄悄攒额度的唯一途径 —— 所以首次授权时一定要提示用户勾选。
 *
 * 本文件里所有函数都不弹模态框：wx.showModal 之后的异步链路里再调
 * requestSubscribeMessage 有可能已经离开「用户点击行为」的窗口而被拒，
 * 所以解释文案一律由页面内嵌的提示条承担（见 SUBSCRIBE_HINT）。
 *
 * 另外的现实：本接口只在真机生效，开发者工具里的弹窗是模拟的；
 * 而且用户可以在「小程序设置」里整体关掉订阅主开关（errCode 20004），
 * 这两种情况都必须降级成一句人话，而不是抛一个用户看不懂的错。
 */
const api = require("./api");

/**
 * 调起订阅弹窗
 * @param {string[]} tmplIds 模板 ID 列表（微信限制一次最多 3 个）
 * @returns {Promise<{res:Object, err?:Object}>} 永不 reject：失败也要拿到原因去分流
 */
function requestSubscribe(tmplIds) {
  return new Promise((resolve) => {
    if (!tmplIds || !tmplIds.length) {
      resolve({ res: null, err: { errMsg: "no-template-id", errCode: -1 } });
      return;
    }
    if (!wx.requestSubscribeMessage) {
      // 基础库过低（<2.8.2）：不弹窗、不报错，直接告诉调用方「这台设备不支持」
      resolve({ res: null, err: { errMsg: "unsupported", errCode: -2 } });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => resolve({ res }),
      fail: (err) => resolve({ res: null, err: err || {} }),
    });
  });
}

/**
 * 某个模板这次的授权结果
 * accept=同意，acceptWithAudio=同意并开语音提醒，reject=拒绝，
 * ban/filter=被平台判定不可用或已被用户拒收
 */
function acceptOf(res, templateId) {
  if (!res) return false;
  const v = res[templateId];
  return v === "accept" || v === "acceptWithAudio";
}

/** 把微信的失败码翻成人话（只列真机常见的那几个） */
function failText(err) {
  const code = Number(err && err.errCode);
  if (code === 20004)
    return "你已在设置里关闭订阅消息，请在「…」→设置里重新开启";
  if (code === 20001 || code === 10004)
    return "提醒模板不可用，请联系服务端配置模板 ID";
  if (code === 20003) return "一次最多订阅 3 条消息";
  if (code === 10005) return "页面已退出，请回到提醒页再试";
  if (code === -2) return "当前微信版本过低，暂不支持订阅消息";
  return "没有调起订阅弹窗";
}

/**
 * 攒一次订阅额度：弹窗 → 同意了就上报后端累加
 * @param {string} templateId 后端 /api/reminder/config 下发的模板 ID
 * @param {number} [count] 本次同意的模板数（一次调用最多 3 个模板）
 * @returns {Promise<{ok:boolean, accepted:boolean, quota?:number, reason?:string, needBind?:boolean}>}
 */
async function addSubscribeQuota(templateId, count = 1) {
  const { res, err } = await requestSubscribe([templateId]);
  if (err) {
    return { ok: false, accepted: false, reason: failText(err) };
  }
  if (!acceptOf(res, templateId)) {
    return {
      ok: false,
      accepted: false,
      reason: "未同意订阅，到点不会推送",
    };
  }
  try {
    const r = await api.reminder.authorize(count);
    if (Number(r.code) !== 200) {
      return { ok: false, accepted: true, reason: r.message || "授权上报失败" };
    }
    const data = r.data || {};
    return {
      ok: true,
      accepted: true,
      quota: data.quota,
      released: data.released,
      // 攒到额度但没绑微信等于「有钱没地址」，前端要单独提示一句去绑定
      needBind: data.wxBound === false,
    };
  } catch (e) {
    return { ok: false, accepted: true, reason: "授权上报失败，请稍后重试" };
  }
}

/** 页面内嵌的授权说明文案（放在按钮上方，不进点击链路） */
const SUBSCRIBE_HINT =
  "微信限制：每授权一次只能给你发一条提醒。弹窗里请勾选「总是保持以上选择」，之后每次保存提醒都会自动续一条，不再打扰你。";

module.exports = {
  requestSubscribe,
  acceptOf,
  failText,
  addSubscribeQuota,
  SUBSCRIBE_HINT,
};
