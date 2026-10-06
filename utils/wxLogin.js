/**
 * 微信登录链路：wx.login 拿 code → 后端换登录态（新用户顺便注册）
 *
 * 为什么不塞进 auth.js：auth.js 被 request.js 引用，而这里要引用 api.js
 * （api.js → request.js → auth.js），放进 auth.js 就成了循环依赖，
 * require 会拿到一个只构造了一半的空对象。
 *
 * 后端业务码约定（见 NPC-log_node/src/controller/user.js）：
 * 4001 该微信未绑账号、且服务端不自动建档（没带 allowRegister 或 WX_AUTO_REGISTER=false）
 * 4002 服务端未开启微信登录 → 本次生命周期内隐藏微信入口（不反复试、不弹错）
 * 4003 该微信可以注册，但还缺用户自填的账号与密码 → 登录页跳 pages/wx-register 收输入
 */
const api = require("./api");
const auth = require("./auth");

const NEED_BIND = 4001;
const NEED_REGISTER = 4003;
const NOT_AVAILABLE = 4002;

/**
 * 「后端没开微信登录」只记在内存里、不落 storage：
 * 落盘的话服务端补好 .env 之后，老客户端要等到缓存被清才能看到微信按钮。
 */
let wxDisabled = false;

/** wx.login 拿一次性凭证（用过就废、约 5 分钟过期，所以每次登录/绑定都要现取） */
function getCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res && res.code) {
          resolve(res.code);
        } else {
          reject(new Error("wx.login 未返回 code"));
        }
      },
      fail: (err) => reject(err),
    });
  });
}

function markDisabled() {
  wxDisabled = true;
}

/** 微信入口是否还值得展示 */
function isAvailable() {
  return !wxDisabled;
}

/**
 * 用微信 code 换登录态（或换一个新账号）
 * @param {object} [opts] - {allowRegister, username, password}
 *   allowRegister 只给用户主动点那个按钮传 true；静默续期不传，
 *   否则只是打开过小程序就会攒出一堆空账号。
 *   username/password 只在 wx-register 页提交时带（password 传明文，MD5 在 api 层做）。
 * @returns {Promise<{ok:boolean, registered?:boolean, needBind?:boolean, needRegister?:boolean, notAvailable?:boolean, message?:string}>}
 */
async function wxLogin(opts) {
  const code = await getCode();
  const res = await api.user.wxLogin(code, opts);
  const bizCode = Number(res.code);

  if (bizCode === 200 && res.data && res.data.token) {
    auth.saveLogin(res.data);
    return { ok: true, registered: !!res.data.isNewUser };
  }
  if (bizCode === NOT_AVAILABLE) {
    markDisabled();
    return { ok: false, notAvailable: true };
  }
  if (bizCode === NEED_BIND) {
    return { ok: false, needBind: true, message: res.message };
  }
  if (bizCode === NEED_REGISTER) {
    return { ok: false, needRegister: true, message: res.message };
  }
  return { ok: false, message: res.message || "微信登录失败" };
}

/**
 * 静默登录的安全上限：wx.login 本身没有超时参数，万一它既不 success 也不 fail，
 * 登录页会永远停在占位上——6s 后无论有没有结果都让用户看到表单。
 */
const SILENT_MAX_MS = 6000;

/**
 * 静默登录：本地没有 token 时先试一次微信，已绑定用户就此跳过整个登录页
 * 不带 allowRegister——静默登录只续已有账号，新用户必须自己点一下那个按钮才算他愿意注册。
 * 失败一律不弹 toast——紧接着登录页就会把账号密码表单摆在面前，
 * 这里再弹一句「微信登录失败」只会让人以为账号也登不进去。
 * @returns {Promise<{ok:boolean, already?:boolean, needBind?:boolean, notAvailable?:boolean, timeout?:boolean, message?:string}>}
 */
async function silentLogin() {
  if (auth.getToken()) return { ok: true, already: true };
  if (wxDisabled) return { ok: false, notAvailable: true };
  try {
    return await Promise.race([
      wxLogin(),
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ ok: false, timeout: true, message: "微信登录超时" }),
          SILENT_MAX_MS,
        );
      }),
    ]);
  } catch (err) {
    // wx.login 本身失败（开发者工具未登录、断网）与后端不可达都归到这里
    return { ok: false, message: "微信登录暂不可用" };
  }
}

/**
 * 把当前微信绑到「已经登录上的」账号（账号密码登录成功后自动走一次）
 *
 * 失败绝不阻断进首页：绑定冲突/微信抖动只意味着「下次还得手动登录」，
 * 而不是「这次登不进去」。
 * @returns {Promise<{bound:boolean, notAvailable?:boolean, message?:string}>}
 */
async function bindCurrentWx() {
  if (wxDisabled) return { bound: false, notAvailable: true };
  try {
    const code = await getCode();
    const res = await api.user.bindWx(code);
    const bizCode = Number(res.code);
    if (bizCode === 200) {
      auth.markWxBound(true);
      return { bound: true };
    }
    if (bizCode === NOT_AVAILABLE) {
      markDisabled();
      return { bound: false, notAvailable: true };
    }
    return { bound: false, message: res.message || "绑定微信失败" };
  } catch (err) {
    return { bound: false, message: "绑定微信失败" };
  }
}

module.exports = {
  NEED_BIND,
  NEED_REGISTER,
  NOT_AVAILABLE,
  getCode,
  isAvailable,
  markDisabled,
  wxLogin,
  silentLogin,
  bindCurrentWx,
};
