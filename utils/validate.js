/**
 * 输入校验规则集中一处
 *
 * ⚠ 必须与后端 src/service/userService.js 的 LIMITS / USERNAME_RE、
 *   Web 端 NPC-log/src/utils/config.ts 的 PASSWORD_RULE 逐字一致：
 *   两边不一样就会出现「小程序设的密码网页端改不了」「小程序放过的账号后端打回」，
 *   而这两句话对用户来说都是「明明填对了却报错」。
 */

/**
 * 账号（登录名）：3-20 位 ASCII 字母/数字/下划线/减号/点
 * 不给中文与空格：同一个号以后要在 PC 端手敲，看着一样却打不出来的名字最坑
 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const USERNAME_HINT = "账号请用 3-20 位字母、数字、下划线、减号或点";

/**
 * 密码：6-30 位，且必须同时含字母与数字
 * 减号必须写成 `\-` 或放到字符类末尾：`..._-*` 会被当成「从 _ 到 * 的区间」，
 * 而 _ (0x5F) > * (0x2A) 属于逆序区间，正则字面量在解析阶段就抛
 * SyntaxError，整包 appservice 编译中断，报成「module 'app.js' is not defined」
 */
const PWD_RE = /^(?=.*\d)(?=.*[a-zA-Z])[\da-zA-Z~!@#$%^&*+\.\_\-*]{6,30}$/;
const PWD_HINT = "密码需 6-30 位，且同时含字母和数字";

module.exports = { USERNAME_RE, USERNAME_HINT, PWD_RE, PWD_HINT };
