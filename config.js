/**
 * 全局配置
 * BASE_URL：后端服务地址，需与你的实际部署一致，只改这一处即可：
 *   - 直连 Node 服务：http://47.116.208.170:3000
 *   - 经 Nginx 反代（/api、/uploads 同域）：http://47.116.208.170
 *   - 本机联调：http://localhost:3000
 * 注意：正式发布需在小程序后台配置 HTTPS 备案域名，开发阶段在开发者工具
 * 勾选「不校验合法域名」即可使用下面的 HTTP 地址。
 */
// 【临时】指向本地 node 服务（NPC-log_node 默认 3000 端口，若 .env 改了 PORT 需同步）；
// 恢复线上时改回：http://47.116.208.170:3000
// 开发者工具模拟器用 localhost 即可；真机预览时 localhost 不通，需换成本机局域网 IP：
// http://192.168.3.24:3000（手机与电脑需同一 Wi-Fi，且 Windows 防火墙放行 3000 端口）
// ⚠️ 真机预览必须用手机能访问的局域网 IP，localhost 会被解析到手机自身
const BASE_URL = "http://192.168.3.24:3000";

module.exports = {
  BASE_URL,
  // 与 Web 端保持一致的本地缓存 key
  TOKEN_KEY: "NPC_token",
  USER_KEY: "NPC_user",
  ONLY_MINE_KEY: "npc_only_mine",
  // 统一请求超时（对齐后端 60s 全局超时，AI 问答耗时较长）
  TIMEOUT: 60000,
};
